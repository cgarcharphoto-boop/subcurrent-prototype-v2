# Subcurrent Prototype v2

Fan app, Teams (crew) portal and owner portal, with a live backend. One Vercel project serves both:
- `docs/`: the static front end, with no build step. `docs/index.html` is generated, so don't hand-edit it beyond small text fixes. `docs/connect.js` is the live layer: it hooks the app's `data-act` buttons in the capture phase and adds the "Live" panel.
- `api/index.js` → `backend/` (Express + Prisma) as a serverless function at `/api`. Same origin, so no CORS.

Live: https://subcurrent-prototype-v2.vercel.app (health: `/api/health` lists which integrations are on).
Repo: github.com/cgarcharphoto-boop/subcurrent-prototype-v2. Vercel team: thedude007s-projects. Every push to `main` deploys to production.

## Database
- Production: Neon Postgres attached through the Vercel integration (`DATABASE_URL`). Local and tests use SQLite. `backend/scripts/prisma.js` switches providers and generates `schema.postgres.prisma`; always run Prisma through it.
- Schema changes: run `./migrate-prod.sh` BEFORE pushing code that needs them. Code that ships first breaks every query that touches the new columns. Changes must be additive; if Prisma warns about data loss, stop.
- Auto mode blocks Claude from pulling the production env or pushing the schema, so ask the user to run `! ./migrate-prod.sh`.

## Integrations
Each one turns on when its env vars are set; until then it is simulated and reports honestly (e.g. broadcast says `not_connected`). The user enters keys with `./set-keys.sh` (hidden input, redeploys). See README for the variable list.
- Stripe: the server-side charge confirms with `pm_card_visa`, so only test keys (`sk_test_`) work. Real cards need Stripe Checkout, which isn't built.
- Anthropic: flyer reading and the night recap; model from `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`).

## Tests
- Backend: `cd backend && npm test` (vitest). On this Mac, first run `npm i --no-save @rolldown/binding-darwin-arm64`.
- End to end: `npm test -- https://subcurrent-prototype-v2.vercel.app` (Playwright smoke test in `tests/smoke.mjs`).

## Rules
- v2 is separate from v1 (`~/Developer/sub-current`, sub-current.vercel.app) and from ColoradoBassHeads. Don't mix code or data between them.
- `ship-v2.sh` was the one-time setup (repo, project, DB, secrets, seed). It is idempotent, but normal changes only need a push.
- Never print the owner password; it is in the git-ignored `.owner-credentials`.
