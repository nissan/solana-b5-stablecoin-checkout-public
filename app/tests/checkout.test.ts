// @vitest-environment node
import {
  address,
  appendTransactionMessageInstructions,
  type Address,
  assertIsTransactionWithBlockhashLifetime,
  assertIsTransactionWithinSizeLimit,
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  createTransactionMessage,
  decompileTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  sendAndConfirmTransactionFactory,
  signTransaction,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import {
  createTransfer,
  parseURL,
  type TransactionRequestURL,
  type TransferRequestURL,
} from "@solana/pay";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Surfnet } from "@solana/surfpool";
import {
  afterEach,
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { POST as confirmRoute } from "../app/api/orders/[id]/confirm/route";
import {
  GET as payGet,
  OPTIONS as payOptions,
  POST as payPost,
} from "../app/api/orders/[id]/pay/route";
import { GET as getRoute } from "../app/api/orders/[id]/route";
import { POST as createRoute } from "../app/api/orders/route";
import { POST as webhookRoute } from "../app/api/webhooks/helius/route";
import { DEVNET_USDC_MINT } from "../app/lib/checkout/config";
import { jsonString } from "../app/lib/checkout/json";
import type { PublicOrder } from "../app/lib/checkout/orders";
import { webhookSettled } from "../app/lib/checkout/webhook";

// An offline Surfpool runtime stands in for devnet. The USDC mint is written
// at Circle's devnet address with six decimals, so the order's URL is the one
// a devnet customer would get. OTHER is a second six-decimal token.
const USDC = address(DEVNET_USDC_MINT);
let OTHER: Address;
let surfnet: Surfnet;
let rpc: ReturnType<typeof createSolanaRpc>;
let sendAndConfirm: ReturnType<typeof sendAndConfirmTransactionFactory>;
let merchant: Address;
let customer: KeyPairSigner;

type OrderBody = PublicOrder & { checkError?: string | null; error?: string };

function writeMint(mint: Address) {
  const data = getMintEncoder().encode({
    mintAuthority: none(),
    supply: 1_000_000_000_000n,
    decimals: 6,
    isInitialized: true,
    freezeAuthority: none(),
  });
  surfnet.setAccount(
    mint,
    1_461_600,
    Uint8Array.from(data),
    TOKEN_PROGRAM_ADDRESS
  );
}

beforeAll(async () => {
  surfnet = Surfnet.startWithConfig({ offline: true });
  rpc = createSolanaRpc(surfnet.rpcUrl);
  sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions: createSolanaRpcSubscriptions(surfnet.wsUrl),
  });
  OTHER = (await generateKeyPairSigner()).address;
  merchant = (await generateKeyPairSigner()).address;
  customer = await generateKeyPairSigner();
  writeMint(USDC);
  writeMint(OTHER);
  surfnet.fundSol(customer.address, 1_000_000_000);
  for (const mint of [USDC, OTHER]) {
    surfnet.fundToken(customer.address, mint, 1_000_000_000); // 1,000 tokens
    surfnet.fundToken(merchant, mint, 0); // the merchant's token account
  }
  Object.assign(process.env, {
    MERCHANT_ADDRESS: merchant,
    USDC_MINT: USDC,
    SOLANA_CLUSTER: "localnet",
    SOLANA_RPC_URL: surfnet.rpcUrl,
    CHECK_INTERVAL_MS: "0",
  });
}, 60_000);

afterAll(() => surfnet?.stop());

beforeEach(() => {
  // A fresh order store per test, as after a server restart.
  Reflect.deleteProperty(globalThis, "__checkoutOrders");
});

async function createOrder(
  amount: unknown,
  currency?: unknown
): Promise<Response> {
  return createRoute(
    new Request("http://checkout.test/api/orders", {
      method: "POST",
      body: JSON.stringify(
        currency === undefined ? { amount } : { amount, currency }
      ),
    })
  );
}

async function newOrder(
  amount = "12.50",
  currency?: "USDC" | "AUDD"
): Promise<OrderBody> {
  const response = await createOrder(amount, currency);
  expect(response.status).toBe(201);
  return (await response.json()) as OrderBody;
}

async function getOrder(id: string): Promise<OrderBody> {
  const response = await getRoute(
    new Request(`http://checkout.test/api/orders/${id}`),
    {
      params: Promise.resolve({ id }),
    }
  );
  return (await response.json()) as OrderBody;
}

