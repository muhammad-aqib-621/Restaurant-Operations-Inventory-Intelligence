# The Copper Table · Restaurant Operations

A full-stack restaurant workspace for owners, managers, cashiers, kitchen staff and inventory staff. React/Vite connects to an Express API and PostgreSQL through Prisma. The application includes authenticated operations, POS and kitchen orders, versioned recipes, a stock ledger, purchasing, approvals, reports, notifications and audit history.

## Run locally

Requirements: Node **24.19.0** (`nvm use`), npm 11, Docker Engine with Compose v2, and a browser. From the repository root:

```sh
npm run env:init
npm ci
npm run db:up
npm run db:generate
npm run db:migrate
npm run db:seed
npm run dev
```

Open **http://127.0.0.1:5173**. The API uses port **4000**, and PostgreSQL **5432**; all development services bind to loopback by default. Use the existing checkout; another Git worktree is unnecessary. Ctrl+C stops the web/API processes. `npm run db:down` stops PostgreSQL and preserves its named data volume.

`env:init` creates an ignored `.env` with random database credentials, `SESSION_SECRET` and `DEMO_PASSWORD`. It preserves existing values and appends missing development configuration. Open that local file privately to obtain your generated demo password; it is never printed or committed. Sign in with one of:

| Email | Role |
| --- | --- |
| `owner@newkarachi.test` | Owner |
| `manager@newkarachi.test` | Manager |
| `cashier@newkarachi.test` | Cashier |
| `kitchen@newkarachi.test` | Kitchen |
| `inventory@newkarachi.test` | Inventory |

The demo email domain is a stable local account identifier and is intentionally unchanged by the restaurant name.

The seed creates marked demonstration suppliers, ingredients, stock and menu recipes. It creates no fabricated sales: the dashboard begins at zero until you record activity. Re-running the seed preserves existing passwords, custom settings, stock balances and catalog edits; it updates the original default demo restaurant name to The Copper Table. Changing `DEMO_PASSWORD` does not reset an existing account. The initializer and seed refuse production mode. The initial **0% tax rate is illustrative**; the owner must configure the applicable restaurant policy.

## Demonstrate the workflows

1. Sign in as owner or manager and review Menu & recipes and Inventory. Canonical stock units are grams, millilitres and pieces; inputs also support explicit kilograms/litres conversions.
2. As cashier, add menu items in POS, enter any notes/customer details, apply a permitted discount, and confirm an order. Prices, discounts and taxes are calculated by the server. Confirmation reserves the full recipe requirement atomically.
3. In a separate browser profile, sign in as kitchen staff. Begin preparation, mark item quantities ready, and watch connected screens update. Preparation consumes reserved stock once; retries cannot repeat consumption.
4. Record cash/card/bank-transfer payment against the order, then complete it when ready and fully paid. Order details provide a printable receipt. These are payment **records**; no bank or payment gateway transaction is performed.
5. Create and order a supplier purchase, then receive a full or partial delivery as inventory staff. Actual quantity/cost updates inventory, weighted-average cost and the immutable ledger together. Repeated requests with the same key return the original result.
6. Submit waste, an adjustment or a stock count. An owner/manager approval posts its stock effect. Inspect reports, CSV exports, notifications and the owner audit trail.

Cancelling before preparation releases reservations. Cancelling after preparation requires an owner/manager and does not automatically restock ingredients. A partially received purchase can be cancelled to close its outstanding remainder while retaining received stock and history. Over-deliveries must be handled through a separate approved purchase rather than exceeding ordered quantities.

## Modules and access

| Module | Implemented behavior |
| --- | --- |
| Identity | PostgreSQL sessions, bcrypt passwords, CSRF protection, rate-limited login and account requests, owner-approved staff registration, active-account checks, owner user management |
| Dashboard | Real payment/refund aggregates, estimated COGS and gross profit, current low-stock/open-purchase counts, sales chart and recent activity |
| Catalog | Categories, menu descriptions/images, availability/prices, versioned recipes, canonical ingredient conversions, estimated recipe costs and margins |
| POS and kitchen | Server totals, price/recipe snapshots, stock reservation/consumption, payments/refunds, receipts, status validation and real-time refetch |
| Inventory | Append-only stock movements, reservations, counts/adjustments with approval, safe reversal, low-stock and demand estimates |
| Procurement | Supplier contacts, purchase orders, partial receiving, invoice references and actual received costs |
| Oversight | Waste approvals, business-date reports/CSV, role-scoped notifications and immutable audit history |

Permissions are enforced by API routes. Owner has all modules; managers run operations and reports; cashiers handle permitted order/payment work; kitchen staff handle preparation; inventory staff handle stock/receiving submissions. User administration, settings changes and audit review are owner-only. Authenticated staff can read restaurant settings needed by their workflow.

