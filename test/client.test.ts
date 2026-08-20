import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BeldexWeb3, buildAuthChallenge } from '../src/client.js'
import { BdxRpcError, ERROR_CODES } from '../src/errors.js'
import { toAtomic } from '../src/units.js'
import { MockWallet, MOCK_ADDRESS, MOCK_TXHASH, RpcHandlerError } from './mock-wallet.js'

let wallet: MockWallet
let bdx: BeldexWeb3

beforeEach(() => {
  wallet = new MockWallet()
  bdx = new BeldexWeb3(wallet.provider)
})

afterEach(() => wallet.destroy())

describe('construction', () => {
  it('rejects non-providers', () => {
    expect(() => new BeldexWeb3(null as never)).toThrow(TypeError)
    expect(() => new BeldexWeb3({} as never)).toThrow(TypeError)
  })
})

describe('methods — happy paths', () => {
  it('connect() returns and caches the address', async () => {
    expect(bdx.isConnected).toBe(false)
    const r = await bdx.connect()
    expect(r).toEqual({ address: MOCK_ADDRESS, network: 'mainnet' })
    expect(bdx.address).toBe(MOCK_ADDRESS)
    expect(bdx.isConnected).toBe(true)
  })

  it('disconnect() clears the cache', async () => {
    await bdx.connect()
    await bdx.disconnect()
    expect(bdx.address).toBeNull()
  })

  it('getAddress()', async () => {
    expect(await bdx.getAddress()).toBe(MOCK_ADDRESS)
  })

  it('getBalance() parses to BigInt', async () => {
    const b = await bdx.getBalance()
    expect(b.total).toBe(12_500_000_000n)
    expect(b.unlocked).toBe(10_000_000_000n)
    expect(b.approximate).toBe(true)
    expect(b.height).toBe(3_500_000)
  })

  it('sendTransaction() sends atomic strings on the wire', async () => {
    const r = await bdx.sendTransaction({ to: MOCK_ADDRESS, amount: toAtomic('1.25'), priority: 5 })
    expect(r.txHash).toBe(MOCK_TXHASH)
    expect(wallet.calls[0]!.params).toEqual({ to: MOCK_ADDRESS, amount: '1250000000', priority: 5 })
  })

  it('sendTransaction() sweep omits amount', async () => {
    await bdx.sendTransaction({ to: MOCK_ADDRESS, sweep: true })
    expect(wallet.calls[0]!.params).toEqual({ to: MOCK_ADDRESS, sweep: true })
  })

  it('signMessage / verifyMessage', async () => {
    const s = await bdx.signMessage('hello')
    expect(s.address).toBe(MOCK_ADDRESS)
    expect(await bdx.verifyMessage({ message: 'hello', address: s.address, signature: s.signature })).toBe(true)
  })

  it('connectWithProof() signs <address>:<nonce>:<timestamp>', async () => {
    const r = await bdx.connectWithProof()
    expect(r.address).toBe(MOCK_ADDRESS)
    expect(r.proof).not.toBeNull()
    const p = r.proof!
    expect(p.signature).toBe('SigV1mockmockmock')
    expect(p.nonce).toMatch(/^[0-9a-f]{32}$/)
    expect(p.message).toBe(buildAuthChallenge(MOCK_ADDRESS, p.nonce, p.timestamp))
    // the exact challenge went over the wire
    const signCall = wallet.calls.find(c => c.method === 'bdx_signMessage')!
    expect(signCall.params).toEqual({ message: p.message })
    // fresh timestamp
    expect(Math.abs(Date.now() - p.timestamp)).toBeLessThan(5_000)
  })

  it('connectWithProof() rejection → disconnects and throws (default)', async () => {
    wallet.handlers.bdx_signMessage = () => { throw new RpcHandlerError(4001, 'rejected') }
    await expect(bdx.connectWithProof()).rejects.toMatchObject({ code: 4001 })
    expect(wallet.calls.some(c => c.method === 'bdx_disconnect')).toBe(true)
    expect(bdx.isConnected).toBe(false)
  })

  it('connectWithProof({required:false}) rejection → connected, proof null', async () => {
    wallet.handlers.bdx_signMessage = () => { throw new RpcHandlerError(4001, 'rejected') }
    const r = await bdx.connectWithProof({ required: false })
    expect(r.proof).toBeNull()
    expect(bdx.isConnected).toBe(true)
  })

  it('resolveBns trims input', async () => {
    const r = await bdx.resolveBns('  shop.bdx  ')
    expect(r.address).toBe(MOCK_ADDRESS)
    expect(wallet.calls[0]!.params).toEqual({ name: 'shop.bdx' })
  })

  it('getNetwork / getState', async () => {
    expect((await bdx.getNetwork()).protocolVersion).toBe(1)
    expect(await bdx.getState()).toBe('unlocked')
  })
})

