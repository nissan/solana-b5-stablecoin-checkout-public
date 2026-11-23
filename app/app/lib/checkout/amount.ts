import { type Currency, TOKEN_DECIMALS } from "./config";

/** Largest invoice this checkout accepts, in whole units of the order's currency. */
export const MAX_AMOUNT = 1_000_000;

export class AmountError extends Error {
  name = "AmountError";
}

export type Amount = Readonly<{
  /** Fixed two-or-more-decimal text for people: "12.50". */
  display: string;
  /** Base units: millionths of the order's currency. */
  units: bigint;
  /** The same amount as a number, for @solana/pay's URL and validation. */
  value: number;
}>;

/**
 * Parse an amount typed by the merchant. Decimal text only, more than zero,
 * at most six decimals (the precision of both tokens) and at most MAX_AMOUNT,
 * so the number handed to @solana/pay converts to base units exactly. The
 * amount is in the order's own currency; nothing is converted.
 */
export function parseAmount(
  input: unknown,
  currency: Currency = "USDC"
): Amount {
  if (typeof input !== "string" && typeof input !== "number") {
    throw new AmountError("amount is required");
  }
  const text = String(input).trim();
  const match = /^(\d{1,7})(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new AmountError(
      `amount must be a number with at most ${TOKEN_DECIMALS} decimals`
    );
  }
  const whole = match[1];
  const fraction = (match[2] ?? "").padEnd(TOKEN_DECIMALS, "0");
  const units =
    BigInt(whole) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt(fraction);
  if (units === 0n) throw new AmountError("amount must be more than zero");
  if (units > BigInt(MAX_AMOUNT) * 10n ** BigInt(TOKEN_DECIMALS)) {
    throw new AmountError(`amount must be at most ${MAX_AMOUNT} ${currency}`);
  }
  return { display: formatUnits(units), units, value: Number(text) };
}

/** "12500000" base units -> "12.50"; keeps every significant decimal. */
export function formatUnits(units: bigint): string {
  const scale = 10n ** BigInt(TOKEN_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale)
    .toString()
    .padStart(TOKEN_DECIMALS, "0")
    .replace(/0+$/, "")
    .padEnd(2, "0");
  return `${whole}.${fraction}`;
}
