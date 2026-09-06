// Wire + public types, transcribed from PROTOCOL.md (protocolVersion 1).
// PROTOCOL.md is normative; if this file and the spec disagree, the spec wins.

// ---------------------------------------------------------------- methods ----

export type BdxMethod =
  | 'bdx_connect'
  | 'bdx_disconnect'
  | 'bdx_getAddress'
  | 'bdx_getBalance'
  | 'bdx_sendTransaction'
  | 'bdx_signMessage'
  | 'bdx_verifyMessage'
  | 'bdx_resolveBns'
  | 'bdx_getNetwork'
  | 'bdx_getState'

export type BdxEvent =
  | 'connect'
  | 'disconnect'
  | 'accountsChanged'
  | 'networkChanged'
  | 'balanceChanged'
  | 'lock'
  | 'unlock'

export type Nettype = 'mainnet' | 'testnet'

// -------------------------------------------------------------- envelopes ----

export const REQUEST_TARGET = 'beldex-contentscript'
export const RESPONSE_TARGET = 'beldex-inpage'

export interface RpcRequest {
  target: typeof REQUEST_TARGET
  id: string
  method: BdxMethod
  params?: object
}

export interface RpcErrorShape {
  code: number
  message: string
}

export interface RpcResponse {
  target: typeof RESPONSE_TARGET
  id: string
  result?: unknown
  error?: RpcErrorShape
}

export interface RpcEventMessage {
  target: typeof RESPONSE_TARGET
  event: BdxEvent
  data?: unknown
}

// -------------------------------------------------- method params/results ----

export interface ConnectResult {
  address: string
  network: Nettype
}

/** Server-issued challenge for `connectWithProof()` — issue the nonce
 *  server-side, single-use, bound to the session that requested it. */
export interface AuthChallenge {
  /** Server-generated random nonce (8–128 chars of `A-Za-z0-9._-`).
   *  The server MUST track it and consume it atomically on verification. */
  nonce: string
  /** Optional opaque request/session id, echoed into the signed message. */
  requestId?: string
  /** Proof validity window; default 300 000 ms. */
  expiresInMs?: number
}

/** Ownership proof produced by `connectWithProof()` — the wallet signs a
 *  domain-bound `beldex-auth-v1` statement right after connecting. */
export interface ConnectProof {
  /** The exact signed statement (single line):
   *  `beldex-auth-v1 domain=… uri=… address=… network=… nonce=… iat=… exp=…[ rid=…]` */
  message: string
  /** "SigV1…" signature over `message` (PROTOCOL.md §4.6). */
  signature: string
  /** Signing wallet's primary address (== the connected address). */
  address: string
  /** Requesting page's origin at signing time (audience binding). */
  domain: string
  /** Requesting page's origin + path at signing time. */
  uri: string
  network: Nettype
  /** Server nonce if a challenge was supplied, else 16 random bytes hex. */
  nonce: string
  /** Unix ms when the statement was built. */
  issuedAt: number
  /** Unix ms after which verifiers MUST reject the proof. */
  expirationTime: number
  requestId?: string
  /** true when the nonce came from a server-issued `AuthChallenge` —
   *  only such proofs are suitable for authentication. */
  serverIssued: boolean
}

export interface ConnectWithProofResult extends ConnectResult {
  /** null when the user approved the connection but rejected the signature
   *  (only possible with `required: false`). */
  proof: ConnectProof | null
}

export interface GetAddressResult {
  address: string
}

/** Raw wire shape — amounts are strings of atomic units (1 BDX = 1e9). */
export interface GetBalanceResult {
  total: string
  unlocked: string
  approximate: boolean
  height: number
}

/** SDK-facing shape: amounts parsed to BigInt. */
export interface Balance {
  total: bigint
  unlocked: bigint
  approximate: boolean
  height: number
}

export interface SendTransactionParams {
  /** Beldex address (standard | integrated | subaddress). BNS names are NOT
   *  accepted here — resolve them first via resolveBns() so the user approves
   *  a concrete address. */
  to: string
  /** Atomic units. bigint, or an integer string of atomic units. Use
   *  toAtomic('1.25') to convert display BDX. Required unless sweep. */
  amount?: bigint | string
  /** 1 (default) … 5 = flash (instant). */
  priority?: 1 | 2 | 3 | 4 | 5
  /** Hex, 16 or 64 chars. Only for non-integrated addresses. */
  paymentId?: string
  /** Send entire spendable balance; `amount` must be absent. */
  sweep?: boolean
}

export interface SendTransactionResult {
  txHash: string
  /** Atomic units actually paid as fee. */
  fee: string
}

export interface SignMessageResult {
  signature: string
  address: string
}

export interface VerifyMessageParams {
  message: string
  address: string
  signature: string
}

export interface VerifyMessageResult {
  valid: boolean
}

export interface ResolveBnsResult {
  name: string
  address: string
  /** Always false in v1: resolution trusts the wallet's configured HTTPS
   *  resolver, not an on-chain proof. Display the address to the user. */
  verified: false
}

export interface GetNetworkResult {
  nettype: Nettype
  height: number
  protocolVersion: number
  walletVersion: string
}

export type WalletState = 'locked' | 'unlocked' | 'no-wallet'

export interface GetStateResult {
  state: WalletState
}

// ----------------------------------------------------------- event payloads --

export interface ConnectEventData {
  address: string
  network: string
}

export interface AccountsChangedEventData {
  /** null after a wallet switch: the new wallet requires a fresh connect(). */
  address: string | null
}

export interface NetworkChangedEventData {
  nettype: string
}

export interface BalanceChangedEventData {
  total: string
  unlocked: string
  height: number
}

// ---------------------------------------------------------------- provider ---

export interface BeldexProviderInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface BeldexProvider {
  request(args: { method: BdxMethod; params?: object }): Promise<unknown>
  on(event: BdxEvent, listener: (data: unknown) => void): void
  off(event: BdxEvent, listener: (data: unknown) => void): void
  readonly isBeldex: true
}

export interface AnnounceProviderDetail {
  info: BeldexProviderInfo
  provider: BeldexProvider
}

export const REQUEST_PROVIDER_EVENT = 'beldex:requestProvider'
export const ANNOUNCE_PROVIDER_EVENT = 'beldex:announceProvider'
