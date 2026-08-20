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
- **`fromAtomic()`** — converts atomic units to a display BDX amount.

## Files

| File | Purpose |
|---|---|
| `src/main.jsx` | The entire app — provider, connect button, balance display |
| `index.html` | Vite entry page |
| `vite.config.js` | Vite + React plugin config |

## Troubleshooting

- **Connect button does nothing** — check the extension is installed and unlocked; check the page is served over http(s).
- **`balance error: …`** — shown inline by the demo; usually means the wallet lost connection to its light-wallet server.
- **Stale SDK behavior** — re-run `npm run build` at the repo root; the demo links the local build, not a published package.
