// Pay a checkout order on devnet as a scripted customer.
//
//   CUSTOMER_KEYPAIR=~/customer.json node scripts/devnet-pay.mts '<solana: link>' [amount]
//
// Builds the transfer from the order's Solana Pay link with @solana/pay's
// createTransfer, as a wallet does. An optional amount replaces the link's,
// to try an overpayment or an underpayment, which a wallet scanning the QR
// cannot do. It refuses to sign unless the RPC's genesis hash is devnet's,
// prints the signature and explorer link before sending, waits for
// "finalized" and reads both USDC balances back. The keypair is read by path
// and never printed.
import { readFileSync } from "node:fs";
import {
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
} from "@solana/kit";
import { createTransfer, parseURL, type TransferRequestURL } from "@solana/pay";
import {
  fetchToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

const [link, amountArg] = process.argv.slice(2);
const keypairPath = process.env.CUSTOMER_KEYPAIR?.trim();
if (!link || !keypairPath) {
  console.error(
    "usage: CUSTOMER_KEYPAIR=<path> devnet-pay.mts '<solana: link>' [amount]"
  );
  process.exit(2);
}
const request = parseURL(link);
if (!("recipient" in request) || !request.splToken || !request.amount) {
  console.error("the link is not a token transfer request with an amount");
  process.exit(2);
}
const transfer: TransferRequestURL = request;
const amount = amountArg === undefined ? transfer.amount! : Number(amountArg);
if (!Number.isFinite(amount) || amount <= 0) {
  console.error(`amount ${amountArg} is not a positive number`);
  process.exit(2);
}

const rpcUrl =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing to sign: genesis hash ${genesis} is not devnet's`);
  process.exit(1);
}

const customer = await createKeyPairSignerFromBytes(
  Uint8Array.from(
    JSON.parse(
      readFileSync(keypairPath.replace(/^~/, process.env.HOME ?? "~"), "utf8")
    ) as number[]
  )
);
const mint = transfer.splToken!;
const tokenAccount = async (owner: typeof customer.address) =>
  (
    await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
const customerAta = await tokenAccount(customer.address);
const merchantAta = await tokenAccount(transfer.recipient);
const balances = async () =>
  Promise.all(
    [customerAta, merchantAta].map(
      async (ata) =>
        (await fetchToken(rpc, ata, { commitment: "finalized" })).data.amount
    )
  );

console.log(`cluster      devnet (genesis ${genesis})`);
console.log(`customer     ${customer.address}`);
console.log(`merchant     ${transfer.recipient}`);
console.log(`mint         ${mint}`);
console.log(`reference    ${transfer.reference?.join(", ") ?? "none"}`);
console.log(`link amount  ${transfer.amount}; paying ${amount}`);
const [customerBefore, merchantBefore] = await balances();

const instructions = await createTransfer(rpc, customer, {
  recipient: transfer.recipient,
  amount,
  splToken: mint,
  reference: transfer.reference,
  memo: transfer.memo,
});
const { value: blockhash } = await rpc
  .getLatestBlockhash({ commitment: "finalized" })
  .send();
const signed = await signTransactionMessageWithSigners(
  pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(customer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  )
);
assertIsTransactionWithBlockhashLifetime(signed);
const signature = getSignatureFromTransaction(signed);
console.log(`signature    ${signature}`);
console.log(
  `explorer     https://explorer.solana.com/tx/${signature}?cluster=devnet`
);
await sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")),
})(signed, { commitment: "finalized" });
console.log("status       finalized");

const [customerAfter, merchantAfter] = await balances();
console.log(
  `read back    customer ${customerBefore} -> ${customerAfter}, merchant ${merchantBefore} -> ${merchantAfter} (USDC base units)`
);
