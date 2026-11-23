// Reproduce the stablecoin checkout on devnet in one command.
//
//   DEVNET_PAYER_KEYPAIR=~/devnet-payer.json pnpm devnet:reproduce
//
// What it does, in order:
// 1. Refuses unless the RPC's genesis hash is devnet's, and unless the run's
//    estimated cost fits the spend cap (0.05 SOL).
// 2. Creates two test tokens on devnet, each with 6 decimals: one stands in
//    for USDC (it is NOT Circle's USDC) and one for AUDD (the issuer's AUDD
//    exists only on mainnet). Throwaway keypairs live only in memory: a
//    merchant and two customers.
// 3. Builds and starts this app's production server on a free local port,
//    pointed at the test tokens and the throwaway merchant.
// 4. Through the server's HTTP API: an order paid in full, an underpayment,
//    an overpayment, a wallet that cannot pay asking for the
//    transaction-request transaction, and an AUDD order that is first paid
//    in the wrong currency and then in the right one.
// 5. Starts the server again with webhooks switched on and a secret made up
//    for this run. A scripted sender stands in for a webhook provider, with
//    the body shape Helius posts: a call without the secret is refused, a
//    call with it marks an order paid, a repeated call changes nothing, and
//    an order that gets no call is still found by the fallback check.
// 6. Reads every result back: each signature finalized without error, the
//    token balances, and the payer's SOL spent.
//
// Every transaction's signature and explorer link is printed before it is
// sent; the script waits for "finalized". The payer pays all fees and rent;
// its keypair is read by path and never printed. Exits non-zero if any check
// fails.
import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import {
  type Address,
  appendTransactionMessageInstructions,
  assertIsTransactionWithBlockhashLifetime,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  generateKeyPairSigner,
  getSignatureFromTransaction,
  type Instruction,
  isSolanaError,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_FAILED_TO_CONNECT,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { createTransfer, parseURL, type TransferRequestURL } from "@solana/pay";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  fetchToken,
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const CAP_LAMPORTS = 50_000_000n; // 0.05 SOL, agreed with the owner
const FEE_MARGIN_LAMPORTS = 10_000n; // per transaction, generous
const TRANSACTIONS = 9n; // two setups and seven payments
/** With webhooks on, how long the fallback check waits. Long enough that a
 * payment finalizes, and its webhook is acted on, well inside it. */
const FALLBACK_MS = 45_000;
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

type Order = {
  id: string;
  url: string;
  reference: string;
  status: "unpaid" | "paid";
  currency: string;
  receipt: { signature: string; received: string; foundBy: string } | null;
  refundDue: string;
  refunds: { signature: string; amount: string; reason: string }[];
  events: {
    kind: string;
    message: string;
    signature?: string;
    wallet?: string;
  }[];
};

const failures: string[] = [];
/** Lamports are SOL's smallest unit: 1 SOL is 1,000,000,000 lamports. */
const lamports = (n: bigint) =>
  `${n.toLocaleString("en-US")} lamports (${(Number(n) / 1e9).toFixed(6)} SOL)`;
const line = (label: string, text: string) =>
  console.log(`${label.padEnd(13)}${text}`);
function check(ok: boolean, what: string) {
  line(ok ? "  ok" : "  FAILED", what);
  if (!ok) failures.push(what);
}

// --- Devnet, payer and cap -------------------------------------------------

const payerPath = process.env.DEVNET_PAYER_KEYPAIR?.trim();
if (!payerPath) {
  console.error("DEVNET_PAYER_KEYPAIR must name a devnet keypair file");
  process.exit(2);
}
const rpcUrl =
  process.env.SOLANA_RPC_URL?.trim() || "https://api.devnet.solana.com";
const rpc = createSolanaRpc(rpcUrl);
const genesis = await rpc.getGenesisHash().send();
if (genesis !== DEVNET_GENESIS) {
  console.error(`refusing to sign: genesis hash ${genesis} is not devnet's`);
  process.exit(1);
}
const sendAndConfirm = sendAndConfirmTransactionFactory({
  rpc,
  rpcSubscriptions: createSolanaRpcSubscriptions(rpcUrl.replace(/^http/, "ws")),
});
const payer = await createKeyPairSignerFromBytes(
  Uint8Array.from(
    JSON.parse(
      readFileSync(payerPath.replace(/^~/, process.env.HOME ?? "~"), "utf8")
    ) as number[]
  )
);

/** The public devnet endpoint turning a request away for now: HTTP 429, or
 * its websocket refusing to open. Neither says anything about the request. */
const rateLimited = (error: unknown) =>
  (isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
    error.context.statusCode === 429) ||
  isSolanaError(
    error,
    SOLANA_ERROR__RPC_SUBSCRIPTIONS__CHANNEL_FAILED_TO_CONNECT
  );

/** Public devnet rate-limits: retry a read a few times on HTTP 429 only. */
async function read<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      if (!rateLimited(error) || attempt === 5) throw error;
      await sleep(2000 * attempt);
    }
  }
}

