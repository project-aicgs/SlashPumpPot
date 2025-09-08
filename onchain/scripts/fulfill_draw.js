import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const idl = await anchor.Program.fetchIdl("PmpVRF1111111111111111111111111111111111111", provider);
  const program = new anchor.Program(idl, new PublicKey("PmpVRF1111111111111111111111111111111111111"), provider);

  const [drawState] = PublicKey.findProgramAddressSync(
    [Buffer.from("draw"), provider.wallet.publicKey.toBuffer()],
    program.programId
  );

  const randomnessHex = process.env.RANDOMNESS;
  const winner = new PublicKey(process.env.WINNER || provider.wallet.publicKey);
  if (!randomnessHex) throw new Error("Missing RANDOMNESS");
  const randomness = Buffer.from(randomnessHex, "hex");

  await program.methods
    .fulfillRandomness(Array.from(randomness), winner)
    .accounts({
      authority: provider.wallet.publicKey,
      drawState,
    })
    .rpc();

  console.log("fulfill_randomness submitted", { drawState: drawState.toBase58() });
}

main().catch((e) => { console.error(e); process.exit(1); });

