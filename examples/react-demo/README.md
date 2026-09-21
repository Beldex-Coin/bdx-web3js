# bdx-web3js React demo

Minimal Vite + React app showing the `bdx-web3js/react` bindings: `BeldexProvider`, `ConnectButton`, and the `useConnect` / `useBalance` hooks with live balance polling.

## Prerequisites

- Node.js ≥ 18
- The Beldex Wallet browser extension installed and set up

## Run

The demo consumes the SDK via `file:../..`, so build the SDK first:

```bash
# from the repo root
npm install
npm run build

# then the demo
cd examples/react-demo
npm install
npm run dev
```

Open the printed URL (default `http://localhost:5173`) and click **Connect**.

> The extension only injects into http(s) pages — opening `index.html` from `file://` will not work.

## What it demonstrates

- **`BeldexProvider`** — wraps the app and manages the wallet connection.
- **`ConnectButton`** — drop-in connect/disconnect button.
- **`useConnect()`** — reads connection state (`isConnected`).
- **`useBalance({ pollMs })`** — polls the spendable balance every 15 s; `balance.approximate` flags estimates.
- **`fromAtomic()` / `toAtomic()`** — convert between atomic units and display BDX amounts.
- **Send form** — `bdx.sendTransaction()` via `useBeldex()`: recipient, amount (or sweep-all), priority 1–5 (5 = flash), approval-gated in the wallet; shows tx hash + fee on success and handles user rejection (4001) quietly.
- **`useSignMessage()`** — approval-gated `bdx_signMessage` ("SigV1…" encoding, spend key); the card then round-trips the fresh signature through `bdx.verifyMessage()` (public, no approval) and shows the result.
- **Sign-in with Beldex** — `signOnConnect={{ getChallenge }}`: a mock in-page "backend" issues a single-use nonce; on connect the SDK requests `bdx_signAuthChallenge`, so the **wallet composes** the `beldex-auth-v1` statement from the origin it observed (the page never supplies the text — requires extension v1.2+); the mock backend then runs the full relying-party checklist (`parseAuthChallenge`, domain === own origin, nonce issued/unused/consumed, iat/exp window, `verifyMessage`). Replace `mockAuthServer` with real `/api/auth/*` endpoints in production.
- **Signing-text policy live feedback** — the sign card runs `validateSigningText()` (policy v1) plus the reserved `beldex-auth-v1` prefix check as you type, mirroring exactly what the SDK/wallet reject, and disables the Sign button with the reason shown.

## Files

| File | Purpose |
|---|---|
| `src/main.jsx` | The entire app — provider, connect button, balance display, send form |
| `index.html` | Vite entry page |
| `vite.config.js` | Vite + React plugin config |

## Troubleshooting

- **Connect button does nothing** — check the extension is installed and unlocked; check the page is served over http(s).
- **`balance error: …`** — shown inline by the demo; usually means the wallet lost connection to its light-wallet server.
- **Stale SDK behavior** — re-run `npm run build` at the repo root; the demo links the local build, not a published package.