## Validation

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
```

Unit/HTTP/component tests run with `npm test`. The integration runner provisions a uniquely named disposable database on the **local** PostgreSQL instance, applies real migrations, seeds it, runs critical business/permission/concurrency tests, then drops that disposable database. It never resets the development application database. Your local database role needs database-creation privileges; the generated development role has them. Do not run this development runner against production.

Playwright's root runner creates its own disposable database and starts isolated API/web servers on ports 4100/5174. Your normal development instance can keep running on 4000/5173:

```sh
npm exec --workspace @nk/web -- playwright install chromium
npm run test:e2e
```

If Chromium is already installed:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm run test:e2e
```

A fresh Linux machine may also need `playwright install-deps chromium`. Browser workflows use the generated demo credentials and create records only in their disposable database, which is removed afterward. Passing tests establish the exercised behavior, not a completed production rollout or an independent security audit. The current verification results are recorded in [validation evidence](docs/validation.md).

## Configuration and API

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL URL; URL-encode credentials and use verified TLS for remote production databases |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Local Docker database initialization and loopback port |
| `SESSION_SECRET` | At least 32 random characters; keep stable across restarts and secret |
| `DEMO_PASSWORD` | Development seed only, at least 12 characters and at most 72 UTF-8 bytes |
| `APP_ORIGIN` | Browser origin, default `http://127.0.0.1:5173`; production must use HTTPS |
| `API_HOST`, `API_PORT` | API bind address/port, default `127.0.0.1:4000` |
| `WEB_HOST`, `WEB_PORT` | Development Vite bind address/port, default `127.0.0.1:5173` |
| `NODE_ENV` | `development`, `test` or `production`; production uses secure cookies |
| `TRUST_PROXY` | Enable only behind the documented private, trusted proxy path |

Exported shell variables take precedence over `.env`. Changing `POSTGRES_PORT` also requires changing `DATABASE_URL`. If npm's home cache is unwritable, use `npm ci --cache /workspace/.cache/npm`.

Vite proxies `/api` and `/socket.io` to Express. The [API reference](docs/api.md) is also served at **/api/docs**, with OpenAPI at **/api/openapi.json**. `GET /api/health` is liveness; `GET /api/readiness` verifies database access and restaurant configuration. Protected APIs require a session cookie. Writes require JSON and `x-csrf-token`; obtain the session's token from `/api/auth/me`. Financial/stock commands also require `Idempotency-Key`. Successes use `{data: ...}`, paginated lists add `pagination`, and errors use `{error:{code,message,requestId}}`. Decimal values cross the API as strings.

## Build, architecture and deployment

`npm run build` produces shared declarations/JavaScript, `apps/api/dist` and `apps/web/dist`. Run the compiled API with `npm run start --workspace @nk/api`. Production containers use a non-root API and nginx serving static assets while proxying API and WebSocket traffic. See [deployment instructions](docs/deployment.md) for explicit migrations, first-owner provisioning, TLS/proxy requirements and backup procedures. No production deployment, public publication or remote push is performed by local setup.

Read [architecture and business rules](docs/architecture.md), [database decisions](docs/database.md), and the [eight-phase implementation map](docs/phases.md).

Reporting uses cash-basis sales excluding tax, net of refunds. Estimated gross profit subtracts historical recipe-cost estimates; it is **not net profit**. Physical stock consumption is reported separately. Forecasts are rule-based estimates with insufficient-history states, without an AI claim. Expiry tracking is ingredient-level with received-line dates; it does not implement batch-level stock allocation or automatic FEFO consumption.

## Troubleshooting

- **Database unavailable:** inspect `docker compose ps` and `docker compose logs db`, then verify migrations and configuration. Keep credential-bearing `.env`/Compose output private.
- **Database password changed in `.env`:** existing PostgreSQL volumes retain their original credentials. Restore the matching configuration or rotate credentials using PostgreSQL; restarting does not rewrite a stored password.
- **Login fails after changing `DEMO_PASSWORD`:** re-seeding preserves existing password hashes. Use the original local value or an explicit owner password reset.
- **New account cannot sign in:** account requests stay inactive until an owner reviews the request, assigns a role and activates the account under Team members.
- **Prisma client differs from schema:** run `npm run db:generate`, rebuild and restart the API. Never reset a database as routine troubleshooting.
- **Downloads denied:** allow the destination confirmed by the error, such as `registry.npmjs.org`, `binaries.prisma.sh`, Docker registry/CDN hosts or Playwright's CDN. Keep TLS, checksum and package verification enabled.
- **Production login does not set a cookie:** confirm HTTPS, the exact `APP_ORIGIN`, trusted proxy headers and private proxy routing; production cookies are intentionally secure.
