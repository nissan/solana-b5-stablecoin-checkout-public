import {
  OrderForm,
  type OfferedCurrency,
} from "./components/checkout/order-form";
import { readCheckoutConfig, tokensOf } from "./lib/checkout/config";

// The currencies on offer come from the server's environment at request time.
export const dynamic = "force-dynamic";

/** What the server offers. A server not yet configured still shows the USDC form. */
function offered(): OfferedCurrency[] {
  try {
    return tokensOf(readCheckoutConfig()).map(({ currency, note }) => ({
      currency,
      note,
    }));
  } catch {
    return [{ currency: "USDC", note: null }];
  }
}

export default function Home() {
  const currencies = offered();
  const names = currencies.map(({ currency }) => currency).join(" or ");
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black tracking-tight">
        Stablecoin checkout
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Create an order in {names}. The customer pays it with any Solana wallet
        by scanning a Solana Pay QR code, and the order turns to paid once the
        server has checked the payment on chain. Devnet only.
      </p>
      <OrderForm currencies={currencies} />
    </main>
  );
}
