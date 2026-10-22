// Offline, format-only validation of Beldex addresses — mainnet AND testnet.
//
// This checks SHAPE (base58 alphabet, network prefix, plausible length) — it
// does NOT verify the embedded checksum or prove the address is spendable.
// Full validation requires the wallet's crypto core; the wallet re-validates
// every address it is asked to send to.
//
// Network prefixes are consensus constants (beldex core / the wallet's
// addressForNettype encoder): mainnet standard varint 209 → base58 text
// leading "bx"; testnet standard 53 → leading '9'–'A', integrated → 'A',
// subaddress → 'B'. Shapes derived from the varint+keys+checksum byte layout:
//
//              standard/subaddress      integrated (embeds 8-byte payment ID)
//   mainnet    'bx…'  ~95–99 chars      'bx…'  ~104–110 chars
//   testnet    '9'|'A'|'B' ~93–97       'A…'   ~102–108

import type { Nettype } from './types.js'

const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/ // Monero/Bitcoin base58: no 0 O I l

const MAIN_STANDARD_MIN = 95
const MAIN_STANDARD_MAX = 99
const MAIN_INTEGRATED_MIN = 104
const MAIN_INTEGRATED_MAX = 110

const TEST_STANDARD_MIN = 93
const TEST_STANDARD_MAX = 97
const TEST_INTEGRATED_MIN = 102
const TEST_INTEGRATED_MAX = 108

export type AddressKind = 'standard' | 'integrated'

export interface AddressCheck {
  valid: boolean
  /** Present when valid. 'standard' covers subaddresses too (format-identical). */
  kind?: AddressKind
  /** Present when valid: which chain the prefix belongs to. */
  network?: Nettype
  reason?: string
}

/**
 * Shape-check an address. With `expectedNetwork`, an address whose prefix
 * belongs to the OTHER chain is invalid — catching a testnet address pasted
 * into a mainnet dapp (and vice versa) before it ever reaches the wallet.
 */
export function checkAddress(address: string, expectedNetwork?: Nettype): AddressCheck {
  if (typeof address !== 'string' || address.length === 0) {
    return { valid: false, reason: 'empty' }
  }
  const s = address.trim()
  if (!BASE58_RE.test(s)) return { valid: false, reason: 'contains non-base58 characters' }

  let network: Nettype
  if (s.startsWith('bx')) {
    network = 'mainnet'
  } else if ('9AB'.includes(s[0]!)) {
    network = 'testnet'
  } else {
    return { valid: false, reason: 'unrecognized network prefix (mainnet "bx…", testnet "9…"/"A…"/"B…")' }
  }
  if (expectedNetwork !== undefined && network !== expectedNetwork) {
    return { valid: false, reason: `${network} address, but the wallet is on ${expectedNetwork}` }
  }

  const [stdMin, stdMax, intMin, intMax] = network === 'mainnet'
    ? [MAIN_STANDARD_MIN, MAIN_STANDARD_MAX, MAIN_INTEGRATED_MIN, MAIN_INTEGRATED_MAX]
    : [TEST_STANDARD_MIN, TEST_STANDARD_MAX, TEST_INTEGRATED_MIN, TEST_INTEGRATED_MAX]

  if (s.length >= stdMin && s.length <= stdMax) return { valid: true, kind: 'standard', network }
  if (s.length >= intMin && s.length <= intMax) return { valid: true, kind: 'integrated', network }
  return { valid: false, reason: `unexpected length ${s.length} for a ${network} address` }
}

/** Convenience boolean form of checkAddress(). */
export function isValidAddressShape(address: string, expectedNetwork?: Nettype): boolean {
  return checkAddress(address, expectedNetwork).valid
}
