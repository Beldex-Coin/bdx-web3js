# bdx-web3js

Typed SDK for connecting web apps to the **Beldex Wallet** browser extension — connect, read the address and balance, and initiate transactions the user approves in the wallet, MetaMask-style.

Zero runtime dependencies. ESM + CJS + browser global builds. Amounts are BigInt end-to-end (1 BDX = 10⁹ atomic units — floats are never trusted).

> Protocol spec: [`PROTOCOL.md`](./PROTOCOL.md) · Roadmap: [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md)

## Install

```bash
npm install bdx-web3js
```

Or as a browser global: `<script src="…/bdx-web3.global.js"></script>` → `window.BdxWeb3`.

## Quickstart

```ts
import { BeldexWeb3, detectProvider, toAtomic, fromAtomic } from 'bdx-web3js'

const provider = await detectProvider({ timeoutMs: 3000 })
if (!provider) {
  // Extension not installed — show an "Install Beldex Wallet" CTA.
  return
}
const bdx = new BeldexWeb3(provider)

// Connect (opens the wallet's approval UI; idempotent once granted)
const { address, network } = await bdx.connect()

// Balance — BigInt atomic units; format with fromAtomic()
const { unlocked, approximate } = await bdx.getBalance()
console.log(`spendable: ${fromAtomic(unlocked)} BDX${approximate ? ' (approx.)' : ''}`)

// Send — the user reviews and approves inside the wallet
try {
  const { txHash, fee } = await bdx.sendTransaction({
    to: 'bx…',                  // resolve BNS names first (see below)
    amount: toAtomic('1.25'),   // display BDX → atomic units
    priority: 5                 // 1 default … 5 flash (instant)
  })
  console.log('sent', txHash, 'fee', fromAtomic(fee))
} catch (e) {
  if (BeldexWeb3.isUserRejection(e)) {
    // user said no — not an error state
  } else throw e
}

// Events
bdx.on('accountsChanged', () => {/* wallet switched — call connect() again */})
bdx.on('balanceChanged', d => {/* refresh UI */})
bdx.on('disconnect', () => {/* show connect button */})
```

### Message signing

Ask the wallet to sign a plain-text message with the account **spend key** (the user approves in the wallet; `"SigV1…"` encoding, verifiable by `beldex-wallet-cli` and the explorer — see PROTOCOL.md §4.6):

```ts
const { signature, address } = await bdx.signMessage('I own this address — challenge #42')
// → { signature: 'SigV1…', address: 'bx…' }

// Verification is public — no connection or approval needed:
const valid = await bdx.verifyMessage({ message, address, signature })
```

Constraints (enforced client-side before the request leaves the page, and again by the wallet): non-empty plain text only — no control characters (`\n` included) — and the reference wallet caps messages at 512 characters.

**Ownership proof on connect.** `connectWithProof()` connects and immediately has the wallet sign a `<address>:<nonce>:<timestamp>` challenge (two approvals back-to-back). All-or-nothing by default: if the user declines the signature, the fresh connection is revoked again and the 4001 is rethrown:

```ts
const { address, network, proof } = await bdx.connectWithProof()
// proof: { message, signature, address, nonce, timestamp }

// lenient variant — declined signature keeps the connection, proof is null:
await bdx.connectWithProof({ required: false })
```

Verify server-side by rebuilding the challenge with the exported `buildAuthChallenge(address, nonce, timestamp)` and checking it via `bdx_verifyMessage` (or CLI `verify_value`). The challenge carries no origin binding — enforce nonce single-use and a timestamp window on your backend for replay protection.

### BNS names

`sendTransaction` accepts only concrete addresses — resolve names first so users approve exactly what gets paid:

```ts
const { address } = await bdx.resolveBns('shop.bdx')
// ALWAYS show `address` to the user before sending — resolution is not
// verified on-chain (verified: false).
```

### Error handling

All failures throw `BdxRpcError` with a protocol `code`:

| Code | Meaning | Suggested UX |
|---|---|---|
| 4001 | User rejected | Neutral UI, no error toast |
| 4100 | Not connected | Call `connect()` |
| 4900 | Wallet locked | "Open your Beldex Wallet to continue" |
| 4901 | No wallet created | Point to wallet onboarding |
| 4999 | Request/approval expired or timed out | Safe to retry |
| -32602 | Invalid params | Developer bug — check the message |
| -32603 | Internal wallet error | Retry later |

