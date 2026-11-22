import { address, signature as asSignature } from "@solana/kit";
import { encodeURL } from "@solana/pay";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { CheckoutView } from "../app/components/checkout/checkout-view";
import { OrderForm } from "../app/components/checkout/order-form";
import type { PublicOrder } from "../app/lib/checkout/orders";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

// Fixture addresses: an example merchant and reference, not real accounts.
const merchant = address("9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin");
const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
const reference = address("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1");
const url = encodeURL({
  recipient: merchant,
  amount: 12.5,
  splToken: mint,
  reference,
}).toString();
const signature = asSignature(
  "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
);
const second = asSignature(
  "DyXZZCSiBREJ8YZ5cULd7PVdKpbkhHvHJ7otbJmLJajJtRsyq1irMMqKimYeKvRmZ8Sc2qWLhKjYR4ekM8RSzkV"
);

const unpaid: PublicOrder = {
  id: "0b6c7f1e-0000-4000-8000-000000000001",
  amount: "12.50",
  currency: "USDC",
  merchant,
  mint,
  cluster: "devnet",
  reference,
  url,
  createdAt: "2026-11-21T09:00:00.000Z",
  status: "unpaid",
  receipt: null,
  requestUrl: null,
  refundDue: "0.00",
  refunds: [],
  events: [
    {
      at: "2026-11-21T09:00:00.000Z",
      kind: "created",
      message: "Order for 12.50 USDC",
    },
  ],
};

const paid: PublicOrder = {
  ...unpaid,
  status: "paid",
  receipt: {
    signature,
    slot: "123",
    blockTime: "2026-11-21T09:00:05.000Z",
    commitment: "confirmed",
    received: "12.50",
    paidAt: "2026-11-21T09:00:06.000Z",
  },
  events: [
    ...unpaid.events,
    {
      at: "2026-11-21T09:00:06.000Z",
      kind: "paid",
      message: "Paid 12.50 USDC",
      signature,
    },
  ],
};

/** Paid, then a second 12.50 to the same reference. */
const paidAgain: PublicOrder = {
  ...paid,
  refundDue: "12.50",
  refunds: [
    {
      signature: second,
      amount: "12.50",
      reason: "paid again",
      at: "2026-11-21T09:01:00.000Z",
    },
  ],
};

