# vendor

`solana-pay-1.2.0.tgz` is `@solana/pay` 1.2.0, built from [`solana-foundation/pay`](https://github.com/solana-foundation/pay) at commit `a5c1c831cfa6c67e312313f4fee8f3975fe5f355`.

It is here because that version, the first built on `@solana/kit` 8, is on upstream's main branch but not on npm; npm's newest is 1.0.26, built on `@solana/kit` 6. No registry published or signed this file. What vouches for it is that it can be rebuilt:

```sh
# from the repository root, with the Node and pnpm that mise.toml pins on PATH
scripts/verify-pay-tarball.sh
```

The script checks out that commit, builds and packs the package, and fails unless the result is byte-identical to this file. CI runs it in the `pay-tarball` job. `app/pnpm-lock.yaml` also records the file's integrity, so a changed tarball fails `pnpm install --frozen-lockfile`.

It differs from what upstream will publish in two ways: it has no `skills` folder and no `cliVersion` stamp, both added by upstream's publish workflow. Neither is used by the library.

Remove this folder when `@solana/pay` 1.2.0 or later is on npm: depend on the registry version, delete `scripts/verify-pay-tarball.sh` and the `pay-tarball` CI job.
