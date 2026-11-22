import { CheckoutView } from "../../components/checkout/checkout-view";

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <h1 className="text-3xl font-black tracking-tight">Checkout</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-muted">
        Scan the code with a Solana wallet on devnet, or open the link on a
        device that has one. The page turns to paid once the server has checked
        the payment on chain.
      </p>
      <CheckoutView id={id} />
    </main>
  );
}
