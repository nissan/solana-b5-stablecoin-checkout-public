import { address } from "@solana/kit";
import { encodeURL, parseURL } from "@solana/pay";
import { Surfnet } from "@solana/surfpool";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useMemo } from "react";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import { ClusterProvider } from "../app/components/cluster-context";
import { WalletButton } from "../app/components/wallet-button";
import { AppClientProvider } from "../app/lib/client-provider";
import { mockWalletAddress, registerMockWallet } from "./mock-wallet";

const LAMPORTS_PER_SOL = 1_000_000_000;

let surfnet: Surfnet;

beforeAll(() => {
  // Offline: the scaffold test needs no account from a remote cluster.
  surfnet = Surfnet.startWithConfig({ offline: true });
  surfnet.fundSol(mockWalletAddress, 5 * LAMPORTS_PER_SOL);
  registerMockWallet();
}, 60_000);

afterAll(() => {
  surfnet?.stop();
});

afterEach(cleanup);

function TestApp() {
  const urls = useMemo(
    () => ({
      rpcUrl: surfnet.rpcUrl,
      rpcSubscriptionsUrl: surfnet.wsUrl,
    }),
    []
  );
  return (
    <ClusterProvider>
      <AppClientProvider urls={urls}>
        <WalletButton />
      </AppClientProvider>
    </ClusterProvider>
  );
}

// The one scaffold test, across the whole pinned stack: Wallet Standard
// discovery, the kit client and an RPC read against a local Surfpool runtime
// through the real wallet button, then a Solana Pay transfer request URL for
// that wallet built and parsed back by @solana/pay.
test("connects the mock wallet, shows its balance and round-trips a Solana Pay URL to it", async () => {
  render(<TestApp />);

  fireEvent.click(
    await screen.findByRole("button", { name: "Connect Wallet" })
  );
  fireEvent.click(await screen.findByRole("button", { name: "Mock Wallet" }));
  fireEvent.click(
    await screen.findByRole("button", { name: `Wallet ${mockWalletAddress}` })
  );

  await screen.findByText(mockWalletAddress);
  await waitFor(
    () => {
      const balance = screen.getByText("Balance").nextElementSibling;
      expect(balance?.textContent).toBe("5 SOL");
    },
    { timeout: 10_000 }
  );

  const recipient = address(mockWalletAddress);
  const url = encodeURL({ recipient, amount: 1.5 });
  expect(url.protocol).toBe("solana:");
  expect(parseURL(url)).toMatchObject({ recipient, amount: 1.5 });
});
