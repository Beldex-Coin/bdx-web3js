import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { BeldexWeb3, buildAuthChallenge, parseAuthChallenge } from '../src/client.js'
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

  it('sendTransaction() sends atomic strings + an auto idempotencyKey on the wire', async () => {
    const r = await bdx.sendTransaction({ to: MOCK_ADDRESS, amount: toAtomic('1.25'), priority: 5 })
    expect(r.txHash).toBe(MOCK_TXHASH)
    const p = wallet.calls[0]!.params as Record<string, unknown>
    expect(p).toMatchObject({ to: MOCK_ADDRESS, amount: '1250000000', priority: 5 })
    expect(p.idempotencyKey).toMatch(/^[A-Za-z0-9._-]{8,128}$/)
  })

  it('sendTransaction() forwards a caller-supplied idempotencyKey', async () => {
    await bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 1n, idempotencyKey: 'order-42.retry' })
    expect((wallet.calls[0]!.params as { idempotencyKey: string }).idempotencyKey).toBe('order-42.retry')
  })

  it('sendTransaction() sweep omits amount', async () => {
    await bdx.sendTransaction({ to: MOCK_ADDRESS, sweep: true })
    expect(wallet.calls[0]!.params).toMatchObject({ to: MOCK_ADDRESS, sweep: true })
    expect(wallet.calls[0]!.params).not.toHaveProperty('amount')
  })

  it('signMessage / verifyMessage', async () => {
    const s = await bdx.signMessage('hello')
    expect(s.address).toBe(MOCK_ADDRESS)
    expect(await bdx.verifyMessage({ message: 'hello', address: s.address, signature: s.signature })).toBe(true)
  })

  it('connectWithProof() signs a domain-bound beldex-auth-v1 statement', async () => {
    const r = await bdx.connectWithProof()
    expect(r.address).toBe(MOCK_ADDRESS)
    const p = r.proof!
    expect(p.signature).toBe('SigV1mockmockmock')
    expect(p.nonce).toMatch(/^[0-9a-f]{32}$/)   // self-generated
    expect(p.serverIssued).toBe(false)
    expect(p.domain).toBe(globalThis.location.origin)
    // message round-trips through the parser with the audience baked in
    const f = parseAuthChallenge(p.message)!
    expect(f).toMatchObject({
      domain: globalThis.location.origin, address: MOCK_ADDRESS,
      network: 'mainnet', nonce: p.nonce, issuedAt: p.issuedAt,
      expirationTime: p.expirationTime
    })
    expect(p.message).toBe(buildAuthChallenge(f))
    // the exact statement went over the wire; freshness + default TTL
    expect(wallet.calls.find(c => c.method === 'bdx_signMessage')!.params).toEqual({ message: p.message })
    expect(Math.abs(Date.now() - p.issuedAt)).toBeLessThan(5_000)
    expect(p.expirationTime - p.issuedAt).toBe(300_000)
  })

  it('connectWithProof({challenge}) embeds the server nonce and requestId', async () => {
    const r = await bdx.connectWithProof({
      challenge: { nonce: 'srv-nonce-01.abc', requestId: 'req-77', expiresInMs: 60_000 }
    })
    const p = r.proof!
    expect(p.serverIssued).toBe(true)
    expect(p.nonce).toBe('srv-nonce-01.abc')
    expect(p.requestId).toBe('req-77')
    expect(p.expirationTime - p.issuedAt).toBe(60_000)
    expect(p.message).toContain('nonce=srv-nonce-01.abc')
    expect(p.message).toContain('rid=req-77')
  })

  it('connectWithProof rejects malformed server nonces before any wire call', async () => {
    for (const nonce of ['short', 'has space in it', 'evil\nnonce', 'x'.repeat(200)]) {
      await expect(bdx.connectWithProof({ challenge: { nonce } }))
        .rejects.toMatchObject({ code: ERROR_CODES.INVALID_PARAMS })
    }
    expect(wallet.calls).toHaveLength(0)
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

describe('send operation recovery (audit: unknown outcome ≠ safe retry)', () => {
  const hang = () => new Promise(() => {}) // never answers

  it('send timeout → UNKNOWN_OUTCOME (4998); read timeout stays 4999', async () => {
    const fast = new BeldexWeb3(wallet.provider, { approvalTimeoutMs: 30, readTimeoutMs: 30 })
    wallet.handlers.bdx_sendTransaction = hang
    wallet.handlers.bdx_getBalance = hang
    await expect(fast.sendTransaction({ to: MOCK_ADDRESS, amount: 1n }))
      .rejects.toMatchObject({ code: ERROR_CODES.UNKNOWN_OUTCOME })
    await expect(fast.getBalance())
      .rejects.toMatchObject({ code: ERROR_CODES.REQUEST_EXPIRED })
  })

  it('getOperationStatus decodes all four states', async () => {
    const states = [
      { status: 'executing', operationId: 'op-1' },
      { status: 'confirmed', operationId: 'op-1', txHash: MOCK_TXHASH, fee: '5' },
      { status: 'failed', operationId: 'op-1' },
      { status: 'unknown' }
    ] as const
    for (const s of states) {
      wallet.handlers.bdx_getOperationStatus = () => s
      expect(await bdx.getOperationStatus('op-1')).toEqual(s)
    }
    expect(wallet.calls.every(c => c.method === 'bdx_getOperationStatus')).toBe(true)
  })

  it('sendTransactionSafe resolves a timed-out send via idempotent replay — one payment', async () => {
    const fast = new BeldexWeb3(wallet.provider, { approvalTimeoutMs: 30 })
    let approvals = 0
    const seenKeys = new Set<string>()
    wallet.handlers.bdx_sendTransaction = (p) => {
      const key = (p as { idempotencyKey: string }).idempotencyKey
      seenKeys.add(key)
      if (approvals === 0) { approvals++; return hang() }      // 1st: approved+executing, reply lost
      // retry with same key: wallet replays the recorded outcome, no 2nd approval
      return { txHash: MOCK_TXHASH, fee: '5', operationId: 'op-9', idempotent: true }
    }
    const r = await fast.sendTransactionSafe(
      { to: MOCK_ADDRESS, amount: 1n },
      { resolveTimeoutMs: 2_000, pollIntervalMs: 10 }
    )
    expect(r).toMatchObject({ status: 'confirmed', txHash: MOCK_TXHASH, idempotent: true, operationId: 'op-9' })
    expect(approvals).toBe(1)        // exactly one approved transaction
    expect(seenKeys.size).toBe(1)    // every attempt reused the same key
  })

  it('sendTransactionSafe waits out "already in progress" then surfaces the confirmation', async () => {
    let calls = 0
    wallet.handlers.bdx_sendTransaction = () => {
      calls++
      if (calls <= 2) throw new RpcHandlerError(-32603, 'a transaction for this idempotency key is already in progress')
      return { txHash: MOCK_TXHASH, fee: '5', operationId: 'op-3', idempotent: true }
    }
    const r = await bdx.sendTransactionSafe(
      { to: MOCK_ADDRESS, amount: 1n, idempotencyKey: 'resume-key-1' },
      { resolveTimeoutMs: 2_000, pollIntervalMs: 5 }
    )
    expect(r.status).toBe('confirmed')
    expect(calls).toBe(3)
  })

  it('sendTransactionSafe returns unresolved (with the key) when the outcome stays unknown', async () => {
    const fast = new BeldexWeb3(wallet.provider, { approvalTimeoutMs: 20 })
    wallet.handlers.bdx_sendTransaction = hang
    const r = await fast.sendTransactionSafe(
      { to: MOCK_ADDRESS, amount: 1n, idempotencyKey: 'resume-key-2' },
      { resolveTimeoutMs: 150, pollIntervalMs: 10 }
    )
    expect(r).toEqual({ status: 'unresolved', idempotencyKey: 'resume-key-2' })
  })

  it('sendTransactionSafe rethrows terminal errors (user rejection)', async () => {
    wallet.handlers.bdx_sendTransaction = () => { throw new RpcHandlerError(4001, 'rejected') }
    await expect(bdx.sendTransactionSafe({ to: MOCK_ADDRESS, amount: 1n }))
      .rejects.toMatchObject({ code: 4001 })
    expect(wallet.calls).toHaveLength(1) // no retry storm on a real "no"
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
    ['bad idempotencyKey', () => bdx.sendTransaction({ to: MOCK_ADDRESS, amount: 1n, idempotencyKey: 'has spaces!' })],
    ['empty operationId', () => bdx.getOperationStatus('')],
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
