import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PostMessageProvider } from '../src/transport.js'
import { RESPONSE_TARGET } from '../src/types.js'
import { BdxRpcError } from '../src/errors.js'
import { MockWallet, MOCK_ADDRESS, RpcHandlerError, postToPage } from './mock-wallet.js'

let wallet: MockWallet
let provider: PostMessageProvider

beforeEach(() => {
  wallet = new MockWallet()
  wallet.attachRelay()
  provider = new PostMessageProvider({ requestTimeoutMs: 500 })
})

afterEach(() => {
  provider.destroy()
  wallet.destroy()
})

describe('PostMessageProvider over raw envelopes', () => {
  it('round-trips a request', async () => {
    const r = await provider.request({ method: 'bdx_getAddress' })
    expect(r).toEqual({ address: MOCK_ADDRESS })
    expect(wallet.calls[0]!.method).toBe('bdx_getAddress')
  })

  it('passes params through', async () => {
    await provider.request({ method: 'bdx_resolveBns', params: { name: 'shop.bdx' } })
    expect(wallet.calls[0]!.params).toEqual({ name: 'shop.bdx' })
  })

  it('rejects with BdxRpcError on wallet error', async () => {
    wallet.handlers.bdx_getBalance = () => { throw new RpcHandlerError(4100, 'unauthorized') }
    await expect(provider.request({ method: 'bdx_getBalance' }))
      .rejects.toMatchObject({ code: 4100, message: 'unauthorized' })
  })

  it('times out unanswered requests with 4999', async () => {
    wallet.destroy() // nobody listening
    const p = provider.request({ method: 'bdx_getState' })
    await expect(p).rejects.toBeInstanceOf(BdxRpcError)
    await expect(p.catch((e: BdxRpcError) => e.code)).resolves.toBe(4999)
  })

  it('an aborted signal cancels the pending request immediately', async () => {
    wallet.destroy() // nobody will ever answer
    const ac = new AbortController()
    const p = provider.request({ method: 'bdx_getState', signal: ac.signal })
    ac.abort()
    await expect(p).rejects.toMatchObject({ code: 4999, message: 'request aborted' })
  })

  it('a pre-aborted signal rejects without posting anything', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(provider.request({ method: 'bdx_getState', signal: ac.signal }))
      .rejects.toMatchObject({ code: 4999 })
    expect(wallet.calls).toHaveLength(0)
  })

  it('delivers events to listeners and supports off()', async () => {
    const seen: unknown[] = []
    const fn = (d: unknown) => seen.push(d)
    provider.on('balanceChanged', fn)
    wallet.emit('balanceChanged', { total: '1', unlocked: '1', height: 5 })
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toEqual([{ total: '1', unlocked: '1', height: 5 }])
    provider.off('balanceChanged', fn)
    wallet.emit('balanceChanged', { total: '2', unlocked: '2', height: 6 })
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toHaveLength(1)
  })

  it('a broken listener does not break delivery to others', async () => {
    const seen: unknown[] = []
    provider.on('lock', () => { throw new Error('bad listener') })
    provider.on('lock', d => seen.push(d))
    wallet.emit('lock', {})
    await new Promise(r => setTimeout(r, 10))
    expect(seen).toHaveLength(1)
  })
})

describe('malformed-message fuzzing', () => {
  it('drops garbage without throwing or resolving pending requests', async () => {
    wallet.delayMs = 100 // keep one request pending while we fuzz
    const pending = provider.request({ method: 'bdx_getAddress' })

    const garbage: unknown[] = [
      null, 42, 'string', [], {},
      { target: 'wrong-target', id: 'x', result: 1 },
      { target: RESPONSE_TARGET },                                  // no id/event
      { target: RESPONSE_TARGET, id: 12345, result: 1 },            // non-string id
      { target: RESPONSE_TARGET, id: 'unknown-id', result: 'sto' }, // stale id
      { target: RESPONSE_TARGET, event: 'evil-event', data: 1 },    // unknown event
      { target: RESPONSE_TARGET, event: 42 },
      { target: RESPONSE_TARGET, id: 'unknown', error: 'not-an-object' }
    ]
    for (const g of garbage) postToPage(g)

    // The legitimate pending request still resolves correctly afterwards.
    await expect(pending).resolves.toEqual({ address: MOCK_ADDRESS })
  })

  it('a malformed error object does not settle the request wrongly', async () => {
    // Relay that answers with a bad error shape, then a good result.
    wallet.destroy()
    const bad = new MockWallet()
    const onMsg = (ev: MessageEvent) => {
      const m = ev.data
      if (m?.target !== 'beldex-contentscript') return
      postToPage({ target: RESPONSE_TARGET, id: m.id, error: 'oops' })
      setTimeout(() => postToPage({ target: RESPONSE_TARGET, id: m.id, result: { ok: 1 } }), 20)
    }
    window.addEventListener('message', onMsg)
    try {
      await expect(provider.request({ method: 'bdx_getState' })).resolves.toEqual({ ok: 1 })
    } finally {
      window.removeEventListener('message', onMsg)
      bad.destroy()
    }
  })

  it('destroy() rejects in-flight requests', async () => {
    wallet.delayMs = 1000
    const p = provider.request({ method: 'bdx_getAddress' })
    provider.destroy()
    await expect(p).rejects.toMatchObject({ code: -32603 })
  })
})
