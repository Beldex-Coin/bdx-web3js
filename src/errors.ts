// Protocol error codes (PROTOCOL.md §6) and the SDK error class.

export const ERROR_CODES = {
  USER_REJECTED: 4001,
  UNAUTHORIZED: 4100,
  WALLET_LOCKED: 4900,
  NO_WALLET: 4901,
  REQUEST_EXPIRED: 4999,
  /** SDK-local (never on the wire): a state-MUTATING call (send) timed out
   *  locally — the wallet may still be executing it. NOT safe to blind-retry;
   *  resolve via getOperationStatus() or an idempotent retry (same key). */
  UNKNOWN_OUTCOME: 4998,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export class BdxRpcError extends Error {
  readonly code: number

  constructor(code: number, message: string) {
    super(message)
    this.name = 'BdxRpcError'
    this.code = code
    // Restore prototype chain when targeting ES5-transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype)
  }

  /** User declined or closed the approval window — not an app error. */
  static isUserRejection(e: unknown): boolean {
    return e instanceof BdxRpcError && e.code === ERROR_CODES.USER_REJECTED
  }

  /** Wallet is locked/unavailable — prompt the user to open the wallet. */
  static isLocked(e: unknown): boolean {
    return e instanceof BdxRpcError && e.code === ERROR_CODES.WALLET_LOCKED
  }

  /** Origin holds no grant — call connect() first. */
  static isUnauthorized(e: unknown): boolean {
    return e instanceof BdxRpcError && e.code === ERROR_CODES.UNAUTHORIZED
  }

  /** Approval TTL elapsed, or an SDK timeout on a READ — safe to retry.
   *  (Send timeouts raise UNKNOWN_OUTCOME instead — see isUnknownOutcome.) */
  static isExpired(e: unknown): boolean {
    return e instanceof BdxRpcError && e.code === ERROR_CODES.REQUEST_EXPIRED
  }

  /** A send stopped being waited on but may still execute. NOT safe to
   *  blind-retry — use sendTransactionSafe(), or getOperationStatus() /
   *  a retry with the same idempotencyKey, to learn the true outcome. */
  static isUnknownOutcome(e: unknown): boolean {
    return e instanceof BdxRpcError && e.code === ERROR_CODES.UNKNOWN_OUTCOME
  }
}

/** Terse, printable, bounded — raw transport/backend strings must not leak
 *  through to callers unfiltered (audit: sanitize surfaced errors). */
function sanitizeMessage(msg: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = msg.replace(/[\x00-\x1f\x7f]/g, ' ').trim()
  return clean.length > 256 ? `${clean.slice(0, 253)}…` : clean || 'error'
}

/** Normalize anything a provider throws/returns into a BdxRpcError. */
export function toBdxError(e: unknown): BdxRpcError {
  if (e instanceof BdxRpcError) return e
  if (
    typeof e === 'object' && e !== null &&
    typeof (e as { code?: unknown }).code === 'number' &&
    typeof (e as { message?: unknown }).message === 'string'
  ) {
    return new BdxRpcError((e as { code: number }).code, sanitizeMessage((e as { message: string }).message))
  }
  return new BdxRpcError(ERROR_CODES.INTERNAL, sanitizeMessage(e instanceof Error ? e.message : String(e)))
}