/**
 * After a rate-limited send: has the chain got this signature? Waits for
 * "finalized" if it has; answers false if the chain has never seen it.
 */
async function landed(signature: Signature) {
  for (const from = Date.now(); Date.now() - from < 90_000;) {
    const { value } = await read(() =>
      rpc
        .getSignatureStatuses([signature], { searchTransactionHistory: true })
        .send()
    );
    const status = value[0];
    if (!status) return false;
    if (status.err) throw new Error(`transaction ${signature} failed`);
    if (status.confirmationStatus === "finalized") return true;
    await sleep(2000);
  }
  throw new Error(`transaction ${signature} did not finalize in 90 s`);
}

const balance = async () =>
  (
    await read(() =>
      rpc.getBalance(payer.address, { commitment: "finalized" }).send()
    )
  ).value;

const started = Date.now();
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: APP_DIR })
  .toString()
  .trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: APP_DIR })
    .toString()
    .trim() !== "";
console.log("Stablecoin checkout: devnet reproduction");
line("commit", `${commit}${dirty ? " (with uncommitted changes)" : ""}`);
line("cluster", `devnet (genesis ${genesis})`);

const before = await balance();
const [mintRent, tokenAccountRent] = await Promise.all([
  rpc.getMinimumBalanceForRentExemption(BigInt(getMintSize())).send(),
  rpc.getMinimumBalanceForRentExemption(165n).send(),
]);
const estimate =
  2n * mintRent + 5n * tokenAccountRent + TRANSACTIONS * FEE_MARGIN_LAMPORTS;
line(
  "unit",
  "1 SOL = 1,000,000,000 lamports; fees and rent are paid in lamports"
);
line("payer", `${payer.address}: ${lamports(before)}`);
line(
  "cost",
  `about ${lamports(estimate)} for this run; cap ${lamports(CAP_LAMPORTS)}`
);
if (estimate > CAP_LAMPORTS || before < estimate) {
  console.error(
    "refusing: the estimate exceeds the cap or the payer's balance"
  );
  process.exit(1);
}

const signatures: Signature[] = [];
async function send(label: string, instructions: Instruction[]) {
  const spent = before - (await balance());
  if (spent + FEE_MARGIN_LAMPORTS > CAP_LAMPORTS) {
    throw new Error(
      `stopping: ${lamports(spent)} spent, the cap is ${lamports(CAP_LAMPORTS)}`
    );
  }
  const { value: blockhash } = await read(() =>
    rpc.getLatestBlockhash({ commitment: "finalized" }).send()
  );
  const signed = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions(instructions, m)
    )
  );
  assertIsTransactionWithBlockhashLifetime(signed);
  const signature = getSignatureFromTransaction(signed);
  line(label, signature);
  line("", `https://explorer.solana.com/tx/${signature}?cluster=devnet`);
  for (let attempt = 1; ; attempt++) {
    try {
      await sendAndConfirm(signed, { commitment: "finalized" });
      break;
    } catch (error) {
      if (!rateLimited(error) || attempt === 5) throw error;
      await sleep(2000 * attempt);
      // Rate-limited part way through. If the chain already has it, wait for
      // it; if not, send the same signed transaction again. The chain accepts
      // a signature once, so this cannot pay twice.
      if (await landed(signature)) break;
    }
  }
  line("", "finalized");
  signatures.push(signature);
  return signature;
}

