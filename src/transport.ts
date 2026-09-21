// Raw postMessage transport: a BeldexProvider implementation that speaks the
// PROTOCOL.md §1 envelopes directly over window.postMessage. This is the
// reference client of the wire protocol; the wallet's injected inpage provider
// implements the same contract from the other side (and may reuse this class).
//
// Validation is strict: anything not exactly matching an envelope shape is
// silently dropped (spec §1). A response whose id matches no pending request is
// ignored (spec pending-id rule).

import type {
  BdxEvent, BdxMethod, BeldexProvider, RpcErrorShape
} from './types.js'
import { REQUEST_TARGET, RESPONSE_TARGET } from './types.js'
import { BdxRpcError, ERROR_CODES } from './errors.js'

const EVENTS: ReadonlySet<string> = new Set([
  'connect', 'disconnect', 'accountsChanged', 'networkChanged',
  'balanceChanged', 'lock', 'unlock'
])

interface Pending {
  resolve: (v: unknown) => void
  reject: (e: BdxRpcError) => void
  timer: ReturnType<typeof setTimeout>
}

function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC 4122 v4 fallback
  const b = new Uint8Array(16)
  crypto.getRandomValues(b)
  b[6] = (b[6]! & 0x0f) | 0x40
  b[8] = (b[8]! & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

function isRpcError(v: unknown): v is RpcErrorShape {
  return typeof v === 'object' && v !== null &&
    typeof (v as RpcErrorShape).code === 'number' &&
    typeof (v as RpcErrorShape).message === 'string'
}

export interface PostMessageProviderOptions {
  /** Safety net for requests the wallet never answers. Default 360 000 ms
   *  (6 min — above the wallet's own 5-min approval TTL, so the wallet's
   *  4999 normally arrives first). */
  requestTimeoutMs?: number
  /** Window to bind to (tests). Defaults to globalThis.window. */
  targetWindow?: Window
}

export class PostMessageProvider implements BeldexProvider {
  readonly isBeldex = true as const

  private readonly win: Window
  private readonly timeoutMs: number
  private readonly pending = new Map<string, Pending>()
  private readonly listeners = new Map<BdxEvent, Set<(data: unknown) => void>>()
  private readonly onMessage: (ev: MessageEvent) => void
  private destroyed = false

  constructor(opts: PostMessageProviderOptions = {}) {
    if (typeof window === 'undefined' && !opts.targetWindow) {
      throw new Error('PostMessageProvider requires a window (browser main world)')
    }
    this.win = opts.targetWindow ?? window
    this.timeoutMs = opts.requestTimeoutMs ?? 360_000
    this.onMessage = ev => this.handleMessage(ev)
    this.win.addEventListener('message', this.onMessage)
  }

  request(args: { method: BdxMethod; params?: object; signal?: AbortSignal }): Promise<unknown> {
    if (this.destroyed) {
      return Promise.reject(new BdxRpcError(ERROR_CODES.INTERNAL, 'provider destroyed'))
    }
    if (args.signal?.aborted) {
      return Promise.reject(new BdxRpcError(ERROR_CODES.REQUEST_EXPIRED, 'request aborted'))
    }
    const id = uuid()
    return new Promise<unknown>((resolve, reject) => {
      // True cancellation: the caller's deadline abort drops the pending entry,
      // so a late wallet response to this id is ignored (stale-id rule).
      const onAbort = () => {
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        clearTimeout(p.timer)
        reject(new BdxRpcError(ERROR_CODES.REQUEST_EXPIRED, 'request aborted'))
      }
      const settleWrap = <A>(fn: (v: A) => void) => (v: A) => {
        args.signal?.removeEventListener('abort', onAbort)
        fn(v)
      }
      args.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => {
        this.pending.delete(id)
        args.signal?.removeEventListener('abort', onAbort)
        reject(new BdxRpcError(ERROR_CODES.REQUEST_EXPIRED, 'Request timed out'))
      }, this.timeoutMs)
      this.pending.set(id, { resolve: settleWrap(resolve), reject: settleWrap(reject), timer })
      this.win.postMessage(
        { target: REQUEST_TARGET, id, method: args.method, ...(args.params !== undefined ? { params: args.params } : {}) },
        '*'
      )
    })
  }

  on(event: BdxEvent, listener: (data: unknown) => void): void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(listener)
  }

  off(event: BdxEvent, listener: (data: unknown) => void): void {
    this.listeners.get(event)?.delete(listener)
  }

  /** Remove the window listener and reject all in-flight requests. */
  destroy(): void {
    this.destroyed = true
    this.win.removeEventListener('message', this.onMessage)
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new BdxRpcError(ERROR_CODES.INTERNAL, 'provider destroyed'))
      this.pending.delete(id)
    }
  }

  // ------------------------------------------------------------- internal ----

  private handleMessage(ev: MessageEvent): void {
    // Only same-window messages (content script posts into its own window).
    if (ev.source !== this.win) return
    const msg = ev.data
    if (typeof msg !== 'object' || msg === null) return
    if ((msg as { target?: unknown }).target !== RESPONSE_TARGET) return

    // Event push?
    const evName = (msg as { event?: unknown }).event
    if (typeof evName === 'string') {
      if (!EVENTS.has(evName)) return // unknown events: ignore (spec §5)
      const data = (msg as { data?: unknown }).data
      for (const fn of this.listeners.get(evName as BdxEvent) ?? []) {
        try { fn(data) } catch { /* listener errors must not break the transport */ }
      }
      return
    }

    // Response?
    const id = (msg as { id?: unknown }).id
    if (typeof id !== 'string') return
    const pending = this.pending.get(id)
    if (!pending) return // unknown/stale id: ignore
    const { result, error } = msg as { result?: unknown; error?: unknown }
    if (error !== undefined) {
      if (!isRpcError(error)) return // malformed error object: drop, keep waiting
      this.pending.delete(id)
      clearTimeout(pending.timer)
      pending.reject(new BdxRpcError(error.code, error.message))
      return
    }
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(result)
  }
}
