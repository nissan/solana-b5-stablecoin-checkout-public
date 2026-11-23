import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createTransactionMessage,
  getBase64Decoder,
  getBase64EncodedWireTransaction,
  pipe,
  type Rpc,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SolanaRpcApi,
  type TransactionMessageBytesBase64,
} from "@solana/kit";
import { createTransfer, CreateTransferError } from "@solana/pay";
import {
  fetchMaybeToken,
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { formatUnits } from "./amount";
import type { Order } from "./orders";

const LAMPORTS_PER_SOL = 1_000_000_000n;

/** The answer to a wallet that asked for an order's transaction. */
export type WalletAnswer =
  | Readonly<{ ok: true; transaction: string; message: string }>
  | Readonly<{ ok: false; status: 400 | 409; reason: string }>;

function sol(lamports: bigint): string {
  const whole = lamports / LAMPORTS_PER_SOL;
  const fraction = (lamports % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * Check a wallet against an order before it is asked to sign anything, then
 * build the order's token transfer for it to sign, or refuse with a reason a
 * person can act on. Balances are read on the order's cluster, at
 * "confirmed". The transfer is @solana/pay's createTransfer, carrying the
 * order's reference, with the wallet as fee payer; it is returned unsigned.
 */
export async function answerWallet(
  order: Order,
  wallet: Address,
  rpc: Rpc<SolanaRpcApi>
): Promise<WalletAnswer> {
  const refuse = (reason: string, status: 400 | 409 = 400): WalletAnswer => ({
    ok: false,
    status,
    reason,
  });
  // Serving a transaction for a paid order would invite a second payment.
  if (order.status === "paid") return refuse("this order is already paid", 409);

  const network = order.cluster;
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: wallet,
    mint: order.mint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const [{ value: lamports }, token] = await Promise.all([
    rpc.getBalance(wallet, { commitment: "confirmed" }).send(),
    fetchMaybeToken(rpc, tokenAccount, { commitment: "confirmed" }),
  ]);
  const held = token.exists ? token.data.amount : 0n;
  const currency = order.currency;

  if (lamports === 0n && held === 0n) {
    return refuse(
      `this wallet holds no SOL and no ${currency} on ${network}; if the wallet is set to another network, switch it to ${network}`
    );
  }
  if (held < order.amount.units) {
    return refuse(
      `this wallet holds ${formatUnits(held)} ${currency} on ${network} and the order is ${order.amount.display} ${currency}: ${formatUnits(order.amount.units - held)} ${currency} is missing`
    );
  }

  let instructions;
  try {
    instructions = await createTransfer(rpc, createNoopSigner(wallet), {
      recipient: order.merchant,
      amount: order.amount.value,
      splToken: order.mint,
      reference: order.reference,
    });
  } catch (error) {
    if (!(error instanceof CreateTransferError)) throw error;
    return refuse(`the payment cannot be built: ${error.message}`);
  }
  const { value: blockhash } = await rpc
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const transaction = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(wallet, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    )
  );

  // The fee, and the floor a funded account must stay above: an account left
  // with fewer lamports than rent exemption needs, but more than none, makes
  // the transaction fail.
  const messageBase64 = getBase64Decoder().decode(
    transaction.messageBytes
  ) as TransactionMessageBytesBase64;
  const [{ value: fee }, rentFloor] = await Promise.all([
    rpc.getFeeForMessage(messageBase64, { commitment: "confirmed" }).send(),
    rpc.getMinimumBalanceForRentExemption(0n).send(),
  ]);
  const needed = fee ?? 5000n;
  const left = lamports - needed;
  if (left < 0n || (left > 0n && left < rentFloor)) {
    return refuse(
      `this wallet holds ${sol(lamports)} SOL on ${network} and needs at least ${sol(needed + rentFloor)} SOL to pay the network fee and stay open`
    );
  }

  return {
    ok: true,
    transaction: getBase64EncodedWireTransaction(transaction),
    message: `Pay ${order.amount.display} ${currency} for order ${order.id.slice(0, 8)}`,
  };
}
