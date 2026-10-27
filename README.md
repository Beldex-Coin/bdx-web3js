# bdx-web3js

Typed SDK for connecting web apps to the **Beldex Wallet** browser extension — connect, read the address and balance, and initiate transactions the user approves in the wallet, MetaMask-style.

Zero runtime dependencies. ESM + CJS + browser global builds. Amounts are BigInt end-to-end (1 BDX = 10⁹ atomic units — floats are never trusted).

## Install

```bash
npm install @bdxi/web3js
```

Or as a browser global: `<script src="…/bdx-web3.global.js"></script>` → `window.BdxWeb3`.

## Quickstart

```ts
import { BeldexWeb3, detectProvider, toAtomic, fromAtomic } from '@bdxi/web3js'

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

**Ownership proof on connect.** `connectWithProof()` connects and immediately has the wallet sign a domain-bound, single-line `beldex-auth-v1` statement (two approvals back-to-back):

```
beldex-auth-v1 domain=<origin> uri=<origin+path> address=<addr> network=<net> nonce=<n> iat=<ms> exp=<ms>[ rid=<id>]
```

The page's origin is baked into the signed bytes, so a proof obtained by one site fails verification at any other relying party that checks `domain`. All-or-nothing by default: if the user declines the signature, the fresh connection is revoked again and the 4001 is rethrown.

```ts
// AUTHENTICATION — use a server-issued challenge (nonce made, tracked, and
// consumed single-use by YOUR backend):
const challenge = await fetch('/api/auth/challenge').then(r => r.json())
// → { nonce, requestId?, expiresInMs? }
const { proof } = await bdx.connectWithProof({ challenge })   // proof.serverIssued === true
await fetch('/api/auth/verify', { method: 'POST', body: JSON.stringify(proof) })

// Ownership/liveness signal only (SDK self-generates the nonce — do NOT
// accept these for login; the server can't tell the statement was made for
// its session):
const { proof: p2 } = await bdx.connectWithProof()            // p2.serverIssued === false

// lenient variant — declined signature keeps the connection, proof is null:
await bdx.connectWithProof({ required: false })
```

Server-side verification checklist: parse with `parseAuthChallenge(message)` (or rebuild via `buildAuthChallenge(fields)` from stored parts), then check **all** of: signature via `bdx_verifyMessage`/CLI `verify_value` · `domain` equals *your* origin · `address` is the claimed account · `network` is the expected chain · `nonce` was issued by you, unused, and consume it atomically · now within `iat`/`exp`. Reject anything that fails a single check. (The statement is single-line by design — the wallet rejects control characters, so multi-line SIWE-style layouts cannot be signed.) `connectWithProof()` obtains the statement via `bdx_signAuthChallenge` (wallet v1.2+ required): the *wallet* composes it from the origin it observes via the browser, so page-side code cannot forge the bound domain — and the reserved `beldex-auth-v1` prefix is rejected in generic `signMessage()`, so an auth statement cannot be forged through raw message signing either. `signAuthChallenge(params)` is also exposed directly for custom flows.

### Privacy tokens (HF22 — live on testnet)

Wallet v1.3+ on an HF22 chain exposes token reads and token sends to dapps. Token registration (minting) stays wallet-panel-only. All token methods require a `connect()` grant, like `getBalance()`.

**Fetch every token the wallet holds** — one call, no token ids needed (the dapp twin of the wallet's own Tokens screen):

```ts
const { tokens, height } = await bdx.getTokenBalances()
for (const t of tokens) {
  if (t.status !== 'confirmed') continue  // 'unknown' = no chain verdict, NOT a zero balance
  console.log(`${t.ticker}: ${fromTokenAtomic(t.unlocked, t.decimalPoint)} unlocked`,
              t.locked > 0n ? `(+${fromTokenAtomic(t.locked, t.decimalPoint)} locked)` : '')
}

// Optionally ALSO ask about tokens not (yet) held, e.g. a just-registered one:
await bdx.getTokenBalances([knownTokenId])          // ≤16 ids
```

**Look up one token** — balance for the connected wallet, or the public descriptor:

```ts
const bal  = await bdx.getTokenBalance(tokenId)     // { status, total, unlocked, locked, ticker?, decimalPoint?, height } — BigInt amounts in TOKEN atomic units
const info = await bdx.getTokenInfo(tokenId)        // { ticker, name, owner, metaInfo, currentSupply, totalMaxSupply, decimalPoint }
```

**Send a token** — set `tokenId` on a normal send; `amount` then means the token's own atomic units, and the network fee stays BDX (the sender needs unlocked BDX too):

```ts
const info = await bdx.getTokenInfo(tokenId)        // authoritative decimals
const { txHash, fee, operationId } = await bdx.sendTransaction({
  to,                                               // concrete address (resolve BNS first)
  tokenId,
  amount: toTokenAtomic('1.25', info.decimalPoint)  // display units → token atomic
})
console.log('sent', txHash, 'BDX fee', fromAtomic(fee))
```

The user approves in the wallet, which resolves the ticker/decimals from its own LWS for the approval card — a dapp can never influence how the approved amount is displayed, and an unresolvable token is refused before approval (`-32602`). `sweep` is not available for token sends.

**Track a token transaction.** Token sends ride the same recovery machinery as BDX sends: prefer `sendTransactionSafe({ to, tokenId, amount, idempotencyKey })` so a timeout can never double-pay, keep the returned `operationId`, and poll `bdx.getOperationStatus(operationId)` → `executing | confirmed | failed | unknown` (confirmed carries `txHash` + BDX `fee`). Beldex is a privacy chain, so there is no dapp API for listing an address's past transactions — the wallet's own history stays in the wallet; show the user your dapp's own record (txHash + explorer link, e.g. `https://testnet.beldex.dev/tx/<txHash>`) for payments it initiated.

