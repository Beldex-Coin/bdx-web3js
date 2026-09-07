// Signing-text policy v1 vectors — mirrors the wallet's sign-params tests so
// the two enforcers cannot drift apart silently. All disallowed code points
// are written as \uXXXX escapes on purpose: literal invisibles in source are
// exactly the ambiguity this policy exists to prevent.

import { describe, it, expect } from 'vitest'
import {
  validateSigningText, SIGNING_TEXT_POLICY_VERSION, MAX_SIGNING_TEXT_CHARS
} from '../src/signing-policy.js'

const ok = (s: string) => expect(validateSigningText(s)).toEqual({ ok: true })
const bad = (s: string): string => {
  const v = validateSigningText(s)
  expect(v.ok).toBe(false)
  return v.ok ? '' : v.reason
}

describe('signing-text policy v1', () => {
  it('is version 1 with the 512-char cap', () => {
    expect(SIGNING_TEXT_POLICY_VERSION).toBe('1')
    expect(MAX_SIGNING_TEXT_CHARS).toBe(512)
  })

  it('accepts legitimate text across scripts', () => {
    ok('hello world')                            // ASCII
    ok('café déjà-vu naïve') // accented Latin
    ok('Привет мир')  // Cyrillic
    ok('你好世界')               // CJK
    ok('مرحبا بالعالم') // Arabic letters
    ok('I own this address \u{1f600}')           // base emoji, NO variation selector
    ok('x'.repeat(512))                          // exactly at the cap
  })

  it('rejects empty and over-cap', () => {
    bad('')
    expect(bad('x'.repeat(513))).toMatch(/512/)
  })

  it('rejects every audited class, naming the code point', () => {
    const vectors: Array<[string, string]> = [
      ['a\u{7}b', 'U+0007'],   // C0 control
      ['a\u{7f}b', 'U+007F'],   // DEL
      ['a\u{85}b', 'U+0085'],   // C1 control
      ['a\u{ad}b', 'U+00AD'],   // soft hyphen
      ['a\u{34f}b', 'U+034F'],   // combining grapheme joiner
      ['a\u{61c}b', 'U+061C'],   // ARABIC LETTER MARK
      ['a\u{180e}b', 'U+180E'],   // Mongolian FVS/MVS block
      ['a\u{200b}b', 'U+200B'],   // zero-width space
      ['a\u{202e}b', 'U+202E'],   // RLO bidi override
      ['a\u{2028}b', 'U+2028'],   // line separator
      ['a\u{206a}b', 'U+206A'],   // deprecated format controls
      ['a\u{206f}b', 'U+206F'],
      ['a\u{fe0f}b', 'U+FE0F'],   // VS16 variation selector
      ['a\u{e0101}b', 'U+E0101'],   // astral variation-selector supplement
      ['a\u{e0041}b', 'U+E0041'],   // tag code point
      ['a\u{feff}b', 'U+FEFF'],   // BOM / zero-width no-break space
      ['a\u{fdd0}b', 'U+FDD0'],   // noncharacter (BMP block)
      ['a\u{fffe}b', 'U+FFFE'],   // noncharacter
      ['a\u{1fffe}b', 'U+1FFFE'],   // noncharacter, plane 1
      ['a\ud800b', 'U+D800'],   // lone surrogate
      ['line1\nline2', 'U+000A']    // newline - multi-line SIWE cannot be signed
    ]
    for (const [input, cp] of vectors) {
      expect(bad(input), `expected rejection naming ${cp}`).toContain(cp)
    }
  })

  it('never normalizes: verdict carries no transformed text', () => {
    const v = validateSigningText('a\u200bb')
    expect(v).not.toHaveProperty('message')
    expect(v).not.toHaveProperty('normalized')
  })
})
