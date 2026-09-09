// BeldexWeb3 — the typed client dapps use. Wraps any BeldexProvider (the
// extension's injected one, or a PostMessageProvider) with:
//   · typed methods for every protocol call
//   · per-method timeouts (30 s auto-answered, 5 min approval-gated)
//   · BigInt-parsed balances, atomic-string amounts on the wire
//   · normalized BdxRpcError errors
//   · EventEmitter-style protocol events + cached connection state

import type {
  AccountsChangedEventData, Balance, BdxEvent, BdxMethod, BeldexProvider,
  AuthChallenge, ConnectEventData, ConnectProof, ConnectResult,
  ConnectWithProofResult, GetAddressResult, GetBalanceResult, Nettype,
  OperationStatus, SafeSendResult, SignAuthChallengeParams, SignAuthChallengeResult,
  GetNetworkResult, GetStateResult, ResolveBnsResult, SendTransactionParams,
  SendTransactionResult, SignMessageResult, VerifyMessageParams,
  VerifyMessageResult, WalletState
} from './types.js'
import { BdxRpcError, ERROR_CODES, toBdxError } from './errors.js'
import { validateSigningText } from './signing-policy.js'
import { sanitizeRequestParams } from './request-schema.js'
import { parseAtomic } from './units.js'
import { checkAddress } from './address.js'

const APPROVAL_METHODS: ReadonlySet<BdxMethod> = new Set([
  'bdx_connect', 'bdx_sendTransaction', 'bdx_signMessage', 'bdx_signAuthChallenge'
])

/** Approval methods that MUTATE chain state. A local timeout on these means
 *  "we stopped waiting", not "nothing happened" — the wallet may still be
 *  broadcasting. They reject with UNKNOWN_OUTCOME instead of REQUEST_EXPIRED. */
const MUTATING_METHODS: ReadonlySet<BdxMethod> = new Set(['bdx_sendTransaction'])

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9._-]{8,128}$/

// ------------------------------------------------------------- auth proof ----
// Single-line on purpose: the wallet rejects control characters (incl. \n),
// so a SIWE-style multi-line statement can never pass its approval filter.

const AUTH_VERSION = 'beldex-auth-v1'
const DEFAULT_PROOF_TTL_MS = 300_000
/** Server nonces: opaque but wire-safe — no spaces, no control chars. */
const SERVER_NONCE_RE = /^[A-Za-z0-9._-]{8,128}$/

export interface AuthMessageFields {
  domain: string
  uri: string
  address: string
  network: Nettype
  nonce: string
  issuedAt: number
  expirationTime: number
  requestId?: string
}

/** Build the exact `beldex-auth-v1` statement `connectWithProof()` signs.
 *  Exported so server-side verifiers can rebuild it from stored fields. */
export function buildAuthChallenge(f: AuthMessageFields): string {
  const parts = [
    AUTH_VERSION,
    `domain=${f.domain}`, `uri=${f.uri}`, `address=${f.address}`,
    `network=${f.network}`, `nonce=${f.nonce}`,
    `iat=${f.issuedAt}`, `exp=${f.expirationTime}`
  ]
  if (f.requestId !== undefined) parts.push(`rid=${f.requestId}`)
  for (const p of parts) {
    // Fields are single tokens (no whitespace) AND must individually satisfy
    // signing-text policy v1 — same classes the wallet rejects (§4.6/§4.6a).
    const v = validateSigningText(p)
    if (/\s/.test(p) || !v.ok) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS,
        `auth field "${p.split('=')[0]}" invalid: ${!v.ok ? (v as { reason: string }).reason : 'contains whitespace'}`)
    }
  }
  const message = parts.join(' ')
  const mv = validateSigningText(message)
  if (!mv.ok) throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, `auth statement invalid: ${mv.reason}`)
  return message
}

/** Parse a `beldex-auth-v1` statement back into fields (null if malformed).
 *  Verifiers MUST also check domain === their own origin, address, network,
 *  nonce (issued by them, unused), and the iat/exp window. */
