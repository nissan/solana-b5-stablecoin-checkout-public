import { readCheckoutConfig } from "../../../lib/checkout/config";
import { orderStore, publicOrder } from "../../../lib/checkout/orders";
import { refreshPayment, rpcFor } from "../../../lib/checkout/payment";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * GET the order. Each request first checks the chain for payments carrying
 * its reference (at most once a second per order), so the checkout page's
 * polling is what moves it to paid, and, once paid, what finds a second
 * payment or anything else owed back.
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
    await refreshPayment(store, order, rpcFor(readCheckoutConfig().rpcUrl));
  } catch (error) {
    // An RPC failure is not a verdict on the payment: report it, keep polling.
    checkError = error instanceof Error ? error.message : String(error);
    console.error(`[checkout] order ${id} payment check failed: ${checkError}`);
  }
  return Response.json({ ...publicOrder(order), checkError });
}
