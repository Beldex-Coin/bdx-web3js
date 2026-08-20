import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, Root } from 'react-dom/client'
import { act } from 'react'
import { BeldexProvider, ConnectButton, useBalance, useBeldex, useConnect, useSignMessage } from '../src/react.js'
import { MockWallet, MOCK_ADDRESS } from './mock-wallet.js'

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

let wallet: MockWallet
let container: HTMLDivElement
let root: Root

const flush = (ms = 20) => act(() => new Promise<void>(r => setTimeout(r, ms)))

beforeEach(() => {
  wallet = new MockWallet()
  wallet.announce()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  wallet.destroy()
})

function BalanceProbe() {
  const { balance } = useBalance({ pollMs: 60_000 })
  const { address } = useBeldex()
  return (
    <div>
      <span data-testid="addr">{address ?? 'none'}</span>
      <span data-testid="bal">{balance ? balance.unlocked.toString() : 'loading'}</span>
    </div>
  )
}

describe('BeldexProvider + ConnectButton', () => {
  it('detects, connects on click, then disconnects', async () => {
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200}>
          <ConnectButton />
        </BeldexProvider>
      )
    })
    await flush(50)
    const btn = () => container.querySelector('button')!
    expect(btn().textContent).toBe('Connect Beldex Wallet')

    await act(async () => { btn().click() })
    await flush(50)
    expect(btn().textContent).toContain(MOCK_ADDRESS.slice(0, 8))
    expect(wallet.calls.some(c => c.method === 'bdx_connect')).toBe(true)

    await act(async () => { btn().click() }) // click while connected = disconnect
    await flush(50)
    expect(btn().textContent).toBe('Connect Beldex Wallet')
  })

  it('user rejection resolves quietly (no throw, stays disconnected)', async () => {
    wallet.handlers.bdx_connect = () => { throw { code: 4001, message: 'no' } }
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200}>
          <ConnectButton />
        </BeldexProvider>
      )
    })
    await flush(50)
    const btn = container.querySelector('button')!
    await act(async () => { btn.click() })
    await flush(50)
    expect(container.querySelector('button')!.textContent).toBe('Connect Beldex Wallet')
  })
})

function SignProbe() {
  const { sign, data, error } = useSignMessage()
  return (
    <div>
      <button data-testid="sign" onClick={() => { sign('hello').catch(() => {}) }}>sign</button>
      <span data-testid="sig">{data ? data.signature : error ? `err:${(error as { code?: number }).code}` : 'none'}</span>
    </div>
  )
}

describe('signOnConnect', () => {
  function ProofProbe() {
    const { proof } = useConnect()
    return <span data-testid="proof">{proof ? proof.signature : 'none'}</span>
  }

  it('connect() also signs the challenge and exposes proof', async () => {
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200} signOnConnect>
          <ConnectButton />
          <ProofProbe />
        </BeldexProvider>
      )
    })
    await flush(50)
    await act(async () => { container.querySelector('button')!.click() })
    await flush(50)
    expect(container.querySelector('[data-testid="proof"]')!.textContent).toBe('SigV1mockmockmock')
    const sign = wallet.calls.find(c => c.method === 'bdx_signMessage')
    expect(sign).toBeTruthy()
    expect((sign!.params as { message: string }).message)
      .toMatch(new RegExp(`^${MOCK_ADDRESS}:[0-9a-f]{32}:\\d+$`))
  })

  it('declined signature disconnects again (all-or-nothing)', async () => {
    wallet.handlers.bdx_signMessage = () => { throw { code: 4001, message: 'no' } }
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200} signOnConnect>
          <ConnectButton />
          <ProofProbe />
        </BeldexProvider>
      )
    })
    await flush(50)
    await act(async () => { container.querySelector('button')!.click() })
    await flush(50)
    expect(wallet.calls.some(c => c.method === 'bdx_disconnect')).toBe(true)
    expect(container.querySelector('button')!.textContent).toBe('Connect Beldex Wallet')
    expect(container.querySelector('[data-testid="proof"]')!.textContent).toBe('none')
  })
})

describe('useSignMessage', () => {
  async function mount() {
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200}>
          <ConnectButton />
          <SignProbe />
        </BeldexProvider>
      )
    })
    await flush(50)
    await act(async () => { container.querySelector('button')!.click() }) // connect
    await flush(50)
  }
  const signBtn = () => container.querySelector<HTMLButtonElement>('[data-testid="sign"]')!
  const sig = () => container.querySelector('[data-testid="sig"]')!.textContent

  it('signs via the wallet and exposes the result', async () => {
    await mount()
    await act(async () => { signBtn().click() })
    await flush(50)
    expect(sig()).toBe('SigV1mockmockmock')
    expect(wallet.calls.some(c => c.method === 'bdx_signMessage')).toBe(true)
  })

  it('user rejection stays quiet (no error state)', async () => {
    wallet.handlers.bdx_signMessage = () => { throw { code: 4001, message: 'no' } }
    await mount()
    await act(async () => { signBtn().click() })
    await flush(50)
    expect(sig()).toBe('none')
  })

  it('non-rejection errors land in error state', async () => {
    wallet.handlers.bdx_signMessage = () => { throw { code: -32603, message: 'boom' } }
    await mount()
    await act(async () => { signBtn().click() })
    await flush(50)
    expect(sig()).toBe('err:-32603')
  })
})

describe('useBalance', () => {
  it('loads after connect and updates on balanceChanged', async () => {
    await act(async () => {
      root.render(
        <BeldexProvider detectTimeoutMs={200}>
          <ConnectButton />
          <BalanceProbe />
        </BeldexProvider>
      )
    })
    await flush(50)
    expect(container.querySelector('[data-testid="bal"]')!.textContent).toBe('loading')

    await act(async () => { container.querySelector('button')!.click() })
    await flush(50)
    expect(container.querySelector('[data-testid="addr"]')!.textContent).toBe(MOCK_ADDRESS)
    expect(container.querySelector('[data-testid="bal"]')!.textContent).toBe('10000000000')

    wallet.handlers.bdx_getBalance = () => ({
      total: '99000000000', unlocked: '99000000000', approximate: false, height: 1
    })
    await act(async () => { wallet.emit('balanceChanged', { total: '99000000000', unlocked: '99000000000', height: 1 }) })
    await flush(50)
    expect(container.querySelector('[data-testid="bal"]')!.textContent).toBe('99000000000')
  })
})