// --- Test token and throwaway accounts --------------------------------------

const mint = await generateKeyPairSigner();
const auddMint = await generateKeyPairSigner();
const merchant = await generateKeyPairSigner();
const customer = await generateKeyPairSigner();
const shortWallet = await generateKeyPairSigner();
const ata = async (owner: Address, of: Address = mint.address) =>
  (
    await findAssociatedTokenPda({
      owner,
      mint: of,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
const [merchantAta, customerAta, shortAta] = await Promise.all(
  [merchant, customer, shortWallet].map((k) => ata(k.address))
);
const [merchantAuddAta, customerAuddAta] = await Promise.all(
  [merchant, customer].map((k) => ata(k.address, auddMint.address))
);
console.log("");
console.log("Setup");
line(
  "test token",
  `${mint.address} (6 decimals; a test token, not Circle USDC)`
);
line(
  "AUDD stand-in",
  `${auddMint.address} (6 decimals; a test token, not the issuer's AUDD)`
);
line("merchant", `${merchant.address} (throwaway)`);
line(
  "customer",
  `${customer.address} (throwaway, 35.00 test tokens and 15.00 AUDD stand-in)`
);
line("short wallet", `${shortWallet.address} (throwaway, 1.00 test token)`);
await send("setup", [
  getCreateAccountInstruction({
    payer,
    newAccount: mint,
    lamports: mintRent,
    space: getMintSize(),
    programAddress: TOKEN_PROGRAM_ADDRESS,
  }),
  getInitializeMint2Instruction({
    mint: mint.address,
    decimals: 6,
    mintAuthority: payer.address,
  }),
  ...(await Promise.all(
    [merchant, customer, shortWallet].map((k) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: k.address,
        mint: mint.address,
      })
    )
  )),
  getMintToInstruction({
    mint: mint.address,
    token: customerAta,
    mintAuthority: payer,
    amount: 35_000_000n,
  }),
  getMintToInstruction({
    mint: mint.address,
    token: shortAta,
    mintAuthority: payer,
    amount: 1_000_000n,
  }),
]);
await send("setup AUDD", [
  getCreateAccountInstruction({
    payer,
    newAccount: auddMint,
    lamports: mintRent,
    space: getMintSize(),
    programAddress: TOKEN_PROGRAM_ADDRESS,
  }),
  getInitializeMint2Instruction({
    mint: auddMint.address,
    decimals: 6,
    mintAuthority: payer.address,
  }),
  ...(await Promise.all(
    [merchant, customer].map((k) =>
      getCreateAssociatedTokenIdempotentInstructionAsync({
        payer,
        owner: k.address,
        mint: auddMint.address,
      })
    )
  )),
  getMintToInstruction({
    mint: auddMint.address,
    token: customerAuddAta,
    mintAuthority: payer,
    amount: 15_000_000n,
  }),
]);

// --- The checkout server ----------------------------------------------------

const freePort = () =>
  new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const free = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(free));
    });
  });
