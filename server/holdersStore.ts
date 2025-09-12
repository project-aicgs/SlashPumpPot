import { writeFile, readFile, mkdir } from "fs/promises";
import { dirname } from "path";

type BalanceMap = Map<string, bigint>;

export class HoldersStore {
  private balances: BalanceMap = new Map();
  private decimals = 0;
  private mint = "";

  constructor(private persistPath = process.env.DATA_DIR ? `${process.env.DATA_DIR}/holders.json` : ".holders.json") {}

  setMint(mint: string, decimals: number) {
    this.mint = mint;
    this.decimals = decimals;
  }

  getDecimals() { return this.decimals; }
  getMint() { return this.mint; }

  setSnapshot(records: { owner: string; raw: bigint }[]) {
    this.balances = new Map(records.map(r => [r.owner, r.raw]));
  }

  adjust(owner: string, delta: bigint) {
    const cur = this.balances.get(owner) ?? 0n;
    const next = cur + delta;
    if (next <= 0n) this.balances.delete(owner);
    else this.balances.set(owner, next);
  }

  getRaw(owner: string): bigint {
    return this.balances.get(owner) ?? 0n;
  }

  toArraySorted() {
    return [...this.balances.entries()].map(([owner, raw]) => ({ owner, raw }))
      .sort((a, b) => Number(b.raw - a.raw));
  }

  totalRaw() {
    let t = 0n;
    for (const v of this.balances.values()) t += v;
    return t;
  }

  async save() {
    // Ensure directory exists (handles missing DATA_DIR mount gracefully)
    try { await mkdir(dirname(this.persistPath), { recursive: true }); } catch {}
    await writeFile(this.persistPath, JSON.stringify({
      mint: this.mint,
      decimals: this.decimals,
      balances: [...this.balances.entries()].map(([k, v]) => [k, v.toString()])
    }, null, 2));
  }

  async load() {
    try {
      const j = JSON.parse(await readFile(this.persistPath, "utf8"));
      this.mint = j.mint || "";
      this.decimals = j.decimals || 0;
      this.balances = new Map(j.balances.map(([k, v]: [string, string]) => [k, BigInt(v)]));
    } catch {}
  }
}

