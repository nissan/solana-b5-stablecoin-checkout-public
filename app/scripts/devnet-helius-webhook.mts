// Create, list or delete the Helius webhook that tells a devnet checkout
// about payments.
//
//   HELIUS_API_KEY=… WEBHOOK_SECRET=… PUBLIC_URL=https://… \
//     MERCHANT_ADDRESS=<address> [USDC_MINT=…] [AUDD_MINT=…] \
//     node scripts/devnet-helius-webhook.mts create
//   HELIUS_API_KEY=… node scripts/devnet-helius-webhook.mts list
//   HELIUS_API_KEY=… node scripts/devnet-helius-webhook.mts delete <webhookID>
//
// "create" asks Helius for a raw devnet webhook (webhookType "rawDevnet")
// that watches the merchant's token accounts, one per currency on offer, and
// posts to PUBLIC_URL/api/webhooks/helius with WEBHOOK_SECRET as its
// Authorization header. Start the checkout with the same WEBHOOK_SECRET.
// A payment's transaction names the merchant's token account, not the
// merchant's own address, so the token accounts are what is watched.
//
// Cost, from Helius's documentation (read 22 November 2026): creating,
// editing or deleting a webhook costs 100 credits per request, and each
// delivery costs 1 credit whether or not the endpoint handles it. So create
// one, use it, and delete it.
//
// The API key travels in the request URL's query string, as Helius requires.
// This script never prints the URL, the key or the secret, and removes both
// from anything it does print. Nothing here signs a transaction or holds a
// Solana key: it is account administration at a provider, not chain access.
import { address } from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const MIN_SECRET_LENGTH = 16; // the checkout's own minimum
const HOOK_PATH = "/api/webhooks/helius";

type Webhook = {
  webhookID: string;
  webhookURL: string;
  webhookType: string;
  accountAddresses?: string[];
  authHeader?: string;
  active?: boolean;
};

function fail(message: string, code = 1): never {
  console.error(message);
  process.exit(code);
}
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`${name} is required`, 2);
  return value;
}

const apiKey = required("HELIUS_API_KEY");
const secret = process.env.WEBHOOK_SECRET?.trim() ?? "";
const api = (
  process.env.HELIUS_API_URL?.trim() || "https://mainnet.helius-rpc.com"
).replace(/\/+$/, "");

/** Nothing printed may carry the key or the secret. */
const redact = (text: string) => {
  let out = text.split(apiKey).join("[api key]");
  if (secret) out = out.split(secret).join("[secret]");
  return out;
};

async function call(method: string, path: string, body?: unknown) {
  let response: Response;
  try {
    response = await fetch(
      `${api}${path}?api-key=${encodeURIComponent(apiKey)}`,
      {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      }
    );
  } catch (error) {
    // The error may quote the URL, which holds the key: say only what failed.
    fail(
      `${method} ${path}: no answer from Helius (${redact(error instanceof Error ? error.message : "request failed")})`
    );
  }
  const text = await response.text();
  if (!response.ok) {
    fail(
      `${method} ${path}: HTTP ${response.status} ${redact(text).slice(0, 300)}`
    );
  }
  return text ? (JSON.parse(text) as unknown) : null;
}

function show(hook: Webhook) {
  console.log(`webhook        ${hook.webhookID}`);
  console.log(`  type         ${hook.webhookType}`);
  console.log(`  posts to     ${redact(hook.webhookURL)}`);
  console.log(
    `  watches      ${(hook.accountAddresses ?? []).join(", ") || "(nothing)"}`
  );
  console.log(
    `  auth header  ${hook.authHeader ? "set (not shown)" : "NOT SET"}`
  );
  if (hook.active !== undefined) console.log(`  active       ${hook.active}`);
}

const [command, argument] = process.argv.slice(2);

if (command === "list") {
  const hooks = (await call("GET", "/v0/webhooks")) as Webhook[];
  console.log(`${hooks.length} webhook(s) on this Helius account`);
  hooks.forEach(show);
} else if (command === "delete") {
  if (!argument || !/^[\w-]{8,64}$/.test(argument)) {
    fail("usage: devnet-helius-webhook.mts delete <webhookID>", 2);
  }
  await call("DELETE", `/v0/webhooks/${argument}`);
  console.log(`deleted        ${argument} (100 credits)`);
} else if (command === "create") {
  if (secret.length < MIN_SECRET_LENGTH) {
    fail(
      `WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters, the same value the checkout is started with`,
      2
    );
  }
  const publicUrl = new URL(required("PUBLIC_URL"));
  if (publicUrl.protocol !== "https:") {
    fail(
      "PUBLIC_URL must be https: Helius posts only to a public https URL",
      2
    );
  }
  const merchant = address(required("MERCHANT_ADDRESS"));
  const mints = [
    process.env.USDC_MINT?.trim() || DEVNET_USDC_MINT,
    process.env.AUDD_MINT?.trim(),
  ].filter((mint): mint is string => Boolean(mint));
  const accounts = await Promise.all(
    mints.map(
      async (mint) =>
        (
          await findAssociatedTokenPda({
            owner: merchant,
            mint: address(mint),
            tokenProgram: TOKEN_PROGRAM_ADDRESS,
          })
        )[0]
    )
  );
  console.log(`merchant       ${merchant}`);
  mints.forEach((mint, i) =>
    console.log(`token account  ${accounts[i]} (mint ${mint})`)
  );
  const hook = (await call("POST", "/v0/webhooks", {
    webhookURL: new URL(HOOK_PATH, publicUrl).toString(),
    webhookType: "rawDevnet",
    transactionTypes: ["ANY"],
    accountAddresses: accounts,
    authHeader: secret,
  })) as Webhook;
  console.log("created        (100 credits; each delivery costs 1)");
  show(hook);
  console.log("");
  console.log(
    `When finished: node scripts/devnet-helius-webhook.mts delete ${hook.webhookID}`
  );
} else {
  fail(
    "usage: devnet-helius-webhook.mts create | list | delete <webhookID>",
    2
  );
}
