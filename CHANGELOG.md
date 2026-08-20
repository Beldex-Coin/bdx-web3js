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
- `connectWithProof()`: connect, then immediately sign an ownership challenge of
  `<address>:<nonce>:<timestamp>` (nonce = 16 random bytes hex; two approvals).
  All-or-nothing by default: a declined signature disconnects the fresh
  connection and rethrows 4001; `required: false` keeps the connection with
  `proof: null`. `buildAuthChallenge()` exported for server-side verifiers.
- React: `signOnConnect` prop on `BeldexProvider` — connect() runs
  `connectWithProof()` and exposes the result as `proof` (context + `useConnect`),
  cleared on disconnect/accountsChanged.
- `examples/react-demo`: sign-message card with local verify round trip; send form,
  disconnect button, full address display.

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