async function confirm(id: string, signature: string): Promise<Response> {
  return confirmRoute(
    new Request(`http://checkout.test/api/orders/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ signature }),
    }),
    { params: Promise.resolve({ id }) }
  );
}

/**
 * The customer's wallet: build the transfer with @solana/pay, sign, send, confirm.
 * `fails` puts an unaffordable SOL transfer first, so the transaction lands on
 * chain, carrying the order's reference, as a failed transaction.
 */
async function pay(
  order: OrderBody,
  overrides: { amount?: number; splToken?: Address; fails?: boolean } = {}
): Promise<Signature> {
  const request = parseURL(order.url) as TransferRequestURL;
  const transfer = await createTransfer(rpc, customer, {
    recipient: request.recipient,
    amount: overrides.amount ?? request.amount!,
    splToken: overrides.splToken ?? request.splToken,
    reference: request.reference,
  });
  const instructions = overrides.fails
    ? [
        getTransferSolInstruction({
          source: customer,
          destination: merchant,
          amount: 1_000_000_000_000n,
        }),
        ...transfer,
      ]
    : transfer;
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(customer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m)
  );
  const signed = await signTransactionMessageWithSigners(message);
  assertIsTransactionWithBlockhashLifetime(signed);
  const signature = getSignatureFromTransaction(signed);
  if (overrides.fails) {
    // Confirmation throws for a failed transaction; what matters is that it landed.
    await expect(
      sendAndConfirm(signed, { commitment: "confirmed", skipPreflight: true })
    ).rejects.toThrow();
    const { value } = await rpc.getSignatureStatuses([signature]).send();
    expect(value[0]?.err).not.toBeNull();
    return signature;
  }
  // Resolves on Surfpool's "confirmed" notification; throws if the transaction fails.
  await sendAndConfirm(signed, { commitment: "confirmed" });
  return signature;
}

async function merchantUsdc(): Promise<bigint> {
  const ata = address(surfnet.getAta(merchant, USDC));
  const { value } = await rpc.getTokenAccountBalance(ata).send();
  return BigInt(value.amount);
}

describe("B5-002-S1: an order for 12.50 USDC", () => {
  test("its link encodes the merchant, the amount, the USDC mint and a reference unique to the order", async () => {
    const first = await newOrder("12.50");
    const second = await newOrder("12.50");

    expect(first.amount).toBe("12.50");
    expect(first.status).toBe("unpaid");
    const fields = parseURL(first.url) as TransferRequestURL;
    expect(fields.recipient).toBe(merchant);
    expect(fields.amount).toBe(12.5);
    expect(fields.splToken).toBe(USDC);
    expect(fields.reference).toEqual([first.reference]);
    expect(first.url).toContain("amount=12.5&spl-token=" + USDC);

    expect(second.reference).not.toBe(first.reference);
    expect((parseURL(second.url) as TransferRequestURL).reference).toEqual([
      second.reference,
    ]);
  });

  test.each([
    ["", "amount must be a number"],
    ["0", "more than zero"],
    ["-1", "amount must be a number"],
    ["12.5000001", "at most 6 decimals"],
    ["1000000.01", "at most 1000000 USDC"],
    ["1e3", "amount must be a number"],
  ])("refuses the amount %j with 400 and says why", async (amount, message) => {
    const response = await createOrder(amount);
    expect(response.status).toBe(400);
    expect(jsonString(await response.json(), "error")).toContain(message);
  });

  test("refuses to create orders when MERCHANT_ADDRESS is not a Solana address", async () => {
    const saved = process.env.MERCHANT_ADDRESS;
    process.env.MERCHANT_ADDRESS = "not-an-address";
    try {
      const response = await createOrder("12.50");
      expect(response.status).toBe(500);
      expect(jsonString(await response.json(), "error")).toContain(
        "MERCHANT_ADDRESS"
      );
    } finally {
      process.env.MERCHANT_ADDRESS = saved;
    }
  });
});

describe("B5-002-S2: the customer pays the request", () => {
  test("the order moves to paid and the receipt carries the payment's signature", async () => {
    const order = await newOrder("12.50");
    expect((await getOrder(order.id)).status).toBe("unpaid");
    const before = await merchantUsdc();

    const signature = await pay(order);
    const after = await getOrder(order.id);

    expect(after.status).toBe("paid");
    expect(after.receipt?.signature).toBe(signature);
    expect(after.receipt?.commitment).toBe("confirmed");
    expect(after.events.map((event) => event.kind)).toEqual([
      "created",
      "paid",
    ]);
    expect((await merchantUsdc()) - before).toBe(12_500_000n);
  });

  test("a wallet's signature can be confirmed directly with the same validation", async () => {
    const order = await newOrder("3.25");
    const signature = await pay(order);
    const response = await confirm(order.id, signature);
    expect(response.status).toBe(200);
    const body = (await response.json()) as OrderBody;
    expect(body.status).toBe("paid");
    expect(body.receipt?.signature).toBe(signature);
  });
});

describe("B5-002-S3: a payment the server must refuse", () => {
  test("an underpayment leaves the order unpaid with the reason logged, and a later full payment still pays it", async () => {
    const order = await newOrder("12.50");
    const short = await pay(order, { amount: 12.49 });

    const after = await getOrder(order.id);
    expect(after.status).toBe("unpaid");
    expect(after.receipt).toBeNull();
    // B5-005 then records the money it moved as owed back; see its tests.
    const rejected = after.events.find((event) => event.kind === "rejected");
    expect(rejected).toMatchObject({
      signature: short,
      message: expect.stringContaining("underpaid"),
    });
    expect(rejected?.message).toContain(
      "validateTransfer: amount not transferred"
    );

    // Polling again does not log the same rejection twice.
    expect((await getOrder(order.id)).events).toHaveLength(after.events.length);

    // findReference would keep returning the short payment; this check moves on.
    const full = await pay(order);
    const paid = await getOrder(order.id);
    expect(paid.status).toBe("paid");
    expect(paid.receipt?.signature).toBe(full);
  });

  test("a payment in another token leaves the order unpaid with the reason logged", async () => {
    const order = await newOrder("12.50");
    const wrong = await pay(order, { splToken: OTHER });

    const after = await getOrder(order.id);
    expect(after.status).toBe("unpaid");
    expect(after.receipt).toBeNull();
    expect(after.events.at(-1)).toMatchObject({
      kind: "rejected",
      signature: wrong,
      message: expect.stringContaining("not a transfer of the order's token"),
    });
  });

  test("a failed transaction carrying the reference is logged and does not block a later payment", async () => {
    const order = await newOrder("12.50");
    const failed = await pay(order, { fails: true });

    const after = await getOrder(order.id);
    expect(after.checkError).toBeNull();
    expect(after.status).toBe("unpaid");
    expect(after.receipt).toBeNull();
    expect(after.events.at(-1)).toMatchObject({
      kind: "rejected",
      signature: failed,
      message: expect.stringContaining("the transaction failed on chain"),
    });

    const full = await pay(order);
    const paid = await getOrder(order.id);
    expect(paid.status).toBe("paid");
    expect(paid.receipt?.signature).toBe(full);
  });

  test("a failed transaction posted to confirm is refused with the reason logged", async () => {
    const order = await newOrder("12.50");
    const failed = await pay(order, { fails: true });

    const response = await confirm(order.id, failed);
    expect(response.status).toBe(200);
    const after = (await response.json()) as OrderBody;
    expect(after.status).toBe("unpaid");
    expect(after.receipt).toBeNull();
    expect(after.events.at(-1)).toMatchObject({
      kind: "rejected",
      signature: failed,
      message: expect.stringContaining("the transaction failed on chain"),
    });
  });

  test("a signature that already paid one order cannot pay another", async () => {
    const first = await newOrder("12.50");
    const second = await newOrder("12.50");
    const signature = await pay(first);
    expect((await getOrder(first.id)).status).toBe("paid");

    const response = await confirm(second.id, signature);
    expect(response.status).toBe(200);
    const after = (await response.json()) as OrderBody;
    expect(after.status).toBe("unpaid");
    expect(after.receipt).toBeNull();
    expect(after.events.at(-1)).toMatchObject({
      kind: "rejected",
      signature,
      message: `signature already paid order ${first.id}`,
    });
    // The first order is untouched.
    expect((await getOrder(first.id)).receipt?.signature).toBe(signature);
  });

  test("a confirm request without a valid signature is refused and changes nothing", async () => {
    const order = await newOrder("12.50");
    const response = await confirm(order.id, "not-a-signature");
    expect(response.status).toBe(400);
    const after = await getOrder(order.id);
    expect(after.status).toBe("unpaid");
    expect(after.events.map((event) => event.kind)).toEqual(["created"]);
  });

  test("an unknown order is 404", async () => {
    const response = await getRoute(
      new Request("http://checkout.test/api/orders/nope"),
      {
        params: Promise.resolve({ id: "nope" }),
      }
    );
    expect(response.status).toBe(404);
  });
});

describe("B5-005: the merchant sees every payment that reaches an order", () => {
  test("S1: an overpayment pays the order, the receipt shows what arrived, and the excess is owed back", async () => {
    const order = await newOrder("12.50");
    const before = await merchantUsdc();
    const signature = await pay(order, { amount: 15 });

    const after = await getOrder(order.id);
    expect((await merchantUsdc()) - before).toBe(15_000_000n);
    expect(after.status).toBe("paid");
    expect(after.receipt).toMatchObject({ signature, received: "15.00" });
    expect(after.refundDue).toBe("2.50");
    expect(after.refunds).toEqual([
      expect.objectContaining({
        signature,
        amount: "2.50",
        reason: "overpaid",
      }),
    ]);
    expect(after.events.at(-1)).toMatchObject({
      kind: "refund",
      signature,
      message: "2.50 USDC to refund: overpaid",
    });

    // Polling again records nothing twice.
    const again = await getOrder(order.id);
    expect(again.events).toHaveLength(after.events.length);
    expect(again.refunds).toHaveLength(1);
  });

  test("an exact payment owes nothing back", async () => {
    const order = await newOrder("12.50");
    const signature = await pay(order);
    const after = await getOrder(order.id);
    expect(after.receipt).toMatchObject({ signature, received: "12.50" });
    expect(after.refundDue).toBe("0.00");
    expect(after.refunds).toEqual([]);
  });

  test("S2: payments after the order is paid are recorded as owed back, and the order stays paid by the first", async () => {
    const order = await newOrder("12.50");
    const first = await pay(order);
    expect((await getOrder(order.id)).status).toBe("paid");

    const second = await pay(order);
    const afterSecond = await getOrder(order.id);
    expect(afterSecond.status).toBe("paid");
    expect(afterSecond.receipt?.signature).toBe(first);
    expect(afterSecond.refundDue).toBe("12.50");
    expect(afterSecond.refunds).toEqual([
      expect.objectContaining({
        signature: second,
        amount: "12.50",
        reason: "paid again",
      }),
    ]);

    // A later payment smaller than the order is rejected as a payment, but
    // its money is owed back too.
    const small = await pay(order, { amount: 5 });
    const afterSmall = await getOrder(order.id);
    expect(afterSmall.receipt?.signature).toBe(first);
    expect(afterSmall.refundDue).toBe("17.50");
    expect(afterSmall.refunds.map((refund) => refund.signature)).toEqual([
      second,
      small,
    ]);
    expect(afterSmall.refunds[1]).toMatchObject({
      amount: "5.00",
      reason: "underpaid",
    });
  });

  test("an underpayment is rejected, and the money it moved is owed back", async () => {
    const order = await newOrder("12.50");
    const short = await pay(order, { amount: 12.49 });

    const after = await getOrder(order.id);
    expect(after.status).toBe("unpaid");
    expect(after.refunds).toEqual([
      expect.objectContaining({
        signature: short,
        amount: "12.49",
        reason: "underpaid",
      }),
    ]);

    const full = await pay(order);
    const paid = await getOrder(order.id);
    expect(paid.status).toBe("paid");
    expect(paid.receipt?.signature).toBe(full);
    expect(paid.refundDue).toBe("12.49");
  });

  test("a poll and a confirm racing over the paying signature do not record it as a second payment", async () => {
    const order = await newOrder("12.50");
    const signature = await pay(order);

    await Promise.all([confirm(order.id, signature), getOrder(order.id)]);

    const after = await getOrder(order.id);
    expect(after.status).toBe("paid");
    expect(after.receipt?.signature).toBe(signature);
    expect(after.refunds).toEqual([]);
    expect(after.events.map((event) => event.kind)).toEqual([
      "created",
      "paid",
    ]);
  });
});

describe("B5-006: a wallet that cannot pay is told why, and the merchant sees it", () => {
  beforeEach(() => {
    process.env.PUBLIC_URL = "https://checkout.test";
  });
  afterEach(() => {
    delete process.env.PUBLIC_URL;
  });

  async function askForTransaction(id: string, account: unknown) {
    const response = await payPost(
      new Request(`https://checkout.test/api/orders/${id}/pay`, {
        method: "POST",
        body: JSON.stringify({ account }),
      }),
      { params: Promise.resolve({ id }) }
    );
    const body = (await response.json()) as {
      message?: string;
      transaction?: string;
    };
    return { status: response.status, body, cors: response.headers };
  }

  /** A wallet with the given devnet balances; no USDC account when usdc is undefined. */
  async function wallet(lamports: number, usdc?: number): Promise<Address> {
    const { address: account } = await generateKeyPairSigner();
    if (lamports > 0) surfnet.fundSol(account, lamports);
    if (usdc !== undefined) surfnet.fundToken(account, USDC, usdc);
    return account;
  }

  async function referenceSignatures(order: OrderBody) {
    return rpc.getSignaturesForAddress(order.reference).send();
  }

  test("with a public URL the order offers a transaction request to its own pay endpoint", async () => {
    const order = await newOrder("12.50");
    expect(order.requestUrl).not.toBeNull();
    const request = parseURL(order.requestUrl!) as TransactionRequestURL;
    expect(String(request.link)).toBe(
      `https://checkout.test/api/orders/${order.id}/pay`
    );
    // The plain transfer request is still there for wallets without one.
    expect((parseURL(order.url) as TransferRequestURL).recipient).toBe(
      merchant
    );

    const shown = await payGet(
      new Request(`https://checkout.test/api/orders/${order.id}/pay`),
      { params: Promise.resolve({ id: order.id }) }
    );
    expect(await shown.json()).toEqual({
      label: "Stablecoin checkout",
      icon: "https://checkout.test/icon.svg",
    });
    expect(shown.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = payOptions();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-headers")).toContain(
      "Cache-Control"
    );
  });

  test("S1: a wallet short of USDC is refused with how much is missing, nothing is sent, and the page sees it", async () => {
    const order = await newOrder("12.50");
    const short = await wallet(1_000_000_000, 3_000_000);

    const answer = await askForTransaction(order.id, short);
    expect(answer.status).toBe(400);
    expect(answer.body.transaction).toBeUndefined();
    expect(answer.body.message).toBe(
      "this wallet holds 3.00 USDC on localnet and the order is 12.50 USDC: 9.50 USDC is missing"
    );
    expect(answer.cors.get("access-control-allow-origin")).toBe("*");

    const after = await getOrder(order.id);
    expect(after.status).toBe("unpaid");
    expect(after.events.at(-1)).toMatchObject({
      kind: "refused",
      wallet: short,
      message: answer.body.message,
    });
    expect(await referenceSignatures(order)).toEqual([]);
  });

  test("S2: a wallet with USDC but no SOL is told it needs SOL for the fee", async () => {
    const order = await newOrder("12.50");
    const noSol = await wallet(0, 20_000_000);
    const answer = await askForTransaction(order.id, noSol);
    expect(answer.status).toBe(400);
    expect(answer.body.message).toMatch(
      /^this wallet holds 0 SOL on localnet and needs at least 0\.\d+ SOL to pay the network fee and stay open$/
    );
    expect((await getOrder(order.id)).events.at(-1)).toMatchObject({
      kind: "refused",
      wallet: noSol,
    });
  });

  test("S2: a wallet whose SOL would fall below rent exemption after the fee is refused too", async () => {
    const order = await newOrder("12.50");
    // Enough for the fee alone, not to stay rent exempt afterwards.
    const lowSol = await wallet(100_000, 20_000_000);
    const answer = await askForTransaction(order.id, lowSol);
    expect(answer.status).toBe(400);
    expect(answer.body.message).toContain(
      "this wallet holds 0.0001 SOL on localnet and needs at least"
    );
  });

  test("S2: a wallet with no SOL and no USDC is told it may be on another network", async () => {
    const order = await newOrder("12.50");
    const empty = await wallet(0);
    const answer = await askForTransaction(order.id, empty);
    expect(answer.status).toBe(400);
    expect(answer.body.message).toBe(
      "this wallet holds no SOL and no USDC on localnet; if the wallet is set to another network, switch it to localnet"
    );
  });

  test("S3: a wallet that can pay gets the transaction, signs it, and the order turns paid", async () => {
    const order = await newOrder("12.50");
    const answer = await askForTransaction(order.id, customer.address);
    expect(answer.status).toBe(200);
    expect(answer.body.message).toBe(
      `Pay 12.50 USDC for order ${order.id.slice(0, 8)}`
    );

    // What a wallet does: decode, sign these exact bytes, send.
    const transaction = getTransactionDecoder().decode(
      getBase64Encoder().encode(answer.body.transaction!)
    );
    const message = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(transaction.messageBytes)
    );
    const signed = {
      ...(await signTransaction([customer.keyPair], transaction)),
      lifetimeConstraint: message.lifetimeConstraint,
    };
    assertIsTransactionWithBlockhashLifetime(signed);
    assertIsTransactionWithinSizeLimit(signed);
    await sendAndConfirm(signed, { commitment: "confirmed" });
    const signature = getSignatureFromTransaction(signed);

    const after = await getOrder(order.id);
    expect(after.status).toBe("paid");
    expect(after.receipt?.signature).toBe(signature);
    expect(after.events.map((event) => event.kind)).toEqual([
      "created",
      "requested",
      "paid",
    ]);
    expect(after.events[1]).toMatchObject({ wallet: customer.address });
  });

  test("a wallet that appends compute budget instructions after the transfer, as Solflare does, still pays", async () => {
    const order = await newOrder("12.50");
    const answer = await askForTransaction(order.id, customer.address);
    expect(answer.status).toBe(200);

    // Solflare, given this unsigned transaction on devnet, added a compute
    // unit limit and a compute unit price after the transfer before signing.
    const computeBudget = address(
      "ComputeBudget111111111111111111111111111111"
    );
    const unitLimit = new Uint8Array(5);
    unitLimit[0] = 2;
    new DataView(unitLimit.buffer).setUint32(1, 200_000, true);
    const unitPrice = new Uint8Array(9);
    unitPrice[0] = 3;
    new DataView(unitPrice.buffer).setBigUint64(1, 1_000n, true);
    const served = decompileTransactionMessage(
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(
          getBase64Encoder().encode(answer.body.transaction!)
        ).messageBytes
      )
    );
    const signed = await signTransactionMessageWithSigners(
      pipe(
        served,
        (m) => setTransactionMessageFeePayerSigner(customer, m),
        (m) =>
          appendTransactionMessageInstructions(
            [
              { programAddress: computeBudget, data: unitLimit },
              { programAddress: computeBudget, data: unitPrice },
            ],
            m
          )
      )
    );
    assertIsTransactionWithBlockhashLifetime(signed);
    assertIsTransactionWithinSizeLimit(signed);
    await sendAndConfirm(signed, { commitment: "confirmed" });

    const after = await getOrder(order.id);
    expect(after.events.filter((event) => event.kind === "rejected")).toEqual(
      []
    );
    expect(after.status).toBe("paid");
    expect(after.receipt).toMatchObject({
      signature: getSignatureFromTransaction(signed),
      received: "12.50",
    });
  });

  test("a paid order refuses to hand out another transaction", async () => {
    const order = await newOrder("12.50");
    await pay(order);
    expect((await getOrder(order.id)).status).toBe("paid");

    const answer = await askForTransaction(order.id, customer.address);
    expect(answer.status).toBe(409);
    expect(answer.body.message).toBe("this order is already paid");
    expect((await getOrder(order.id)).refunds).toEqual([]);
  });

  test("a request without a valid account is refused and logs nothing", async () => {
    const order = await newOrder("12.50");
    const answer = await askForTransaction(order.id, "not-an-address");
    expect(answer.status).toBe(400);
    expect(answer.body.message).toBe("account is not a Solana address");
    expect((await getOrder(order.id)).events.map((e) => e.kind)).toEqual([
      "created",
    ]);
  });
});

