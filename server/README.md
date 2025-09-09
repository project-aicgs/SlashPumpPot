# PumpPot Holders Server

Lightweight Fastify server that:
- Provides a trimmed holders snapshot: `GET /holders/:mint`
- Streams live diffs via Server-Sent Events: `GET /holders/stream`
- Consumes Helius TOKEN_EVENT webhooks: `POST /webhooks/helius?secret=...`

## Setup

1) Install deps

```bash
cd server
npm i
```

2) Configure environment

Create `.env` in the project root or export vars in your shell:

```
HELIUS_API_KEY=your_helius_key
WEBHOOK_SECRET=your_shared_secret
PORT=8787
DATA_DIR=/data               # set when you attach a Render disk
# Optional: auto-track creator wallet for latest mint (Pump.fun)
TRACK_WALLET=CreatorWalletPubkey
PUMPFUN_PROGRAM_ID=Vote111111111111111111111111111111111111111  # update with real program id if desired
# Scheduler
DRAW_INTERVAL_MS=3600000
DRAW_ANCHOR_MS=0
```

3) Run

```bash
npm run dev
```

The server listens on `http://localhost:8787`.

### Schedule and authoritative timer
### Persistent disk (Render)

1) In Render → your web service → Disks → Add Disk
   - Name: `pumppot-data`
   - Size: 1–5 GB
   - Mount path: `/data`
2) In Render → Environment → add `DATA_DIR=/data`
3) Redeploy. Holders will save to `/data/holders.json`. Draws will append to `/data/draws.json`.
4) Read history: `GET /draw/history` (proxied via Netlify at `/api/draw/history`).


- `GET /schedule` returns `{ now, intervalMs, nextAt }` so clients render the same countdown.
- The server aligns draws to a fixed cadence: `DRAW_INTERVAL_MS` and optional `DRAW_ANCHOR_MS` (epoch anchor). Default is hourly.
- `POST /draw/trigger?secret=WEBHOOK_SECRET` lets an external cron trigger a draw immediately.

## Helius Webhook

Create a webhook that targets your public URL (use a tunnel like `cloudflared` or `ngrok` locally):

```bash
export HELIUS_API_KEY=your_key
export PUBLIC_WEBHOOK_URL=https://your-domain.com/webhooks/helius?secret=your_shared_secret

curl -X POST "https://api.helius.xyz/v0/webhooks?api-key=$HELIUS_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "accountAddresses": ["<TOKEN_MINT>"],
    "webhookURL": "'"$PUBLIC_WEBHOOK_URL"'",
    "transactionTypes": ["TOKEN_EVENT"],
    "encoding": "jsonParsed",
    "maxBatchSize": 1
  }'
```

- Use one webhook per active mint, or update the webhook `accountAddresses` when your UI switches tokens.
- The server will only apply deltas for the currently active mint (set by the first request to `/holders/:mint`).

## Client wiring

The root `index.html` is wired to:
- Load a full snapshot from `/holders/:mint`
- Open `EventSource(/holders/stream)` and merge `snapshot`/`delta` messages

This keeps bandwidth and free-tier usage low while feeling realtime.

