// Conformance guard (external audit: PROTOCOL.md / types.ts / README.md had
// drifted from the wallet's real behavior). Fails when the documented method
// tables and the runtime type source disagree, or when corrected claims creep
// back in. PROTOCOL.md is normative; BDX_METHODS is the runtime mirror.

import { describe, it, expect } from 'vitest'
import { BDX_METHODS } from '../src/types.js'
import { REQUEST_SCHEMAS } from '../src/request-schema.js'
import type { FieldSpec } from '../src/request-schema.js'
// Vite/vitest raw imports — the docs and type source as plain text.
import protocol from '../docs/PROTOCOL.md?raw'
import typesSrc from '../src/types.ts?raw'
import readme from '../README.md?raw'

describe('PROTOCOL.md ↔ types.ts ↔ README.md conformance', () => {
  it('§4 method headings and BDX_METHODS match verbatim', () => {
    const documented = [...protocol.matchAll(/^### 4\.\d+[a-z]? `(bdx_\w+)`/gm)].map(m => m[1]!)
    expect(documented.length).toBeGreaterThan(0)
    expect([...documented].sort()).toEqual([...BDX_METHODS].sort())
  })

  it('walletVersion is optional and documented as grant-gated', () => {
    expect(protocol).toMatch(/walletVersion\?: string/)
    expect(protocol).toMatch(/ONLY for granted/i)
    expect(typesSrc).toMatch(/walletVersion\?: string/)
    expect(typesSrc).not.toMatch(/walletVersion: string\b/)
  })

  it('pre-grant getState coarseness is documented in both', () => {
    expect(protocol).toMatch(/`unlocked` is collapsed to `locked`/)
    expect(typesSrc).toMatch(/collapsed to `locked`/)
  })

  it('origin display is ASCII/punycode-preserving, never described as decoded', () => {
    expect(protocol).toMatch(/NOT Unicode-decoded/)
    expect(protocol).not.toMatch(/punycode-decoded/)
  })

  it('request ids are correlation handles, not sender authentication', () => {
    expect(protocol).toMatch(/correlation handles, not sender authentication/)
    expect(protocol).toMatch(/MAIN world and is assumed hostile/)
    expect(protocol).not.toMatch(/cannot spoof responses/)
  })

  it('no stale "signing unimplemented" claims remain', () => {
    for (const doc of [protocol, readme, typesSrc]) {
      expect(doc).not.toMatch(/reserved, not implemented/i)
      expect(doc).not.toMatch(/not yet implemented/i)
    }
  })

  it('send-recovery fields are documented and typed', () => {
    expect(protocol).toMatch(/idempotencyKey\?: string/)
    expect(protocol).toMatch(/operationId\?: string/)
    expect(typesSrc).toMatch(/idempotencyKey\?: string/)
    expect(typesSrc).toMatch(/operationId\?: string/)
  })

  it('§4.0 request-size profile table matches REQUEST_SCHEMAS exactly', () => {
    // Parse the normative table into the same shape as the runtime schema.
    const row = /^\| `(bdx_\w+)` \| (—|`\w+`) \| (—|string|number|boolean) \| (—|\d+) \| (—|yes|no) \|$/gm
    const documented: Record<string, Record<string, FieldSpec>> = {}
    for (const m of protocol.matchAll(row)) {
      const [, method, fieldRaw, type, max, req] = m as unknown as string[]
      documented[method!] ??= {}
      if (fieldRaw === '—') continue // no-parameter method
      const field = fieldRaw!.slice(1, -1)
      documented[method!]![field] = {
        type: type as FieldSpec['type'],
        ...(max !== '—' ? { maxLen: Number(max) } : {}),
        ...(req === 'yes' ? { required: true } : {})
      }
    }
    expect(Object.keys(documented).sort()).toEqual(Object.keys(REQUEST_SCHEMAS).sort())
    for (const method of Object.keys(REQUEST_SCHEMAS)) {
      expect(documented[method], `table rows for ${method}`)
        .toEqual(REQUEST_SCHEMAS[method as keyof typeof REQUEST_SCHEMAS])
    }
  })

  it('signAuthChallenge wire shapes are typed as documented', () => {
    expect(protocol).toMatch(/### 4\.6a `bdx_signAuthChallenge`/)
    for (const src of [protocol, typesSrc]) {
      expect(src).toMatch(/requestId\?: string/)
      expect(src).toMatch(/expiresInMs\?: number/)
    }
  })
})
