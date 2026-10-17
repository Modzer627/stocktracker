# Parts Checkout

Web replacement for the "Inventory Part Sign-Out" Microsoft Form + Power
Automate emails. Techs scan a QR code in the parts room, pick their name, enter
the parts and quantities, and say whether it is for van stock or a job. The
parts manager opens a dashboard that already has the week added up: every
tech, every part, taken and returned, with the individual submissions one tap
away. No more reading each email.

Standalone app: its own folder, its own Cloudflare Worker and D1 database, its
own manager PIN. It shares nothing with the other apps in this repo.

**Tech page (QR code):** `https://modzer627.github.io/stocktracker/checkout/?k=<TEAM_KEY>`
**Manager dashboard:** `https://modzer627.github.io/stocktracker/checkout/manager.html`

## What it does

**Tech page** (`index.html`) — no install, no login; the QR code carries the
team key and the phone remembers it.

- Pick your name once (remembered); "Not you?" switches.
- **Take / Return / Request**, same three modes as the Form.
- One row per part: quantity stepper + part number with autocomplete from the
  parts already in use. New part numbers are accepted and learned.
- **For:** Van stock, Job # (recent job numbers offered as chips), or Other.
- Requests take an optional "needed by" date; returns and requests take an
  optional photo.
- Confirmation screen echoes the submission. A submission can be fixed or
  deleted from the same phone for 24 hours ("Recent from this phone").
- No signal in the parts room? The submission is saved on the phone and sent
  automatically when it is back online.

**Manager dashboard** (`manager.html`) — behind the manager PIN.

- **By tech:** a card per tech for the week: part · taken · returned · net ·
  what it was for, with totals; expand for the individual submissions.
- **By part:** team totals per part with who took what.
- **Log:** everything in the week by day; edit or delete any submission.
- **Requests:** open requests with needed-by dates and a status
  (open → ordered → received → closed).
- **Mark week reviewed:** once the week is added up, anything that lands later
  is flagged "new" so late entries are never missed.
- **Export:** Excel workbook (By tech / By part / Log / Open requests),
  CSV, or copy the by-tech table straight into a spreadsheet.
- **Setup:** technician list (name + truck), parts list (rename, merge
  duplicates, retire), the tech link and a printable QR sheet.

Weeks run Monday–Sunday in the browser's local time.

## First-time setup (about 15 minutes)

Prerequisites: a free Cloudflare account with the `*.workers.dev` subdomain
registered (Workers & Pages → open once), and Node 18+.

```
cd checkout/worker
npm install
npx wrangler login
npx wrangler d1 create parts-checkout        # paste the printed database_id into wrangler.jsonc
npx wrangler d1 execute parts-checkout --remote --file=schema.sql
npx wrangler deploy                          # first deploy must happen before secrets
```

Then set the two secrets. Generate a long random team key (it is what the QR
code carries, so anyone who can scan the sticker can submit) and a manager PIN:

```
echo "paste-a-long-random-team-key" | npx wrangler secret put TEAM_KEY
echo "manager-pin"                   | npx wrangler secret put MANAGER_PIN
```

Check `https://parts-checkout.<your-subdomain>.workers.dev/v1/health`. If the
Worker URL is not `https://parts-checkout.modzer627.workers.dev`, change
`DEFAULT_API` in `js/api.js`. If the pages are hosted anywhere other than
`https://modzer627.github.io`, add that origin to `ALLOWED_ORIGINS` in
`worker/src/index.js`.

Push the repo to `main` — GitHub Pages serves `checkout/` at the URLs above.

Finally open the manager dashboard, sign in with the PIN, go to **Setup**:
add the technicians (one per line, optionally `Name, truck`), then
**Print QR sheet** and put it in the parts room. The parts list fills itself
from the first submissions.

## Deploy ritual (every update)

- Pages: push to `main`. There is no service worker, so phones get the new
  files on the next load.
- Worker: from `checkout/worker`, `npx wrangler d1 execute parts-checkout --remote --file=schema.sql`
  (idempotent) if `schema.sql` changed, then `npx wrangler deploy`.

## Run locally

```
cd checkout/worker
cp .dev.vars.example .dev.vars                       # TEAM_KEY=dev-team-key, MANAGER_PIN=1234
npm run schema:local
npm run dev                                          # Worker on http://127.0.0.1:8787
```

In another terminal, from the repo root: `npx --yes http-server . -p 8123 -c-1`, then open

- tech page: `http://localhost:8123/checkout/?k=dev-team-key&api=http://127.0.0.1:8787`
- manager: `http://localhost:8123/checkout/manager.html?api=http://127.0.0.1:8787` (PIN `1234`)

`?api=` is remembered on the device, so it is only needed once.

## Keeping the Microsoft Form alive (optional bridge)

If some techs keep using the Form, Power Automate can post each response into
the dashboard as well, so both feeds land in the same weekly roll-up. Add an
**HTTP** action in each Switch branch (after the Compose step):

- Method: `POST`
- URI: `https://parts-checkout.<subdomain>.workers.dev/v1/submissions`
- Headers: `X-Checkout-Key: <TEAM_KEY>`, `Content-Type: application/json`
- Body (Take branch; use the Return / Request branch's own fields for those):

```json
{
  "type": "take",
  "techName": "<Name1 dynamic content>",
  "partsText": "<Parts Taken dynamic content>",
  "dest": "job",
  "job": "<Van Stock or Job# dynamic content>",
  "source": "forms"
}
```

`techName` must match a name in Setup (case does not matter). `partsText` is
the free-text box as typed — the server understands "4x 711S", "711S x4",
"(2) CO1224T", "14 PG9303", "2 - 1106W" and treats a bare part number as
quantity 1. For `dest` send `"van"` when the text says van/truck/stock, else
`"job"`. Requests may add `"neededBy": "YYYY-MM-DD"`.

Note: the HTTP action is a **premium** Power Automate connector. Without that
license the simplest path is to retire the Form and point the QR code at the
new page.

## Data & limits

- D1 free tier: 5 GB, far beyond what submissions need. Photos are stored as
  base64 JPEG (≈150 KB each, resized on the phone before upload).
- Deleted submissions are soft-deleted (kept with `deleted_at`).
- Renaming a tech does not rewrite history; each submission keeps the name as
  it was. Merging parts does re-point history so totals combine.
- The team key is visible to anyone who photographs the QR sheet; rotate it
  with `wrangler secret put TEAM_KEY` and reprint the sheet if needed. The
  manager PIN is the only thing that can read the data.

## Layout

```
checkout/
  index.html        tech page            js/tech.js
  manager.html      manager dashboard    js/manager.js
  css/style.css     shared styles        js/api.js, js/util.js, js/report.js (week math + roll-ups)
  worker/           Cloudflare Worker + D1 (src/index.js, schema.sql, wrangler.jsonc)
```
