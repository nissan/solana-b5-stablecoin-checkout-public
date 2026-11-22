// Make a merchant address payable on devnet: its USDC token account must
// exist, and so must its main (system) account.
//
//   DEVNET_PAYER_KEYPAIR=~/devnet-payer.json MERCHANT_ADDRESS=<address> \
//     node scripts/devnet-merchant-account.mts
//
// Solana Pay transfers go to the merchant's associated token account for the
// mint, and @solana/pay's createTransfer refuses a recipient that has none.
// Older @solana/pay releases, which wallets embed, also refuse a recipient
// whose main account does not exist ("recipient not found"), even for a token
// transfer; a fresh address holding no SOL has none. So this sends whatever is
// missing, idempotently, from the devnet payer: the token account (its rent,
// about 0.0015 SOL) and 0.01 SOL to the merchant. It refuses to sign unless
// the RPC's genesis hash is devnet's, prints the signature and explorer link
// before sending, waits for "finalized" and reads both accounts back. The
// payer keypair is read by path and never printed.
import { readFileSync } from "node:fs";
import {
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  getSignatureFromTransaction,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Instruction,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

/** SOL sent to a merchant whose main account does not exist yet. */
const MERCHANT_SOL = 10_000_000n; // 0.01 SOL

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

const payerPath = required("DEVNET_PAYER_KEYPAIR").replace(
  /^~/,
  process.env.HOME ?? "~"
);
const merchant = address(required("MERCHANT_ADDRESS"));
const mint = address(process.env.USDC_MINT?.trim() || DEVNET_USDC_MINT);
const rpcUrl =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const wsUrl = rpcUrl.replace(/^http/, "ws");

const rpc = createSolanaRpc(rpcUrl);
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing to sign: genesis hash ${genesis} is not devnet's`);
  process.exit(1);
}

const payer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8")) as number[])
);
const [ata] = await findAssociatedTokenPda({
  owner: merchant,
  mint,
  tokenProgram: TOKEN_PROGRAM_ADDRESS,
});
const explorer = (path: string) =>
  `https://explorer.solana.com/${path}?cluster=devnet`;

console.log(`cluster        devnet (genesis ${genesis})`);
console.log(`payer          ${payer.address}`);
console.log(`merchant       ${merchant}`);
console.log(`mint           ${mint}`);
console.log(`token account  ${ata}`);
const before = (
  await rpc.getBalance(payer.address, { commitment: "finalized" }).send()
).value;
console.log(`payer balance  ${before} lamports before`);

const instructions: Instruction[] = [];
const tokenAccount = await rpc
  .getAccountInfo(ata, { encoding: "base64" })
  .send();
if (tokenAccount.value) {
  console.log("token account  already exists");
} else {
  instructions.push(
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      owner: merchant,
      mint,
    })
  );
}
const mainAccount = await rpc
  .getAccountInfo(merchant, { encoding: "base64" })
  .send();
if (mainAccount.value) {
  console.log(
    `main account   already exists (${mainAccount.value.lamports} lamports)`
  );
} else {
  console.log(`main account   absent; sending ${MERCHANT_SOL} lamports`);
  instructions.push(
    getTransferSolInstruction({
      source: payer,
      destination: merchant,
      amount: MERCHANT_SOL,
    })
  );
}

if (instructions.length === 0) {
  console.log("nothing to send");
} else {
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: "finalized" })
    .send();
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    )
  );
  assertIsTransactionWithBlockhashLifetime(signed);
  const signature = getSignatureFromTransaction(signed);
  console.log(`signature      ${signature}`);
  console.log(`explorer       ${explorer(`tx/${signature}`)}`);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions(wsUrl),
  });
  await sendAndConfirm(signed, { commitment: "finalized" });
  console.log("status         finalized");
}

const account = await fetchToken(rpc, ata, { commitment: "finalized" });
console.log(
  `read back      token account owner ${account.data.owner}, mint ${account.data.mint}, amount ${account.data.amount}`
);
const merchantLamports = (
  await rpc.getBalance(merchant, { commitment: "finalized" }).send()
).value;
console.log(
  `read back      merchant main account ${merchantLamports} lamports`
);
if (
  account.data.owner !== merchant ||
  account.data.mint !== mint ||
  merchantLamports === 0n
) {
  console.error("read-back mismatch");
  process.exit(1);
}
const after = (
  await rpc.getBalance(payer.address, { commitment: "finalized" }).send()
).value;
console.log(`payer balance  ${after} lamports after (spent ${before - after})`);
