import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { encodeURL } from "@solana/pay";
import { type Amount, formatUnits } from "./amount";
import type { CheckoutConfig, Cluster, Currency, Token } from "./config";

export type OrderEvent = Readonly<{
  at: string;
  /**
   * "requested": a wallet was sent this order's transaction to sign;
   * "refused": a wallet asked for it and was refused, with the reason.
   */
  kind: "created" | "rejected" | "paid" | "refund" | "requested" | "refused";
  message: string;
  signature?: Signature;
  wallet?: Address;
}>;

/**
 * What made the server look at the transaction that paid the order:
 * - poll: the checkout page's polling;
 * - webhook: an authenticated webhook call naming the transaction;
 * - confirm: a caller that submitted the signature.
 * In every case the server read the transaction from the chain itself.
 */
export type FoundBy = "poll" | "webhook" | "confirm";

export type Receipt = Readonly<{
  signature: Signature;
  slot: string;
  blockTime: string | null;
  commitment: "confirmed";
  /** What actually reached the merchant, which can be more than the order. */
  received: string;
  paidAt: string;
  foundBy: FoundBy;
}>;

/**
 * Why money that reached the merchant is owed back:
 * - overpaid: the excess of the payment that paid the order;
 * - paid again: a valid payment after the order was already paid;
 * - underpaid: a payment too small to pay the order, which still arrived.
 */
export type RefundReason = "overpaid" | "paid again" | "underpaid";

export type Refund = Readonly<{
  signature: Signature;
  units: bigint;
  reason: RefundReason;
  at: string;
}>;

export type Order = {
  readonly id: string;
  readonly amount: Amount;
  /** The currency the amount is in. Nothing is converted. */
  readonly currency: Currency;
  /** Something the payer should know about this token here, or null. */
  readonly currencyNote: string | null;
  readonly merchant: Address;
  readonly mint: Address;
  readonly cluster: Cluster;
  readonly reference: Address;
  /** The Solana Pay transfer request: the order's fields, for any wallet. */
  readonly url: string;
  /**
   * The Solana Pay transaction request, when the server has a public https
   * address: the wallet asks the server for the transaction, so the server
   * sees the wallet before anything is signed.
   */
  readonly requestUrl: string | null;
  readonly createdAt: string;
  status: "unpaid" | "paid";
  receipt: Receipt | null;
  readonly events: OrderEvent[];
  /** Money that reached the merchant for this order and is owed back. */
  readonly refunds: Refund[];
  /** Signatures already judged for this order, so a poll does not repeat them. */
  readonly judged: Set<Signature>;
};

export class OrderStoreError extends Error {
  name = "OrderStoreError";
}

const LABEL = "Stablecoin checkout";

