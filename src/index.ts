// bdx-web3js — SDK for the Beldex Wallet browser extension.
// Wire protocol: see PROTOCOL.md (protocolVersion 1).

export { BeldexWeb3, buildAuthChallenge } from './client.js'
export type { BeldexWeb3Options } from './client.js'
export { detectProvider } from './provider.js'
export type { DetectOptions } from './provider.js'
export { PostMessageProvider } from './transport.js'
export type { PostMessageProviderOptions } from './transport.js'
export { BdxRpcError, ERROR_CODES, toBdxError } from './errors.js'
export type { ErrorCode } from './errors.js'
export { toAtomic, fromAtomic, parseAtomic, ATOMIC_PER_BDX, BDX_DECIMALS } from './units.js'
export { checkAddress, isValidAddressShape } from './address.js'
export type { AddressCheck, AddressKind } from './address.js'
export * from './types.js'
