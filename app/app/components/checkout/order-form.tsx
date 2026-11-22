"use client";

import { Button } from "@ui-sdk/react/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@ui-sdk/react/field";
import { Input } from "@ui-sdk/react/input";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { jsonString } from "../../lib/checkout/json";

/** The merchant enters an amount; the server creates the order. */
export function OrderForm() {
  const router = useRouter();
  const [amount, setAmount] = useState("12.50");
  const [error, setError] = useState<string | null>(null);

  // Returning the promise keeps the UI SDK button pending until it settles,
  // so a second press cannot create a second order.
  async function createOrder() {
    setError(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
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
      <Field
        name="amount"
        invalid={error !== null}
        className="flex flex-col gap-2"
      >
        <FieldLabel className="text-sm font-medium">
          Order amount (USDC)
        </FieldLabel>
        <Input
          inputMode="decimal"
          autoComplete="off"
          value={amount}
          onValueChange={(value) => setAmount(value)}
          className="rounded-lg border border-input bg-background px-3 py-2 font-mono data-[invalid]:border-destructive"
        />
        <FieldDescription className="text-xs text-muted">
          Up to six decimals; devnet USDC.
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
