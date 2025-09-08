import { Connection, PublicKey } from "@solana/web3.js";

const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhN3h6iF9b7K5fKje1na43EwxTz");

export function heliusRpcUrl(apiKey: string) {
  return `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
}

export async function getMintDecimals(conn: Connection, mint: PublicKey): Promise<number> {
  try {
    const info = await conn.getParsedAccountInfo(mint, "confirmed");
    const p = (info.value?.data as any)?.parsed?.info;
    if (p && typeof p.decimals === "number") return p.decimals;
  } catch {}
  const supply = await conn.getTokenSupply(mint);
  return supply.value.decimals;
}

/**
 * Fetch a trimmed snapshot of holders for a classic SPL Token mint.
 * Uses dataSlice to only fetch owner(32) + amount(8) bytes per account.
 */
export async function fetchHoldersSnapshot(conn: Connection, mint: PublicKey) {
  const commonBase = {
    commitment: "confirmed" as const,
    dataSlice: { offset: 32, length: 40 },
  };
  const rpcUrl = heliusRpcUrl(process.env.HELIUS_API_KEY || "");
  const classicFilters = [
    { dataSize: 165 },
    { memcmp: { offset: 0, bytes: mint.toBase58() } },
  ];
  const token2022Filters = [
    { memcmp: { offset: 0, bytes: mint.toBase58() } },
  ];

  const [accClassic, acc2022] = await Promise.all([
    getProgramAccountsV2Paged(rpcUrl, TOKEN_PROGRAM, { ...commonBase, filters: classicFilters }),
    getProgramAccountsV2Paged(rpcUrl, TOKEN_2022_PROGRAM, { ...commonBase, filters: token2022Filters }).catch(() => [] as any[]),
  ]);
  const combined = [...accClassic, ...acc2022];
  console.log(`[holders] V2 fetched classic=${accClassic.length} token2022=${acc2022.length}`);
  return aggregateOwnerAmountsFromAccounts(combined);
}

function aggregateOwnerAmountsFromAccounts(accounts: Array<{ account: { data: any } }>) {
  const byOwner = new Map<string, bigint>();
  for (const a of accounts) {
    let buf: Buffer | undefined;
    const d: any = a.account?.data;
    if (Buffer.isBuffer(d)) buf = d as Buffer;
    else if (Array.isArray(d) && typeof d[0] === "string") buf = Buffer.from(d[0], "base64");
    else if (typeof d === "string") buf = Buffer.from(d, "base64");
    if (!buf || buf.length < 40) continue;
    const owner = new PublicKey(buf.subarray(0, 32)).toBase58();
    const amount = buf.readBigUInt64LE(32);
    if (amount > 0n) byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
  }
  return [...byOwner.entries()].map(([owner, raw]) => ({ owner, raw }));
}

async function getProgramAccountsV2Paged(
  rpcUrl: string,
  programId: PublicKey,
  params: { commitment: "confirmed"; filters: any[]; dataSlice: { offset: number; length: number } }
) {
  const collected: any[] = [];
  const limit = 1000;
  let paginationToken: string | undefined = undefined;
  let page = 1;
  for (;;) {
    const options: any = {
      commitment: params.commitment,
      filters: params.filters,
      dataSlice: params.dataSlice,
      encoding: "base64",
      limit,
    };
    if (paginationToken) options.paginationToken = paginationToken; else options.page = page;
    const bodyAny: any = {
      jsonrpc: "2.0",
      id: Date.now(),
      method: "getProgramAccountsV2",
      params: [programId.toBase58(), options],
    };
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(bodyAny),
    });
    if (!res.ok) throw new Error(`gpa_v2_http_${res.status}`);
    const j = await res.json();
    if (j.error) throw new Error(`gpa_v2_rpc_${j.error?.message || j.error}`);

    // Support both shapes
    if (Array.isArray(j.result)) {
      const batch: any[] = j.result;
      if (batch.length === 0) break;
      collected.push(...batch);
      page += 1;
      continue;
    }
    const accounts: any[] = j.result?.accounts || [];
    if (!Array.isArray(accounts) || accounts.length === 0) break;
    collected.push(...accounts);
    paginationToken = j.result?.paginationToken;
    if (!paginationToken) break;
  }
  return collected;
}

export async function fetchTopHoldersByLargestAccounts(
  conn: Connection,
  mint: PublicKey,
  topN: number = 1000
) {
  const largest = await conn.getTokenLargestAccounts(mint, "confirmed");
  const list = (largest.value || []).slice(0, topN);
  const accountPubkeys = list.map((x) => new PublicKey(x.address));
  const byOwner = new Map<string, bigint>();

  // Batch fetch owners of token accounts
  const chunkSize = 100;
  for (let i = 0; i < accountPubkeys.length; i += chunkSize) {
    const chunk = accountPubkeys.slice(i, i + chunkSize);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    for (let j = 0; j < chunk.length; j++) {
      const info = infos[j];
      if (!info || !info.data) continue;
      const buf = Buffer.isBuffer(info.data) ? (info.data as Buffer) : Buffer.from(info.data as any);
      if (buf.length < 72) continue;
      const owner = new PublicKey(buf.subarray(32, 64)).toBase58();
      // amount is not in account info when using getMultipleAccounts; reuse amount from largest list
      const amount = BigInt(list[i + j]?.amount || "0");
      if (amount > 0n) byOwner.set(owner, (byOwner.get(owner) ?? 0n) + amount);
    }
  }
  return [...byOwner.entries()].map(([owner, raw]) => ({ owner, raw }));
}