**Amount conversion.** Always use `toTokenAtomic`/`fromTokenAtomic` with the `decimalPoint` from `getTokenInfo()`/`getTokenBalances()` — never a user- or page-supplied value: a wrong decimal point displays (and sends) amounts off by powers of ten.

**Errors.** On wallets/LWS without HF22 token support the methods fail cleanly: `-32601` (method unknown — pre-v1.3 wallet), `-32603` "token lookup unavailable" (legacy LWS), `-32602` "unknown or invalid token id". Status `unknown` in a balance reply means the chain gave no verdict — treat it as "unknown", never as zero.

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
| 4999 | Request/approval expired or timed out | Safe to retry (reads/undecided approvals) |
| 4998 | Send outcome unknown (local timeout) | Do NOT resend blindly — use `sendTransactionSafe()` / `getOperationStatus()` |
| -32602 | Invalid params | Developer bug — check the message |
| -32603 | Internal wallet error | Retry later |

Helpers: `BeldexWeb3.isUserRejection(e)`, `.isLocked(e)`, `.isUnauthorized(e)`, `.isUnknownOutcome(e)`.

### Safe sends (no duplicate payments)

Every send automatically carries an `idempotencyKey` (or pass your own to make it resumable): retrying with the same key can never create a second approved payment — the wallet (v1.2+) replays the recorded outcome. A local timeout on a send throws `4998 UNKNOWN_OUTCOME` (the transaction may still be broadcasting), never "expired":

```ts
const r = await bdx.sendTransactionSafe({ to, amount, idempotencyKey: orderId })
if (r.status === 'confirmed') {
  console.log('paid', r.txHash, r.idempotent ? '(recovered, not re-sent)' : '')
} else {
  // 'unresolved' — may still complete; re-run later with the SAME orderId,
  // or poll bdx.getOperationStatus(operationId). Never treat as "not sent".
}
```

### Utilities

```ts
toAtomic('1.25')            // 1250000000n  (display BDX → atomic)
fromAtomic(1250000000n)     // '1.25'       (atomic → display BDX)
checkAddress('bx…')              // { valid, kind: 'standard' | 'integrated', network: 'mainnet', reason? }
checkAddress('9…', 'testnet')    // testnet shapes ('9…'/'A…'/'B…') supported; second arg
                                 // enforces the expected chain (cross-network ⇒ invalid)
```

`checkAddress` validates **shape only** (base58, network prefix, length) — the wallet fully re-validates every address before signing. The client tracks the wallet's network after `connect()`/`getNetwork()` (exposed as `bdx.network`) and rejects cross-network `sendTransaction` addresses before they reach the approval flow. Testnet works end to end: connect to a testnet-configured wallet and `network: 'testnet'` flows through connect results, auth statements (`network=testnet`), events, and address validation.

## What a dapp can and cannot do

Beldex is a private-by-default (Monero-family) chain, so this SDK is payments-oriented, and everything sensitive is permissioned:

- Balances aren't public — `getBalance()` works only after the user approves `connect()`, and is answered by the wallet itself. Your app never sees the view key.
- Every `sendTransaction`/`signMessage` requires fresh in-wallet approval. There are no allowances or auto-approvals.
- `verifyMessage` is the one keyless call: pure signature arithmetic, public, no grant.
- Before `connect()`, a page can only learn that a wallet exists (`getState()`).

## React

```tsx
import { BeldexProvider, ConnectButton, useConnect, useBalance, fromAtomic } from '@bdxi/web3js/react'

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

`detectProvider(opts?)` · `new BeldexWeb3(provider, opts?)` · `connect()` · `connectWithProof(opts?)` · `disconnect()` · `getAddress()` · `getBalance()` · `sendTransaction(params)` · `sendTransactionSafe(params, opts?)` · `getOperationStatus(operationId)` · `getTokenBalance(tokenId)` · `getTokenBalances(tokenIds?)` · `getTokenInfo(tokenId)` · `signMessage(msg)` · `signAuthChallenge(params)` · `verifyMessage(params)` · `resolveBns(name)` · `getNetwork()` · `getState()` · `buildAuthChallenge(address, nonce, ts)` · `on/off/once(event, fn)` · `address` / `isConnected` getters.

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
