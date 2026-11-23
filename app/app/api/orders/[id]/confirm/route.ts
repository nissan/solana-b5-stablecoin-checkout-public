import { isSignature } from "@solana/kit";
import { readCheckoutConfig, tokensOf } from "../../../../lib/checkout/config";
import { jsonField } from "../../../../lib/checkout/json";
import { orderStore, publicOrder } from "../../../../lib/checkout/orders";
import { checkPayment, rpcFor } from "../../../../lib/checkout/payment";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * POST { signature } -> check that one transaction against this order now.
 * For a wallet or script that already holds the signature. The server trusts
 * nothing from the caller but the signature itself: it reads the transaction
 * from the chain and validates it against the order it stores.
 */
export async function POST(
  request: Request,
  { params }: Context
): Promise<Response> {
  const { id } = await params;
  const store = orderStore();
  const order = store.get(id);
  if (!order)
    return Response.json({ error: "order not found" }, { status: 404 });

  let signature: unknown;
  try {
    signature = jsonField(await request.json(), "signature");
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }
  if (typeof signature !== "string" || !isSignature(signature)) {
    return Response.json(
      { error: "signature is not a transaction signature" },
      { status: 400 }
    );
  }

  const config = readCheckoutConfig();
  await checkPayment(store, order, rpcFor(config.rpcUrl), {
    candidate: signature,
    foundBy: "confirm",
    tokens: tokensOf(config),
  });
  return Response.json(publicOrder(order));
}
