import {
  type Address,
  createSolanaRpc,
  type GetSignaturesForAddressApi,
  type GetSignatureStatusesApi,
  type GetTransactionApi,
  type Rpc,
  type SolanaRpcApi,
  type Signature,
  type TransactionError,
} from "@solana/kit";
import { validateTransfer, ValidateTransferError } from "@solana/pay";
import type { Order, OrderStore } from "./orders";
import { forValidation } from "./validation";

export type PaymentRpc = Rpc<
  GetSignaturesForAddressApi & GetSignatureStatusesApi & GetTransactionApi
>;

/** How many recent transactions per reference are looked at on each check. */
const SIGNATURE_LIMIT = 25;

/** Plain-language reasons for @solana/pay's terse validation errors. */
const REASONS: Readonly<Record<string, string>> = {
  "amount not transferred":
    "underpaid: less than the order amount reached the merchant",
  "invalid transfer":
    "not a transfer of the order's token to the merchant's token account",
  "invalid references":
    "the transfer does not carry exactly this order's reference",
  "invalid reference 0": "the transfer does not carry this order's reference",
  "missing instruction": "the transaction has no transfer instruction",
};

function reasonFor(error: ValidateTransferError): string {
  const plain =
    REASONS[error.message] ?? "the transaction is not a valid payment";
  return `${plain} (validateTransfer: ${error.message})`;
}

/** A transaction error as text; kit decodes its numbers as bigints. */
function describeError(error: TransactionError): string {
  return JSON.stringify(error, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

/** A signature's on-chain error: null if it succeeded, undefined if not seen yet. */
async function statusError(
  rpc: PaymentRpc,
  signature: Signature
): Promise<TransactionError | null | undefined> {
  const {
    value: [status],
  } = await rpc
    .getSignatureStatuses([signature], { searchTransactionHistory: true })
    .send();
  return status ? status.err : undefined;
}

type TokenBalance = Readonly<{
  owner?: Address;
  mint: Address;
  uiTokenAmount: Readonly<{ amount: string }>;
}>;

type BalanceMeta = Readonly<{
  preTokenBalances?: readonly TokenBalance[];
  postTokenBalances?: readonly TokenBalance[];
}> | null;

/**
 * Base units of `mint` that reached `merchant` in one transaction: the change
 * in the merchant's token balances, so it is what arrived, not what the
 * order asked for.
 */
function receivedUnits(
  meta: BalanceMeta,
  merchant: Address,
  mint: Address
): bigint {
  const held = (balances: readonly TokenBalance[] | undefined) =>
    (balances ?? [])
      .filter((balance) => balance.owner === merchant && balance.mint === mint)
      .reduce(
        (total, balance) => total + BigInt(balance.uiTokenAmount.amount),
        0n
      );
  return held(meta?.postTokenBalances) - held(meta?.preTokenBalances);
}

async function receivedBy(
  rpc: PaymentRpc,
  signature: Signature,
  order: Order
): Promise<bigint> {
  const transaction = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  return transaction
    ? receivedUnits(transaction.meta, order.merchant, order.mint)
    : 0n;
}

/**
 * Judge the transactions that carry an order's reference, oldest first. The
 * first that passes @solana/pay's validateTransfer for this order's
 * recipient, mint, amount and reference pays the order. Every other one is
 * logged against the order and not judged again:
 * - a later valid payment, after the order is paid, is money to refund;
 * - an underpayment is rejected, and the money it moved is money to refund;
 * - anything else is rejected with its reason.
 * Paying more than the order also records the excess as money to refund.
 * A paid order keeps being checked, so a second payment is still seen.
 *
 * findReference is not used: it returns only the oldest transaction, so an
 * order whose first payment was rejected could never see a later correct one.
 *
 * `candidate` checks one signature the caller already has, such as a wallet's
 * receipt, instead of listing the reference.
 */
export async function checkPayment(
  store: OrderStore,
  order: Order,
  rpc: PaymentRpc,
  candidate?: Signature
): Promise<void> {
  const listed: { signature: Signature; err?: TransactionError | null }[] =
    candidate
      ? [{ signature: candidate }]
      : (
          await rpc
            .getSignaturesForAddress(order.reference, {
              commitment: "confirmed",
              limit: SIGNATURE_LIMIT,
            })
            .send()
        )
          .map(({ signature, err }) => ({ signature, err }))
          .reverse();

  for (const { signature, err: listedError } of listed) {
    if (order.judged.has(signature)) continue;

    // A signature can pay one order. Checked before any RPC call, so a replay
    // is refused even if validation would also catch it.
    const owner = store.orderPaidBy(signature);
    if (owner !== undefined) {
      store.reject(order, signature, `signature already paid order ${owner}`);
      continue;
    }

    // A failed transaction is judged here and never reaches validateTransfer:
    // @solana/pay 1.2.0 reports one with JSON.stringify(meta.err), which throws
    // a TypeError on the bigints kit 8 decodes, and that would abort this
    // check at the failed transaction every time.
    const failure =
      listedError !== undefined
        ? listedError
        : await statusError(rpc, signature);
    if (failure === undefined) continue; // not visible yet: judge it later
    if (failure !== null) {
      store.reject(
        order,
        signature,
        `the transaction failed on chain (${describeError(failure)})`
      );
      continue;
    }

    try {
      const transaction = await validateTransfer(
        await forValidation(rpc, signature, "confirmed"),
        signature,
        {
          recipient: order.merchant,
          amount: order.amount.value,
          splToken: order.mint,
          reference: order.reference,
        },
        { commitment: "confirmed" }
      );
      const received = receivedUnits(
        transaction.meta,
        order.merchant,
        order.mint
      );
      if (order.status === "paid") {
        store.recordRefund(order, signature, received, "paid again");
      } else {
        store.markPaid(order, signature, {
          slot: transaction.slot,
          blockTime: transaction.blockTime,
          received,
        });
      }
    } catch (error) {
      if (!(error instanceof ValidateTransferError)) throw error;
      // Not visible at "confirmed" yet: judge it on a later check.
      if (error.message === "not found") continue;
      store.reject(order, signature, reasonFor(error));
      if (error.message === "amount not transferred") {
        const received = await receivedBy(rpc, signature, order);
        store.recordRefund(order, signature, received, "underpaid");
      }
    }
  }
}

const rpcs = new Map<string, Rpc<SolanaRpcApi>>();

/** One RPC client per URL, shared by the payment check and the wallet request. */
export function rpcFor(url: string): Rpc<SolanaRpcApi> {
  let rpc = rpcs.get(url);
  if (!rpc) {
    rpc = createSolanaRpc(url);
    rpcs.set(url, rpc);
  }
  return rpc;
}

const inflight = new Map<string, Promise<void>>();
const lastCheck = new Map<string, number>();

/**
 * checkPayment for the page's polling: one check per order at a time, and
 * none more often than CHECK_INTERVAL_MS (default 1000), so many open pages
 * do not exhaust a public RPC's rate limit.
 */
export function refreshPayment(
  store: OrderStore,
  order: Order,
  rpc: PaymentRpc
): Promise<void> {
  const running = inflight.get(order.id);
  if (running) return running;
  const interval = Number(process.env.CHECK_INTERVAL_MS ?? 1000);
  const last = lastCheck.get(order.id) ?? 0;
  if (Date.now() - last < interval) return Promise.resolve();
  lastCheck.set(order.id, Date.now());
  const check = checkPayment(store, order, rpc).finally(() =>
    inflight.delete(order.id)
  );
  inflight.set(order.id, check);
  return check;
}
