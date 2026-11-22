"use client";

import { Button } from "@ui-sdk/react/button";
import { useEffect, useState } from "react";
import { jsonString } from "../../lib/checkout/json";
import type { PublicOrder, RefundReason } from "../../lib/checkout/orders";
import { ellipsify, getExplorerUrl } from "../../lib/explorer";
import { PaymentQR } from "./payment-qr";

const POLL_MS = 1500;

const REFUND_REASONS: Readonly<Record<RefundReason, string>> = {
  overpaid: "paid more than the order",
  "paid again": "paid again after the order was paid",
  underpaid: "too little to pay the order",
};

type OrderResponse = PublicOrder & { checkError?: string | null };

/**
 * The checkout page for one order: link and QR while unpaid, then the
 * receipt, and any money owed back. It polls the server, which checks the
 * chain, for as long as it is open, so a second payment still shows.
 */
export function CheckoutView({ id }: { id: string }) {
  const [order, setOrder] = useState<OrderResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const response = await fetch(`/api/orders/${id}`, {
          cache: "no-store",
        });
        const body: unknown = await response.json();
        if (stopped) return;
        if (!response.ok) {
          setLoadError(
            jsonString(body, "error") ??
              `could not load the order (${response.status})`
          );
          return;
        }
        // A 200 from this app's own route is publicOrder() plus checkError.
        const next = body as OrderResponse;
        setLoadError(null);
        setOrder(next);
      } catch (cause) {
        if (stopped) return;
        setLoadError(cause instanceof Error ? cause.message : String(cause));
      }
      timer = setTimeout(poll, POLL_MS);
    }
    void poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [id]);

  if (!order) {
    return (
      <p
        className="mt-8 text-sm text-muted"
        role={loadError ? "alert" : "status"}
      >
        {loadError ?? "Loading the order…"}
      </p>
    );
  }

  const rejected = order.events.filter((event) => event.kind === "rejected");
  const refused = order.events.filter((event) => event.kind === "refused");
  // A transaction request lets the server see the wallet before it signs, and
  // refuse with a reason; it needs the server reachable over https.
  const payUrl = order.requestUrl ?? order.url;

  return (
    <section className="mt-8 grid gap-8 md:grid-cols-[auto_1fr]">
      {order.status === "unpaid" ? (
        <div className="flex flex-col items-center gap-3">
          <PaymentQR url={payUrl} />
          <Button
            render={<a href={payUrl} />}
            className="rounded-lg border border-border px-4 py-2 text-sm font-semibold"
          >
            Open in a wallet
          </Button>
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <p className="text-4xl font-black tracking-tight">
          {order.amount} <span className="text-muted">USDC</span>
        </p>
        <p
          role="status"
          className={
            order.status === "paid"
              ? "text-lg font-semibold text-green-600"
              : "text-lg font-semibold"
          }
        >
          {order.status === "paid" ? "Paid" : "Waiting for payment"}
        </p>

        {order.receipt ? (
          <dl
            aria-label="Receipt"
            className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm"
          >
            <dt className="text-muted">Signature</dt>
            <dd className="font-mono break-all">
              <a
                href={getExplorerUrl(
                  `/tx/${order.receipt.signature}`,
                  order.cluster
                )}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-4"
              >
                {order.receipt.signature}
              </a>
            </dd>
            <dt className="text-muted">Received</dt>
            <dd className="font-mono">{order.receipt.received} USDC</dd>
            <dt className="text-muted">Slot</dt>
            <dd className="font-mono">{order.receipt.slot}</dd>
            <dt className="text-muted">Block time</dt>
            <dd className="font-mono">
              {order.receipt.blockTime ?? "unknown"}
            </dd>
            <dt className="text-muted">Confirmed as</dt>
            <dd className="font-mono">{order.receipt.commitment}</dd>
          </dl>
        ) : null}

        {order.refunds.length > 0 ? (
          <section aria-label="To refund">
            <h2 className="text-sm font-semibold text-destructive">
              To refund: {order.refundDue} USDC
            </h2>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {order.refunds.map((refund) => (
                <li key={refund.signature} className="font-mono">
                  <a
                    href={getExplorerUrl(
                      `/tx/${refund.signature}`,
                      order.cluster
                    )}
                    target="_blank"
                    rel="noreferrer"
                    title={refund.signature}
                    className="underline underline-offset-4"
                  >
                    {ellipsify(refund.signature, 6)}
                  </a>
                  : {refund.amount} USDC, {REFUND_REASONS[refund.reason]}
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted">Order</dt>
          <dd className="font-mono">{order.id}</dd>
          <dt className="text-muted">Merchant</dt>
          <dd className="font-mono" title={order.merchant}>
            {ellipsify(order.merchant, 6)}
          </dd>
          <dt className="text-muted">Token</dt>
          <dd className="font-mono" title={order.mint}>
            USDC {ellipsify(order.mint, 6)}
          </dd>
          <dt className="text-muted">Reference</dt>
          <dd className="font-mono" title={order.reference}>
            {ellipsify(order.reference, 6)}
          </dd>
          <dt className="text-muted">Network</dt>
          <dd className="font-mono">{order.cluster}</dd>
        </dl>

        {rejected.length > 0 ? (
          <div>
            <h2 className="text-sm font-semibold">Rejected payments</h2>
            <ul
              aria-label="Rejected payments"
              className="mt-1 flex flex-col gap-1 text-sm"
            >
              {rejected.map((event) => (
                <li
                  key={`${event.signature}-${event.at}`}
                  className="font-mono text-destructive"
                >
                  {event.signature ? `${ellipsify(event.signature, 6)}: ` : ""}
                  {event.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {refused.length > 0 ? (
          <div>
            <h2 className="text-sm font-semibold">
              Wallets that could not pay
            </h2>
            <ul
              aria-label="Wallets that could not pay"
              className="mt-1 flex flex-col gap-1 text-sm"
            >
              {refused.map((event) => (
                <li
                  key={`${event.wallet}-${event.at}`}
                  className="font-mono text-destructive"
                >
                  {event.wallet ? `${ellipsify(event.wallet, 6)}: ` : ""}
                  {event.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {order.checkError ? (
          <p className="text-sm text-muted">
            Last check failed, retrying: {order.checkError}
          </p>
        ) : null}
        {loadError ? <p className="text-sm text-muted">{loadError}</p> : null}
      </div>
    </section>
  );
}
