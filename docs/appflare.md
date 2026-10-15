# Appflare catalog packaging

`appflare.jsonc` in this repository is a packaging template. Its all-zero source SHA is a sentinel and must never be submitted to the catalog. The catalog pin must identify a clean, committed source tree that is available from the public `mainbrella/ai-receptionist` repository.

## Generate and copy the pinned manifest

Commit the source changes first, then generate a manifest pinned to the current commit. Use a tag when preparing a release:

```sh
npm run catalog:manifest
# or
npm run catalog:manifest -- --ref v0.1.0
```

The script refuses dirty source or a ref that does not point to `HEAD`. It writes `dist/catalog/apps/mainbrella-voice/appflare.jsonc` with the exact commit SHA. Publish that commit to the public source repository before submitting it.

## Prepare the catalog PR

App additions go to [appflare/catalog](https://github.com/appflare/catalog), not the Appflare manager repository. From this app's repository root, prepare a sibling catalog checkout if you do not already have one:

```sh
cd ..
gh repo fork appflare/catalog --clone
cd catalog
git switch -c mainbrella-voice
mkdir -p apps/mainbrella-voice
cp ../ai-receptionist/dist/catalog/apps/mainbrella-voice/appflare.jsonc apps/mainbrella-voice/appflare.jsonc
```

Do not hand-edit the generated pin or `index.json`. Regenerate `CODEOWNERS` with the catalog tooling. The entry names `andrewarrow` as its catalog maintainer.

## Validate in the catalog checkout

Use Node.js 22 and pnpm 10. `APPFLARE_DIR` points to the **manager/packer checkout**, not the catalog. The catalog's `.appflare-ref` pins the packer revision used by CI. Use a separate tools checkout so the existing Appflare fork can stay on its `mainbrella` branch. From the catalog checkout:

```sh
git clone https://github.com/appflare/appflare.git ../appflare-catalog-tools
git -C ../appflare-catalog-tools checkout "$(cat .appflare-ref)"
export APPFLARE_DIR="$PWD/../appflare-catalog-tools"
cd "$APPFLARE_DIR"
pnpm install --frozen-lockfile
pnpm build
cd ../catalog
pnpm install --frozen-lockfile
pnpm gen-codeowners
pnpm check
pnpm validate mainbrella-voice
pnpm pack-app mainbrella-voice
```

Review the generated manifest and package output. Commit the entry and `CODEOWNERS` changes using Conventional Commits; CI lints every commit. Push the catalog branch to your fork and open the PR against `appflare/catalog:main`. A suitable commit and PR title is:

```text
feat(apps): add mainbrella voice
```

The [catalog contribution guide](https://github.com/appflare/catalog/blob/main/CONTRIBUTING.md) is authoritative. CI validates the schema and ownership, packs the pinned source, verifies file hashes, and checks installation where its Cloudflare credentials are available. Fork PRs do not receive those credentials; a maintainer may need to run the live install check. Do not claim it passed from local packaging alone.

## Install behavior and release checks

The manifest declares the app's Worker build command as `npm run build:client`; the install flow provisions the D1 database, SQLite Durable Object, migrations, static assets, and a generated `ADMIN_PASSWORD`. The manifest declares Workers AI and Access integrations. Access can be disabled; when enabled, its bypasses for `/health`, `/voice/twilio/*`, and `/voice/telnyx/*` let health checks and signed carrier callbacks reach the Worker.

Before listing the app, confirm that the public source repository resolves at the pinned commit, perform a fresh Appflare install against the catalog package, and verify a real incoming call through each provider advertised as supported. Unit tests and deterministic AI fixtures do not verify Cloudflare account provisioning, paid model calls, carrier signatures, or live call audio.
