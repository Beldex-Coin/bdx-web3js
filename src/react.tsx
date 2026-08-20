// React bindings for bdx-web3js — import from 'bdx-web3js/react'.
// react is a peer dependency (>=18) and is NOT bundled.

import {
  createContext, useCallback, useContext, useEffect, useRef, useState
} from 'react'
import type { ReactNode, CSSProperties } from 'react'
import { BeldexWeb3 } from './client.js'
import { detectProvider } from './provider.js'
import { BdxRpcError } from './errors.js'
import { fromAtomic } from './units.js'
import type { Balance, ConnectProof, Nettype, SignMessageResult } from './types.js'

export type WalletStatus = 'detecting' | 'ready' | 'unavailable'

export interface BeldexContextValue {
  /** The client — null until a provider is detected. */
  bdx: BeldexWeb3 | null
  status: WalletStatus
  /** Connected address, or null. Kept in sync with wallet events. */
  address: string | null
  network: Nettype | null
  connecting: boolean
  /** Opens the wallet's approval UI. Resolves quietly on user rejection. */
  connect: () => Promise<void>
  disconnect: () => Promise<void>
  /** Ownership proof from connect (only with `signOnConnect`); with
   *  `signOnConnect` a connection only exists together with its proof. */
  proof: ConnectProof | null
}

const Ctx = createContext<BeldexContextValue | null>(null)

export function BeldexProvider({ children, detectTimeoutMs = 3000, signOnConnect = false }: {
  children: ReactNode
  detectTimeoutMs?: number
  /** When true, connect() immediately asks the wallet to sign an
   *  `<address>:<nonce>:<timestamp>` challenge (bdx.connectWithProof) and
   *  exposes the result as `proof`. All-or-nothing: declining the signature
   *  disconnects the freshly made connection again. */
  signOnConnect?: boolean
}) {
  const [bdx, setBdx] = useState<BeldexWeb3 | null>(null)
  const [status, setStatus] = useState<WalletStatus>('detecting')
  const [address, setAddress] = useState<string | null>(null)
  const [network, setNetwork] = useState<Nettype | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [proof, setProof] = useState<ConnectProof | null>(null)

  useEffect(() => {
    let stop = false
    detectProvider({ timeoutMs: detectTimeoutMs }).then(provider => {
      if (stop) return
      if (!provider) { setStatus('unavailable'); return }
      const client = new BeldexWeb3(provider)
      client.on('accountsChanged', () => { setAddress(null); setProof(null) })
      client.on('disconnect', () => { setAddress(null); setProof(null) })
      client.on('connect', d => {
        const data = d as { address?: string } | undefined
        if (typeof data?.address === 'string') setAddress(data.address)
      })
      setBdx(client)
      setStatus('ready')
    })
    return () => { stop = true }
  }, [detectTimeoutMs])

  const connect = useCallback(async () => {
    if (!bdx || connecting) return
    setConnecting(true)
    try {
      if (signOnConnect) {
        const r = await bdx.connectWithProof()
        setAddress(r.address)
        setNetwork(r.network)
        setProof(r.proof)
      } else {
        const r = await bdx.connect()
        setAddress(r.address)
        setNetwork(r.network)
      }
    } catch (e) {
      if (!BdxRpcError.isUserRejection(e)) throw e
    } finally {
      setConnecting(false)
    }
  }, [bdx, connecting, signOnConnect])

  const disconnect = useCallback(async () => {
    if (!bdx) return
    await bdx.disconnect()
    setAddress(null)
    setProof(null)
  }, [bdx])

  return (
    <Ctx.Provider value={{ bdx, status, address, network, connecting, connect, disconnect, proof }}>
      {children}
    </Ctx.Provider>
  )
}

export function useBeldex(): BeldexContextValue {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useBeldex must be used inside <BeldexProvider>')
  return ctx
}

export function useConnect() {
  const { connect, disconnect, address, connecting, status, proof } = useBeldex()
  return { connect, disconnect, address, isConnected: address !== null, connecting, status, proof }
}

export interface UseBalanceResult {
  /** BigInt atomic units; null until first successful load. */
  balance: Balance | null
  error: Error | null
  refresh: () => void
}