Helpers: `BeldexWeb3.isUserRejection(e)`, `.isLocked(e)`, `.isUnauthorized(e)`.

### Utilities

```ts
toAtomic('1.25')            // 1250000000n  (display BDX → atomic)
fromAtomic(1250000000n)     // '1.25'       (atomic → display BDX)
checkAddress('bx…')         // { valid, kind: 'standard' | 'integrated', reason? }
```

`checkAddress` validates **shape only** (base58, `bx` prefix, length) — the wallet fully re-validates every address before signing.

## What a dapp can and cannot do

Beldex is a private-by-default (Monero-family) chain, so this SDK is payments-oriented, and everything sensitive is permissioned:

- Balances aren't public — `getBalance()` works only after the user approves `connect()`, and is answered by the wallet itself. Your app never sees the view key.
- Every `sendTransaction`/`signMessage` requires fresh in-wallet approval. There are no allowances or auto-approvals.
- `verifyMessage` is the one keyless call: pure signature arithmetic, public, no grant.
- Before `connect()`, a page can only learn that a wallet exists (`getState()`).

## React

```tsx
import { BeldexProvider, ConnectButton, useConnect, useBalance, fromAtomic } from 'bdx-web3js/react'

function App() {
  return (
    <BeldexProvider>
      <ConnectButton />
      <Balance />
    </BeldexProvider>
  )
}

function Balance() {
  const { isConnected } = useConnect()
  const { balance } = useBalance({ pollMs: 15000 })
  return isConnected && balance ? <p>{fromAtomic(balance.unlocked)} BDX</p> : null
}
```

Hooks: `useBeldex()` (full context incl. the raw `BeldexWeb3` client), `useConnect()`, `useBalance({ pollMs })`, `useSignMessage()` (`sign(msg)` resolves null on user rejection; `signing`/`data`/`error` state). Pass `signOnConnect` to `<BeldexProvider>` to run `connectWithProof()` on connect and expose the result as `proof` (via context and `useConnect()`). `react >= 18` is an optional peer dependency — plain-JS users install nothing extra. See `examples/react-demo`.

## API surface

`detectProvider(opts?)` · `new BeldexWeb3(provider, opts?)` · `connect()` · `connectWithProof(opts?)` · `disconnect()` · `getAddress()` · `getBalance()` · `sendTransaction(params)` · `signMessage(msg)` · `verifyMessage(params)` · `resolveBns(name)` · `getNetwork()` · `getState()` · `buildAuthChallenge(address, nonce, ts)` · `on/off/once(event, fn)` · `address` / `isConnected` getters.

Events: `connect`, `disconnect`, `accountsChanged`, `networkChanged`, `balanceChanged`, `lock`, `unlock`.

## E2E tests

`e2e/run.mjs` drives the **built extension** in real Chromium over the real wire protocol: discovery, connect approve/reject, reads, client-side validation, and wallet-side revoke → `disconnect` event. Run on a desktop machine:

```bash
cd ../beldex-wallet-extension && npm run build:chrome
cd ../bdx-web3js && npm run build
npm i -D puppeteer     # not committed: heavyweight Chromium download
npm run e2e            # E2E_HEADED=1 to watch it
```

Send-path testing requires a funded **testnet** wallet and a testnet LWS (`CONFIG` in the extension) — keep real sends manual.

## Development

```bash
npm install
npm run build       # dist/: ESM + CJS + IIFE + .d.ts
npm test            # vitest (jsdom) against a mock wallet
npm run typecheck
```

`examples/vanilla.html` runs against an inline mock wallet — open it after `npm run build` to try the full connect → balance → send flow with no extension installed. The mock steps aside automatically when the real extension is present.

## Status

Protocol v1 implemented end-to-end against the Beldex Wallet extension: connect (optionally with ownership proof), reads, user-approved sends, and message sign/verify (extension v1.1+; SigV1 `wallet2::sign` scheme). See `CHANGELOG.md`.
