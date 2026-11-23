import { createHash, timingSafeEqual } from "node:crypto";
import {
  type Address,
  isAddress,
  isSignature,
  type Signature,
} from "@solana/kit";
import { type CheckoutConfig, tokensOf } from "./config";
import { jsonField } from "./json";
import type { Order, OrderStore } from "./orders";
import { checkPayment, type PaymentRpc } from "./payment";

/** Largest webhook body accepted, in characters. */
export const MAX_WEBHOOK_BODY = 1_000_000;
/** Most transactions looked at in one webhook call. */
export const MAX_WEBHOOK_TRANSACTIONS = 50;
/** Most accounts read from one transaction in a webhook call. */
const MAX_ACCOUNTS = 256;

/**
 * Does the Authorization header carry the shared secret? Compared in constant
 * time, on digests, so neither the secret's length nor how much of it matched
 * can be learned from how long the answer takes.
 */
export function authorised(header: string | null, secret: string): boolean {
  if (header === null) return false;
  const digest = (text: string) => createHash("sha256").update(text).digest();
  return timingSafeEqual(digest(header), digest(secret));
}

/** One transaction a webhook call names, and the accounts it says it touches. */
export type Named = Readonly<{ signature: Signature; accounts: Address[] }>;

function addresses(values: unknown, into: Set<Address>): void {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    if (into.size >= MAX_ACCOUNTS) return;
    // Raw transactions list keys as strings, or as { pubkey } when parsed;
    // enhanced ones list { account }.
    const text =
      typeof value === "string"
        ? value
        : (jsonField(value, "pubkey") ?? jsonField(value, "account"));
    if (typeof text === "string" && isAddress(text)) into.add(text);
  }
}

/**
 * Read which transactions a webhook body names. The body is a hint and is
 * trusted for nothing else: a signature says where to look on the chain, and
 * the accounts say which orders might care. Two shapes are understood, both
 * Helius's: a raw transaction ({ transaction: { signatures, message }, meta })
 * and an enhanced one ({ signature, accountData, instructions }). Anything
 * that is not a well-formed signature is skipped.
 */
export function namedTransactions(body: unknown): Named[] {
  const items = Array.isArray(body) ? body : [body];
  const named: Named[] = [];
  for (const item of items.slice(0, MAX_WEBHOOK_TRANSACTIONS)) {
    const transaction = jsonField(item, "transaction");
    const signatures = jsonField(transaction, "signatures");
    const signature =
      jsonField(item, "signature") ??
      (Array.isArray(signatures) ? signatures[0] : undefined);
    if (typeof signature !== "string" || !isSignature(signature)) continue;

    const accounts = new Set<Address>();
    addresses(
      jsonField(jsonField(transaction, "message"), "accountKeys"),
      accounts
    );
    const loaded = jsonField(jsonField(item, "meta"), "loadedAddresses");
    addresses(jsonField(loaded, "writable"), accounts);
    addresses(jsonField(loaded, "readonly"), accounts);
    addresses(jsonField(item, "accountData"), accounts);
    const instructions = jsonField(item, "instructions");
    if (Array.isArray(instructions)) {
      for (const instruction of instructions) {
        addresses(jsonField(instruction, "accounts"), accounts);
      }
    }
    named.push({ signature, accounts: [...accounts] });
  }
  return named;
}

/** The accounts of a transaction, read from the chain, when the body gave none. */
async function accountsOnChain(
  rpc: PaymentRpc,
  signature: Signature
): Promise<Address[]> {
  const transaction = await rpc
    .getTransaction(signature, {
      commitment: "confirmed",
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  if (!transaction) return [];
  return [
    ...transaction.transaction.message.accountKeys,
    ...(transaction.meta?.loadedAddresses?.writable ?? []),
    ...(transaction.meta?.loadedAddresses?.readonly ?? []),
  ];
}

/**
 * Look at a transaction a webhook named, for one order. A provider can call
 * the moment a transaction confirms, before this server's RPC shows it, so an
 * unseen transaction is looked at again after each configured delay.
 *
 * A look that fails, because the RPC is rate-limiting or unreachable, is not
 * a verdict and does not end the check: the next look is still made. Never
 * rejects. If every look fails or sees nothing, the fallback poll remains.
 */
async function checkNamed(
  store: OrderStore,
  order: Order,
  rpc: PaymentRpc,
  signature: Signature,
  config: CheckoutConfig
): Promise<void> {
  for (const delay of config.webhook?.retryDelaysMs ?? [0]) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      await checkPayment(store, order, rpc, {
        candidate: signature,
        foundBy: "webhook",
        tokens: tokensOf(config),
      });
    } catch (error) {
      console.error(
        `[checkout] webhook look at ${signature} for order ${order.id} failed: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    // Judged, one way or the other: paid, rejected or recorded to refund.
    if (order.judged.has(signature)) return;
  }
  // Still not judged. The fallback poll will find it if it ever lands.
}

export type WebhookOutcome = Readonly<{
  /** Transactions the call named with a well-formed signature. */
  named: number;
  /** How many of them carry the reference of one of this server's orders. */
  matched: number;
}>;

/**
 * Act on an authenticated webhook call: for every transaction it names that
 * carries one of this server's order references, read that transaction from
 * the chain and judge it against the order, exactly as a poll would. Nothing
 * in the body decides anything: a body that lies costs only an RPC read, and
 * a repeated delivery finds the signature already judged.
 *
 * Returns what was matched at once, and `done`, which settles when every
 * check has finished.
 */
export function handleWebhook(
  store: OrderStore,
  rpc: PaymentRpc,
  config: CheckoutConfig,
  body: unknown
): { outcome: Promise<WebhookOutcome>; done: Promise<void> } {
  const checks: Promise<void>[] = [];
  const outcome = (async (): Promise<WebhookOutcome> => {
    const named = namedTransactions(body);
    let matched = 0;
    for (const { signature, accounts } of named) {
      const keys =
        accounts.length > 0 ? accounts : await accountsOnChain(rpc, signature);
      const orders = new Set<Order>();
      for (const key of keys) {
        const order = store.findByReference(key);
        if (order) orders.add(order);
      }
      if (orders.size > 0) matched += 1;
      for (const order of orders) {
        checks.push(checkNamed(store, order, rpc, signature, config));
      }
    }
    // Signatures are public; the caller's secret is never logged.
    console.info(
      `[checkout] webhook call accepted: ${named.length} transaction(s) named, ${matched} carrying an order's reference` +
        (named.length > 0
          ? `: ${named
              .slice(0, 3)
              .map((n) => n.signature)
              .join(", ")}${named.length > 3 ? ", ..." : ""}`
          : "")
    );
    return { named: named.length, matched };
  })();
  const done = outcome.then(
    () => Promise.all(checks).then(() => undefined),
    () => undefined
  );
  pending.add(done);
  void done.finally(() => pending.delete(done));
  return { outcome, done };
}

const pending = new Set<Promise<void>>();

/** Settles when every webhook check started so far has finished. For tests and scripts. */
export async function webhookSettled(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}
