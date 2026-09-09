# Changelog

## Unreleased

### Added
- `signMessage` / `verifyMessage` are live: the reference wallet (extension v1.1)
  implements `bdx_signMessage` (approval-gated, SigV1 `wallet2::sign` scheme, spend
  key) and `bdx_verifyMessage` (public, no grant). PROTOCOL.md §4.6/4.7 updated with
  the pinned encoding and reference-wallet limits (≤512 chars, no control characters).
- `signMessage` client-side validation now mirrors the wallet: control characters
  rejected with `-32602` before the request leaves the page.
- React: `useSignMessage()` hook (sign + signing/result/error state, quiet on user
  rejection).
- `connectWithProof()`: connect, then immediately sign a domain-bound
  `beldex-auth-v1` ownership statement (single line: domain, uri, address,
  network, nonce, iat/exp, optional rid — audience-bound per external audit
  finding on proof transferability). Accepts a server-issued
  `challenge: { nonce, requestId?, expiresInMs? }` for authentication flows
  (`proof.serverIssued`); self-generated nonces are marked non-auth.
  All-or-nothing by default: a declined signature disconnects the fresh
  connection and rethrows 4001; `required: false` keeps the connection with
  `proof: null`. `buildAuthChallenge()` / `parseAuthChallenge()` exported for
  server-side verifiers.
- React: `signOnConnect` prop on `BeldexProvider` — connect() runs
  `connectWithProof()` and exposes the result as `proof` (context + `useConnect`),
  cleared on disconnect/accountsChanged. Declining the signature disconnects the
  fresh connection again (all-or-nothing).
- `examples/react-demo`: sign-message card (approval-gated sign, then a public
  `verifyMessage` round trip); send form (amount/sweep, priority 1–5 incl. flash,
  tx hash + fee display); explicit disconnect button; full address display with
  the connect-time proof (challenge + signature); README covering setup,
  demonstrated APIs, and troubleshooting.

- Send operation recovery (external audit: a terminal timeout/error could
  outlive an executing transaction, and "4999 is safe to retry" invited
  duplicate payments — requires wallet v1.2+):
  - every `sendTransaction` carries an `idempotencyKey` (auto-generated, or
    caller-supplied for resumability); same key ⇒ the wallet replays the
    recorded outcome, never a second approved payment. Result gains
    `operationId` / `idempotent` (additive).
  - new error `4998 UNKNOWN_OUTCOME` (SDK-local) + `isUnknownOutcome()`: a
    local send timeout no longer reports `requestExpired` — the tx may still
    broadcast. Reads keep `4999`.
  - `getOperationStatus(operationId)` wraps the wallet's new
    `bdx_getOperationStatus` (executing | confirmed | failed | unknown).
  - `sendTransactionSafe()`: idempotent send + bounded recovery loop —
    resolves replayed confirmations, waits out in-progress operations, and
    returns an explicit `{ status: 'unresolved', idempotencyKey }` instead of
    ever guessing. PROTOCOL.md §4.5/§4.5a/§6 document the scheme.

- Protocol doc/type drift reconciled with the wallet (external audit):
  `walletVersion` is grant-gated (now optional in `GetNetworkResult`); pre-grant
  `bdx_getState` collapses `unlocked` to `locked` (documented); origin display
  is ASCII/punycode-preserving, not Unicode-decoded (anti-homograph — doc claim
  corrected); request ids documented as correlation handles with the MAIN-world
  threat model, not sender authentication; `bdx_signAuthChallenge` (§4.6a) and
  `bdx_getOperationStatus` added to the method set and `types.ts`
  (`BDX_METHODS` runtime constant). New `test/protocol-conformance.test.ts`
  fails the build if PROTOCOL.md, `types.ts`, or README drift again.

- Request deadlines & bounded responses (external audit): every
  `provider.request()` now carries an AbortController-backed application
  deadline (long for approvals, short for reads; configurable via the existing
  constructor options) — the transport cancels the pending id on abort instead
  of merely being raced. `useBalance` polling is single-flight (no overlapping
  reads under a slow wallet). Surfaced error messages are sanitized (control
  chars stripped, length-bounded). PROTOCOL.md §7 documents that the SDK does
  no direct HTTP — response-size budgeting lives wallet-side.