function respond(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

beforeEach(() => push.mockReset());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("checkout page", () => {
  test("shows the order's Solana Pay link and QR code, then the receipt once the server says paid", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockImplementation(() => respond(paidAgain))
      .mockImplementationOnce(() => respond(unpaid))
      .mockImplementationOnce(() => respond(paid));
    vi.stubGlobal("fetch", fetchMock);

    render(<CheckoutView id={unpaid.id} />);
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(fetchMock).toHaveBeenCalledWith(`/api/orders/${unpaid.id}`, {
      cache: "no-store",
    });
    expect(
      screen
        .getByRole("link", { name: "Open in a wallet" })
        .getAttribute("href")
    ).toBe(url);
    const qr = screen.getByRole("img", { name: "Solana Pay QR code" });
    expect(qr.getAttribute("data-qr-url")).toBe(url);
    expect(qr.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("status").textContent).toBe("Waiting for payment");

    // The page polls; the next answer is paid.
    await act(() => vi.advanceTimersByTimeAsync(1500));

    expect(screen.getByRole("status").textContent).toBe("Paid");
    const receipt = screen.getByLabelText("Receipt");
    expect(receipt.textContent).toContain(signature);
    expect(receipt.textContent).toContain("confirmed");
    expect(receipt.textContent).toContain("12.50 USDC");
    const link = screen.getByRole("link", { name: signature });
    expect(link.getAttribute("href")).toBe(
      `https://explorer.solana.com/tx/${signature}?cluster=devnet`
    );
    expect(
      screen.queryByRole("img", { name: "Solana Pay QR code" })
    ).toBeNull();
    expect(screen.queryByRole("region", { name: "To refund" })).toBeNull();

    // Paid is not the end: the page keeps polling, and a second payment shows.
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const refunds = screen.getByRole("region", { name: "To refund" });
    expect(refunds.textContent).toContain("To refund: 12.50 USDC");
    expect(refunds.textContent).toContain(
      "12.50 USDC, paid again after the order was paid"
    );
    expect(screen.getByTitle(second).getAttribute("href")).toBe(
      `https://explorer.solana.com/tx/${second}?cluster=devnet`
    );
    expect(screen.getByRole("status").textContent).toBe("Paid");
  });

  test("shows what an overpayment received and the excess to refund", async () => {
    const overpaid: PublicOrder = {
      ...paid,
      receipt: { ...paid.receipt!, received: "15.00" },
      refundDue: "2.50",
      refunds: [
        {
          signature,
          amount: "2.50",
          reason: "overpaid",
          at: "2026-11-21T09:00:06.000Z",
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond(overpaid))
    );
    render(<CheckoutView id={unpaid.id} />);
    const refunds = await screen.findByRole("region", { name: "To refund" });
    expect(refunds.textContent).toContain("To refund: 2.50 USDC");
    expect(refunds.textContent).toContain(
      "2.50 USDC, paid more than the order"
    );
    expect(screen.getByLabelText("Receipt").textContent).toContain(
      "15.00 USDC"
    );
  });

  test("lists a rejected payment with its reason", async () => {
    const rejected: PublicOrder = {
      ...unpaid,
      events: [
        ...unpaid.events,
        {
          at: "2026-11-21T09:00:04.000Z",
          kind: "rejected",
          message: "underpaid: less than the order amount reached the merchant",
          signature,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond(rejected))
    );
    render(<CheckoutView id={unpaid.id} />);
    const list = await screen.findByRole("list", { name: "Rejected payments" });
    expect(list.textContent).toContain("underpaid");
    expect(screen.getByRole("status").textContent).toBe("Waiting for payment");
  });

  test("offers the transaction request when the server has one, and lists a refused wallet with its reason", async () => {
    const requestUrl =
      "solana:https%3A%2F%2Fcheckout.example%2Fapi%2Forders%2F0b6c7f1e-0000-4000-8000-000000000001%2Fpay";
    // A throwaway address made for this test; its key was never saved.
    const wallet = address("BiQGpZZDyDBQsELSStDgpYSE9GmVeqNJgqBGrK92HyHC");
    const withRequest: PublicOrder = {
      ...unpaid,
      requestUrl,
      events: [
        ...unpaid.events,
        {
          at: "2026-11-21T09:00:04.000Z",
          kind: "refused",
          message:
            "this wallet holds 3.00 USDC on devnet and the order is 12.50 USDC: 9.50 USDC is missing",
          wallet,
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond(withRequest))
    );
    render(<CheckoutView id={unpaid.id} />);
    const list = await screen.findByRole("list", {
      name: "Wallets that could not pay",
    });
    expect(list.textContent).toContain("BiQGpZ");
    expect(list.textContent).toContain("9.50 USDC is missing");
    expect(
      screen
        .getByRole("img", { name: "Solana Pay QR code" })
        .getAttribute("data-qr-url")
    ).toBe(requestUrl);
    expect(
      screen
        .getByRole("link", { name: "Open in a wallet" })
        .getAttribute("href")
    ).toBe(requestUrl);
  });
});

describe("order form", () => {
  test("creates the order and opens its checkout page", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => respond(unpaid, 201));
    vi.stubGlobal("fetch", fetchMock);
    render(<OrderForm />);

    fireEvent.change(screen.getByLabelText("Order amount (USDC)"), {
      target: { value: "12.50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    await vi.waitFor(() =>
      expect(push).toHaveBeenCalledWith(`/orders/${unpaid.id}`)
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      amount: "12.50",
    });
  });

  test("shows the server's refusal against the field and does not navigate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => respond({ error: "amount must be more than zero" }, 400))
    );
    render(<OrderForm />);

    fireEvent.change(screen.getByLabelText("Order amount (USDC)"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create order" }));

    expect(
      await screen.findByText("amount must be more than zero")
    ).toBeTruthy();
    expect(
      screen.getByLabelText("Order amount (USDC)").getAttribute("aria-invalid")
    ).toBe("true");
    expect(push).not.toHaveBeenCalled();
  });
});
