import { AmountError, parseAmount } from "../../lib/checkout/amount";
import {
  CheckoutConfigError,
  readCheckoutConfig,
} from "../../lib/checkout/config";
import { jsonField } from "../../lib/checkout/json";
import { orderStore, publicOrder } from "../../lib/checkout/orders";

export const dynamic = "force-dynamic";

/** POST { amount: "12.50" } -> 201 with the new order and its payment URL. */
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

  let amount;
  try {
    amount = parseAmount(jsonField(body, "amount"));
  } catch (error) {
    if (error instanceof AmountError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    throw error;
  }

  const order = orderStore().create(amount, config);
  return Response.json(publicOrder(order), { status: 201 });
}