export function parseAuthChallenge(message: string): AuthMessageFields | null {
  const parts = message.split(' ')
  if (parts[0] !== AUTH_VERSION) return null
  const kv: Record<string, string> = {}
  for (const p of parts.slice(1)) {
    const i = p.indexOf('=')
    if (i <= 0) return null
    kv[p.slice(0, i)] = p.slice(i + 1)
  }
  const { domain, uri, address, network, nonce, iat, exp, rid } = kv
  if (!domain || !uri || !address || !nonce || (network !== 'mainnet' && network !== 'testnet')) return null
  const issuedAt = Number(iat), expirationTime = Number(exp)
  if (!Number.isInteger(issuedAt) || !Number.isInteger(expirationTime)) return null
  return {
    domain, uri, address, network, nonce, issuedAt, expirationTime,
    ...(rid !== undefined ? { requestId: rid } : {})
  }
}

/** 16 random bytes as 32 hex chars (web crypto — browsers and Node ≥18). */
function randomNonceHex(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  let s = ''
  for (const x of b) s += x.toString(16).padStart(2, '0')
  return s
}

export interface BeldexWeb3Options {
  /** Timeout for auto-answered methods. Default 30 000 ms. */
  readTimeoutMs?: number
  /** Timeout for approval-gated methods. Default 300 000 ms (wallet TTL). */
  approvalTimeoutMs?: number
}

export class BeldexWeb3 {
  readonly provider: BeldexProvider

  private readonly readTimeoutMs: number
  private readonly approvalTimeoutMs: number
  private cachedAddress: string | null = null
  /** Our listeners keyed by event, mapping user fn → wrapped fn (for off()). */
  private readonly subs = new Map<BdxEvent, Map<(data: never) => void, (data: unknown) => void>>()

  constructor(provider: BeldexProvider, opts: BeldexWeb3Options = {}) {
    if (!provider || provider.isBeldex !== true) {
      throw new TypeError('BeldexWeb3 requires a Beldex provider (see detectProvider())')
    }
    this.provider = provider
    this.readTimeoutMs = opts.readTimeoutMs ?? 30_000
    this.approvalTimeoutMs = opts.approvalTimeoutMs ?? 300_000

    // Keep cached state truthful regardless of user subscriptions.
    provider.on('accountsChanged', data => {
      this.cachedAddress = (data as AccountsChangedEventData | undefined)?.address ?? null
    })
    provider.on('disconnect', () => { this.cachedAddress = null })
    provider.on('connect', data => {
      const d = data as ConnectEventData | undefined
      if (d && typeof d.address === 'string') this.cachedAddress = d.address
    })
  }

  // ---------------------------------------------------------------- core ----