const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCHANT_ADDRESS: merchant.address,
  USDC_MINT: mint.address,
  AUDD_MINT: auddMint.address,
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: rpcUrl,
  CHECK_INTERVAL_MS: "1000",
};
delete serverEnv.PUBLIC_URL;
delete serverEnv.DEVNET_PAYER_KEYPAIR;
delete serverEnv.WEBHOOK_SECRET;
delete serverEnv.FALLBACK_CHECK_INTERVAL_MS;
delete serverEnv.WEBHOOK_RETRY_DELAYS_MS;
console.log("");
console.log("Checkout server");
const nextBin = `${APP_DIR}node_modules/.bin/next`;
const build = spawnSync(nextBin, ["build"], { cwd: APP_DIR, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  throw new Error("next build failed");
}
line("built", "next build");
let base = "";
let server: ChildProcess | undefined;
/** The servers' own "[checkout]" log lines, kept to explain a failed check. They never hold the secret. */
const serverLines: string[] = [];
/** Start the built server on a free port with these extra settings, and wait for it. */
async function startServer(extra: Record<string, string>, what: string) {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn(nextBin, ["start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: APP_DIR,
    env: { ...serverEnv, ...extra },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [server.stdout, server.stderr]) {
    stream?.setEncoding("utf8").on("data", (chunk: string) => {
      for (const text of chunk.split("\n")) {
        if (text.includes("[checkout]") && serverLines.length < 200) {
          serverLines.push(text.trim());
        }
      }
    });
  }
  for (let ready = false, tries = 0; !ready; tries++) {
    if (tries > 120) throw new Error("the server did not start");
    ready = await fetch(base).then(
      (r) => r.ok,
      () => false
    );
    if (!ready) await sleep(500);
  }
  line("started", `${base} (${what})`);
}
async function stopServer() {
  const running = server;
  server = undefined;
  if (!running || running.exitCode !== null) return;
  const exited = new Promise((resolve) => running.once("exit", resolve));
  running.kill("SIGTERM");
  await exited;
}
try {
  await startServer(
    {},
    "production build, test tokens, throwaway merchant, no webhooks"
  );

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const createOrder = async (amount: string, currency = "USDC") => {
    for (let attempt = 1; ; attempt++) {
      const answer = await json("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount, currency }),
      });
      if (answer.status === 201) return answer.body as Order;
      // 503 is the server saying it could not read the token's mint just now,
      // which on public devnet means it was rate-limited: wait and ask again.
      if (answer.status !== 503 || attempt === 5) {
        throw new Error(
          `creating a ${currency} order failed: HTTP ${answer.status} ${JSON.stringify(answer.body)}`
        );
      }
      await sleep(2000 * attempt);
    }
  };
  const getOrder = async (id: string) =>
    (await json(`/api/orders/${id}`)).body as Order;
  const until = async (id: string, done: (order: Order) => boolean) => {
    const from = Date.now();
    for (;;) {
      const order = await getOrder(id);
      if (done(order)) return { order, seconds: (Date.now() - from) / 1000 };
      if (Date.now() - from > 60_000) return { order, seconds: Infinity };
      await sleep(1500);
    }
  };
  const pay = async (
    label: string,
    order: Order,
    amount: number,
    token?: Address
  ) => {
    const link = parseURL(order.url) as TransferRequestURL;
    // Building the transfer only reads accounts, so it is safe to retry.
    return send(
      label,
      await read(() =>
        createTransfer(rpc, customer, {
          recipient: link.recipient,
          amount,
          splToken: token ?? link.splToken,
          reference: link.reference,
        })
      )
    );
  };
  /**
   * The scripted sender. It stands in for a webhook provider: it posts what
   * Helius posts for a raw webhook, the transaction's signatures and account
   * keys, read here from devnet. `secret` goes in the Authorization header.
   */
  const deliver = async (signature: Signature, secret: string | null) => {
    const transaction = await read(() =>
      rpc
        .getTransaction(signature, {
          commitment: "finalized",
          encoding: "json",
          maxSupportedTransactionVersion: 0,
        })
        .send()
    );
    if (!transaction) throw new Error(`transaction ${signature} not found`);
    return json("/api/webhooks/helius", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret === null ? {} : { authorization: secret }),
      },
      body: JSON.stringify([
        {
          transaction: {
            signatures: transaction.transaction.signatures,
            message: {
              accountKeys: transaction.transaction.message.accountKeys,
            },
          },
          meta: {
            loadedAddresses: transaction.meta?.loadedAddresses ?? {
              writable: [],
              readonly: [],
            },
          },
        },
      ]),
    });
  };

  // S1 and S2 of B5-002: an order's link, then a payment marked paid.
  console.log("");
  console.log("1. An order for 12.50 is paid in full");
  const paidOrder = await createOrder("12.50");
  line("order", paidOrder.id);
  line("link", paidOrder.url);
  const link = parseURL(paidOrder.url) as TransferRequestURL;
  check(
    link.recipient === merchant.address &&
      link.amount === 12.5 &&
      link.splToken === mint.address &&
      link.reference?.length === 1 &&
      link.reference[0] === paidOrder.reference,
    "the link carries the merchant, 12.5, the token and the order's reference"
  );
  const paidSignature = await pay("payment", paidOrder, 12.5);
  const paid = await until(paidOrder.id, (o) => o.status === "paid");
  check(
    paid.order.status === "paid" &&
      paid.order.receipt?.signature === paidSignature,
    `the server marked it paid with that signature (${paid.seconds.toFixed(1)} s after finalized)`
  );

  // S3 of B5-002 and the owner's B5-005 choice: an underpayment.
  console.log("");
  console.log("2. An order for 5.00 receives 4.99");
  const shortOrder = await createOrder("5.00");
  line("order", shortOrder.id);
  const shortSignature = await pay("payment", shortOrder, 4.99);
  const rejected = await until(shortOrder.id, (o) =>
    o.events.some(
      (e) => e.kind === "rejected" && e.signature === shortSignature
    )
  );
  const reason = rejected.order.events.find(
    (e) => e.kind === "rejected"
  )?.message;
  line("reason", reason ?? "(none)");
  check(
    rejected.order.status === "unpaid" &&
      (reason ?? "").startsWith("underpaid"),
    "the order stays unpaid with the underpayment logged against it"
  );
  check(
    rejected.order.refunds.some(
      (r) =>
        r.signature === shortSignature &&
        r.amount === "4.99" &&
        r.reason === "underpaid"
    ),
    "the 4.99 that arrived is recorded as owed back"
  );

  // S1 of B5-005: an overpayment.
  console.log("");
  console.log("3. An order for 2.00 receives 2.50");
  const overOrder = await createOrder("2.00");
  line("order", overOrder.id);
  const overSignature = await pay("payment", overOrder, 2.5);
  const over = await until(overOrder.id, (o) => o.status === "paid");
  line(
    "receipt",
    `received ${over.order.receipt?.received}; to refund ${over.order.refundDue}`
  );
  check(
    over.order.receipt?.signature === overSignature &&
      over.order.receipt?.received === "2.50" &&
      over.order.refundDue === "0.50",
    "paid, the receipt shows 2.50 received, and 0.50 is owed back"
  );

  // S1 of B5-006: a wallet that cannot pay asks for the transaction.
  console.log("");
  console.log("4. A wallet holding 1.00 asks to pay an order for 12.50");
  const requestOrder = await createOrder("12.50");
  line("order", requestOrder.id);
  const answer = await json(`/api/orders/${requestOrder.id}/pay`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ account: shortWallet.address }),
  });
  const message = (answer.body as { message?: string }).message ?? "";
  line("answer", `HTTP ${answer.status}: ${message}`);
  const refusedOrder = await getOrder(requestOrder.id);
  check(
    answer.status === 400 &&
      message.endsWith("11.50 USDC is missing") &&
      refusedOrder.events.some(
        (e) => e.kind === "refused" && e.wallet === shortWallet.address
      ),
    "refused before anything is signed, with the reason logged against the order"
  );

  // S1 and S3 of B5-004: an order in the second currency.
  console.log("");
  console.log(
    "5. An AUDD order for 7.50 is paid 7.50 in the wrong currency, then 7.50 AUDD"
  );
  const auddOrder = await createOrder("7.50", "AUDD");
  line("order", `${auddOrder.id} (${auddOrder.currency})`);
  const auddLink = parseURL(auddOrder.url) as TransferRequestURL;
  check(
    auddOrder.currency === "AUDD" &&
      auddLink.splToken === auddMint.address &&
      auddLink.amount === 7.5,
    "the link asks for 7.5 of the AUDD stand-in: the same number, no conversion"
  );
  const wrongSignature = await pay("wrong token", auddOrder, 7.5, mint.address);
  const wrong = await until(auddOrder.id, (o) =>
    o.events.some(
      (e) => e.kind === "rejected" && e.signature === wrongSignature
    )
  );
  const wrongReason =
    wrong.order.events.find((e) => e.kind === "rejected")?.message ?? "";
  line("reason", wrongReason || "(none)");
  check(
    wrong.order.status === "unpaid" &&
      wrongReason.startsWith(
        "paid in USDC, but this order is priced in AUDD: 7.50 USDC reached the merchant"
      ) &&
      wrong.order.refundDue === "0.00",
    "rejected, naming both currencies; the order stays unpaid and nothing is added to what it owes back"
  );
  const auddSignature = await pay("payment", auddOrder, 7.5);
  const auddPaid = await until(auddOrder.id, (o) => o.status === "paid");
  check(
    auddPaid.order.receipt?.signature === auddSignature &&
      auddPaid.order.receipt?.received === "7.50" &&
      auddPaid.order.events.some((e) => e.message === "Paid 7.50 AUDD"),
    "paid in AUDD with that signature, and the log says so in AUDD"
  );

  // S2, S4, S5 and S6 of B5-004: the same server with webhooks switched on.
  await stopServer();
  // Made up for this run, kept in memory, never printed.
  const secret = randomBytes(24).toString("hex");
  console.log("");
  console.log("Checkout server, with webhooks on");
  await startServer(
    {
      WEBHOOK_SECRET: secret,
      FALLBACK_CHECK_INTERVAL_MS: String(FALLBACK_MS),
    },
    `webhooks on, a secret made up for this run, fallback check every ${FALLBACK_MS / 1000} s`
  );
  line(
    "sender",
    "this script stands in for the provider, posting what Helius posts for a raw webhook"
  );

  // Each order is read once when it is created, which is its one page-load
  // look at the chain. After that, with webhooks on, reading it does not read
  // the chain again until the fallback interval has passed.
  const quietOrder = await createOrder("1.00");
  const quietOpened = Date.now();
  await getOrder(quietOrder.id);

  console.log("");
  console.log(
    "6. An order for 1.00 is paid and no webhook is sent for it (checked again in step 10)"
  );
  line("order", quietOrder.id);
  const quietSignature = await pay("payment", quietOrder, 1);

  console.log("");
  console.log(
    "7. An AUDD order for 2.00 is paid; polling alone does not see it"
  );
  // Created only now, so its webhook arrives well inside its fallback interval.
  const hookOrder = await createOrder("2.00", "AUDD");
  await getOrder(hookOrder.id);
  line("order", `${hookOrder.id} (${hookOrder.currency})`);
  const hookSignature = await pay("payment", hookOrder, 2);
  const unseen = await getOrder(hookOrder.id);
  check(
    unseen.status === "unpaid",
    "after the payment finalized, reading the order still says unpaid: the page's polling no longer reads the chain"
  );

  console.log("");
  console.log("8. A webhook call without the secret, then with a wrong one");
  const noSecret = await deliver(hookSignature, null);
  const badSecret = await deliver(hookSignature, "not-the-secret-0123456789");
  line("answers", `HTTP ${noSecret.status} and HTTP ${badSecret.status}`);
  const stillUnpaid = await getOrder(hookOrder.id);
  check(
    noSecret.status === 401 &&
      badSecret.status === 401 &&
      stillUnpaid.status === "unpaid" &&
      stillUnpaid.events.length === 1,
    "both refused, and the order is unchanged"
  );

  console.log("");
  console.log("9. The same call with the secret, then once more");
  const accepted = await deliver(hookSignature, secret);
  line("answer", `HTTP ${accepted.status}: ${JSON.stringify(accepted.body)}`);
  const hooked = await until(hookOrder.id, (o) => o.status === "paid");
  check(
    accepted.status === 200 &&
      hooked.order.receipt?.signature === hookSignature &&
      hooked.order.receipt?.foundBy === "webhook",
    `marked paid from the chain, found by the webhook call (${hooked.seconds.toFixed(1)} s after the call)`
  );
  const again = await deliver(hookSignature, secret);
  await sleep(1500);
  const afterAgain = await getOrder(hookOrder.id);
  check(
    again.status === 200 &&
      afterAgain.events.length === hooked.order.events.length &&
      afterAgain.refunds.length === 0,
    "the repeated call is accepted and changes nothing"
  );

  console.log("");
  console.log(
    `10. The order from step 6, which got no webhook, ${FALLBACK_MS / 1000} s after it was first read`
  );
  const early = await getOrder(quietOrder.id);
  const earlySeconds = (Date.now() - quietOpened) / 1000;
  check(
    earlySeconds < FALLBACK_MS / 1000 && early.status === "unpaid",
    `${earlySeconds.toFixed(0)} s in, it still reads unpaid`
  );
  await sleep(Math.max(0, FALLBACK_MS + 1000 - (Date.now() - quietOpened)));
  const found = await until(quietOrder.id, (o) => o.status === "paid");
  check(
    found.order.receipt?.signature === quietSignature &&
      found.order.receipt?.foundBy === "poll",
    "the fallback check found it: paid, found by polling"
  );
} finally {
  await stopServer();
}