describe("B5-004: a second currency, and confirmation by webhook", () => {
  const SECRET = "test-webhook-secret-0123456789";
  // In these tests OTHER is the stand-in for AUDD, as a devnet deployment's
  // AUDD_MINT would be.
  let AUDD: Address;

  beforeEach(() => {
    AUDD = OTHER;
    process.env.AUDD_MINT = AUDD;
  });
  afterEach(() => {
    for (const name of [
      "AUDD_MINT",
      "WEBHOOK_SECRET",
      "FALLBACK_CHECK_INTERVAL_MS",
      "WEBHOOK_RETRY_DELAYS_MS",
      "PUBLIC_URL",
    ]) {
      delete process.env[name];
    }
    process.env.USDC_MINT = USDC;
    vi.restoreAllMocks();
  });

  /** Webhooks on. The fallback poll is an hour away unless a test shortens it. */
  function webhooksOn(fallbackMs = 3_600_000) {
    process.env.WEBHOOK_SECRET = SECRET;
    process.env.FALLBACK_CHECK_INTERVAL_MS = String(fallbackMs);
    process.env.WEBHOOK_RETRY_DELAYS_MS = "0,20";
  }

  async function merchantHolds(mint: Address): Promise<bigint> {
    const ata = address(surfnet.getAta(merchant, mint));
    const { value } = await rpc.getTokenAccountBalance(ata).send();
    return BigInt(value.amount);
  }

  async function accountKeys(signature: Signature): Promise<Address[]> {
    const transaction = await rpc
      .getTransaction(signature, {
        commitment: "confirmed",
        encoding: "json",
        maxSupportedTransactionVersion: 0,
      })
      .send();
    return [...transaction!.transaction.message.accountKeys];
  }

  /** What Helius posts for a raw webhook: the transaction, signatures and account keys. */
  async function rawDelivery(signature: Signature) {
    return {
      transaction: {
        signatures: [signature],
        message: { accountKeys: await accountKeys(signature) },
      },
      meta: { loadedAddresses: { writable: [], readonly: [] } },
    };
  }

  /** POST to the webhook endpoint and wait for its checks to finish. */
  async function deliver(body: unknown, authorization: string | null = SECRET) {
    const response = await webhookRoute(
      new Request("https://checkout.test/api/webhooks/helius", {
        method: "POST",
        headers: authorization === null ? {} : { authorization },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    );
    await webhookSettled();
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  }

  /** The RPC methods requested through fetch since the spy was last cleared. */
  function rpcMethods(spy: { mock: { calls: unknown[][] } }): string[] {
    return spy.mock.calls.map(([, init]) => {
      const body = (init as { body?: unknown } | undefined)?.body;
      return typeof body === "string"
        ? ((JSON.parse(body) as { method?: string }).method ?? "?")
        : "?";
    });
  }

  /** An order whose first, page-load check of the chain has already happened. */
  async function openOrder(
    amount = "12.50",
    currency?: "USDC" | "AUDD"
  ): Promise<OrderBody> {
    const order = await newOrder(amount, currency);
    expect((await getOrder(order.id)).status).toBe("unpaid");
    return order;
  }

  describe("B5-004-S3: the merchant picks the currency", () => {
    test("an AUDD order carries its currency in the link, the note and its log; a USDC order is unchanged", async () => {
      const audd = await newOrder("12.50", "AUDD");
      expect(audd).toMatchObject({
        amount: "12.50",
        currency: "AUDD",
        mint: AUDD,
        status: "unpaid",
      });
      expect(audd.currencyNote).toContain("stand-in test token");
      expect(audd.events[0].message).toBe("Order for 12.50 AUDD");
      const link = parseURL(audd.url) as TransferRequestURL;
      expect(link.splToken).toBe(AUDD);
      // The same number, in AUDD: nothing is converted.
      expect(link.amount).toBe(12.5);
      expect(link.recipient).toBe(merchant);

      const usdc = await newOrder("12.50");
      expect(usdc).toMatchObject({
        currency: "USDC",
        currencyNote: null,
        mint: USDC,
      });
      expect((parseURL(usdc.url) as TransferRequestURL).splToken).toBe(USDC);
      expect(usdc.reference).not.toBe(audd.reference);
    });

    test("an overpayment in AUDD is owed back in AUDD", async () => {
      const order = await newOrder("12.50", "AUDD");
      await pay(order, { amount: 15 });
      const paid = await getOrder(order.id);
      expect(paid.status).toBe("paid");
      expect(paid.receipt?.received).toBe("15.00");
      expect(paid.refundDue).toBe("2.50");
      expect(paid.events.map((event) => event.message)).toEqual([
        "Order for 12.50 AUDD",
        "Paid 12.50 AUDD",
        "2.50 AUDD to refund: overpaid",
      ]);
    });

    test("a wallet short of AUDD is refused in AUDD, and one that can pay is asked for AUDD", async () => {
      process.env.PUBLIC_URL = "https://checkout.test";
      const order = await newOrder("12.50", "AUDD");
      const ask = async (account: Address) => {
        const response = await payPost(
          new Request(`https://checkout.test/api/orders/${order.id}/pay`, {
            method: "POST",
            body: JSON.stringify({ account }),
          }),
          { params: Promise.resolve({ id: order.id }) }
        );
        return {
          status: response.status,
          body: (await response.json()) as { message?: string },
        };
      };

      // Plenty of USDC does not help: the order is in AUDD.
      const { address: short } = await generateKeyPairSigner();
      surfnet.fundSol(short, 1_000_000_000);
      surfnet.fundToken(short, USDC, 500_000_000);
      surfnet.fundToken(short, AUDD, 3_000_000);
      const refused = await ask(short);
      expect(refused.status).toBe(400);
      expect(refused.body.message).toBe(
        "this wallet holds 3.00 AUDD on localnet and the order is 12.50 AUDD: 9.50 AUDD is missing"
      );

      const served = await ask(customer.address);
      expect(served.status).toBe(200);
      expect(served.body.message).toBe(
        `Pay 12.50 AUDD for order ${order.id.slice(0, 8)}`
      );
    });

    test.each([
      ["EUR", 400, "currency must be one of USDC, AUDD"],
      [42, 400, "currency must be one of USDC, AUDD"],
    ])("currency %j is refused", async (currency, status, message) => {
      const response = await createOrder("12.50", currency);
      expect(response.status).toBe(status);
      expect(jsonString(await response.json(), "error")).toBe(message);
    });

    test("the amount limit is stated in the order's currency", async () => {
      const response = await createOrder("1000000.01", "AUDD");
      expect(response.status).toBe(400);
      expect(jsonString(await response.json(), "error")).toBe(
        "amount must be at most 1000000 AUDD"
      );
    });

    test("AUDD is not offered when AUDD_MINT is not set, and USDC still is", async () => {
      delete process.env.AUDD_MINT;
      const refused = await createOrder("12.50", "AUDD");
      expect(refused.status).toBe(400);
      expect(jsonString(await refused.json(), "error")).toBe(
        "AUDD is not offered here: AUDD_MINT is not set"
      );
      expect((await createOrder("12.50", "USDC")).status).toBe(201);
    });

    test("a token that is not usable as configured creates no order", async () => {
      // The same mint for both currencies.
      process.env.AUDD_MINT = USDC;
      const same = await createOrder("12.50", "AUDD");
      expect(same.status).toBe(500);
      expect(jsonString(await same.json(), "error")).toBe(
        "AUDD_MINT and USDC_MINT name the same token"
      );

      // A mint with nine decimals: every amount would be out by a thousand.
      const nine = (await generateKeyPairSigner()).address;
      surfnet.setAccount(
        nine,
        1_461_600,
        Uint8Array.from(
          getMintEncoder().encode({
            mintAuthority: none(),
            supply: 1_000_000_000_000n,
            decimals: 9,
            isInitialized: true,
            freezeAuthority: none(),
          })
        ),
        TOKEN_PROGRAM_ADDRESS
      );
      process.env.AUDD_MINT = nine;
      const wrongDecimals = await createOrder("12.50", "AUDD");
      expect(wrongDecimals.status).toBe(500);
      expect(jsonString(await wrongDecimals.json(), "error")).toBe(
        `the AUDD mint ${nine} has 9 decimals; this checkout supports 6`
      );

      // The same six-decimal mint data, but owned by the Token-2022 program:
      // the transfers built here could not move it.
      const token2022 = (await generateKeyPairSigner()).address;
      surfnet.setAccount(
        token2022,
        1_461_600,
        Uint8Array.from(
          getMintEncoder().encode({
            mintAuthority: none(),
            supply: 1_000_000_000_000n,
            decimals: 6,
            isInitialized: true,
            freezeAuthority: none(),
          })
        ),
        address("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")
      );
      process.env.AUDD_MINT = token2022;
      const otherProgram = await createOrder("12.50", "AUDD");
      expect(otherProgram.status).toBe(500);
      expect(jsonString(await otherProgram.json(), "error")).toBe(
        `${token2022}, named as the AUDD mint, is not owned by the SPL Token program; Token-2022 mints are not supported`
      );

      // A token account, which the token program owns but is not a mint.
      const tokenAccount = (await generateKeyPairSigner()).address;
      surfnet.setAccount(
        tokenAccount,
        2_039_280,
        new Uint8Array(165),
        TOKEN_PROGRAM_ADDRESS
      );
      process.env.AUDD_MINT = tokenAccount;
      const notMint = await createOrder("12.50", "AUDD");
      expect(notMint.status).toBe(500);
      expect(jsonString(await notMint.json(), "error")).toBe(
        `${tokenAccount}, named as the AUDD mint, is a token program account but not a mint`
      );

      // An address that is not a mint on this network at all.
      const missing = (await generateKeyPairSigner()).address;
      process.env.AUDD_MINT = missing;
      const noMint = await createOrder("12.50", "AUDD");
      expect(noMint.status).toBe(500);
      expect(jsonString(await noMint.json(), "error")).toBe(
        `the AUDD mint ${missing} does not exist on this network`
      );
    });
  });

  describe("B5-004-S1: an order priced in the second stablecoin", () => {
    test("paid in AUDD, it is marked paid and the AUDD reached the merchant", async () => {
      const order = await newOrder("12.50", "AUDD");
      const before = await merchantHolds(AUDD);
      const usdcBefore = await merchantHolds(USDC);
      const signature = await pay(order);

      const paid = await getOrder(order.id);
      expect(paid.status).toBe("paid");
      expect(paid.receipt).toMatchObject({
        signature,
        received: "12.50",
        foundBy: "poll",
      });
      expect(paid.events.at(-1)?.message).toBe("Paid 12.50 AUDD");
      expect((await merchantHolds(AUDD)) - before).toBe(12_500_000n);
      expect(await merchantHolds(USDC)).toBe(usdcBefore);
    });

    test("a USDC payment carrying its reference is rejected, naming both currencies, and a later AUDD payment still pays it", async () => {
      const order = await newOrder("12.50", "AUDD");
      const usdcBefore = await merchantHolds(USDC);
      const wrong = await pay(order, { splToken: USDC });

      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.receipt).toBeNull();
      expect(after.events.at(-1)).toMatchObject({
        kind: "rejected",
        signature: wrong,
      });
      expect(after.events.at(-1)?.message).toContain(
        "paid in USDC, but this order is priced in AUDD: 12.50 USDC reached the merchant and is not counted for this order"
      );
      // The USDC did arrive. By decision it is not tallied as owed back.
      expect((await merchantHolds(USDC)) - usdcBefore).toBe(12_500_000n);
      expect(after.refundDue).toBe("0.00");
      expect(after.refunds).toEqual([]);

      const right = await pay(order);
      const paid = await getOrder(order.id);
      expect(paid.status).toBe("paid");
      expect(paid.receipt?.signature).toBe(right);
    });

    test("the other way round: an AUDD payment to a USDC order is rejected the same way", async () => {
      const order = await newOrder("5.00", "USDC");
      await pay(order, { splToken: AUDD });
      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.events.at(-1)?.message).toContain(
        "paid in AUDD, but this order is priced in USDC: 5.00 AUDD reached the merchant"
      );
    });
  });

  describe("B5-004-S2: a webhook call with a missing or wrong secret", () => {
    test("is refused, changes no order and reads nothing from the chain", async () => {
      webhooksOn();
      const order = await openOrder();
      const signature = await pay(order);
      const delivery = [await rawDelivery(signature)];
      const spy = vi.spyOn(globalThis, "fetch");

      for (const authorization of [
        null,
        "",
        "wrong-secret-0123456789",
        SECRET.slice(0, -1),
        // One character more. (A trailing space would not do: HTTP strips
        // whitespace around a header's value before the server sees it.)
        `${SECRET}x`,
        `Bearer ${SECRET}`,
      ]) {
        const refused = await deliver(delivery, authorization);
        expect(refused.status).toBe(401);
        expect(refused.body).toEqual({
          error: "missing or wrong webhook secret",
        });
      }
      expect(rpcMethods(spy)).toEqual([]);
      // Reading the order now does not read the chain either: the fallback is an hour away.
      const untouched = await getOrder(order.id);
      expect(rpcMethods(spy)).toEqual([]);
      expect(untouched.status).toBe("unpaid");
      expect(untouched.events.map((event) => event.kind)).toEqual(["created"]);

      // Positive control: the same delivery with the secret is acted on.
      const accepted = await deliver(delivery);
      expect(accepted.status).toBe(200);
      expect(rpcMethods(spy).length).toBeGreaterThan(0);
      expect((await getOrder(order.id)).status).toBe("paid");
    });

    test("the endpoint is off without a secret, and a short secret is a configuration error", async () => {
      const off = await deliver([], SECRET);
      expect(off.status).toBe(404);

      process.env.WEBHOOK_SECRET = "too-short";
      const short = await deliver([], "too-short");
      expect(short.status).toBe(500);
      expect(short.body.error).toBe(
        "WEBHOOK_SECRET must be at least 16 characters"
      );
    });
  });

  describe("B5-004-S4: an authentic webhook naming a payment", () => {
    test("marks the order paid from the chain, without polling having read it", async () => {
      webhooksOn();
      const order = await openOrder("12.50", "AUDD");
      const signature = await pay(order);
      // The page keeps polling the server; the server does not read the chain.
      expect((await getOrder(order.id)).status).toBe("unpaid");
      const delivery = [await rawDelivery(signature)];

      const spy = vi.spyOn(globalThis, "fetch");
      const result = await deliver(delivery);
      expect(result.status).toBe(200);
      expect(result.body).toEqual({
        accepted: true,
        checked: true,
        named: 1,
        matched: 1,
      });

      const paid = await getOrder(order.id);
      expect(paid.status).toBe("paid");
      expect(paid.receipt).toMatchObject({
        signature,
        received: "12.50",
        foundBy: "webhook",
      });
      // The transaction itself was read; the reference was never listed.
      const methods = rpcMethods(spy);
      expect(methods).toContain("getTransaction");
      expect(methods).not.toContain("getSignaturesForAddress");
    });

    test("an RPC error on the first look does not end the check: the next look pays the order", async () => {
      webhooksOn();
      const order = await openOrder();
      const signature = await pay(order);
      const delivery = [await rawDelivery(signature)];

      // The RPC turns the first request away, as public devnet does when it
      // rate-limits; every later request goes through.
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementationOnce(() =>
          Promise.resolve(new Response("Too Many Requests", { status: 429 }))
        );
      const result = await deliver(delivery);
      expect(result.status).toBe(200);
      expect(spy.mock.calls.length).toBeGreaterThan(1);

      // Paid by the webhook's second look, not left for the fallback an hour away.
      const paid = await getOrder(order.id);
      expect(paid.status).toBe("paid");
      expect(paid.receipt).toMatchObject({ signature, foundBy: "webhook" });
    });

    test("an RPC that fails every look leaves the order for the fallback, without an error", async () => {
      webhooksOn(0);
      const order = await openOrder();
      const signature = await pay(order);
      const delivery = [await rawDelivery(signature)];

      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(() =>
          Promise.resolve(new Response("Too Many Requests", { status: 429 }))
        );
      const result = await deliver(delivery);
      // One request per configured look, and the call is still answered.
      expect(result.status).toBe(200);
      expect(spy.mock.calls.length).toBe(2);
      spy.mockRestore();

      // Nothing was judged on a failed read; the fallback poll then finds it.
      const later = await getOrder(order.id);
      expect(later.status).toBe("paid");
      expect(later.receipt).toMatchObject({ signature, foundBy: "poll" });
    });

    test.each([
      [
        "an enhanced delivery",
        (signature: Signature, keys: Address[]) => [
          {
            signature,
            type: "TRANSFER",
            accountData: keys.map((account) => ({ account })),
          },
        ],
      ],
      [
        "a delivery with only the signature, whose accounts are read from the chain",
        (signature: Signature) => [{ signature }],
      ],
      [
        "a single object in place of a list",
        (signature: Signature) => ({ signature }),
      ],
    ])("%s is understood too", async (_name, shape) => {
      webhooksOn();
      const order = await openOrder();
      const signature = await pay(order);
      const result = await deliver(
        shape(signature, await accountKeys(signature))
      );
      expect(result.body).toMatchObject({ named: 1, matched: 1 });
      expect((await getOrder(order.id)).receipt).toMatchObject({
        signature,
        foundBy: "webhook",
      });
    });

    test("a second payment to a paid order arrives by webhook and is owed back", async () => {
      webhooksOn();
      const order = await openOrder("2.00");
      const first = await pay(order);
      await deliver([await rawDelivery(first)]);
      const second = await pay(order);
      await deliver([await rawDelivery(second)]);

      const after = await getOrder(order.id);
      expect(after.receipt?.signature).toBe(first);
      expect(after.refundDue).toBe("2.00");
      expect(after.refunds).toMatchObject([
        { signature: second, reason: "paid again" },
      ]);
    });
  });

  describe("B5-004-S5: an authentic webhook that pays nothing, or arrives twice", () => {
    test("a payment in the wrong token stays unpaid, with the reason", async () => {
      webhooksOn();
      const order = await openOrder("12.50", "AUDD");
      const wrong = await pay(order, { splToken: USDC });
      const result = await deliver([await rawDelivery(wrong)]);
      expect(result.body).toMatchObject({ named: 1, matched: 1 });

      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.events.at(-1)).toMatchObject({
        kind: "rejected",
        signature: wrong,
        message: expect.stringContaining(
          "paid in USDC, but this order is priced in AUDD"
        ),
      });
    });

    test("an underpayment stays unpaid, and what arrived is owed back", async () => {
      webhooksOn();
      const order = await openOrder("5.00");
      const short = await pay(order, { amount: 4.99 });
      await deliver([await rawDelivery(short)]);

      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.refunds).toMatchObject([
        { signature: short, amount: "4.99", reason: "underpaid" },
      ]);
    });

    test("a transaction that failed on chain is logged as failed", async () => {
      webhooksOn();
      const order = await openOrder();
      const failed = await pay(order, { fails: true });
      await deliver([await rawDelivery(failed)]);

      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.events.at(-1)).toMatchObject({
        kind: "rejected",
        signature: failed,
        message: expect.stringContaining("the transaction failed on chain"),
      });
    });

    test("a payment whose reference is no order's matches nothing", async () => {
      webhooksOn();
      // A real payment for an order this server has since forgotten.
      const forgotten = await newOrder("12.50");
      const signature = await pay(forgotten);
      Reflect.deleteProperty(globalThis, "__checkoutOrders");
      const order = await openOrder();

      const result = await deliver([await rawDelivery(signature)]);
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ named: 1, matched: 0 });
      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.events.map((event) => event.kind)).toEqual(["created"]);
    });

    test("a body that names another order's reference cannot pay that order", async () => {
      webhooksOn();
      const paidFor = await openOrder();
      const target = await openOrder();
      const signature = await pay(paidFor);

      // The secret is right; the body is not. It claims the payment for one
      // order touched the other order's reference.
      const result = await deliver([
        { signature, accountData: [{ account: target.reference }] },
      ]);
      expect(result.body).toMatchObject({ named: 1, matched: 1 });

      const after = await getOrder(target.id);
      expect(after.status).toBe("unpaid");
      expect(after.receipt).toBeNull();
      expect(after.events.at(-1)).toMatchObject({
        kind: "rejected",
        signature,
        message: expect.stringContaining("this order's reference"),
      });
      // The order it really paid was not named, so nothing prompted its check.
      expect((await getOrder(paidFor.id)).status).toBe("unpaid");
      await deliver([await rawDelivery(signature)]);
      expect((await getOrder(paidFor.id)).status).toBe("paid");
    });

    test("a signature the chain has never seen changes nothing", async () => {
      webhooksOn();
      const order = await openOrder();
      const unseen = getBase58Decoder().decode(
        crypto.getRandomValues(new Uint8Array(64))
      ) as Signature;
      const result = await deliver([
        { signature: unseen, accountData: [{ account: order.reference }] },
      ]);
      expect(result.body).toMatchObject({ named: 1, matched: 1 });
      const after = await getOrder(order.id);
      expect(after.status).toBe("unpaid");
      expect(after.events.map((event) => event.kind)).toEqual(["created"]);
    });

    test("the same delivery twice changes nothing the second time", async () => {
      webhooksOn();
      const order = await openOrder();
      const signature = await pay(order);
      const delivery = [await rawDelivery(signature)];
      await deliver(delivery);
      const once = await getOrder(order.id);
      expect(once.status).toBe("paid");

      const again = await deliver(delivery);
      expect(again.status).toBe(200);
      const twice = await getOrder(order.id);
      expect(twice.events).toEqual(once.events);
      expect(twice.receipt).toEqual(once.receipt);
      expect(twice.refunds).toEqual([]);
    });

    test("bodies that name nothing, or are not JSON, or are too large", async () => {
      webhooksOn();
      const order = await openOrder();

      for (const body of [[], {}, [{ signature: "nope" }], [null, 7, "x"]]) {
        const result = await deliver(body);
        expect(result.status).toBe(200);
        expect(result.body).toMatchObject({ named: 0, matched: 0 });
      }
      expect((await deliver("not json")).status).toBe(400);
      expect((await deliver("x".repeat(1_000_001))).status).toBe(413);
      expect(
        (await getOrder(order.id)).events.map((event) => event.kind)
      ).toEqual(["created"]);
    });
  });

  describe("B5-004-S6: webhooks on, and no call arrives", () => {
    test("the fallback check still finds the payment, later", async () => {
      webhooksOn(1000);
      const order = await openOrder();
      const opened = Date.now();
      const signature = await pay(order);

      // Inside the fallback interval, polling does not read the chain.
      const soon = await getOrder(order.id);
      expect(Date.now() - opened).toBeLessThan(1000);
      expect(soon.status).toBe("unpaid");

      await new Promise((resolve) =>
        setTimeout(resolve, 1050 - (Date.now() - opened))
      );
      const later = await getOrder(order.id);
      expect(later.status).toBe("paid");
      expect(later.receipt).toMatchObject({ signature, foundBy: "poll" });
    });
  });
});
