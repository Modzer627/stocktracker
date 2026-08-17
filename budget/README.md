# Household Budget

Shared budgeting PWA for two people, living alongside the stock tracker in
this repo and following the same architecture: vanilla JS, no build step,
IndexedDB local-first, its own Cloudflare Worker + D1 for sync.

**App URL (GitHub Pages):** `https://modzer627.github.io/stocktracker/budget/`

## What it does

- **Receipts**: snap a photo → on-device OCR (vendored Tesseract.js) reads the
  total, you confirm/correct it, pick a category (or split one receipt across
  several), save. The photo stays attached and syncs to your partner.
- **Recurring bills & subscriptions**: fixed bills (rent, board, internet…)
  auto-post on their due date; variable ones (electric, credit card) show a
  "Mark paid" reminder where you confirm the actual amount. Sinking funds
  (vaccines $800/6 mo, farrier $100/2 mo) show their monthly set-aside.
- **Partner sharing**: both phones enter the same **household code**. Everything
  merges row-by-row (last write wins, deletes are tombstones); the same
  recurring bill never double-posts because occurrences use deterministic ids.
- **Seeded budget**: first run loads the categories, budgets, income and
  recurring bills from the household budget spreadsheet (Aug 2026).
- **Extras**: goals screen (1-year debt-payoff → savings plan vs actuals), bank
  statement CSV/XLSX import with learned merchant→category picks, monthly Excel
  report export, web-push (bill-due reminders + partner activity).

## Run locally

```
npx --yes http-server .. -p 8123 -c-1     # serve the repo root
```

Open http://localhost:8123/budget/?nosw=1 (the `nosw` flag skips the service
worker while developing). Console helpers: `__seedDemo()` adds sample
expenses, `__resetAll()` wipes this device and reseeds.

Worker: `cd worker && echo "HOUSEHOLD_CODE=test" > .dev.vars && npx wrangler@4 dev`,
then in the app Settings → Advanced set the sync server URL to
`http://localhost:8787` and connect with code `test`.
Apply the schema to the local DB once: `npx wrangler@4 d1 execute budget-sync --local --file=schema.sql`.

## First-time server setup

**Easiest path — automatic via GitHub Actions:** add two repository secrets
(repo Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN`
(a token with Workers Scripts:Edit + D1:Edit) and `HOUSEHOLD_CODE` (the
passphrase you and your partner will share). The
`deploy-budget-worker` workflow then creates the database, applies the
schema, sets the secrets and deploys whenever `budget/worker/` changes on
`main` — or run it manually from the Actions tab. Optionally also add
`VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` (from `npx web-push generate-vapid-keys`)
to enable push notifications.

**Manual path** — from your own machine:

```
cd budget/worker
npm install
npx wrangler@4 d1 create budget-sync          # paste the id into wrangler.jsonc
npx wrangler@4 d1 execute budget-sync --remote --file=schema.sql
npx wrangler@4 secret put HOUSEHOLD_CODE      # the passphrase you'll both use
npx wrangler@4 deploy
```

Check `https://budget-sync.modzer627.workers.dev/v1/health`.

Optional — push notifications (bill reminders + partner activity) need VAPID
keys, same ritual as the stock tracker:

```
npx web-push generate-vapid-keys
npx wrangler@4 secret put VAPID_PUBLIC_KEY
npx wrangler@4 secret put VAPID_PRIVATE_KEY
npx wrangler@4 deploy
```

The app fetches the public key from the worker, so no client change is needed.
The daily reminder cron is configured in `wrangler.jsonc` (13:00 UTC).

## Inviting your partner

Send them the app URL and the household code. They open it, "Add to Home
Screen", enter their name + the code in Settings → everything syncs both ways,
including receipt photos. That's the whole invite.

## Deploy ritual (every update)

Same as the main app: bump `VERSION` in `budget/sw.js`, add any new files to
its `ASSETS`, push to GitHub Pages. If `budget/worker/` changed, rerun the
idempotent schema command and `npx wrangler@4 deploy` from `budget/worker`.

## Vendored libraries (version-locked)

`vendor/tesseract/` holds Tesseract.js **5.1.1** (`tesseract.min.js`,
`worker.min.js`), tesseract.js-core **5.1.1** (both lstm core builds; SIMD is
auto-detected) and the `eng.traineddata.gz` language file (tessdata
4.0.0_best_int). The tesseract.js and tesseract.js-core versions must move
together — mismatched pairs break at runtime. The two small JS files are
precached by the service worker; the ~7 MB core+language files are cached on
first OCR run, or via Settings → "Receipt reading (OCR) → Download" for
guaranteed offline use. If OCR assets are missing entirely the receipt flow
still works — you just type the total yourself.

SheetJS (bank import + Excel export) is shared from the stock tracker's
`../vendor/sheetjs/` copy.

## Notes

- Money is stored as **integer cents** everywhere.
- The local database is named `budgettracker` (the stock tracker uses
  `stocktracker` on the same origin — do not rename either).
- Receipt photos are stored base64 in D1 (~135 KB each; the free 500 MB tier
  holds years of receipts).
- The household code is a workflow gate, not a security boundary — same
  trade-off as the stock tracker's team codes.
