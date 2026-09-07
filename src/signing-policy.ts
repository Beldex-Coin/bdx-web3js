// Shared signing-text policy — v1, pinned to Unicode 15.1.
//
// ONE policy, two enforcers: the Beldex Wallet extension REJECTS these classes
// at its router before anything is displayed or signed, and this module gives
// the SDK the byte-for-byte same rule so a bad message fails locally with a
// clear reason instead of round-tripping. The invariant: the approval card
// must render exactly the logical bytes the user signs, so whole Unicode
// classes that are invisible, ignorable, direction-controlling, or ill-formed
// are refused. REJECT, never normalize — the exact input bytes get signed.
//
// Covered classes (regenerate from the UCD on a Unicode bump — no ad-hoc adds):
//  - C0 / DEL / C1 controls
//  - Default_Ignorable_Code_Point (soft hyphen, CGJ, ALM U+061C, Hangul
//    fillers, Khmer inherent vowels, Mongolian FVS/MVS, zero-width + LRM/RLM,
//    bidi embeddings/overrides, all of U+2060–U+206F incl. deprecated format
//    controls, variation selectors U+FE00–U+FE0F + supplement U+E0100–U+E01EF,
//    tags U+E0000–U+E007F, BOM, reserved U+FFF0–U+FFF8, shorthand/musical
//    format controls)
//  - line/paragraph separators U+2028/U+2029
//  - noncharacters (U+FDD0–U+FDEF, U+xFFFE/U+xFFFF of every plane)
//  - lone (unpaired) surrogates
// Legitimate text passes: ASCII, accented Latin, Cyrillic, CJK, Arabic
// letters, and base emoji WITHOUT a variation selector.

/** Bump only together with the wallet — the two must stay identical. */
export const SIGNING_TEXT_POLICY_VERSION = '1'
export const SIGNING_TEXT_UNICODE_VERSION = '15.1'
export const MAX_SIGNING_TEXT_CHARS = 512

// Identical ranges to the wallet router's DISALLOWED_SIGN_CHARS (dapp.ts).
// With the `u` flag, `[\ud800-\udfff]` matches only LONE surrogates (a valid
// pair iterates as one supplementary code point outside the range).
// eslint-disable-next-line no-control-regex
const DISALLOWED = new RegExp('[' + [
  '\\u0000-\\u001f\\u007f-\\u009f',
  '\\u00ad\\u034f\\u061c\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f',
  '\\u200b-\\u200f\\u2028\\u2029\\u202a-\\u202e\\u2060-\\u206f',
  '\\u3164\\ufe00-\\ufe0f\\ufeff\\uffa0\\ufff0-\\ufff8',
  '\\ufdd0-\\ufdef\\ud800-\\udfff',
  '\\u{1bca0}-\\u{1bca3}\\u{1d173}-\\u{1d17a}\\u{e0000}-\\u{e0fff}',
  '\\ufffe\\uffff',
  '\\u{1fffe}\\u{1ffff}\\u{2fffe}\\u{2ffff}\\u{3fffe}\\u{3ffff}\\u{4fffe}\\u{4ffff}',
  '\\u{5fffe}\\u{5ffff}\\u{6fffe}\\u{6ffff}\\u{7fffe}\\u{7ffff}\\u{8fffe}\\u{8ffff}',
  '\\u{9fffe}\\u{9ffff}\\u{afffe}\\u{affff}\\u{bfffe}\\u{bffff}\\u{cfffe}\\u{cffff}',
  '\\u{dfffe}\\u{dffff}\\u{efffe}\\u{effff}\\u{ffffe}\\u{fffff}\\u{10fffe}\\u{10ffff}'
].join('') + ']', 'u')

export type SigningTextVerdict = { ok: true } | { ok: false; reason: string }

/** Validate text against signing-text policy v1 (shared with the wallet).
 *  Disallowed input is REJECTED with the offending code point named — never
 *  stripped or transformed. */
export function validateSigningText(message: string): SigningTextVerdict {
  if (typeof message !== 'string' || message.length === 0) {
    return { ok: false, reason: 'message must be a non-empty string' }
  }
  if (message.length > MAX_SIGNING_TEXT_CHARS) {
    return { ok: false, reason: `message exceeds ${MAX_SIGNING_TEXT_CHARS} characters` }
  }
  const m = DISALLOWED.exec(message)
  if (m) {
    const cp = message.codePointAt(m.index)!
    return {
      ok: false,
      reason: `disallowed code point U+${cp.toString(16).toUpperCase().padStart(4, '0')} at index ${m.index} ` +
        '(control, invisible, direction-control, noncharacter, or lone surrogate — signing-text policy v' +
        `${SIGNING_TEXT_POLICY_VERSION})`
    }
  }
  return { ok: true }
}
