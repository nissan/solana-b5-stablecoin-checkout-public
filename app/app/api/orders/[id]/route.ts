import { readCheckoutConfig } from "../../../lib/checkout/config";
import { orderStore, publicOrder } from "../../../lib/checkout/orders";
import { refreshPayment, rpcFor } from "../../../lib/checkout/payment";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * GET the order. Each request may first check the chain for payments carrying
 * its reference, so the checkout page's polling moves it to paid, and, once
 * paid, finds a second payment or anything else owed back. Without webhooks
 * that is at most once a second per order. With webhooks on, a webhook call
 * is what prompts a check, and this one only runs at the slower fallback
 * interval, in case a call never arrives.
 */
export async function GET(
  _request: Request,
  { params }: Context
): Promise<Response> {
  const { id } = await params;
  const store = orderStore();
  const order = store.get(id);
  if (!order)
    return Response.json({ error: "order not found" }, { status: 404 });

  let checkError: string | null = null;
  try {
    const config = readCheckoutConfig();
    await refreshPayment(store, order, rpcFor(config.rpcUrl), config);
  } catch (error) {
    // An RPC failure is not a verdict on the payment: report it, keep polling.
    checkError = error instanceof Error ? error.message : String(error);
    console.error(`[checkout] order ${id} payment check failed: ${checkError}`);
  }
  return Response.json({ ...publicOrder(order), checkError });
}
