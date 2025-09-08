import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = await anchor.Program.fetchIdl("PmpVRF1111111111111111111111111111111111111", provider);
  const program = new anchor.Program(idl, new PublicKey("PmpVRF1111111111111111111111111111111111111"), provider);

  const [drawState] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  const drawId = process.env.DRAW_ID || `${Date.now()}`;
  const tokenMint = new PublicKey(process.env.TOKEN_MINT);
  const snapshotHashHex = process.env.SNAPSHOT_HASH;
  if (!snapshotHashHex) throw new Error("Missing SNAPSHOT_HASH");
  const snapshotHash = Buffer.from(snapshotHashHex, "hex");

  const sig = await program.methods
    .startDraw(drawId, tokenMint, Array.from(snapshotHash))
    .accounts({
      authority: provider.wallet.publicKey,
      drawState,
      systemProgram: SystemProgram.programId
    })
    .rpc();

  console.log("start_draw submitted", { drawId, drawState: drawState.toBase58(), signature: sig });
  console.log("SIGNATURE:", sig);
}

main().catch((e) => { console.error(e); process.exit(1); });

