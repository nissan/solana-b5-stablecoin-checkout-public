# Solana B5 stablecoin checkout

A checkout that takes payment in a stablecoin on Solana. A merchant creates an order; the customer pays it with a Solana wallet by scanning a Solana Pay QR code; the server finds the payment on chain, checks it and shows a receipt. Orders can be priced in USDC or in a second currency, and a webhook provider can tell the server about a payment so it does not have to keep asking the chain. It runs on devnet only.

This is Deed #5 of The Solana Deeds, a series of one-day learning builds. It was published in two parts.

- **Part one**, the USDC checkout: [write-up](https://reddi.tech/blog/solana-b5-stablecoin-checkout) and [demo](https://youtu.be/gIUIRtcEszs). Both were made before the second currency and the webhook were added, so they do not show them.
- **Part two**, the second currency and the webhook: [write-up](https://reddi.tech/blog/solana-b5-stablecoin-checkout-part-two) and [demo](https://youtu.be/2oWgf6E7pNU).

This is a source snapshot of `857df9e920e0646e72deb9e2a2c7753911b48af0`. An earlier snapshot, of `597e2b156f75d9869eb71fef208f39f56354d685`, is the first commit here. The private build journal, issue history, evidence files and hosted checks are not part of this repository. Test names and a few comments carry labels such as `B5-002` and `D-11`; they are outcome and decision numbers from that private plan.

## Run it

Install [mise](https://mise.jdx.dev), then:

```sh
mise install
cd app
export PATH="$(mise where node)/bin:$(mise where pnpm):$PATH"
pnpm install --frozen-lockfile
pnpm run ci        # build, typecheck, lint, format check, 69 tests
```

The tests need no funds and no network once the packages are installed. They run against an in-process [Surfpool](https://www.npmjs.com/package/@solana/surfpool) validator, which supports Linux x64 and macOS.

The project refuses any Node other than 22.x, which is why the `PATH` line is there.

**The whole flow on devnet, in one command.** This needs a devnet keypair holding about 0.05 SOL, from [faucet.solana.com](https://faucet.solana.com) for example. Never use a keypair that holds anything of value.

```sh
DEVNET_PAYER_KEYPAIR=~/path/to/devnet-keypair.json pnpm devnet:reproduce
```

The script:

- refuses anything but devnet, and refuses to start if its estimated cost exceeds 0.05 SOL;
- creates two test tokens with 6 decimals, one standing in for USDC and one for AUDD (neither is Circle's USDC or the issuer's AUDD, so no token faucet is needed), plus a throwaway merchant and customers held only in memory;
- builds and starts this app's production server on a free local port;
- runs five cases through its HTTP API: an order paid in full, an underpayment, an overpayment, a wallet that cannot pay asking for the transaction, and an AUDD order paid first in the wrong currency, then in AUDD;
- starts the server again with webhooks on and a secret made up for the run, and plays the webhook provider itself: a call without the secret is refused, a call with it marks an order paid, a repeated call changes nothing, and an order that gets no call is found by the fallback check 45 s later;
- prints every signature and explorer link before sending, waits for `finalized`, reads the results back, and reports what it spent in lamports and SOL. If public devnet rate-limits a request, it waits and tries again.

One run spends about 9,665,800 lamports (0.0097 SOL): rent deposits for seven new accounts, plus 90,000 lamports in fees. It takes a little over a minute, most of it waiting out the fallback interval. The server names its tokens USDC and AUDD, so its messages use those names even for the test tokens.

## How it works

```mermaid
sequenceDiagram
    participant M as Merchant (browser)
    participant S as Checkout server
    participant W as Customer wallet
    participant D as Solana devnet
    participant P as Webhook provider
    M->>S: POST /api/orders {amount, currency}
    S-->>M: order + Solana Pay link (merchant, amount, the currency's mint, reference)
    alt transfer request (default)
        W->>D: transfer to the merchant's token account, carrying the reference
    else transaction request (PUBLIC_URL set)
        W->>S: POST /api/orders/{id}/pay {account}
        S->>D: read the wallet's SOL and its balance in the order's currency
        alt the wallet cannot pay
            S-->>W: 400 with the reason (logged on the order)
        else the wallet can pay
            S-->>W: unsigned transfer with the reference
            W->>D: signs and sends it
        end
    end
    loop while the checkout page is open (every 1.5 s)
        M->>S: GET /api/orders/{id}
        opt no webhooks, or the fallback interval has passed
            S->>D: transactions carrying the reference
            S->>S: validateTransfer each: recipient, mint, amount, reference
        end
        S-->>M: paid with receipt, rejections with reasons, money owed back
    end
    opt webhooks on (WEBHOOK_SECRET set)
        D-->>P: a transaction touched the merchant's token account
        P->>S: POST /api/webhooks/helius, secret in the Authorization header
        S->>S: refuse unless the secret matches
        S->>D: read each named transaction; find its order by reference
        S->>S: validateTransfer, exactly as above
    end
```

- **Pay by QR, confirmed on chain.** Each order gets a Solana Pay link and QR code carrying the merchant, the amount, the USDC mint and a reference unique to the order. The server lists every transaction carrying that reference, checks each with `@solana/pay`'s `validateTransfer`, and marks the order paid by the first that passes. An underpayment, a payment in another token, a transaction that failed on chain, or a signature that already paid another order is rejected, and the reason is logged against the order.
- **Every payment is accounted for.** The receipt shows what actually arrived. An overpayment's excess, a payment made after the order was paid, and the money from a rejected underpayment are listed as owed back, with a total.
- **A wallet that cannot pay is told why.** With a public https address, the QR is a Solana Pay transaction request. The wallet asks the server for the transaction, and the server checks the wallet's SOL and its balance in the order's currency first. A wallet that is short, empty or possibly on another network is refused with a reason before it signs anything, and the checkout page lists it.
- **A second currency.** With `AUDD_MINT` set, the merchant chooses USDC or AUDD for each order. The amount is the number typed: nothing is converted. An order is paid only in its own currency; the other one sent to it is rejected with a reason naming both. On devnet AUDD is a stand-in test token, and the page says so: the issuer's AUDD exists only on mainnet, which this build refuses.
- **Confirmation by webhook.** With `WEBHOOK_SECRET` set, a webhook provider can tell the server about a payment at `POST /api/webhooks/helius`. A webhook is a hint, never a verdict: the server checks the caller's secret, then reads each named transaction from the chain and applies the same checks as before. It still reads the chain at a slower interval, so a lost webhook delays a payment rather than losing it.

The server holds no key that can sign; customers sign in their own wallets. `app/README.md` has the file map.

## What was actually proven

Everything below is on devnet, with test money.

- A 12.50 USDC order paid from a phone wallet (Solflare) through a transfer request: [`m8nK1goP…`](https://explorer.solana.com/tx/m8nK1goPxfxCn6QFHo9RNNQoaWd261e6TCfkjN1qPzCE33fsBjjjTHnCeKYbwUVxDma7McPbv3uiYGpmJEqUWL7?cluster=devnet). A second order paid from the checkout's own QR: [`2A4xcXbR…`](https://explorer.solana.com/tx/2A4xcXbRGuxjxX9353ayE7E7ioAND94HER873gdFFjduU4AdBegoYgELnBD6edUjgwBgKqSjtwfWCB2Uqvstw9Sd?cluster=devnet).
- A phone payment through a transaction request: [`5FxSWHLu…`](https://explorer.solana.com/tx/5FxSWHLuwvXaHfTVsU7gGEPrvfYRH4K9A6ShLv9ZjRHn3GkWyTsyeUAFmYruJYLLHPuG4fuD2MQiRTPeK6VHzKg6?cluster=devnet).
- An overpayment (15.00 on a 12.50 order, [`5bX3eXeQ…`](https://explorer.solana.com/tx/5bX3eXeQ3F8tDiHGJVRetdZ2CW7LZUJePdoeKQqo8Ushhx3UhLUaY4Kthnds6QfcGeW3LqKjpG2ZDRYd4j2KconZ?cluster=devnet)) and a second payment to a paid order ([`4akKKaYk…`](https://explorer.solana.com/tx/4akKKaYk7Q75eeShUsm13Bh4wiFVahDRL8NAWT4EpyqR1Z1pAFV1yLPebjXem2fjke4yamufJdxKcyPSBKZxhfiq?cluster=devnet)), both from a scripted test customer, both recorded as owed back.
- Wallets that cannot pay were refused with a reason. Those were scripted test wallets, and once a phone wallet that was 45.00 short on an AUDD order.
- With one real webhook from [Helius](https://www.helius.dev) on devnet, a 20.00 order in the stand-in AUDD was paid from a phone wallet and marked paid about 2 seconds after its block time: [`5pMpbH57…`](https://explorer.solana.com/tx/5pMpbH579FHN4XUh3pghTLB9NtyVCboUTobx2ftxeuGgP8Bar9xF9KqQh8Pn9ABPumhz9HWHH6xy2DsJVSb5EnDw?cluster=devnet). The server's own check of the chain was set to every two minutes for that test, so only the webhook could have found it that fast. A scripted 1.00 payment was found the same way: [`kqMD8yZj…`](https://explorer.solana.com/tx/kqMD8yZjr9Hh7EgjXXNX1v2FAHB6Zj29FkjSGvHANoLeAtMyMGMNX6aiKCtbfRa8aRWz1Stgooo9Q4KDZeGb3VD?cluster=devnet). That is one provider, one delivery shape and two deliveries.
- The wrong-currency rejection, the refused and repeated webhook calls, and the fallback for a lost webhook were shown on devnet by `pnpm devnet:reproduce`, which plays the provider itself. They were not observed from a real provider.
- `pnpm devnet:reproduce` passed every check when run from this snapshot before it was published.

Public devnet may prune old transactions, so an explorer link may eventually stop resolving.

## Two bugs found in `@solana/pay`, and the workarounds here

Both are in `validateTransfer` in `@solana/pay` 1.2.0 and are reported upstream:

- [solana-foundation/pay#551](https://github.com/solana-foundation/pay/issues/551): for a transaction that failed on chain it throws a `TypeError`, not a `ValidateTransferError`. Here, a failed transaction is judged from its status before validation.
- [solana-foundation/pay#552](https://github.com/solana-foundation/pay/issues/552): it rejects a transaction-request payment when the wallet appends Compute Budget instructions after the transfer, which the Solana Pay spec allows. Here, trailing Compute Budget instructions, which move no tokens, are dropped before validation. See `app/app/lib/checkout/validation.ts`.

## Why `@solana/pay` comes from a file

Version 1.2.0, the first built on `@solana/kit` 8, is on upstream's main branch but not on npm; npm's newest, 1.0.26, is built on `@solana/kit` 6 and does not install beside this app. So `app/vendor/solana-pay-1.2.0.tgz` is a build of upstream commit `a5c1c83`. No registry published or signed that file. What vouches for it is that you can rebuild it:

```sh
# from the repository root, with the Node and pnpm that mise.toml pins on PATH
scripts/verify-pay-tarball.sh
```

The script checks out that commit, builds and packs the package, and fails unless the result is byte-identical to the committed file. `app/vendor/README.md` mentions a CI job that runs it; that job is in the private repository, and this public copy has no hosted checks.

## Running the checkout yourself

The server reads these environment variables. Only `MERCHANT_ADDRESS` is required. One is secret, `WEBHOOK_SECRET`, and only if you switch webhooks on.

| Variable | Meaning | Default |
|---|---|---|
| `MERCHANT_ADDRESS` | The merchant's Solana address. Payments go to its token account for the order's currency | none; order creation fails without it |
| `USDC_MINT` | The USDC mint | Circle's devnet USDC, `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU` |
| `AUDD_MINT` | A mint to offer as AUDD: a classic SPL token with 6 decimals. On devnet this is a stand-in test token, and the page says so | none: only USDC is offered |
| `SOLANA_CLUSTER` | `devnet` or `localnet`. Anything else, mainnet included, is refused | `devnet` |
| `SOLANA_RPC_URL` | RPC endpoint the server reads payments from | the public endpoint for the cluster |
| `CHECK_INTERVAL_MS` | Least time between two chain checks for one order, when webhooks are off | `1000` |
| `WEBHOOK_SECRET` | Switches webhooks on. The provider must send exactly this value as its `Authorization` header; at least 16 characters. Keep it out of the repository and out of logs | none: `/api/webhooks/helius` answers 404 |
| `FALLBACK_CHECK_INTERVAL_MS` | With webhooks on, least time between two chain checks for one order. This is how long a payment can wait if its webhook is lost | `15000` |
| `WEBHOOK_RETRY_DELAYS_MS` | With webhooks on, when to look for a named transaction the RPC does not show yet: comma-separated waits before each look | `0,400,800,1600,3200` |
| `PUBLIC_URL` | The https address wallets reach this server at. When set, the QR is a Solana Pay transaction request served from `/api/orders/{id}/pay` | none: the QR is a transfer request |

```sh
MERCHANT_ADDRESS=<devnet address> pnpm dev   # http://localhost:3000
```

A fresh merchant address is not payable yet: its token account for each currency must exist. Older `@solana/pay` releases, which wallets may embed, also refuse a recipient whose main account does not exist, and an address that has never held SOL has none.

Devnet helper scripts (each refuses any RPC that is not devnet):

- `DEVNET_PAYER_KEYPAIR=<path> MERCHANT_ADDRESS=<address> pnpm devnet:merchant-account` creates whatever is missing for USDC, paid by the devnet keypair at that path.
- `DEVNET_PAYER_KEYPAIR=<path> MERCHANT_ADDRESS=<address> [MINT_TO=<wallet> AMOUNT=50] pnpm devnet:audd` creates a stand-in AUDD test token and the merchant's token account for it, optionally mints some to a wallet so it can pay, and prints the `AUDD_MINT` to start the checkout with.
- `CUSTOMER_KEYPAIR=<path> pnpm devnet:pay '<solana: link>' [amount]` pays an order as a scripted customer, optionally with a different amount.
- `[MINT=<mint>] pnpm devnet:verify-payment <signature> <merchant> <amount> <reference>` reads a payment back at `finalized`, independently of the server, and signs nothing.
- `pnpm devnet:helius-webhook create | list | delete <webhookID>` manages a Helius webhook for the checkout. It reads `HELIUS_API_KEY` from the environment and never prints it. Helius charges credits for each of these and for each delivery; the script's header has the figures as read on 22 November 2026.

Pay from a phone wallet set to devnet, holding devnet SOL for the fee and devnet USDC from [Circle's faucet](https://faucet.circle.com). For an AUDD order the wallet needs the stand-in token, minted to it with `devnet:audd`; it has no name or icon on chain, so a wallet may list it as an unknown token. Solana Pay links carry no network, so a wallet left on mainnet cannot pay a devnet order.

To open the checkout page from another device, run a production server: `pnpm build`, then `MERCHANT_ADDRESS=<address> pnpm start -H 0.0.0.0`. The development server blocks its page scripts for any origin but localhost, so a checkout page opened from a LAN address never turns to paid.

A transaction request needs the server reachable from the phone over https, and so does a webhook provider. A tunnel does that, and exposes the server to the internet while it runs; stop it when done.

To try webhooks with a provider: make up a secret of at least 16 characters, start the server with `WEBHOOK_SECRET` and `PUBLIC_URL` set, and create the webhook with the same values (`devnet:helius-webhook create`, whose header lists what it needs). The endpoint is not tied to Helius: it accepts any caller that sends the secret and a JSON list of transactions, each with its signature and account keys. `pnpm devnet:reproduce` does exactly that itself, so trying webhooks needs no provider account.

## Security

- **No signing key on the server.** It knows the merchant's public address and reads the chain. Customers sign in their own wallets.
- **Devnet only.** `SOLANA_CLUSTER` accepts `devnet` or `localnet`; every devnet script refuses to sign unless the genesis hash is devnet's.
- **The server decides paid, never the browser.** Paid means the transaction succeeded on chain and passed `validateTransfer` for this order, and its signature has paid no other order.
- **A webhook cannot mark an order paid.** The endpoint is off unless `WEBHOOK_SECRET` is set. A call without exactly that secret is refused before its body is read, in a constant-time comparison. An accepted call only names transactions; the server reads each from the chain, so a forged, replayed or repeated call can do no more than make the server look. The secret cannot sign or move funds.
- **No keypair, seed phrase, API key, webhook secret or `.env` file belongs in this repository.** The devnet scripts read a keypair by path and never print it.

This is a learning build. It has not been audited and is not a production setup.

## Limits

- Orders and the amounts owed back live in server memory, and are lost on restart. Refunds are listed, not sent.
- No access control or rate limiting on the API. The pay endpoint and `confirm` call the RPC on every request.
- A page turns to paid at `confirmed`, not `finalized`.
- Each check reads the 25 newest transactions carrying a reference.
- The balance check before signing is advice, not a lock. How a wallet shows a refusal is up to the wallet; the checkout page always shows it.
- One phone wallet was tested (Solflare), and one webhook provider (Helius).
- AUDD on devnet is a stand-in test token. Nothing is converted between currencies, and nothing was tried with the issuer's AUDD.
- A payment in the wrong currency is rejected and logged with its amount, but not added to the order's refund total; returning it is manual.
- The webhook secret is one shared value sent in a header. There is no signature over the body.
- Only a classic SPL Token mint with 6 decimals can be the second currency.

## Licence

MIT. See [LICENSE](LICENSE).