// --- Read back from the chain -------------------------------------------------

console.log("");
console.log("Read back from devnet");
const { value: statuses } = await read(() =>
  rpc
    .getSignatureStatuses(signatures, { searchTransactionHistory: true })
    .send()
);
check(
  statuses.every(
    (s) => s?.confirmationStatus === "finalized" && s.err === null
  ),
  `all ${signatures.length} transactions finalized without error`
);
const [merchantHeld, customerHeld, merchantAudd, customerAudd] =
  await Promise.all(
    [merchantAta, customerAta, merchantAuddAta, customerAuddAta].map(
      async (a) =>
        (await read(() => fetchToken(rpc, a, { commitment: "finalized" }))).data
          .amount
    )
  );
line(
  "merchant",
  `${Number(merchantHeld) / 1e6} test tokens and ${Number(merchantAudd) / 1e6} AUDD stand-in`
);
line(
  "customer",
  `${Number(customerHeld) / 1e6} test tokens and ${Number(customerAudd) / 1e6} AUDD stand-in`
);
check(
  merchantHeld === 28_490_000n && customerHeld === 6_510_000n,
  "the merchant holds 28.49 test tokens (12.50 + 4.99 + 2.50 + 7.50 in the wrong currency + 1.00) and the customer 6.51"
);
check(
  merchantAudd === 9_500_000n && customerAudd === 5_500_000n,
  "the merchant holds 9.50 AUDD stand-in (7.50 + 2.00) and the customer 5.50"
);
const after = await balance();
line("payer", `${lamports(after)} after`);
line(
  "spent",
  `${lamports(before - after)} of the ${lamports(CAP_LAMPORTS)} cap`
);
check(before - after <= CAP_LAMPORTS, "within the spend cap");

if (failures.length > 0 && serverLines.length > 0) {
  console.log("");
  console.log("What the checkout server logged");
  for (const text of serverLines) console.log(`  ${text}`);
}
console.log("");
line(
  failures.length === 0 ? "PASSED" : "FAILED",
  `${failures.length === 0 ? "every check" : failures.join("; ")} (${((Date.now() - started) / 1000).toFixed(0)} s)`
);
process.exit(failures.length === 0 ? 0 : 1);
