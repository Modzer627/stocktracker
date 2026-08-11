# One-time production setup for the sync backend (run from the worker\ folder).
# Prerequisites (browser, one time):
#   1. Free Cloudflare account: https://dash.cloudflare.com/sign-up
#   2. In the dashboard, open Workers & Pages once and register your
#      *.workers.dev subdomain (avoids a prompt that breaks scripted deploys).
#
# Then, in order:

# 1. Sign in (opens a browser window to approve)
npx wrangler@4 login
npx wrangler@4 whoami

# 2. Create the database, then paste the printed database_id into wrangler.jsonc
npx wrangler@4 d1 create stocktracker-sync

# 3. Apply the schema to the real (remote) database
npx wrangler@4 d1 execute stocktracker-sync --remote --file=schema.sql

# 4. Deploy the Worker (FIRST deploy must happen before secrets)
npx wrangler@4 deploy

# 5. Set the two access codes (generate long random ones!)
# echo "TEAM-CODE-HERE"    | npx wrangler@4 secret put TEAM_CODE
# echo "MANAGER-CODE-HERE" | npx wrangler@4 secret put MANAGER_CODE
