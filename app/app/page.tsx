import { OrderForm } from "./components/checkout/order-form";

export default function Home() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black tracking-tight">
        Stablecoin checkout
      </h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Create an order in USDC. The customer pays it with any Solana wallet by
        scanning a Solana Pay QR code, and the order turns to paid once the
        server has checked the payment on chain. Devnet only.
      </p>
      <OrderForm />
    </main>
  );
}
