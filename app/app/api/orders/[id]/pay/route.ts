import { isAddress } from "@solana/kit";
import { readCheckoutConfig } from "../../../../lib/checkout/config";
import { jsonField } from "../../../../lib/checkout/json";
import { orderStore } from "../../../../lib/checkout/orders";
import { rpcFor } from "../../../../lib/checkout/payment";
import { answerWallet } from "../../../../lib/checkout/request";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

// Wallets running in a browser fetch this cross-origin (Solana Pay spec).
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Cache-Control",
};

function reply(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: CORS });
}

export function OPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/** Solana Pay transaction request, step 1: what the wallet shows. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  if (!orderStore().get(id)) return reply({ message: "order not found" }, 404);
  const origin = readCheckoutConfig().publicUrl ?? new URL(request.url).origin;
  return reply({ label: "Stablecoin checkout", icon: `${origin}/icon.svg` });
}

/**
 * Solana Pay transaction request, step 2: POST { account } -> the unsigned
 * transaction, or a 4xx with { message } saying why this wallet cannot pay.
 * Every answer to a wallet is logged against the order, so the checkout page
 * shows a refusal even when the wallet does not.
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const store = orderStore();
  const order = store.get(id);
  if (!order) return reply({ message: "order not found" }, 404);

  let account: unknown;
  try {
    account = jsonField(await request.json(), "account");
  } catch {
    return reply({ message: "body must be JSON" }, 400);
  }
  if (typeof account !== "string" || !isAddress(account)) {
    return reply({ message: "account is not a Solana address" }, 400);
  }

  const answer = await answerWallet(
    order,
    account,
    rpcFor(readCheckoutConfig().rpcUrl)
  );
  if (!answer.ok) {
    store.walletRefused(order, account, answer.reason);
    return reply({ message: answer.reason }, answer.status);
  }
  store.walletServed(order, account);
  return reply({ transaction: answer.transaction, message: answer.message });
}
