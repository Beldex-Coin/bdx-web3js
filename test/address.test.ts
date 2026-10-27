import { describe, it, expect } from 'vitest'
import { checkAddress, isValidAddressShape } from '../src/address.js'
import { MOCK_ADDRESS } from './mock-wallet.js'

const b58 = (n: number) => 'V'.repeat(n)
// Shape-plausible testnet addresses (prefix 53/54 → leading 9/A/B).
const TEST_STANDARD = '9' + b58(94)      // 95 chars
const TEST_SUBADDR = 'B' + b58(94)       // 95 chars
const TEST_INTEGRATED = 'A' + b58(105)   // 106 chars

describe('checkAddress', () => {
  it('accepts standard-length bx (mainnet) addresses', () => {
    expect(checkAddress(MOCK_ADDRESS)).toEqual({ valid: true, kind: 'standard', network: 'mainnet' })
    expect(checkAddress('bx' + b58(93))).toEqual({ valid: true, kind: 'standard', network: 'mainnet' }) // 95
    expect(checkAddress('bx' + b58(95))).toEqual({ valid: true, kind: 'standard', network: 'mainnet' }) // 97
  })

  it('accepts integrated-length mainnet addresses', () => {
    expect(checkAddress('bx' + b58(104))).toEqual({ valid: true, kind: 'integrated', network: 'mainnet' }) // 106
  })

  it('accepts testnet shapes (9/A/B prefixes)', () => {
    expect(checkAddress(TEST_STANDARD)).toEqual({ valid: true, kind: 'standard', network: 'testnet' })
    expect(checkAddress(TEST_SUBADDR)).toEqual({ valid: true, kind: 'standard', network: 'testnet' })
    expect(checkAddress(TEST_INTEGRATED)).toEqual({ valid: true, kind: 'integrated', network: 'testnet' })
  })

  it('enforces expectedNetwork: cross-chain addresses are invalid', () => {
    expect(checkAddress(MOCK_ADDRESS, 'mainnet').valid).toBe(true)
    expect(checkAddress(TEST_STANDARD, 'testnet').valid).toBe(true)
    const wrong = checkAddress(TEST_STANDARD, 'mainnet')
    expect(wrong.valid).toBe(false)
    expect(wrong.reason).toMatch(/testnet address.*mainnet/)
    expect(checkAddress(MOCK_ADDRESS, 'testnet').valid).toBe(false)
  })

  it('rejects bad shapes', () => {
    expect(checkAddress('').valid).toBe(false)
    expect(checkAddress('T6' + b58(93)).valid).toBe(false)          // unknown prefix
    expect(checkAddress('bx' + 'O'.repeat(93)).valid).toBe(false)   // 'O' not base58
    expect(checkAddress('bx' + b58(93) + '0').valid).toBe(false)    // '0' not base58
    expect(checkAddress('bx' + b58(50)).valid).toBe(false)          // too short
    expect(checkAddress('bx' + b58(150)).valid).toBe(false)         // too long
    expect(checkAddress('9' + b58(50)).valid).toBe(false)           // testnet too short
    expect(checkAddress('A' + b58(150)).valid).toBe(false)          // testnet too long
  })

  it('boolean helper agrees, including the network argument', () => {
    expect(isValidAddressShape(MOCK_ADDRESS)).toBe(true)
    expect(isValidAddressShape('nope')).toBe(false)
    expect(isValidAddressShape(TEST_STANDARD, 'mainnet')).toBe(false)
  })
})