function randomReference(): Address {
  // A reference is any public key nobody else uses: 32 random bytes.
  return getAddressDecoder().decode(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * Orders held in this server's memory. One instance per process; a restart
 * forgets every order. Two indexes enforce the rules validation relies on:
 * a reference belongs to exactly one order, and a signature can pay at most
 * one order.
 */
export class OrderStore {
  private readonly orders = new Map<string, Order>();
  private readonly byReference = new Map<Address, string>();
  private readonly paidBySignature = new Map<Signature, string>();

  constructor(
    private readonly newReference: () => Address = randomReference,
    private readonly now: () => Date = () => new Date()
  ) {}

  create(amount: Amount, token: Token, config: CheckoutConfig): Order {
    const reference = this.newReference();
    if (this.byReference.has(reference)) {
      throw new OrderStoreError(
        `reference ${reference} already belongs to order ${this.byReference.get(reference)}`
      );
    }
    const id = crypto.randomUUID();
    const url = encodeURL({
      recipient: config.merchant,
      amount: amount.value,
      splToken: token.mint,
      reference,
      label: LABEL,
      message: `Order ${id.slice(0, 8)}`,
    }).toString();
    const requestUrl = config.publicUrl
      ? encodeURL({
          link: new URL(`${config.publicUrl}/api/orders/${id}/pay`),
          label: LABEL,
          message: `Order ${id.slice(0, 8)}`,
        }).toString()
      : null;
    const order: Order = {
      id,
      amount,
      currency: token.currency,
      currencyNote: token.note,
      merchant: config.merchant,
      mint: token.mint,
      cluster: config.cluster,
      reference,
      url,
      requestUrl,
      createdAt: this.now().toISOString(),
      status: "unpaid",
      receipt: null,
      events: [],
      refunds: [],
      judged: new Set(),
    };
    this.orders.set(id, order);
    this.byReference.set(reference, id);
    this.log(order, "created", `Order for ${amount.display} ${order.currency}`);
    return order;
  }

  get(id: string): Order | undefined {
    return this.orders.get(id);
  }

  /** The order a reference belongs to, if it is one of this server's. */
  findByReference(reference: Address): Order | undefined {
    const id = this.byReference.get(reference);
    return id === undefined ? undefined : this.orders.get(id);
  }

  /** The order a signature already paid, if any. */
  orderPaidBy(signature: Signature): string | undefined {
    return this.paidBySignature.get(signature);
  }

  reject(order: Order, signature: Signature, reason: string): void {
    if (order.judged.has(signature)) return;
    order.judged.add(signature);
    this.log(order, "rejected", reason, signature);
    console.warn(
      `[checkout] order ${order.id} payment ${signature} rejected: ${reason}`
    );
  }

  /**
   * Record money owed back, once per signature. A "paid again" refund is also
   * refused for a signature already judged: under two concurrent checks it may
   * be the very payment that paid the order. (An overpaid or underpaid refund
   * is recorded right after its own signature is judged, so it cannot use
   * that test.)
   */
  recordRefund(
    order: Order,
    signature: Signature,
    units: bigint,
    reason: RefundReason
  ): void {
    if (units <= 0n || order.refunds.some((r) => r.signature === signature)) {
      return;
    }
    if (reason === "paid again" && order.judged.has(signature)) return;
    order.judged.add(signature);
    order.refunds.push({
      signature,
      units,
      reason,
      at: this.now().toISOString(),
    });
    this.log(
      order,
      "refund",
      `${formatUnits(units)} ${order.currency} to refund: ${reason}`,
      signature
    );
  }

  markPaid(
    order: Order,
    signature: Signature,
    found: { slot: bigint; blockTime: bigint | null; received: bigint },
    foundBy: FoundBy
  ): void {
    if (order.status === "paid" || order.judged.has(signature)) return;
    const owner = this.paidBySignature.get(signature);
    if (owner !== undefined && owner !== order.id) {
      throw new OrderStoreError(
        `signature ${signature} already paid order ${owner}`
      );
    }
    order.judged.add(signature);
    order.status = "paid";
    order.receipt = {
      signature,
      slot: found.slot.toString(),
      blockTime:
        found.blockTime === null
          ? null
          : new Date(Number(found.blockTime) * 1000).toISOString(),
      commitment: "confirmed",
      received: formatUnits(found.received),
      paidAt: this.now().toISOString(),
      foundBy,
    };
    this.paidBySignature.set(signature, order.id);
    this.log(
      order,
      "paid",
      `Paid ${order.amount.display} ${order.currency}`,
      signature
    );
    if (found.received > order.amount.units) {
      this.recordRefund(
        order,
        signature,
        found.received - order.amount.units,
        "overpaid"
      );
    }
  }

  /** A wallet asked for this order's transaction and was sent it. */
  walletServed(order: Order, wallet: Address): void {
    this.log(
      order,
      "requested",
      `Transaction sent to wallet ${wallet}`,
      undefined,
      wallet
    );
  }

  /** A wallet asked for this order's transaction and was refused. */
  walletRefused(order: Order, wallet: Address, reason: string): void {
    this.log(order, "refused", reason, undefined, wallet);
    console.warn(
      `[checkout] order ${order.id} wallet ${wallet} refused: ${reason}`
    );
  }

  private log(
    order: Order,
    kind: OrderEvent["kind"],
    message: string,
    signature?: Signature,
    wallet?: Address
  ): void {
    order.events.push({
      at: this.now().toISOString(),
      kind,
      message,
      ...(signature ? { signature } : {}),
      ...(wallet ? { wallet } : {}),
    });
  }
}

/** What the browser is shown. The judged-signature set stays on the server. */
export type PublicRefund = Readonly<{
  signature: Signature;
  amount: string;
  reason: RefundReason;
  at: string;
}>;

export type PublicOrder = Readonly<{
  id: string;
  amount: string;
  currency: Currency;
  currencyNote: string | null;
  merchant: Address;
  mint: Address;
  cluster: Cluster;
  reference: Address;
  url: string;
  requestUrl: string | null;
  createdAt: string;
  status: Order["status"];
  receipt: Receipt | null;
  /** Total owed back, "0.00" when nothing is. */
  refundDue: string;
  refunds: readonly PublicRefund[];
  events: readonly OrderEvent[];
}>;

export function publicOrder(order: Order): PublicOrder {
  return {
    id: order.id,
    amount: order.amount.display,
    currency: order.currency,
    currencyNote: order.currencyNote,
    merchant: order.merchant,
    mint: order.mint,
    cluster: order.cluster,
    reference: order.reference,
    url: order.url,
    requestUrl: order.requestUrl,
    createdAt: order.createdAt,
    status: order.status,
    receipt: order.receipt,
    refundDue: formatUnits(
      order.refunds.reduce((total, refund) => total + refund.units, 0n)
    ),
    refunds: order.refunds.map((refund) => ({
      signature: refund.signature,
      amount: formatUnits(refund.units),
      reason: refund.reason,
      at: refund.at,
    })),
    events: order.events,
  };
}

const globalStore = globalThis as typeof globalThis & {
  __checkoutOrders?: OrderStore;
};

/** The process-wide store, kept on globalThis so dev-server reloads keep it. */
export function orderStore(): OrderStore {
  globalStore.__checkoutOrders ??= new OrderStore();
  return globalStore.__checkoutOrders;
}
