// BeldexWeb3 — the typed client dapps use. Wraps any BeldexProvider (the
// extension's injected one, or a PostMessageProvider) with:
//   · typed methods for every protocol call
//   · per-method timeouts (30 s auto-answered, 5 min approval-gated)
//   · BigInt-parsed balances, atomic-string amounts on the wire
//   · normalized BdxRpcError errors
//   · EventEmitter-style protocol events + cached connection state

import type {
  AccountsChangedEventData, Balance, BdxEvent, BdxMethod, BeldexProvider,
  ConnectEventData, ConnectProof, ConnectResult, ConnectWithProofResult,
  GetAddressResult, GetBalanceResult,
  GetNetworkResult, GetStateResult, ResolveBnsResult, SendTransactionParams,
  SendTransactionResult, SignMessageResult, VerifyMessageParams,
  VerifyMessageResult, WalletState
} from './types.js'
import { BdxRpcError, ERROR_CODES, toBdxError } from './errors.js'
import { parseAtomic } from './units.js'
import { checkAddress } from './address.js'

const APPROVAL_METHODS: ReadonlySet<BdxMethod> = new Set([
  'bdx_connect', 'bdx_sendTransaction', 'bdx_signMessage'
])

/** The challenge signed by `connectWithProof()`: `<address>:<nonce>:<timestamp>`.
 *  Exported so verifiers can rebuild it from the parts they stored. */
export function buildAuthChallenge(address: string, nonce: string, timestamp: number): string {
  return `${address}:${nonce}:${timestamp}`
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

  /** Raw protocol call with timeout + error normalization. */
  async request<T>(method: BdxMethod, params?: object): Promise<T> {
    const timeoutMs = APPROVAL_METHODS.has(method) ? this.approvalTimeoutMs : this.readTimeoutMs
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new BdxRpcError(ERROR_CODES.REQUEST_EXPIRED, `${method} timed out after ${timeoutMs}ms`)),
        timeoutMs
      )
    })
    try {
      const args: { method: BdxMethod; params?: object } =
        params !== undefined ? { method, params } : { method }
      return (await Promise.race([this.provider.request(args), timeout])) as T
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
   * Connect, then immediately ask the wallet to sign an ownership challenge of
   * `<address>:<nonce>:<timestamp>` (two approvals: connect, then signature).
   *
   * - `required: true` (default): connection and proof are all-or-nothing — a
   *   rejected signature disconnects again and rethrows the 4001.
   * - `required: false`: a rejected signature leaves the connection standing
   *   and resolves with `proof: null`.
   *
   * Verify server-side with `bdx_verifyMessage` (or CLI `verify_value`) and
   * check the address, nonce freshness, and timestamp window yourself — the
   * challenge contains no origin binding, so treat nonce+timestamp as your
   * replay protection.
   */
  async connectWithProof(opts: { required?: boolean } = {}): Promise<ConnectWithProofResult> {
    const required = opts.required ?? true
    const { address, network } = await this.connect()
    const nonce = randomNonceHex()
    const timestamp = Date.now()
    const message = buildAuthChallenge(address, nonce, timestamp)
    try {
      const s = await this.signMessage(message)
      const proof: ConnectProof = {
        message, signature: s.signature, address: s.address, nonce, timestamp
      }
      return { address, network, proof }
    } catch (e) {
      if (BdxRpcError.isUserRejection(e) && !required) {
        return { address, network, proof: null }
      }
      if (required) await this.disconnect().catch(() => {})
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
      ...(sweep ? { sweep: true } : {})
    })
  }

  /**
   * Sign a UTF-8 message with the wallet's spend key (user approves in the
   * wallet's window). Returns a `"SigV1…"` signature verifiable by
   * `verifyMessage()`, `beldex-wallet-cli`, and the explorer (PROTOCOL.md §4.6).
   * The reference wallet caps messages at 512 characters.
   */
  async signMessage(message: string): Promise<SignMessageResult> {
    if (typeof message !== 'string' || message.length === 0) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'message must be a non-empty string')
    }
    // Mirrors the wallet (§4.6): text only — a message must not be able to hide
    // its content behind newlines/escapes in the approval card.
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(message)) {
      throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, 'message must not contain control characters')
    }
    return this.request<SignMessageResult>('bdx_signMessage', { message })
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
