import {
  CheckoutConfigError,
  readCheckoutConfig,
} from "../../../lib/checkout/config";
import { orderStore } from "../../../lib/checkout/orders";
import { rpcFor } from "../../../lib/checkout/payment";
import {
  authorised,
  handleWebhook,
  MAX_WEBHOOK_BODY,
} from "../../../lib/checkout/webhook";

export const dynamic = "force-dynamic";

/**
 * How long a call may wait for its checks before it is answered. Helius gives
 * an endpoint one second and retries after that; the checks carry on after
 * the answer either way.
 */
const ANSWER_WITHIN_MS = 700;

/**
 * POST a provider's webhook: transactions that touched the merchant's token
 * accounts. Helius's raw and enhanced shapes are understood.
 *
 * The call is authenticated first, by the shared secret Helius echoes in the
 * Authorization header. A call without it is refused before its body is read
 * and before anything is read from the chain.
 *
 * An authenticated call is still only a hint. For each transaction it names
 * that carries one of this server's order references, the server reads that
 * transaction from the chain and judges it as a poll would. The body decides
 * nothing, so a repeated, late or mistaken delivery cannot pay an order.
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
  if (!config.webhook) {
    return Response.json(
      { error: "webhooks are not switched on here" },
      { status: 404 }
    );
  }
  if (
    !authorised(request.headers.get("authorization"), config.webhook.secret)
  ) {
    console.warn("[checkout] webhook call refused: missing or wrong secret");
    return Response.json(
      { error: "missing or wrong webhook secret" },
      { status: 401 }
    );
  }

  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_WEBHOOK_BODY) {
    return Response.json({ error: "body is too large" }, { status: 413 });
  }
  const text = await request.text();
  if (text.length > MAX_WEBHOOK_BODY) {
    return Response.json({ error: "body is too large" }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "body must be JSON" }, { status: 400 });
  }

  const { outcome, done } = handleWebhook(
    orderStore(),
    rpcFor(config.rpcUrl),
    config,
    body
  );
  // Answer in time whether or not the checks have finished.
  const finished = await Promise.race([
    done.then(() => true),
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), ANSWER_WITHIN_MS)
    ),
  ]);
  if (!finished) return Response.json({ accepted: true, checked: false });
  return Response.json({ accepted: true, checked: true, ...(await outcome) });
}
