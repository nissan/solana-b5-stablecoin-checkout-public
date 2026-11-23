import { fetchEncodedAccount, type Rpc, type SolanaRpcApi } from "@solana/kit";
import {
  decodeMint,
  getMintSize,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { type Token, TOKEN_DECIMALS } from "./config";

export class TokenError extends Error {
  name = "TokenError";
}

/** Mints already read and found usable, by RPC URL and address. */
const verified = new Set<string>();

/**
 * Amounts here are parsed and shown with six decimals. A mint named by the
 * environment could have another count, and every amount would then be wrong
 * by a power of ten without any error. It could also be no mint at all, or a
 * Token-2022 mint, which the transfers built here cannot move. So before the
 * first order in such a token, read its mint once and refuse it unless it is
 * a classic SPL Token mint with six decimals.
 * Circle's devnet USDC, the built-in default, is not read.
 */
export async function assertSupportedToken(
  rpc: Rpc<SolanaRpcApi>,
  rpcUrl: string,
  token: Token
): Promise<void> {
  if (!token.configured) return;
  const key = `${rpcUrl} ${token.mint}`;
  if (verified.has(key)) return;
  const named = `${token.mint}, named as the ${token.currency} mint,`;
  const account = await fetchEncodedAccount(rpc, token.mint, {
    commitment: "confirmed",
  });
  if (!account.exists) {
    throw new TokenError(
      `the ${token.currency} mint ${token.mint} does not exist on this network`
    );
  }
  if (account.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    throw new TokenError(
      `${named} is not owned by the SPL Token program; Token-2022 mints are not supported`
    );
  }
  if (account.data.length !== getMintSize()) {
    throw new TokenError(`${named} is a token program account but not a mint`);
  }
  const mint = decodeMint(account);
  if (mint.data.decimals !== TOKEN_DECIMALS) {
    throw new TokenError(
      `the ${token.currency} mint ${token.mint} has ${mint.data.decimals} decimals; this checkout supports ${TOKEN_DECIMALS}`
    );
  }
  verified.add(key);
}
