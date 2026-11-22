import { type Address, isAddress } from "@solana/kit";

/** Circle's USDC mint on devnet. */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/** USDC has six decimals on every cluster. */
export const USDC_DECIMALS = 6;

export type Cluster = "devnet" | "localnet";

export type CheckoutConfig = Readonly<{
  merchant: Address;
  mint: Address;
  rpcUrl: string;
  cluster: Cluster;
  /**
   * The https origin wallets reach this server at, such as a tunnel's. When
   * set, checkouts offer a Solana Pay transaction request, which a wallet
   * fetches from here; without it, a plain transfer request.
   */
  publicUrl: string | null;
}>;

export class CheckoutConfigError extends Error {
  name = "CheckoutConfigError";
}

/**
 * Read the checkout settings from the server's environment on every call, so a
 * test or a restart with new variables takes effect. Nothing here is secret:
 * the merchant is a public address and the server holds no key.
 */
export function readCheckoutConfig(
  env: Record<string, string | undefined> = process.env
): CheckoutConfig {
  const merchant = env.MERCHANT_ADDRESS?.trim();
  if (!merchant || !isAddress(merchant)) {
    throw new CheckoutConfigError(
      "MERCHANT_ADDRESS must be set to the merchant's Solana address"
    );
  }
  const mint = env.USDC_MINT?.trim() || DEVNET_USDC_MINT;
  if (!isAddress(mint)) {
    throw new CheckoutConfigError("USDC_MINT is not a Solana address");
  }
  const cluster = (env.SOLANA_CLUSTER?.trim() || "devnet") as Cluster;
  if (cluster !== "devnet" && cluster !== "localnet") {
    // Mainnet is out of scope for this build: agents never move real funds.
    throw new CheckoutConfigError("SOLANA_CLUSTER must be devnet or localnet");
  }
  const rpcUrl =
    env.SOLANA_RPC_URL?.trim() ||
    (cluster === "devnet"
      ? "https://api.devnet.solana.com"
      : "http://127.0.0.1:8899");
  return { merchant, mint, rpcUrl, cluster, publicUrl: readPublicUrl(env) };
}

function readPublicUrl(env: Record<string, string | undefined>): string | null {
  const value = env.PUBLIC_URL?.trim();
  if (!value) return null;
  // The Solana Pay spec requires a transaction request link to be https.
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new CheckoutConfigError("PUBLIC_URL must be an https URL");
  }
  return new URL(value).origin;
}
