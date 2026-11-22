// Read a checkout payment back from devnet at "finalized", independently of
// the app, and check it against the order the checkout page showed.
//
//   node scripts/devnet-verify-payment.mts <signature> <merchant> <amount> <reference>
//
// Read-only: it signs nothing and needs no key. It refuses any RPC whose
// genesis hash is not devnet's, runs @solana/pay's validateTransfer at
// "finalized" with the order's fields, and prints the token balance changes
// so they can be compared with the receipt and the block explorer. Like the
// server, it ignores Compute Budget instructions a wallet appended after the
// transfer (see app/lib/checkout/validation.ts).
import {
  address,
  createSolanaRpc,
  signature as toSignature,
} from "@solana/kit";
import { validateTransfer } from "@solana/pay";
import { forValidation } from "../app/lib/checkout/validation.ts";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

const [sig, merchantArg, amountArg, referenceArg] = process.argv.slice(2);
if (!sig || !merchantArg || !amountArg || !referenceArg) {
  console.error(
    "usage: devnet-verify-payment.mts <signature> <merchant> <amount> <reference>"
  );
  process.exit(2);
}
const signature = toSignature(sig);
const merchant = address(merchantArg);
const reference = address(referenceArg);
const amount = Number(amountArg);
const mint = address(process.env.USDC_MINT?.trim() || DEVNET_USDC_MINT);
const rpc = createSolanaRpc(
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com"
);

const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing: genesis hash ${genesis} is not devnet's`);
  process.exit(1);
}

const transaction = await validateTransfer(
  await forValidation(rpc, signature, "finalized"),
  signature,
  { recipient: merchant, amount, splToken: mint, reference },
  { commitment: "finalized" }
);

console.log(`cluster     devnet (genesis ${genesis})`);
console.log(`signature   ${signature}`);
console.log(
  `explorer    https://explorer.solana.com/tx/${signature}?cluster=devnet`
);
console.log(`slot        ${transaction.slot}`);
console.log(
  `block time  ${transaction.blockTime === null ? "unknown" : new Date(Number(transaction.blockTime) * 1000).toISOString()}`
);
// validateTransfer accepts any amount at or above the expected one; the
// balance lines below show what actually moved.
console.log(
  `validated   finalized: at least ${amount} USDC to ${merchant}, mint ${mint}, reference ${reference}`
);
const pre = transaction.meta?.preTokenBalances ?? [];
for (const post of transaction.meta?.postTokenBalances ?? []) {
  if (post.mint !== mint) continue;
  const before = pre.find(
    (balance) => balance.accountIndex === post.accountIndex
  );
  const delta =
    BigInt(post.uiTokenAmount.amount) -
    BigInt(before?.uiTokenAmount.amount ?? "0");
  console.log(
    `balance     ${post.owner}: ${delta >= 0n ? "+" : ""}${delta} base units of USDC`
  );
}
