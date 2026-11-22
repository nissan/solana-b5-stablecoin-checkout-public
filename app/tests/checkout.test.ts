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
} from "vitest";
import { POST as confirmRoute } from "../app/api/orders/[id]/confirm/route";
import {
  GET as payGet,
  OPTIONS as payOptions,
  POST as payPost,
} from "../app/api/orders/[id]/pay/route";
import { GET as getRoute } from "../app/api/orders/[id]/route";
import { POST as createRoute } from "../app/api/orders/route";
import { DEVNET_USDC_MINT } from "../app/lib/checkout/config";
import { jsonString } from "../app/lib/checkout/json";
import type { PublicOrder } from "../app/lib/checkout/orders";

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

async function createOrder(amount: unknown): Promise<Response> {
  return createRoute(
    new Request("http://checkout.test/api/orders", {
      method: "POST",
      body: JSON.stringify({ amount }),
    })
  );
}

async function newOrder(amount = "12.50"): Promise<OrderBody> {
  const response = await createOrder(amount);
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
