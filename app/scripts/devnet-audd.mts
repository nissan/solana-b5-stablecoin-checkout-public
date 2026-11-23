// Set up a stand-in AUDD on devnet for the checkout.
//
//   DEVNET_PAYER_KEYPAIR=~/devnet-payer.json MERCHANT_ADDRESS=<address> \
//     [AUDD_MINT=<stand-in made earlier>] [MINT_TO=<wallet> AMOUNT=50] \
//     node scripts/devnet-audd.mts
//
// The issuer's AUDD exists only on mainnet, so on devnet the checkout is
// pointed at a test token that stands in for it. This script makes one: a
// classic SPL token with 6 decimals, like AUDD, whose mint authority is the
// devnet payer. It is NOT the issuer's AUDD and is worth nothing.
//
// It sends whatever is missing, idempotently:
// - the stand-in mint, unless AUDD_MINT names one made earlier;
// - the merchant's token account for it, which Solana Pay transfers need;
// - with MINT_TO, that wallet's token account and AMOUNT stand-in tokens
//   (default 50), so a wallet has something to pay an AUDD order with.
//
// It refuses to sign unless the RPC's genesis hash is devnet's, prints the
// signature and explorer link before sending, waits for "finalized" and reads
// the accounts back. The payer keypair is read by path and never printed.
// Afterwards, start the checkout with AUDD_MINT set to the printed mint.
import { readFileSync } from "node:fs";
import {
  type Address,
  address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DECIMALS = 6;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

/** "50" or "12.5" to base units; at most 6 decimal places, more than zero. */
function baseUnits(text: string): bigint {
  const match = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(text);
  const units = match
    ? BigInt(match[1]!) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))
    : 0n;
  if (units === 0n) {
    console.error(`AMOUNT must be a positive number like 50 or 12.5`);
    process.exit(2);
  }
  return units;
}

const payerPath = required("DEVNET_PAYER_KEYPAIR").replace(
  /^~/,
  process.env.HOME ?? "~"
);
const merchant = address(required("MERCHANT_ADDRESS"));
const existingMint = process.env.AUDD_MINT?.trim();
const mintTo = process.env.MINT_TO?.trim();
const amount = baseUnits(process.env.AMOUNT?.trim() || "50");
const rpcUrl =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";

const rpc = createSolanaRpc(rpcUrl);
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing to sign: genesis hash ${genesis} is not devnet's`);
  process.exit(1);
}
const payer = await createKeyPairSignerFromBytes(
  Uint8Array.from(JSON.parse(readFileSync(payerPath, "utf8")) as number[])
);
const explorer = (path: string) =>
  `https://explorer.solana.com/${path}?cluster=devnet`;
const tokenAccountOf = async (owner: Address, mint: Address) =>
  (
    await findAssociatedTokenPda({
      owner,
      mint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
const exists = async (account: Address) =>
  (await rpc.getAccountInfo(account, { encoding: "base64" }).send()).value !==
  null;

console.log(`cluster        devnet (genesis ${genesis})`);
console.log(`payer          ${payer.address}`);
console.log(`merchant       ${merchant}`);
const before = (
  await rpc.getBalance(payer.address, { commitment: "finalized" }).send()
).value;
console.log(`payer balance  ${before} lamports before`);

const instructions: Instruction[] = [];
let newMint: KeyPairSigner | undefined;
let mint: Address;
if (existingMint) {
  mint = address(existingMint);
  const found = await fetchMint(rpc, mint);
  if (found.data.decimals !== DECIMALS) {
    console.error(
      `AUDD_MINT has ${found.data.decimals} decimals; the stand-in needs ${DECIMALS}`
    );
    process.exit(1);
  }
  console.log(`stand-in mint  ${mint} (already exists)`);
} else {
  newMint = await generateKeyPairSigner();
  mint = newMint.address;
  console.log(
    `stand-in mint  ${mint} (new: ${DECIMALS} decimals, a test token, not the issuer's AUDD)`
  );
  instructions.push(
    getCreateAccountInstruction({
      payer,
      newAccount: newMint,
      lamports: await rpc
        .getMinimumBalanceForRentExemption(BigInt(getMintSize()))
        .send(),
      space: getMintSize(),
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({
      mint,
      decimals: DECIMALS,
      mintAuthority: payer.address,
    })
  );
}

const merchantAccount = await tokenAccountOf(merchant, mint);
console.log(`merchant's token account  ${merchantAccount}`);
if (!newMint && (await exists(merchantAccount))) {
  console.log("               already exists");
} else {
  instructions.push(
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      owner: merchant,
      mint,
    })
  );
}

let walletAccount: Address | undefined;
let walletBefore = 0n;
if (mintTo) {
  const wallet = address(mintTo);
  walletAccount = await tokenAccountOf(wallet, mint);
  console.log(`wallet         ${wallet}`);
  console.log(`wallet's token account    ${walletAccount}`);
  if (!newMint && (await exists(walletAccount))) {
    walletBefore = (await fetchToken(rpc, walletAccount)).data.amount;
  }
  instructions.push(
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      owner: wallet,
      mint,
    }),
    getMintToInstruction({
      mint,
      token: walletAccount,
      mintAuthority: payer,
      amount,
    })
  );
  console.log(`minting        ${amount} base units (${Number(amount) / 1e6})`);
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
    rpcSubscriptions: createSolanaRpcSubscriptions(
      rpcUrl.replace(/^http/, "ws")
    ),
  });
  await sendAndConfirm(signed, { commitment: "finalized" });
  console.log("status         finalized");
}

const readMint = await fetchMint(rpc, mint, { commitment: "finalized" });
const readMerchant = await fetchToken(rpc, merchantAccount, {
  commitment: "finalized",
});
console.log(
  `read back      mint: ${readMint.data.decimals} decimals, supply ${readMint.data.supply}`
);
console.log(
  `read back      merchant's token account: owner ${readMerchant.data.owner}, amount ${readMerchant.data.amount}`
);
let ok =
  readMint.data.decimals === DECIMALS &&
  readMerchant.data.owner === merchant &&
  readMerchant.data.mint === mint;
if (walletAccount) {
  const readWallet = await fetchToken(rpc, walletAccount, {
    commitment: "finalized",
  });
  console.log(
    `read back      wallet's token account: amount ${readWallet.data.amount} (was ${walletBefore})`
  );
  ok &&= readWallet.data.amount === walletBefore + amount;
}
if (!ok) {
  console.error("read-back mismatch");
  process.exit(1);
}
const after = (
  await rpc.getBalance(payer.address, { commitment: "finalized" }).send()
).value;
console.log(`payer balance  ${after} lamports after (spent ${before - after})`);
console.log("");
console.log(`Start the checkout with AUDD_MINT=${mint}`);
