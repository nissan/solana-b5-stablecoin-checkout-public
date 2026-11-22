// Reproduce the stablecoin checkout on devnet in one command.
//
//   DEVNET_PAYER_KEYPAIR=~/devnet-payer.json pnpm devnet:reproduce
//
// What it does, in order:
// 1. Refuses unless the RPC's genesis hash is devnet's, and unless the run's
//    estimated cost fits the spend cap (0.05 SOL).
// 2. Creates a test token on devnet (6 decimals, like USDC; it is NOT Circle's
//    USDC) and throwaway keypairs that live only in memory: a merchant and
//    two customers, one funded with 25 test tokens and one with 1.
// 3. Builds and starts this app's production server on a free local port,
//    pointed at the test token and the throwaway merchant.
// 4. Through the server's HTTP API: an order paid in full, an underpayment,
//    an overpayment, and a wallet that cannot pay, asking for the
//    transaction-request transaction.
// 5. Reads every result back: each signature finalized without error, the
//    token balances, and the payer's SOL spent.
//
// Every transaction's signature and explorer link is printed before it is
// sent; the script waits for "finalized". The payer pays all fees and rent;
// its keypair is read by path and never printed. Exits non-zero if any check
// fails.
import { execFileSync, spawn, spawnSync } from "node:child_process";
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
const TRANSACTIONS = 4n; // setup and three payments
const APP_DIR = fileURLToPath(new URL("..", import.meta.url));

type Order = {
  id: string;
  url: string;
  reference: string;
  status: "unpaid" | "paid";
  receipt: { signature: string; received: string } | null;
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

/** Public devnet rate-limits: retry a read a few times on HTTP 429 only. */
async function read<T>(request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const limited =
        isSolanaError(error, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR) &&
        error.context.statusCode === 429;
      if (!limited || attempt === 5) throw error;
      await sleep(2000 * attempt);
    }
  }
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
  mintRent + 3n * tokenAccountRent + TRANSACTIONS * FEE_MARGIN_LAMPORTS;
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
  await sendAndConfirm(signed, { commitment: "finalized" });
  line("", "finalized");
  signatures.push(signature);
  return signature;
}

// --- Test token and throwaway accounts --------------------------------------

const mint = await generateKeyPairSigner();
const merchant = await generateKeyPairSigner();
const customer = await generateKeyPairSigner();
const shortWallet = await generateKeyPairSigner();
const ata = async (owner: Address) =>
  (
    await findAssociatedTokenPda({
      owner,
      mint: mint.address,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    })
  )[0];
const [merchantAta, customerAta, shortAta] = await Promise.all(
  [merchant, customer, shortWallet].map((k) => ata(k.address))
);
console.log("");
console.log("Setup");
line(
  "test token",
  `${mint.address} (6 decimals; a test token, not Circle USDC)`
);
line("merchant", `${merchant.address} (throwaway)`);
line("customer", `${customer.address} (throwaway, 25.00 test tokens)`);
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
    amount: 25_000_000n,
  }),
  getMintToInstruction({
    mint: mint.address,
    token: shortAta,
    mintAuthority: payer,
    amount: 1_000_000n,
  }),
]);

// --- The checkout server ----------------------------------------------------

const port = await new Promise<number>((resolve) => {
  const probe = createServer();
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    const free = typeof address === "object" && address ? address.port : 0;
    probe.close(() => resolve(free));
  });
});
const base = `http://127.0.0.1:${port}`;
const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  MERCHANT_ADDRESS: merchant.address,
  USDC_MINT: mint.address,
  SOLANA_CLUSTER: "devnet",
  SOLANA_RPC_URL: rpcUrl,
  CHECK_INTERVAL_MS: "1000",
};
delete serverEnv.PUBLIC_URL;
delete serverEnv.DEVNET_PAYER_KEYPAIR;
console.log("");
console.log("Checkout server");
const nextBin = `${APP_DIR}node_modules/.bin/next`;
const build = spawnSync(nextBin, ["build"], { cwd: APP_DIR, encoding: "utf8" });
if (build.status !== 0) {
  console.error(build.stdout, build.stderr);
  throw new Error("next build failed");
}
line("built", "next build");
const server = spawn(
  nextBin,
  ["start", "-H", "127.0.0.1", "-p", String(port)],
  {
    cwd: APP_DIR,
    env: serverEnv,
    stdio: "ignore",
  }
);
try {
  for (let ready = false, tries = 0; !ready; tries++) {
    if (tries > 120) throw new Error("the server did not start");
    ready = await fetch(base).then(
      (r) => r.ok,
      () => false
    );
    if (!ready) await sleep(500);
  }
  line("started", `${base} (production build, test token, throwaway merchant)`);

  const json = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${base}${path}`, init);
    return {
      status: response.status,
      body: (await response.json()) as unknown,
    };
  };
  const createOrder = async (amount: string) =>
    (
      await json("/api/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount }),
      })
    ).body as Order;
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
  const pay = async (label: string, order: Order, amount: number) => {
    const link = parseURL(order.url) as TransferRequestURL;
    return send(
      label,
      await createTransfer(rpc, customer, {
        recipient: link.recipient,
        amount,
        splToken: link.splToken,
        reference: link.reference,
      })
    );
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
} finally {
  server.kill("SIGTERM");
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
const [merchantHeld, customerHeld] = await Promise.all(
  [merchantAta, customerAta].map(
    async (a) =>
      (await read(() => fetchToken(rpc, a, { commitment: "finalized" }))).data
        .amount
  )
);
line("merchant", `${Number(merchantHeld) / 1e6} test tokens`);
line("customer", `${Number(customerHeld) / 1e6} test tokens`);
check(
  merchantHeld === 19_990_000n && customerHeld === 5_010_000n,
  "the merchant holds 19.99 (12.50 + 4.99 + 2.50) and the customer 5.01"
);
const after = await balance();
line("payer", `${lamports(after)} after`);
line(
  "spent",
  `${lamports(before - after)} of the ${lamports(CAP_LAMPORTS)} cap`
);
check(before - after <= CAP_LAMPORTS, "within the spend cap");

console.log("");
line(
  failures.length === 0 ? "PASSED" : "FAILED",
  `${failures.length === 0 ? "every check" : failures.join("; ")} (${((Date.now() - started) / 1000).toFixed(0)} s)`
);
process.exit(failures.length === 0 ? 0 : 1);
