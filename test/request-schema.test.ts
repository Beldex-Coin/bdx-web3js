// Structural/size gate vectors — client-side mirror of the wallet's
// per-method request schemas. Violations must throw typed errors and never
// produce a wire call.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { sanitizeRequestParams, MAX_PARAM_KEYS } from '../src/request-schema.js'
import { BeldexWeb3 } from '../src/client.js'
import { ERROR_CODES } from '../src/errors.js'
import { MockWallet, MOCK_ADDRESS } from './mock-wallet.js'
import type { BdxMethod } from '../src/types.js'

const INVALID = ERROR_CODES.INVALID_PARAMS

describe('sanitizeRequestParams', () => {
  const expectThrow = (fn: () => unknown, match?: RegExp) => {
    try {
      fn()
    } catch (e) {
      expect((e as { code: number }).code).toBe(INVALID)
      if (match) expect((e as Error).message).toMatch(match)
      return
    }
    throw new Error('expected a -32602 throw')
  }

  it('no-parameter methods reject any own key', () => {
    const noParam: BdxMethod[] = [
      'bdx_connect', 'bdx_disconnect', 'bdx_getState',
      'bdx_getNetwork', 'bdx_getAddress', 'bdx_getBalance'
    ]
    for (const m of noParam) {
      expect(sanitizeRequestParams(m)).toBeUndefined()
      expect(sanitizeRequestParams(m, {})).toEqual({})
      expectThrow(() => sanitizeRequestParams(m, { sneaky: 1 }), /takes no parameters/)
    }
  })

  it('oversized string fields are rejected at the exact cap', () => {
    expect(sanitizeRequestParams('bdx_resolveBns', { name: 'x'.repeat(64) })).toBeTruthy()
    expectThrow(() => sanitizeRequestParams('bdx_resolveBns', { name: 'x'.repeat(65) }), /64/)
    expectThrow(() => sanitizeRequestParams('bdx_verifyMessage', {
      message: 'x'.repeat(8193), address: 'a', signature: 's'
    }), /8192/)
    expectThrow(() => sanitizeRequestParams('bdx_getOperationStatus', { operationId: 'x'.repeat(129) }), /128/)
  })

  it('unknown fields are rejected, never forwarded', () => {
    expectThrow(() => sanitizeRequestParams('bdx_sendTransaction', {
      to: MOCK_ADDRESS, amount: '1', memo: 'hi'
    }), /unknown field "memo"/)
  })

  it('non-primitive field values are rejected', () => {
    expectThrow(() => sanitizeRequestParams('bdx_signMessage', { message: { nested: true } }))
    expectThrow(() => sanitizeRequestParams('bdx_signMessage', { message: ['a'] }))
    expectThrow(() => sanitizeRequestParams('bdx_sendTransaction', { to: MOCK_ADDRESS, amount: 1 as never }))
  })

  it('JSON __proto__/constructor payloads are rejected as unrecognized fields', () => {
    const evil = JSON.parse('{"message":"hi","__proto__":{"polluted":true}}')
    expectThrow(() => sanitizeRequestParams('bdx_signMessage', evil), /unknown field "__proto__"/)
    expectThrow(() => sanitizeRequestParams('bdx_signMessage',
      JSON.parse('{"message":"hi","constructor":1}')), /unknown field "constructor"/)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined() // nothing leaked
  })

  it('caps the number of params keys', () => {
    const many: Record<string, string> = {}
    for (let i = 0; i <= MAX_PARAM_KEYS; i++) many[`k${i}`] = 'v'
    expectThrow(() => sanitizeRequestParams('bdx_sendTransaction', many), /too many/)
  })

  it('missing required fields and bad shapes are rejected', () => {
    expectThrow(() => sanitizeRequestParams('bdx_getOperationStatus', {}), /required/)
    expectThrow(() => sanitizeRequestParams('bdx_resolveBns'), /required/)
    expectThrow(() => sanitizeRequestParams('bdx_signMessage', ['a'] as never), /plain object/)
    expectThrow(() => sanitizeRequestParams('bdx_signAuthChallenge', { nonce: 'n'.repeat(16), expiresInMs: Infinity }), /finite/)
  })

  it('unknown methods are -32601', () => {
    try {
      sanitizeRequestParams('bdx_nope' as BdxMethod)
      throw new Error('expected throw')
    } catch (e) {
      expect((e as { code: number }).code).toBe(ERROR_CODES.METHOD_NOT_FOUND)
    }
  })

  it('valid params come back as a FRESH object with only recognized fields', () => {
    const input = { to: MOCK_ADDRESS, amount: '100', sweep: false }
    const out = sanitizeRequestParams('bdx_sendTransaction', input)
    expect(out).not.toBe(input)
    expect(out).toEqual(input)
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
  })
})

describe('client request path is gated before dispatch', () => {
  let wallet: MockWallet
  let bdx: BeldexWeb3

  beforeEach(() => {
    wallet = new MockWallet()
    bdx = new BeldexWeb3(wallet.provider)
  })
  afterEach(() => wallet.destroy())

  it('violations never reach the provider', async () => {
    await expect(bdx.request('bdx_connect', { extra: 1 })).rejects.toMatchObject({ code: INVALID })
    await expect(bdx.request('bdx_resolveBns', { name: 'x'.repeat(65) })).rejects.toMatchObject({ code: INVALID })
    await expect(bdx.request('bdx_signMessage', { message: 'hi', mode: 'raw' })).rejects.toMatchObject({ code: INVALID })
    expect(wallet.calls).toHaveLength(0)
  })

  it('happy paths still flow (only recognized fields on the wire)', async () => {
    await bdx.connect()
    await bdx.getBalance()
    await bdx.resolveBns('shop.bdx')
    expect(wallet.calls.map(c => c.method))
      .toEqual(['bdx_connect', 'bdx_getBalance', 'bdx_resolveBns'])
  })
})
