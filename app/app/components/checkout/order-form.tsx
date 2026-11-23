"use client";

import { Button } from "@ui-sdk/react/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@ui-sdk/react/segmented-control";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Currency } from "../../lib/checkout/config";
import { jsonString } from "../../lib/checkout/json";

/** A currency the server offers, and what a payer should know about it here. */
export type OfferedCurrency = Readonly<{
  currency: Currency;
  note: string | null;
}>;

const USDC_ONLY: readonly OfferedCurrency[] = [
  { currency: "USDC", note: null },
];

/**
 * The merchant picks a currency, when the server offers more than one, and
 * enters an amount in it; the server creates the order. Nothing is converted
 * between currencies.
 */
export function OrderForm({
  currencies = USDC_ONLY,
}: {
  currencies?: readonly OfferedCurrency[];
}) {
  const router = useRouter();
  const [amount, setAmount] = useState("12.50");
  const [currency, setCurrency] = useState<Currency>(currencies[0].currency);
  const [error, setError] = useState<string | null>(null);
  const note = currencies.find((c) => c.currency === currency)?.note ?? null;

  // Returning the promise keeps the UI SDK button pending until it settles,
  // so a second press cannot create a second order.
  async function createOrder() {
    setError(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, currency }),
      });
      const body: unknown = await response.json();
      const id = jsonString(body, "id");
      if (!response.ok || !id) {
        setError(
          jsonString(body, "error") ??
            `could not create the order (${response.status})`
        );
        return;
      }
      router.push(`/orders/${id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  return (
    <form
      onSubmit={(event) => event.preventDefault()}
      className="mt-8 flex max-w-md flex-col gap-3 rounded-xl border border-border bg-card p-6"
    >
      {currencies.length > 1 ? (
        <div className="flex flex-col gap-2">
          <span id="order-currency-label" className="text-sm font-medium">
            Currency
          </span>
          <SegmentedControl
            aria-labelledby="order-currency-label"
            value={currency}
            onValueChange={(value) => {
              // The control can report nothing checked; an order needs one.
              if (value) setCurrency(value);
            }}
            className="inline-flex w-fit gap-1 rounded-lg border border-input bg-background p-1"
          >
            {currencies.map((offered) => (
              <SegmentedControlItem
                key={offered.currency}
                value={offered.currency}
                className="rounded-md px-4 py-1.5 font-mono text-sm data-[checked]:bg-primary data-[checked]:font-semibold data-[checked]:text-primary-foreground"
              >
                {offered.currency}
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </div>
      ) : null}
      <Field
        name="amount"
        invalid={error !== null}
        className="flex flex-col gap-2"
      >
        <FieldLabel className="text-sm font-medium">
          Order amount ({currency})
        </FieldLabel>
        <Input
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onValueChange={(value) => setAmount(value)}
          className="rounded-lg border border-input bg-background px-3 py-2 font-mono data-[invalid]:border-destructive"
        />
        <FieldDescription className="text-xs text-muted">
          Up to six decimals; devnet {currency}
          {note ? ` (${note})` : ""}. No conversion between currencies.
        </FieldDescription>
        <FieldError className="text-sm text-destructive">{error}</FieldError>
      </Field>
      <Button
        type="submit"
        onClick={createOrder}
        pendingAnnouncement="Creating the order"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground data-[pending]:opacity-60"
      >
        Create order
      </Button>
    </form>
  );
}