/** Polls the balance while connected and refreshes on balanceChanged pushes. */
export function useBalance({ pollMs = 15_000 }: { pollMs?: number } = {}): UseBalanceResult {
  const { bdx, address } = useBeldex()
  const [balance, setBalance] = useState<Balance | null>(null)
  const [error, setError] = useState<Error | null>(null)
  const tick = useRef(0)

  const load = useCallback(() => {
    if (!bdx || address === null) return
    const my = ++tick.current
    bdx.getBalance()
      .then(b => { if (tick.current === my) { setBalance(b); setError(null) } })
      .catch(e => { if (tick.current === my) setError(e as Error) })
  }, [bdx, address])

  useEffect(() => {
    if (!bdx || address === null) { setBalance(null); return }
    load()
    const t = setInterval(load, pollMs)
    const onPush = () => load()
    bdx.on('balanceChanged', onPush)
    return () => { clearInterval(t); bdx.off('balanceChanged', onPush) }
  }, [bdx, address, pollMs, load])

  return { balance, error, refresh: load }
}

export interface UseSignMessageResult {
  /** Ask the wallet to sign `message` (user approves in the wallet's window).
   *  Resolves with the result, or null if the user rejected (4001). */
  sign: (message: string) => Promise<SignMessageResult | null>
  signing: boolean
  /** Last successful signature, or null. */
  data: SignMessageResult | null
  /** Last error (user rejections excluded), or null. */
  error: Error | null
  reset: () => void
}

/** Message signing (PROTOCOL.md §4.6, "SigV1…" encoding). User rejections
 *  resolve quietly as null rather than throwing, matching connect(). */
export function useSignMessage(): UseSignMessageResult {
  const { bdx } = useBeldex()
  const [signing, setSigning] = useState(false)
  const [data, setData] = useState<SignMessageResult | null>(null)
  const [error, setError] = useState<Error | null>(null)

  const sign = useCallback(async (message: string): Promise<SignMessageResult | null> => {
    if (!bdx) throw new Error('wallet not available')
    setSigning(true)
    setError(null)
    try {
      const r = await bdx.signMessage(message)
      setData(r)
      return r
    } catch (e) {
      if (BdxRpcError.isUserRejection(e)) return null
      setError(e as Error)
      throw e
    } finally {
      setSigning(false)
    }
  }, [bdx])

  const reset = useCallback(() => { setData(null); setError(null) }, [])

  return { sign, signing, data, error, reset }
}

// ---------------------------------------------------------------- button ----

function short(addr: string): string {
  return addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-4)}` : addr
}

const defaultStyle: CSSProperties = {
  background: '#3EC745', color: '#000', border: 'none', cursor: 'pointer',
  padding: '10px 18px', fontWeight: 700, fontFamily: 'inherit', fontSize: 14
}

/** Drop-in connect button: detect → connect → shows the address (click to
 *  disconnect). Unstyled beyond a sane default; pass className/style. */
export function ConnectButton({ className, style, installUrl = 'https://beldex.io' }: {
  className?: string
  style?: CSSProperties
  installUrl?: string
}) {
  const { status, address, connecting, connect, disconnect } = useBeldex()
  const s = { ...defaultStyle, ...style }

  if (status === 'detecting') {
    return <button className={className} style={s} disabled>Detecting wallet…</button>
  }
  if (status === 'unavailable') {
    return (
      <a className={className} href={installUrl} target="_blank" rel="noreferrer"
        style={{ ...s, display: 'inline-block', textDecoration: 'none' }}>
        Install Beldex Wallet
      </a>
    )
  }
  if (address === null) {
    return (
      <button className={className} style={s} disabled={connecting} onClick={() => { connect() }}>
        {connecting ? 'Connecting…' : 'Connect Beldex Wallet'}
      </button>
    )
  }
  return (
    <button className={className} style={s} title={`${address}\nClick to disconnect`}
      onClick={() => { disconnect() }}>
      {short(address)}
    </button>
  )
}

export { fromAtomic } // convenience re-export for balance display
