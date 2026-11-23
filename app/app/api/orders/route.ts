import { AmountError, parseAmount } from "../../lib/checkout/amount";
import {
  CheckoutConfigError,
  CURRENCIES,
  isCurrency,
  readCheckoutConfig,
} from "../../lib/checkout/config";
import { jsonField } from "../../lib/checkout/json";
import { orderStore, publicOrder } from "../../lib/checkout/orders";
import { rpcFor } from "../../lib/checkout/payment";
import { assertSupportedToken, TokenError } from "../../lib/checkout/tokens";

export const dynamic = "force-dynamic";

/**
 * POST { amount: "12.50", currency?: "USDC" | "AUDD" } -> 201 with the new
 * order and its payment URL. The amount is in the chosen currency; nothing is
 * converted. Without a currency the order is in USDC.
 */
export async function POST(request: Request): Promise<Response> {
  let config;
  try {
    config = readCheckoutConfig();
  } catch (error) {
    if (error instanceof CheckoutConfigError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    throw error;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const currency = jsonField(body, "currency") ?? "USDC";
  if (!isCurrency(currency)) {
    return Response.json(
      { error: `currency must be one of ${CURRENCIES.join(", ")}` },
      { status: 400 }
    );
  }
  const token = config.tokens[currency];
  if (!token) {
    return Response.json(
      { error: `${currency} is not offered here: ${currency}_MINT is not set` },
      { status: 400 }
    );
  }

  let amount;
  try {
    amount = parseAmount(jsonField(body, "amount"), currency);
  } catch (error) {
    if (error instanceof AmountError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  try {
    await assertSupportedToken(rpcFor(config.rpcUrl), config.rpcUrl, token);
  } catch (error) {
    if (error instanceof TokenError) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    // The mint could not be read: no order is created on a guess.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[checkout] could not read the ${currency} mint: ${reason}`);
    return Response.json(
      { error: `could not read the ${currency} mint; try again` },
      { status: 503 }
    );
  }

  const order = orderStore().create(amount, token, config);
  return Response.json(publicOrder(order), { status: 201 });
}
