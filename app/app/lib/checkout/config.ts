import { type Address, isAddress } from "@solana/kit";

/** Circle's USDC mint on devnet. */
export const DEVNET_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
/**
 * There is no AUDD default. The issuer's AUDD exists on mainnet only, which
 * this build refuses, so on devnet AUDD is a stand-in token named by
 * AUDD_MINT (decision D-13).
 */
/** USDC and AUDD both have six decimals; a mint with any other count is refused. */
export const TOKEN_DECIMALS = 6;

export type Cluster = "devnet" | "localnet";

/** The currencies an order can be priced in. There is no conversion between them. */
export const CURRENCIES = ["USDC", "AUDD"] as const;
export type Currency = (typeof CURRENCIES)[number];

export function isCurrency(value: unknown): value is Currency {
  return CURRENCIES.includes(value as Currency);
}

export type Token = Readonly<{
  currency: Currency;
  mint: Address;
  /** Set when the mint was named by the environment, so its decimals are checked. */
  configured: boolean;
  /** Something a person paying should know about this token here, or null. */
  note: string | null;
}>;

export type WebhookConfig = Readonly<{
  /** The shared secret a provider sends in the Authorization header. */
  secret: string;
  /**
   * With webhooks on, how often the checkout page's polling may still read the
   * chain for an order, in case a webhook call never arrives.
   */
  fallbackIntervalMs: number;
  /**
   * How long to wait before each look at a transaction a webhook named. A
   * provider can call the moment a transaction confirms, before this server's
   * RPC shows it. After the last look the fallback poll is what remains.
   */
  retryDelaysMs: readonly number[];
}>;

export type CheckoutConfig = Readonly<{
  merchant: Address;
  /** The tokens on offer. USDC always is; AUDD only when AUDD_MINT is set. */
  tokens: Readonly<{ USDC: Token; AUDD?: Token }>;
  rpcUrl: string;
  cluster: Cluster;
  /**
   * The https origin wallets reach this server at, such as a tunnel's. When
   * set, checkouts offer a Solana Pay transaction request, which a wallet
   * fetches from here; without it, a plain transfer request.
   */
  publicUrl: string | null;
  /** Least time between two page-triggered chain checks for one order. */
  checkIntervalMs: number;
  /** Null when WEBHOOK_SECRET is not set: the webhook endpoint is then off. */
  webhook: WebhookConfig | null;
}>;

export class CheckoutConfigError extends Error {
  name = "CheckoutConfigError";
}

/** A webhook secret shorter than this is refused as too easy to guess. */
export const MIN_WEBHOOK_SECRET_LENGTH = 16;

const AUDD_NOTE =
  "a stand-in test token: the issuer's AUDD exists only on mainnet";

function readInterval(
  env: Record<string, string | undefined>,
  name: string,
  fallback: number
): number {
  const text = env[name]?.trim();
  if (!text) return fallback;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 0) {
    throw new CheckoutConfigError(`${name} must be a whole number of ms`);
  }
  return value;
}

/**
 * Read the checkout settings from the server's environment on every call, so a
 * test or a restart with new variables takes effect. The merchant is a public
 * address and the server holds no key. WEBHOOK_SECRET is the one secret here:
 * it cannot move funds, only make this server look at a transaction.
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
  const usdcMint = env.USDC_MINT?.trim() || DEVNET_USDC_MINT;
  if (!isAddress(usdcMint)) {
    throw new CheckoutConfigError("USDC_MINT is not a Solana address");
  }
  const auddMint = env.AUDD_MINT?.trim();
  if (auddMint !== undefined && auddMint !== "") {
    if (!isAddress(auddMint)) {
      throw new CheckoutConfigError("AUDD_MINT is not a Solana address");
    }
    if (auddMint === usdcMint) {
      throw new CheckoutConfigError(
        "AUDD_MINT and USDC_MINT name the same token"
      );
    }
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
  return {
    merchant,
    tokens: {
      USDC: {
        currency: "USDC",
        mint: usdcMint,
        configured: usdcMint !== DEVNET_USDC_MINT,
        note: null,
      },
      ...(auddMint
        ? {
            AUDD: {
              currency: "AUDD" as const,
              mint: auddMint as Address,
              configured: true,
              note: AUDD_NOTE,
            },
          }
        : {}),
    },
    rpcUrl,
    cluster,
    publicUrl: readPublicUrl(env),
    checkIntervalMs: readInterval(env, "CHECK_INTERVAL_MS", 1000),
    webhook: readWebhook(env),
  };
}

function readWebhook(
  env: Record<string, string | undefined>
): WebhookConfig | null {
  const secret = env.WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  if (secret.length < MIN_WEBHOOK_SECRET_LENGTH) {
    throw new CheckoutConfigError(
      `WEBHOOK_SECRET must be at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`
    );
  }
  const delays = (env.WEBHOOK_RETRY_DELAYS_MS?.trim() || "0,400,800,1600,3200")
    .split(",")
    .map((part) => Number(part.trim()));
  if (
    delays.length === 0 ||
    delays.length > 10 ||
    delays.some((delay) => !Number.isInteger(delay) || delay < 0)
  ) {
    throw new CheckoutConfigError(
      "WEBHOOK_RETRY_DELAYS_MS must be up to ten whole numbers of ms, separated by commas"
    );
  }
  return {
    secret,
    fallbackIntervalMs: readInterval(env, "FALLBACK_CHECK_INTERVAL_MS", 15_000),
    retryDelaysMs: delays,
  };
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

/** Every token the checkout offers, USDC first. */
export function tokensOf(config: CheckoutConfig): readonly Token[] {
  return config.tokens.AUDD
    ? [config.tokens.USDC, config.tokens.AUDD]
    : [config.tokens.USDC];
}