describe('client-side validation (-32602 before any wire call)', () => {
  const cases: Array<[string, () => Promise<unknown>]> = [
    ['bad address', () => bdx.sendTransaction({ to: 'garbage', amount: 1n })],
    ['zero amount', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 0n })],
    ['missing amount', () => bdx.sendTransaction({ to: MOCK_ADDRESS })],
    ['sweep+amount', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 1n, sweep: true })],
    ['bad priority', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 1n, priority: 9 as never })],
    ['bad paymentId', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 1n, paymentId: 'xyz' })],
    ['fractional amount string', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: '1.5' })],
    ['empty message', () => bdx.signMessage('')],
    ['control chars in message', () => bdx.signMessage('line1\nline2')],
    ['NUL in message', () => bdx.signMessage('a\x00b')],
    ['empty bns name', () => bdx.resolveBns('  ')]
  ]
  for (const [name, fn] of cases) {
    it(name, async () => {
      await expect(fn()).rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS })
      expect(wallet.calls).toHaveLength(0)
    })
  }
})

describe('error propagation', () => {
  it('maps every protocol error code', async () => {
    for (const code of [4001, 4100, 4900, 4901, 4999, -32601, -32602, -32603]) {
      wallet.handlers.bdx_getAddress = () => { throw new RpcHandlerError(code, `err ${code}`) }
      const err = await bdx.getAddress().catch((e: unknown) => e)
      expect(err).toBeInstanceOf(BdxRpcError)
      expect((err as BdxRpcError).code).toBe(code)
    }
  })

  it('static helpers classify', async () => {
    wallet.handlers.bdx_connect = () => { throw new RpcHandlerError(4001, 'no') }
    const err = await bdx.connect().catch((e: unknown) => e)
    expect(BeldexWeb3.isUserRejection(err)).toBe(true)
    expect(BeldexWeb3.isLocked(err)).toBe(false)
  })

  it('times out slow reads with 4999', async () => {
    const fast = new BeldexWeb3(wallet.provider, { readTimeoutMs: 30 })
    wallet.delayMs = 200
    await expect(fast.getBalance()).rejects.toMatchObject({ code: ERROR_CODES.REQUEST_EXPIRED })
  })
})

describe('events', () => {
  it('on/off/once re-emit provider events', () => {
    const seen: unknown[] = []
    const fn = (d: unknown) => seen.push(d)
    bdx.on('balanceChanged', fn)
    wallet.emit('balanceChanged', { total: '1', unlocked: '1', height: 1 })
    bdx.off('balanceChanged', fn)
    wallet.emit('balanceChanged', { total: '2', unlocked: '2', height: 2 })
    expect(seen).toHaveLength(1)

    const onceSeen: unknown[] = []
    bdx.once('lock', d => onceSeen.push(d))
    wallet.emit('lock', {})
    wallet.emit('lock', {})
    expect(onceSeen).toHaveLength(1)
  })

  it('accountsChanged(null) drops the cached address', async () => {
    await bdx.connect()
    wallet.emit('accountsChanged', { address: null })
    expect(bdx.address).toBeNull()
    expect(bdx.isConnected).toBe(false)
  })

  it('disconnect event drops the cached address', async () => {
    await bdx.connect()
    wallet.emit('disconnect', {})
    expect(bdx.address).toBeNull()
  })
})
