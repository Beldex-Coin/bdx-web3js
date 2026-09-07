// Client-side request schema & size limits — mirror of the wallet's
// authoritative per-method gates (the extension rejects oversized /
// unknown-field / no-param-method / unknown-method requests before any work).
// The SDK enforces the SAME caps before provider.request() so violations fail
// immediately with a typed error and never reach the wire. Structural/size
// gates only — semantic validation (charsets, ranges, signing-text policy)
// stays where it is and runs in addition.
//
// PROTOCOL.md §4 "Request-size profile" documents this table; the conformance
// test parses that table and diffs it against REQUEST_SCHEMAS, so the doc and
// the runtime caps cannot drift.

import type { BdxMethod } from './types.js'
import { BdxRpcError, ERROR_CODES } from './errors.js'

export interface FieldSpec {
  type: 'string' | 'number' | 'boolean'
  /** String length cap. Absent for number/boolean. */
  maxLen?: number
  required?: boolean
}

export type MethodSchema = Readonly<Record<string, FieldSpec>>

/** Matches the wallet: incoming params may carry at most 16 own keys. */
export const MAX_PARAM_KEYS = 16
/** Request ids must be non-empty strings of at most 128 chars (the SDK's
 *  transport generates 36-char UUIDs, well inside the cap). */
export const MAX_REQUEST_ID_CHARS = 128

/** Empty schema = no-parameter method: any own key is rejected. */
export const REQUEST_SCHEMAS: Readonly<Record<BdxMethod, MethodSchema>> = {
  bdx_connect: {},
  bdx_disconnect: {},
  bdx_getAddress: {},
  bdx_getBalance: {},
  bdx_getNetwork: {},
  bdx_getState: {},
  bdx_resolveBns: {
    name: { type: 'string', maxLen: 64, required: true }
  },
  bdx_verifyMessage: {
    message: { type: 'string', maxLen: 8192, required: true },
    address: { type: 'string', maxLen: 128, required: true },
    signature: { type: 'string', maxLen: 256, required: true }
  },
  bdx_signMessage: {
    message: { type: 'string', maxLen: 512, required: true }
  },
  bdx_signAuthChallenge: {
    nonce: { type: 'string', maxLen: 128, required: true },
    requestId: { type: 'string', maxLen: 64 },
    expiresInMs: { type: 'number' }
  },
  bdx_sendTransaction: {
    to: { type: 'string', maxLen: 128, required: true },
    amount: { type: 'string', maxLen: 32 },
    sweep: { type: 'boolean' },
    priority: { type: 'number' },
    paymentId: { type: 'string', maxLen: 64 },
    idempotencyKey: { type: 'string', maxLen: 128 }
  },
  bdx_getOperationStatus: {
    operationId: { type: 'string', maxLen: 128, required: true }
  }
}

const bad = (msg: string): never => {
  throw new BdxRpcError(ERROR_CODES.INVALID_PARAMS, msg)
}

/**
 * Validate `params` against `method`'s schema and return a FRESH object
 * holding only the recognized fields (or undefined for no-param calls).
 * Rejects: unknown methods (-32601); populated params on no-param methods,
 * unknown/extra fields (which inherently covers `__proto__`/`constructor`/
 * `prototype` — they are simply not recognized fields), non-primitive values,
 * oversized strings, non-finite numbers, >16 keys, missing required fields
 * (all -32602). Nothing unrecognized is ever forwarded to the wallet.
 */
export function sanitizeRequestParams(method: BdxMethod, params?: object): object | undefined {
  const schema = (Object.prototype.hasOwnProperty.call(REQUEST_SCHEMAS, method)
    ? REQUEST_SCHEMAS[method]
    : undefined)
  if (schema === undefined) {
    throw new BdxRpcError(ERROR_CODES.METHOD_NOT_FOUND, `unknown method: ${String(method)}`)
  }
  const required = Object.keys(schema).filter(f => schema[f]!.required)

  if (params === undefined || params === null) {
    if (required.length > 0) bad(`${method}: missing required field "${required[0]}"`)
    return undefined
  }
  if (typeof params !== 'object' || Array.isArray(params)) {
    bad(`${method}: params must be a plain object`)
  }
  // getOwnPropertyNames (not Object.keys): a JSON-parsed {"__proto__":…} has
  // it as an own key, and nothing own may hide from the gate.
  const keys = Object.getOwnPropertyNames(params)
  if (keys.length > MAX_PARAM_KEYS) bad(`${method}: too many params keys (max ${MAX_PARAM_KEYS})`)

  const out: Record<string, unknown> = {}
  for (const k of keys) {
    const spec = Object.prototype.hasOwnProperty.call(schema, k) ? schema[k] : undefined
    if (!spec) {
      bad(Object.keys(schema).length === 0
        ? `${method} takes no parameters (got "${k}")`
        : `${method}: unknown field "${k}"`)
      continue
    }
    const v = (params as Record<string, unknown>)[k]
    if (typeof v !== spec!.type) bad(`${method}: field "${k}" must be a ${spec!.type}`)
    if (spec!.type === 'string' && spec!.maxLen !== undefined && (v as string).length > spec!.maxLen) {
      bad(`${method}: field "${k}" exceeds ${spec!.maxLen} characters`)
    }
    if (spec!.type === 'number' && !Number.isFinite(v)) bad(`${method}: field "${k}" must be a finite number`)
    out[k] = v
  }
  for (const r of required) {
    if (!(r in out)) bad(`${method}: missing required field "${r}"`)
  }
  return out
}
