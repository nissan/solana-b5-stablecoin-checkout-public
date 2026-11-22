// Imports only @solana/kit, so the devnet scripts can import this file too.
import {
  address,
  type Commitment,
  getBase64Decoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getCompiledTransactionMessageEncoder,
  type GetTransactionApi,
  getTransactionDecoder,
  getTransactionEncoder,
  type Rpc,
  type Signature,
  type TransactionMessageBytes,
} from "@solana/kit";

const COMPUTE_BUDGET_PROGRAM = address(
  "ComputeBudget111111111111111111111111111111"
);

/** A base64 wire transaction without the Compute Budget instructions at its end. */
function withoutTrailingComputeBudget(wire: string): string {
  const transaction = getTransactionDecoder().decode(
    getBase64Encoder().encode(wire)
  );
  const message = getCompiledTransactionMessageDecoder().decode(
    transaction.messageBytes
  );
  // Version 1 messages lay instructions out differently; leave them be.
  if (!("instructions" in message)) return wire;
  const instructions = [...message.instructions];
  while (
    instructions.length > 0 &&
    message.staticAccounts[
      instructions[instructions.length - 1].programAddressIndex
    ] === COMPUTE_BUDGET_PROGRAM
  ) {
    instructions.pop();
  }
  if (instructions.length === message.instructions.length) return wire;
  const messageBytes = getCompiledTransactionMessageEncoder().encode({
    ...message,
    instructions,
  }) as TransactionMessageBytes;
  return getBase64Decoder().decode(
    getTransactionEncoder().encode({ ...transaction, messageBytes })
  );
}

/**
 * The RPC to hand @solana/pay's validateTransfer, holding the payment already
 * fetched. validateTransfer 1.2.0 takes the last instruction to be the
 * transfer, which holds for a transaction a wallet builds from a transfer
 * request. A wallet signing a transaction request may append Compute Budget
 * instructions after the transfer (Solflare does, on devnet), which the spec
 * allows; validateTransfer then fails with "missing instruction accounts".
 * So it is handed the transaction without those trailing instructions. They
 * name no accounts and move no tokens; the token balances it checks are the
 * chain's, unchanged, and every other instruction stays.
 */
export async function forValidation(
  rpc: Rpc<GetTransactionApi>,
  signature: Signature,
  commitment: Exclude<Commitment, "processed">
): Promise<Rpc<GetTransactionApi>> {
  const response = await rpc
    .getTransaction(signature, {
      commitment,
      encoding: "base64",
      maxSupportedTransactionVersion: 0,
    })
    .send();
  const prepared = response && {
    ...response,
    transaction: [
      withoutTrailingComputeBudget(response.transaction[0]),
      "base64",
    ],
  };
  // validateTransfer calls getTransaction(...).send() once and nothing else.
  const once = { getTransaction: () => ({ send: async () => prepared }) };
  return once as unknown as Rpc<GetTransactionApi>;
}
