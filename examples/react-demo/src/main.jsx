import { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { BeldexProvider, ConnectButton, useBeldex, useConnect, useBalance, useSignMessage, fromAtomic } from 'bdx-web3js/react'
import { toAtomic, BdxRpcError, parseAuthChallenge } from 'bdx-web3js'

// ---------------------------------------------------------------------------
// Stand-in for YOUR backend. In production /api/auth/challenge issues the
// nonce (stored server-side, single-use) and /api/auth/verify re-runs these
// exact checks + bdx_verifyMessage before creating a session.
const mockAuthServer = {
  issued: new Map(), // nonce -> requestId

  async getChallenge() {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    const nonce = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
    const requestId = `req-${Date.now()}`
    this.issued.set(nonce, requestId)
    return { nonce, requestId, expiresInMs: 120000 }
  },

  /** Full relying-party verification checklist from the SDK README. */
  async verify(proof, bdx) {
    const f = parseAuthChallenge(proof.message)
    if (!f) return { ok: false, why: 'unparseable statement' }
    if (f.domain !== window.location.origin) return { ok: false, why: `domain mismatch (${f.domain})` }
    if (f.address !== proof.address) return { ok: false, why: 'address mismatch' }
    if (!this.issued.has(f.nonce)) return { ok: false, why: 'unknown or reused nonce' }
    this.issued.delete(f.nonce) // consume single-use
    const now = Date.now()
    if (now < f.issuedAt - 60000 || now > f.expirationTime) return { ok: false, why: 'outside iat/exp window' }
    const valid = await bdx.verifyMessage({
      message: proof.message, address: proof.address, signature: proof.signature
    })
    return valid ? { ok: true } : { ok: false, why: 'bad signature' }
  }
}

const card = { border: '1px solid #222', padding: 16, margin: '16px 0' }
const input = {
  background: '#111', color: '#eee', border: '1px solid #333', padding: 8,
  font: 'inherit', width: '100%', boxSizing: 'border-box', margin: '4px 0'
}
const btn = {
  background: '#3EC745', color: '#000', border: 0, padding: '10px 18px',
  font: 'inherit', fontWeight: 700, cursor: 'pointer', marginTop: 8
}

function DisconnectButton() {
  const { isConnected, disconnect } = useConnect()
  if (!isConnected) return null
  return (
    <button
      style={{ ...btn, background: 'transparent', color: '#ff5c5c', border: '1px solid #ff5c5c', marginLeft: 8 }}
      onClick={() => { disconnect() }}>
      Disconnect
    </button>
  )
}

function Address() {
  const { bdx } = useBeldex()
  const { address, proof } = useConnect()
  const [auth, setAuth] = useState(null) // null | { ok, why? }

  // "Server-side" verification of the connect proof (mock backend above).
  useEffect(() => {
    if (!proof || !bdx) { setAuth(null); return }
    let stale = false
    mockAuthServer.verify(proof, bdx).then(r => { if (!stale) setAuth(r) })
    return () => { stale = true }
  }, [proof, bdx])

  if (!address) return null
  return (
    <div style={{ fontSize: 12 }}>
      <p>
        Address:{' '}
        <span style={{ color: '#3EC745', wordBreak: 'break-all' }}>{address}</span>
      </p>
      {proof && (
        <p style={{ wordBreak: 'break-all' }}>
          ✓ signed on connect ({proof.serverIssued ? 'server-issued nonce' : 'self-nonced — not for login'},
          {' '}bound to <b>{proof.domain}</b>, expires {new Date(proof.expirationTime).toLocaleTimeString()})
          <br /><code>{proof.message}</code>
          <br />signature: <span style={{ color: '#3EC745' }}>{proof.signature}</span>
          <br />
          {auth === null ? 'verifying with mock server…' : auth.ok
            ? <span style={{ color: '#3EC745' }}>✓ mock server accepted the sign-in (nonce consumed)</span>
            : <span style={{ color: '#ff5c5c' }}>✗ mock server rejected: {auth.why}</span>}
        </p>
      )}
    </div>
  )
}

function Balance() {
  const { isConnected } = useConnect()
  const { balance, error } = useBalance({ pollMs: 15000 })
  if (!isConnected) return null
  if (error) return <p style={{ color: '#ff5c5c' }}>balance error: {error.message}</p>
  if (!balance) return <p>loading balance…</p>
  return (
    <p>
      Spendable: <b style={{ color: '#3EC745' }}>{fromAtomic(balance.unlocked)} BDX</b>
      {balance.approximate ? ' (approx.)' : ''}
    </p>
  )
}

function SendForm() {
  const { bdx } = useBeldex()
  const { isConnected } = useConnect()
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [priority, setPriority] = useState(1)
  const [sweep, setSweep] = useState(false)
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState(null)   // { txHash, fee }
  const [error, setError] = useState(null)

  if (!isConnected) return null

  const onSubmit = async (e) => {
    e.preventDefault()
    setError(null)
    setResult(null)
    setSending(true)
    try {
      const params = { to: to.trim(), priority }
      if (sweep) params.sweep = true
      else params.amount = toAtomic(amount)   // display BDX → atomic units
      const r = await bdx.sendTransaction(params)
      setResult(r)
      setTo(''); setAmount(''); setSweep(false)
    } catch (err) {
      if (!BdxRpcError.isUserRejection(err)) setError(err)
      // user rejection (4001): stay quiet, keep the form as-is
    } finally {
      setSending(false)
    }
  }

  return (
    <form style={card} onSubmit={onSubmit}>
      <h2 style={{ fontSize: 14, marginTop: 0 }}>Send BDX</h2>

      <label>
        To address
        <input style={input} value={to} onChange={e => setTo(e.target.value)}
          placeholder="bxc…" required spellCheck={false} />
      </label>

      <label>
        Amount (BDX)
        <input style={{ ...input, opacity: sweep ? 0.4 : 1 }} value={amount}
          onChange={e => setAmount(e.target.value)} placeholder="1.25"
          inputMode="decimal" required={!sweep} disabled={sweep} />
      </label>

      <label style={{ display: 'block', margin: '4px 0' }}>
        <input type="checkbox" checked={sweep} onChange={e => setSweep(e.target.checked)} />
        {' '}Sweep — send entire spendable balance
      </label>

      <label>
        Priority
        <select style={input} value={priority} onChange={e => setPriority(Number(e.target.value))}>
          <option value={1}>1 — normal (default)</option>
          <option value={2}>2</option>
          <option value={3}>3</option>
          <option value={4}>4</option>
          <option value={5}>5 — flash (instant)</option>
        </select>
      </label>

      <button style={btn} type="submit" disabled={sending}>
        {sending ? 'Waiting for approval…' : sweep ? 'Sweep all' : 'Send'}
      </button>

      {result && (
        <p style={{ fontSize: 12, wordBreak: 'break-all' }}>
          ✓ sent — tx <span style={{ color: '#3EC745' }}>{result.txHash}</span>
          <br />fee: {fromAtomic(result.fee)} BDX
        </p>
      )}
      {error && (
        <p style={{ color: '#ff5c5c', fontSize: 12, wordBreak: 'break-all' }}>
          send failed{error.code !== undefined ? ` (${error.code})` : ''}: {error.message}
        </p>
      )}
    </form>
  )
}

function SignMessageCard() {
  const { bdx } = useBeldex()
  const { isConnected } = useConnect()
  const { sign, signing, data, error, reset } = useSignMessage()
  const [message, setMessage] = useState('')
  const [verified, setVerified] = useState(null) // null | true | false

  if (!isConnected) return null

  const onSign = async (e) => {
    e.preventDefault()
    setVerified(null)
    let r
    try {
      r = await sign(message) // null if the user rejected
    } catch {
      return // hook exposes the error via `error` state
    }
    if (!r) return
    // Round trip: verify the fresh signature through the wallet (public, no approval)
    try {
      setVerified(await bdx.verifyMessage({ message, address: r.address, signature: r.signature }))
    } catch {
      setVerified(false)
    }
  }

  return (
    <form style={card} onSubmit={onSign}>
      <h2 style={{ fontSize: 14, marginTop: 0 }}>Sign message</h2>

      <label>
        Message (max 512 chars, plain text)
        <textarea style={{ ...input, resize: 'vertical', minHeight: 60 }} value={message}
          maxLength={512} required placeholder="I own this address — demo challenge"
          onChange={e => { setMessage(e.target.value); reset(); setVerified(null) }} />
      </label>

      <button style={btn} type="submit" disabled={signing || !message}>
        {signing ? 'Waiting for approval…' : 'Sign'}
      </button>

      {data && (
        <div style={{ fontSize: 12, wordBreak: 'break-all', marginTop: 8 }}>
          <p style={{ margin: '4px 0' }}>
            signature: <span style={{ color: '#3EC745' }}>{data.signature}</span>
          </p>
          <p style={{ margin: '4px 0' }}>signed by: {data.address}</p>
          {verified !== null && (
            <p style={{ margin: '4px 0', color: verified ? '#3EC745' : '#ff5c5c' }}>
              {verified ? '✓ verified via bdx_verifyMessage' : '✗ verification failed'}
            </p>
          )}
        </div>
      )}
      {error && (
        <p style={{ color: '#ff5c5c', fontSize: 12, wordBreak: 'break-all' }}>
          sign failed{error.code !== undefined ? ` (${error.code})` : ''}: {error.message}
        </p>
      )}
    </form>
  )
}

function App() {
  return (
    <BeldexProvider signOnConnect={{ getChallenge: () => mockAuthServer.getChallenge() }}>
      <h1 style={{ fontSize: 18 }}>◆ bdx-web3js React demo</h1>
      <ConnectButton />
      <DisconnectButton />
      <Address />
      <Balance />
      <SendForm />
      <SignMessageCard />
      <p style={{ color: '#8a8a8a', fontSize: 12 }}>
        Requires the Beldex Wallet extension. Serve over http(s) — the extension
        does not inject into file:// pages.
      </p>
    </BeldexProvider>
  )
}

createRoot(document.getElementById('root')).render(<App />)
