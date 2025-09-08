import Fastify from "fastify";
import cors from "@fastify/cors";
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";
import { HoldersStore } from "./holdersStore.js";
import { fetchHoldersSnapshot, fetchTopHoldersByLargestAccounts, getMintDecimals, heliusRpcUrl } from "./helius.js";

// Load .env from project root, then server/.env as fallback
try {
  const rootEnv = new URL("../.env", import.meta.url);
  // @ts-ignore dynamic import for dotenv
  (await import("dotenv"))?.config({ path: rootEnv });
} catch {}
try {
  (await import("dotenv"))?.config(); // default to server/.env
} catch {}

const PORT = Number(process.env.PORT || 8787);
const HELIUS_API_KEY = process.env.HELIUS_API_KEY || "";
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "dev";

if (!HELIUS_API_KEY) {
  console.warn("[warn] HELIUS_API_KEY not set. Set it in your environment.");
}

const conn = new Connection(heliusRpcUrl(HELIUS_API_KEY), "confirmed");
const store = new HoldersStore();
await store.load();

const app = Fastify({ logger: false });
await app.register(cors, { origin: true });

// Root health/info endpoint
app.get("/", async (_req, reply) => {
  reply.send({
    ok: true,
    service: "PumpPot holders",
    endpoints: [
      "/schedule",
      "/holders/active",
      "/holders/:mint",
      "/holders/full/:mint",
      "/holders/stream",
      "/draw/latest"
    ]
  });
});

// SSE clients
type Client = { id: number; res: any };
const clients = new Set<Client>();
let nextClientId = 1;

function pushDiff(diff: any) {
  const payload = `data: ${JSON.stringify(diff)}\n\n`;
  for (const c of clients) c.res.raw.write(payload);
}

async function reconcileAndBroadcast(mintStr: string) {
  try {
    const mint = new PublicKey(mintStr);
    const decimals = await getMintDecimals(conn, mint);
    let snapshot = await fetchHoldersSnapshot(conn, mint);
    if (!snapshot.length) {
      // Fallback for very large sets: use largest accounts API (top N)
      snapshot = await fetchTopHoldersByLargestAccounts(conn, mint, 5000);
    }
    store.setMint(mintStr, decimals);
    store.setSnapshot(snapshot);
    await store.save();
    const holdersSerialized = snapshot.map(h => ({ owner: h.owner, raw: h.raw.toString() }));
    pushDiff({ type: "snapshot", mint: mintStr, decimals, holders: holdersSerialized, totalRaw: store.totalRaw().toString() });
  } catch (e) {
    throw new Error(`snapshot_failed:${(e as Error).message}`);
  }
}

app.get("/holders/:mint", async (req, reply) => {
  const { mint } = req.params as { mint: string };
  const q = (req.query || {}) as Record<string, string>;
  const refresh = q.refresh === "1" || q.refresh === "true";
  const limit = q.limit ? Math.max(1, Math.min(1000, Number(q.limit))) : undefined;
  if (mint !== store.getMint() || refresh) {
    try { await reconcileAndBroadcast(mint); } catch (e) {
      const msg = String((e as Error).message || e || "error");
      const isUnknownMint = /invalid|not.*found|could not find|no.*account|owner mismatch/i.test(msg);
      reply.status(isUnknownMint ? 400 : 500);
      return { ok: false, error: msg };
    }
  }
  let holders = store.toArraySorted();
  if (limit) holders = holders.slice(0, limit);
  return {
    mint: store.getMint(),
    decimals: store.getDecimals(),
    totalRaw: store.totalRaw().toString(),
    holders: holders.map(h => ({ owner: h.owner, raw: h.raw.toString() })),
  };
});

app.get("/holders/active", async (req, reply) => {
  const envMint = process.env.DEFAULT_MINT;
  if (envMint) return { mint: envMint };
  const current = store.getMint();
  if (current) return { mint: current };
  reply.status(404);
  return { ok: false, error: "no_active_mint" };
});