- Shared signing-text policy v1 (external audit; pinned to Unicode 15.1):
  `validateSigningText()` mirrors the wallet router's class-based rejection —
  C0/DEL/C1 controls, the full Default_Ignorable_Code_Point set (zero-width,
  bidi controls, variation selectors incl. astral supplement, tags, BOM…),
  line/paragraph separators, noncharacters of every plane, lone surrogates —
  plus the 512-char cap. Enforced in `signMessage()` and every
  `buildAuthChallenge()` field BEFORE dispatch; violations are rejected with
  the offending code point named, never normalized or stripped. Exported with
  `SIGNING_TEXT_POLICY_VERSION`; PROTOCOL.md §4.6 carries the normative
  profile shared by wallet and SDK.

- Client-side request schemas & size limits (external audit; mirrors the
  wallet's authoritative gates): `sanitizeRequestParams()` validates every
  request against a per-method schema (`REQUEST_SCHEMAS`) before dispatch —
  no-param methods reject any key; string caps per field (name ≤64,
  verify message ≤8192 / address ≤128 / signature ≤256, sign message ≤512,
  nonce ≤128, to ≤128, amount ≤32, paymentId ≤64, idempotencyKey ≤128,
  operationId ≤128); ≤16 params keys; primitives only; unknown/extra fields
  rejected (inherently covering `__proto__`/`constructor`/`prototype`); only
  recognized fields are copied into a fresh object and forwarded. PROTOCOL.md
  §4.0 carries the normative profile; the conformance test parses that table
  and diffs it against the runtime schema so doc and caps cannot drift.

- Auth statements can no longer be forged via generic signing (external
  audit follow-up): `connectWithProof()` now obtains the wallet-composed
  statement via `bdx_signAuthChallenge` (extension v1.2+ required; clear
  `-32601` guidance on older wallets, with sanity checks on the returned
  statement), a public `signAuthChallenge()` method is exposed, and
  `signMessage()` rejects the reserved `beldex-auth-v1` prefix (normative in
  PROTOCOL.md §4.6 — wallets must enforce it at the router too).

### Changed
- Mock wallet now returns a `SigV1…` signature (was `SigV2…`), matching the
  encoding the reference wallet actually ships.
- README: "Message signing" section (usage, SigV1 scheme, constraints,
  `connectWithProof` + server-side verification guidance); reserved/`-32601`
  notes removed; API surface, React hooks, and Status refreshed.
- `.gitignore`: vite `*.timestamp-*.mjs` temp files ignored.

## 0.1.0 — 2026-08-11

First release. Protocol v1 (see `docs/PROTOCOL.md`).

### Added
- Core SDK: `detectProvider()` (EIP-6963-style `beldex:announceProvider` handshake with
  `window.beldex` fallback, SSR-safe), `BeldexWeb3` client with per-method timeouts,
  `PostMessageProvider` reference transport.
- Methods: `connect`, `disconnect`, `getAddress`, `getBalance` (BigInt atomic units),
  `sendTransaction` (user-approved in-wallet, flash priority supported), `resolveBns`,
  `getNetwork`, `getState`. Events: `connect`, `disconnect`, `accountsChanged`,
  `networkChanged`, `balanceChanged`, `lock`, `unlock`.
- `BdxRpcError` with protocol error codes (EIP-1193 conventions) and classification
  helpers (`isUserRejection`, `isLocked`, `isUnauthorized`, `isExpired`).
- Utilities: `toAtomic` / `fromAtomic` / `parseAtomic` (BigInt-exact, 1 BDX = 1e9),
  `checkAddress` (format-only shape validation).
- React bindings at `bdx-web3js/react`: `BeldexProvider`, `useBeldex`, `useConnect`,
  `useBalance`, `<ConnectButton/>` (react >=18 optional peer dependency).
- Builds: ESM + CJS + IIFE (`window.BdxWeb3`) + type declarations.
- Examples: `examples/vanilla.html` (inline mock wallet, yields to the real extension),
  `examples/react-demo` (Vite).
- E2E suite (`npm run e2e`) driving the built extension in Chromium.

### Known limitations
- `signMessage` / `verifyMessage` were reserved in 0.1.0: the wallet's WASM core exposed
  no signing primitives (`docs/PHASE4_CAPABILITY_REPORT.md`); calls returned `-32601`.
  *(Resolved — see Unreleased.)*
- `paymentId` on `sendTransaction` is rejected by the v1 wallet — use integrated addresses.
- `getBalance` may be `approximate: true` until the wallet panel has computed
  key-image-corrected figures for the session.