  /** Raw protocol call with an application deadline (AbortController-backed
   *  cancellation + race fallback) and error normalization. Approval methods
   *  get the long budget (a human is deciding); reads the short one. */
  async request<T>(method: BdxMethod, params?: object): Promise<T> {
    // Structural/size gate (mirror of the wallet's): validates against the
    // per-method schema and rebuilds params as a fresh object holding ONLY
    // recognized fields — oversized/unknown/no-param violations throw here
    // and never reach the provider.
    params = sanitizeRequestParams(method, params)
    const timeoutMs = APPROVAL_METHODS.has(method) ? this.approvalTimeoutMs : this.readTimeoutMs
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // Reject FIRST (correct error category wins the race), then abort so a
        // signal-aware transport actually cancels and drops the pending id.
        reject(MUTATING_METHODS.has(method)
          ? new BdxRpcError(ERROR_CODES.UNKNOWN_OUTCOME,
            `${method} timed out after ${timeoutMs}ms — outcome UNKNOWN: the wallet may still execute it. ` +
            'Do not blind-retry; use sendTransactionSafe()/getOperationStatus() or retry with the same idempotencyKey.')
          : new BdxRpcError(ERROR_CODES.REQUEST_EXPIRED, `${method} timed out after ${timeoutMs}ms`))
        controller.abort()
      }, timeoutMs)
    })
    try {
      const call = this.provider.request({
        method,
        ...(params !== undefined ? { params } : {}),
        signal: controller.signal
      })
      // The transport's post-abort rejection must not surface as unhandled.
      call.catch(() => {})
      return (await Promise.race([call, timeout])) as T
    } catch (e) {
      throw toBdxError(e)
    } finally {
      clearTimeout(timer)
    }
  }

  // ------------------------------------------------------------- methods ----

  /** Request access. Idempotent once granted. Opens the wallet's approval UI. */
  async connect(): Promise<ConnectResult> {
    const r = await this.request<ConnectResult>('bdx_connect')
    this.cachedAddress = r.address
    return r
  }

  /**
   * Connect, then immediately ask the wallet to sign a domain-bound ownership
   * statement (two approvals: connect, then signature):
   *
   *   `beldex-auth-v1 domain=<origin> uri=<origin+path> address=<addr>
   *    network=<net> nonce=<nonce> iat=<ms> exp=<ms>[ rid=<id>]`
   *
   * The page's own origin is baked into the signed bytes, so a proof obtained
   * by site A is rejected by any verifier that checks `domain` — proofs are
   * not transferable across relying parties.
   *
   * - For **authentication**, pass a server-issued `challenge` — the server
   *   generates the nonce, tracks it, verifies every field of the returned
   *   message (domain, address, network, nonce it issued, iat/exp window),
   *   and consumes the nonce atomically. `proof.serverIssued` is true.
   * - Without a challenge the SDK self-generates the nonce: still
   *   domain-bound, fine as a liveness/ownership signal, but a verifier
   *   cannot know the statement was made for *its* session — do not accept
   *   such proofs for login.
   * - `required: true` (default): connection and proof are all-or-nothing — a
   *   rejected signature disconnects again and rethrows the 4001.
   *   `required: false`: a rejected signature resolves with `proof: null`.
   *
   * The statement is composed and signed BY THE WALLET (`bdx_signAuthChallenge`,
   * wallet v1.2+) from the origin it observes via the browser — the page never
   * supplies the statement text, and the SDK's `signMessage()` rejects the
   * reserved `beldex-auth-v1` prefix, so a proof cannot be forged through
   * generic message signing. Verifiers MUST still do full field checks
   * server-side via `bdx_verifyMessage`.
   */
  async connectWithProof(
    opts: { challenge?: AuthChallenge; required?: boolean } = {}
  ): Promise<ConnectWithProofResult> {
    const required = opts.required ?? true
    if (opts.challenge && !SERVER_NONCE_RE.test(opts.challenge.nonce)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'challenge.nonce must be 8–128 chars of A-Za-z0-9._-')
    }
    const { address, network } = await this.connect()
    const nonce = opts.challenge?.nonce ?? randomNonceHex()
    try {
      const s = await this.signAuthChallenge({
        nonce,
        expiresInMs: opts.challenge?.expiresInMs ?? DEFAULT_PROOF_TTL_MS,
        ...(opts.challenge?.requestId !== undefined ? { requestId: opts.challenge.requestId } : {})
      })
      // Trust but verify the wallet's statement before handing it to a caller.
      const f = parseAuthChallenge(s.message)
      if (!f || s.address !== address || f.address !== address || f.nonce !== nonce) {
        throw new BdxRpcError(ERROR_CODES.INTERNAL, 'wallet returned an inconsistent auth statement')
      }
      const proof: ConnectProof = {
        message: s.message, signature: s.signature, address: s.address,
        domain: f.domain, uri: f.uri, network: f.network, nonce,
        issuedAt: f.issuedAt, expirationTime: f.expirationTime,
        serverIssued: !!opts.challenge,
        ...(f.requestId !== undefined ? { requestId: f.requestId } : {})
      }
      return { address, network, proof }
    } catch (e) {
      if (BdxRpcError.isUserRejection(e) && !required) {
        return { address, network, proof: null }
      }
      if (required) await this.disconnect().catch(() => {})
      if (e instanceof BdxRpcError && e.code === ERROR_CODES.METHOD_NOT_FOUND) {
        throw new BdxRpcError(ERROR_CODES.METHOD_NOT_FOUND,
          'wallet does not support bdx_signAuthChallenge — extension v1.2+ is required for connectWithProof()')
      }
      throw e
    }
  }

  /** Revoke this origin's grant. */
  async disconnect(): Promise<void> {
    await this.request<object>('bdx_disconnect')
    this.cachedAddress = null
  }

  /** Address from the last successful connect(), without a round-trip. */
  get address(): string | null {
    return this.cachedAddress
  }

  get isConnected(): boolean {
    return this.cachedAddress !== null
  }

  async getAddress(): Promise<string> {
    const r = await this.request<GetAddressResult>('bdx_getAddress')
    this.cachedAddress = r.address
    return r.address
  }

  /** Balance in atomic units (BigInt). Use fromAtomic() for display. */
  async getBalance(): Promise<Balance> {
    const r = await this.request<GetBalanceResult>('bdx_getBalance')
    return {
      total: parseAtomic(r.total),
      unlocked: parseAtomic(r.unlocked),
      approximate: !!r.approximate,
      height: r.height
    }
  }

  /**
   * Ask the wallet to send BDX. The user approves (or rejects — error 4001)
   * in the wallet's own window. `amount` is atomic units: bigint, or an
   * integer string; use toAtomic('1.25') to convert display BDX.
   */
  async sendTransaction(params: SendTransactionParams): Promise<SendTransactionResult> {
    const { to, amount, priority, paymentId, sweep } = params
    let idempotencyKey = params.idempotencyKey
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_RE.test(idempotencyKey)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'idempotencyKey must be 8–128 chars of A-Za-z0-9._-')
    }
    // Every send carries a key (wallet v1.2+): retrying with the same key can
    // never create a second approved payment. Older wallets ignore the field.
    idempotencyKey ??= randomNonceHex()

    const addr = checkAddress(to)
    if (!addr.valid) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, `invalid "to" address: ${addr.reason}`)
    }
    if (sweep && amount !== undefined) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'sweep and amount are mutually exclusive')
    }
    let wireAmount: string | undefined
    if (!sweep) {
      if (amount === undefined) {
        throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'amount is required unless sweep')
      }
      let v: bigint
      try {
        v = typeof amount === 'bigint' ? amount : parseAtomic(amount)
      } catch (e) {
        throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, (e as Error).message)
      }
      if (v <= 0n) throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'amount must be > 0')
      wireAmount = v.toString()
    }
    if (priority !== undefined && ![1, 2, 3, 4, 5].includes(priority)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'priority must be 1–5')
    }
    if (paymentId !== undefined && !/^[0-9a-fA-F]{16}$|^[0-9a-fA-F]{64}$/.test(paymentId)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'paymentId must be 16 or 64 hex chars')
    }

    return this.request<SendTransactionResult>('bdx_sendTransaction', {
      to,
      ...(wireAmount !== undefined ? { amount: wireAmount } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(paymentId !== undefined ? { paymentId } : {}),
      ...(sweep ? { sweep: true } : {}),
      idempotencyKey
    })
  }

  /** True outcome of a send operation (wallet v1.2+). Only the origin that
   *  created the operation can read it; no approval needed. */
  async getOperationStatus(operationId: string): Promise<OperationStatus> {
    if (typeof operationId !== 'string' || !operationId) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'operationId must be a non-empty string')
    }
    return this.request<OperationStatus>('bdx_getOperationStatus', { operationId })
  }

  /**
   * Send with recovery: never turns an unknown outcome into a duplicate
   * payment. Attaches an idempotencyKey (yours, or generated — returned in the
   * `unresolved` case so you can resume after a restart) and, when the local
   * approval timeout fires (UNKNOWN_OUTCOME) or the wallet reports the key
   * already in progress, re-asks the wallet with the SAME key: a confirmed
   * operation is replayed (no second approval), an executing one is awaited,
   * and only a truly failed/absent one opens a fresh approval.
   *
   * Resolves `{ status: 'confirmed', txHash, fee, … }` or
   * `{ status: 'unresolved', idempotencyKey }` — unresolved means the payment
   * may STILL complete; treat it as pending, not as "nothing happened".
   * Terminal errors (4001 rejection, -32602, …) throw as usual.
   */
  async sendTransactionSafe(
    params: SendTransactionParams,
    opts: { resolveTimeoutMs?: number; pollIntervalMs?: number } = {}
  ): Promise<SafeSendResult> {
    const idempotencyKey = params.idempotencyKey ?? randomNonceHex()
    const deadline = Date.now() + (opts.resolveTimeoutMs ?? 30_000)
    let delay = opts.pollIntervalMs ?? 1_000
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const r = await this.sendTransaction({ ...params, idempotencyKey })
        return { status: 'confirmed', ...r }
      } catch (e) {
        const stillUnknown = BdxRpcError.isUnknownOutcome(e)
        const inProgress = e instanceof BdxRpcError
          && e.code === ERROR_CODES.INTERNAL && /idempotency key is already in progress/i.test(e.message)
        if (!stillUnknown && !inProgress) throw e // terminal: rejection, invalid params, …
        if (Date.now() >= deadline) return { status: 'unresolved', idempotencyKey }
        await new Promise(r => setTimeout(r, Math.min(delay, Math.max(0, deadline - Date.now()))))
        delay = Math.min(delay * 2, 8_000)
      }
    }
  }

  /**
   * Sign a UTF-8 message with the wallet's spend key (user approves in the
   * wallet's window). Returns a `"SigV1…"` signature verifiable by
   * `verifyMessage()`, `beldex-wallet-cli`, and the explorer (PROTOCOL.md §4.6).
   * The reference wallet caps messages at 512 characters.
   */
  async signMessage(message: string): Promise<SignMessageResult> {
    // Signing-text policy v1 — the same class-based rule the wallet router
    // enforces (§4.6): reject early with the offending code point named.
    const v = validateSigningText(message)
    if (!v.ok) throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, v.reason)
    // The auth-statement prefix is RESERVED: audience-bound statements must
    // only come from the wallet-composed bdx_signAuthChallenge path — a page
    // must not be able to forge one via generic message signing.
    if (message.trimStart().startsWith(AUTH_VERSION)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS,
        `the "${AUTH_VERSION}" prefix is reserved — use connectWithProof()/bdx_signAuthChallenge for auth statements`)
    }
    return this.request<SignMessageResult>('bdx_signMessage', { message })
  }

  /**
   * Wallet-composed, origin-bound auth statement (wallet v1.2+, approval).
   * The WALLET builds and signs the `beldex-auth-v1` statement from the origin
   * it observes via the browser — the page supplies only the server challenge,
   * so the signed `domain` cannot be forged by page-side code.
   */
  async signAuthChallenge(params: SignAuthChallengeParams): Promise<SignAuthChallengeResult> {
    if (typeof params?.nonce !== 'string' || !SERVER_NONCE_RE.test(params.nonce)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'nonce must be 8–128 chars of A-Za-z0-9._-')
    }
    return this.request<SignAuthChallengeResult>('bdx_signAuthChallenge', {
      nonce: params.nonce,
      ...(params.requestId !== undefined ? { requestId: params.requestId } : {}),
      ...(params.expiresInMs !== undefined ? { expiresInMs: params.expiresInMs } : {})
    })
  }

  /** Verify a message signature. Public — no grant needed. */
  async verifyMessage(params: VerifyMessageParams): Promise<boolean> {
    const r = await this.request<VerifyMessageResult>('bdx_verifyMessage', params)
    return !!r.valid
  }

  /** Resolve a BNS name (e.g. "shop.bdx"). Display the address to the user. */
  async resolveBns(name: string): Promise<ResolveBnsResult> {
    if (typeof name !== 'string' || !name.trim()) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'name must be a non-empty string')
    }
    return this.request<ResolveBnsResult>('bdx_resolveBns', { name: name.trim() })
  }

  async getNetwork(): Promise<GetNetworkResult> {
    return this.request<GetNetworkResult>('bdx_getNetwork')
  }

  async getState(): Promise<WalletState> {
    const r = await this.request<GetStateResult>('bdx_getState')
    return r.state
  }

  // -------------------------------------------------------------- events ----

  on(event: BdxEvent, listener: (data: unknown) => void): this {
    let map = this.subs.get(event)
    if (!map) this.subs.set(event, (map = new Map()))
    if (map.has(listener)) return this
    const wrapped = (data: unknown) => listener(data)
    map.set(listener, wrapped)
    this.provider.on(event, wrapped)
    return this
  }

  off(event: BdxEvent, listener: (data: unknown) => void): this {
    const wrapped = this.subs.get(event)?.get(listener)
    if (wrapped) {
      this.subs.get(event)!.delete(listener)
      this.provider.off(event, wrapped)
    }
    return this
  }

  once(event: BdxEvent, listener: (data: unknown) => void): this {
    const onceFn = (data: unknown) => {
      this.off(event, onceFn)
      listener(data)
    }
    return this.on(event, onceFn)
  }

  // ------------------------------------------------------------- helpers ----

  static isUserRejection(e: unknown): boolean { return BdxRpcError.isUserRejection(e) }
  static isLocked(e: unknown): boolean { return BdxRpcError.isLocked(e) }
  static isUnauthorized(e: unknown): boolean { return BdxRpcError.isUnauthorized(e) }
}
