# Browser Load Balances Fixture

This is the browser integration reference for loading balances with the portable wallet SDK.

Run it from the wallet-sdk root:

```sh
npm run fixture:browser:load-balances
```

The root command copies this fixture to a temporary directory, packs wallet-sdk and its `@railgun-reloaded/*` dependency closure with `npm pack`, installs those tarballs, runs a production Vite build, verifies the bundle has no Node-only imports, serves `vite preview`, and drives the app in headless Chrome.

The fixture intentionally uses slow sync only. Snapshot fast-sync, package aliases, Node polyfills, Vite aliases, `define` shims, and `optimizeDeps` workarounds are out of scope.

The checked-in test wallet is the public deterministic wallet vector from the wallet-sdk test suite. The bounded Sepolia range is `5784866-5970612`, ending at the event vector block already covered by SDK tests. It is expected to decrypt one note with raw token balance `20000000000000000` for `0xfff9976782d46cc05630d1f6ebab18b2324d6b14` in the `MissingExternalPOI` bucket. Spendable balance remains empty because the fixture deliberately disables PPOI refresh and snapshot fast-sync.

The fixture builds its data source with `createDataSource` from wallet-sdk and therefore declares no scanner dependency.