// Simple full snapshot endpoint (stateless): always computes latest set
app.get("/holders/full/:mint", async (req, reply) => {
  const { mint } = req.params as { mint: string };
  try {
    const pk = new PublicKey(mint);
    const decimals = await getMintDecimals(conn, pk);
    let snapshot = await fetchHoldersSnapshot(conn, pk);
    if (!snapshot.length) {
      snapshot = await fetchTopHoldersByLargestAccounts(conn, pk, 10000);
    }
    snapshot.sort((a, b) => Number(b.raw - a.raw));
    const total = snapshot.reduce((s, h) => s + h.raw, 0n);
    return {
      mint,
      decimals,
      totalRaw: total.toString(),
      holders: snapshot.map(h => ({ owner: h.owner, raw: h.raw.toString() })),
    };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

app.get("/holders/stream", async (req, reply) => {
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  const id = nextClientId++;
  clients.add({ id, res: reply });
  reply.raw.write(`event: hello\ndata: {"ok":true}\n\n`);
  req.raw.on("close", () => {
    clients.forEach(c => { if (c.id === id) clients.delete(c); });
  });
});

// ------------------------------------------------------------
// Draw (VRF) – scaffold endpoints for Pyth integration
// ------------------------------------------------------------
type DrawStatus = "pending" | "fulfilled" | "failed";
const draws = new Map<string, { mint: string; snapshotHash: string; status: DrawStatus; winner?: string; winnerPct?: number; randomness?: string; proofTx?: string; proofUrl?: string }>();
let lastDrawId: string = "";

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

async function buildSnapshotManifest(mintStr: string) {
  const pk = new PublicKey(mintStr);
  const decimals = await getMintDecimals(conn, pk);
  let snapshot = await fetchHoldersSnapshot(conn, pk);
  if (!snapshot.length) {
    snapshot = await fetchTopHoldersByLargestAccounts(conn, pk, 10000);
  }
  snapshot.sort((a, b) => Number(b.raw - a.raw));
  const totalPre = snapshot.reduce((s, h) => s + h.raw, 0n);
  // Apply holder percentage cap for eligibility (default 10%)
  const capPctEnv = process.env.HOLDER_CAP_PCT ? Number(process.env.HOLDER_CAP_PCT) : 10;
  const capPct = Number.isFinite(capPctEnv) && capPctEnv >= 0 ? capPctEnv : 10;
  // threshold = floor(total * capPct / 100)
  const capThreshold = totalPre === 0n ? 0n : (totalPre * BigInt(capPct)) / 100n;
  const excluded: { owner: string; raw: string; pct: number }[] = [];
  const eligible = [] as { owner: string; raw: bigint }[];
  for (const h of snapshot) {
    if (totalPre > 0n && h.raw > capThreshold) {
      const pct = Number((h.raw * 10000n) / totalPre) / 100;
      excluded.push({ owner: h.owner, raw: h.raw.toString(), pct });
    } else {
      eligible.push(h);
    }
  }
  const total = eligible.reduce((s, h) => s + h.raw, 0n);
  const holderRecords = eligible.map(h => ({ owner: h.owner, raw: h.raw.toString() }));
  const manifest = {
    mint: mintStr,
    decimals,
    totalRaw: total.toString(),
    holders: holderRecords,
    excluded,
  };
  const snapshotHash = sha256Hex(JSON.stringify(manifest));
  return { manifest, snapshotHash };
}

app.post("/draw/snapshot", async (req, reply) => {
  const body = (req.body || {}) as any;
  const mint = String(body.mint || "");
  if (!mint) return reply.status(400).send({ ok: false, error: "missing_mint" });
  try {
    const { manifest, snapshotHash } = await buildSnapshotManifest(mint);
    return { ok: true, snapshotHash, manifest };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

app.post("/draw/start", async (req, reply) => {
  const body = (req.body || {}) as any;
  const mint = String(body.mint || "");
  const drawId = String(body.drawId || "");
  if (!mint || !drawId) return reply.status(400).send({ ok: false, error: "missing_params" });
  try {
    const { snapshotHash } = await buildSnapshotManifest(mint);
    draws.set(drawId, { mint, snapshotHash, status: "pending" });
    // Kick off on-chain start_draw via node script
    const { spawn } = await import("child_process");
    const proc = spawn(process.platform === 'win32' ? 'node.exe' : 'node', [
      "onchain/scripts/start_draw.js"
    ], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        DRAW_ID: drawId,
        TOKEN_MINT: mint,
        SNAPSHOT_HASH: snapshotHash,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let signature = '';
    proc.stdout.on('data', (d) => {
      const s = d.toString();
      const m = s.match(/SIGNATURE:\s*(\w+)/);
      if (m) signature = m[1];
    });
    proc.on('close', () => {
      const cur = draws.get(drawId);
      if (cur && signature) draws.set(drawId, { ...cur, proofTx: signature });
    });
    return { ok: true, drawId, mint, snapshotHash, status: "pending" };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

app.get("/draw/:id", async (req, reply) => {
  const { id } = req.params as { id: string };
  const d = draws.get(id);
  if (!d) return { ok: false, error: "unknown_draw" };
  return { ok: true, ...d };
});

app.get("/draw/latest", async (_req, reply) => {
  if (!lastDrawId) return reply.status(404).send({ ok: false, error: "no_draws" });
  const d = draws.get(lastDrawId);
  if (!d) return reply.status(404).send({ ok: false, error: "no_draws" });
  return { ok: true, drawId: lastDrawId, ...d };
});

// ------------------------------------------------------------
// Simpler verifiable randomness via Drand (public randomness beacon)
// ------------------------------------------------------------
async function fetchDrandLatest(): Promise<{ round: number; randomness: string; signature: string }>{
  const res = await fetch("https://drand.cloudflare.com/public/latest");
  if (!res.ok) throw new Error(`drand_http_${res.status}`);
  const j = await res.json();
  return { round: Number(j.round), randomness: String(j.randomness), signature: String(j.signature) };
}

function pickWeightedWinner(holders: { owner: string; raw: string }[], randomnessHex: string): string {
  if (!holders?.length) throw new Error("no_eligible_holders");
  const weights = holders.map(h => ({ owner: h.owner, w: BigInt(h.raw) })).filter(x => x.w > 0n);
  const totalPre = weights.reduce((s, x) => s + x.w, 0n);
  if (totalPre === 0n) throw new Error("no_eligible_holders");
  // Enforce 10% cap at selection time as a safety net (even if manifest omitted cap)
  const capPctEnv = process.env.HOLDER_CAP_PCT ? Number(process.env.HOLDER_CAP_PCT) : 10;
  const capPct = Number.isFinite(capPctEnv) && capPctEnv >= 0 ? capPctEnv : 10;
  const capThreshold = (totalPre * BigInt(capPct)) / 100n;
  const eligible = weights.filter(x => x.w <= capThreshold);
  if (eligible.length !== weights.length) {
    const excludedCount = weights.length - eligible.length;
    const largest = weights[0]?.w ?? 0n;
    console.log(`[draw] cap ${capPct}% -> excluded ${excludedCount} holders (largest=${largest.toString()}, total=${totalPre.toString()}, threshold=${capThreshold.toString()})`);
  }
  const total = eligible.reduce((s, x) => s + x.w, 0n);
  if (total === 0n) throw new Error("no_eligible_holders");
  // Use 256-bit number from hex randomness, mod total
  const r = BigInt(`0x${randomnessHex}`) % total;
  let acc = 0n;
  for (const x of eligible) { acc += x.w; if (r < acc) return x.owner; }
  return eligible[eligible.length - 1].owner;
}

// Start a Drand-based draw (no on-chain, but publicly verifiable via Drand)
app.post("/draw/start_drand", async (req, reply) => {
  const body = (req.body || {}) as any;
  let mint = String(body.mint || "");
  const drawId = String(body.drawId || `${Date.now()}`);
  if (!mint) {
    mint = store.getMint() || process.env.DEFAULT_MINT || "";
  }
  if (!mint) return reply.status(400).send({ ok: false, error: "missing_mint" });
  try {
    const { manifest, snapshotHash } = await buildSnapshotManifest(mint);
    const d = await fetchDrandLatest();
    const winner = pickWeightedWinner(manifest.holders, d.randomness);
    const totalEligible = BigInt(manifest.totalRaw || "0");
    const winRec = manifest.holders.find((h: any) => h.owner === winner);
    const winRaw = winRec ? BigInt(winRec.raw) : 0n;
    const winnerPct = totalEligible > 0n ? Number((winRaw * 10000n) / totalEligible) / 100 : 0;
    const proofUrl = `https://drand.cloudflare.com/public/${d.round}`;
    draws.set(drawId, { mint, snapshotHash, status: "fulfilled", winner, winnerPct, randomness: d.randomness, proofUrl });
    lastDrawId = drawId;
    return { ok: true, drawId, mint, snapshotHash, winner, winnerPct, randomness: d.randomness, proofUrl };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

app.post("/webhooks/helius", async (req, reply) => {
  const url = req.raw.url || "";
  const urlSecret = url.includes("secret=") ? url.split("secret=")[1].split("&")[0] : undefined;
  if (urlSecret !== WEBHOOK_SECRET) return reply.status(403).send({ ok: false });

  const body = req.body as any;
  const items = Array.isArray(body) ? body : [body];
  for (const item of items) {
    if (item?.type !== "TOKEN_EVENT") continue;
    for (const ev of item.events?.token || []) {
      const activeMint = store.getMint();
      if (!activeMint || ev.mint !== activeMint) continue;
      const raw = BigInt(ev.amount);
      const from = ev.fromUserAccount;
      const to = ev.toUserAccount;
      if (from) store.adjust(from, -raw);
      if (to) store.adjust(to, raw);
      // derive current raw values for from/to after adjustment
      const getRaw = (owner?: string) => {
        if (!owner) return undefined;
        const v = store.getRaw(owner);
        return { owner, raw: v.toString() };
      };
      pushDiff({
        type: "delta",
        mint: activeMint,
        updates: [getRaw(from), getRaw(to)].filter(Boolean),
        totalRaw: store.totalRaw().toString(),
      });
    }
  }
  await store.save();
  return { ok: true };
});

setInterval(async () => {
  if (!store.getMint()) return;
  try { await reconcileAndBroadcast(store.getMint()); } catch {}
}, 10 * 60 * 1000);

// Optional: auto-monitor a default mint from env on startup
const DEFAULT_MINT = process.env.DEFAULT_MINT;
if (DEFAULT_MINT) {
  try {
    await reconcileAndBroadcast(DEFAULT_MINT);
  } catch (e) {
    console.warn(`[warn] Failed to preload DEFAULT_MINT ${DEFAULT_MINT}:`, (e as Error).message);
  }
}

// ------------------------------------------------------------
// Authoritative schedule + automatic drand draw
// ------------------------------------------------------------
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 60 * 60 * 1000);
const DRAW_ANCHOR_MS = Number(process.env.DRAW_ANCHOR_MS || 0); // epoch anchor; set to an exact hour start for hourly cadence

function getNextBoundary(nowMs: number): number {
  const anchor = Number.isFinite(DRAW_ANCHOR_MS) ? DRAW_ANCHOR_MS : 0;
  if (!Number.isFinite(DRAW_INTERVAL_MS) || DRAW_INTERVAL_MS <= 0) return nowMs;
  const n = Math.floor((nowMs - anchor) / DRAW_INTERVAL_MS) + 1;
  return anchor + n * DRAW_INTERVAL_MS;
}

app.get("/schedule", async (_req, reply) => {
  const now = Date.now();
  const nextAt = getNextBoundary(now);
  reply.send({ now, intervalMs: DRAW_INTERVAL_MS, nextAt });
});

// Optional manual trigger endpoint for external cron/scheduler
app.post("/draw/trigger", async (req, reply) => {
  const url = req.raw.url || "";
  const urlSecret = url.includes("secret=") ? url.split("secret=")[1].split("&")[0] : undefined;
  if (urlSecret !== WEBHOOK_SECRET) return reply.status(403).send({ ok: false });
  await triggerDrandDraw();
  return { ok: true };
});

async function triggerDrandDraw() {
  try {
    const activeMint = store.getMint() || process.env.DEFAULT_MINT;
    if (!activeMint) return;
    const drawId = `${Date.now()}`;
    const res = await fetch(`http://localhost:${PORT}/draw/start_drand`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mint: activeMint, drawId })
    });
    if (res.ok) {
      const j = await res.json();
      console.log(`[draw] drand draw completed`, j);
    } else {
      console.warn(`[draw] drand draw failed with status ${res.status}`);
    }
  } catch (e) {
    console.warn('[draw] drand scheduler error', (e as Error).message);
  }
}

function scheduleNextDrawTick() {
  const now = Date.now();
  const nextAt = getNextBoundary(now);
  const delay = Math.max(0, nextAt - now + 250);
  setTimeout(async () => {
    await triggerDrandDraw();
    scheduleNextDrawTick();
  }, delay);
}

// Kick off the scheduler loop
scheduleNextDrawTick();

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`PumpPot holders server listening on ${PORT}`);
});


