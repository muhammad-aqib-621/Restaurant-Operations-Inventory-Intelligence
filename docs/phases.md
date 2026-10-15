# Eight-phase implementation map

The user authorized all eight phases together after the initial foundation. The repository now contains the complete implementation scope below; there is no per-phase pause or review prerequisite. A production deployment remains a separate operation using real configuration and operational checks.

| Phase | Implementation locations | Result |
| --- | --- | --- |
| 1 · Foundation | Workspace manifests, `apps/web`, `apps/api`, `packages/shared`, development Compose and initial migration | Typed React/Express/PostgreSQL monorepo, environment initialization and reproducible setup |
| 2 · Identity | API `auth`, `admin`, session/core helpers; web auth/layout/admin | Persistent sessions, bcrypt12, CSRF, role enforcement, user activation and dashboard access |
| 3 · Catalog/inventory | API `catalog`, `inventory`, inventory helper; web catalog; Prisma operations migration | Menu/recipe revisions, compatible units, ledger, balances, counts/adjustments and approval |
| 4 · POS | API order service/routes; web orders/POS | Server totals, historical snapshots, concurrent-safe reservations, duplicate-safe payments/refunds and receipts |
| 5 · Kitchen | Order transitions, Socket.IO server/client, web kitchen | Preparation progress, exactly-once consumption, cancellation release and reconnect/refetch |
| 6 · Procurement | API purchasing; web purchasing/waste; schema receipts/approval records | Suppliers, purchase ordering, partial receiving, weighted costs, waste and stock corrections |
| 7 · Reporting | API reporting/reports/notifications; web dashboard/reports/admin | Cash-basis analytics/CSV, consumption/valuation, reorder estimates, scoped notifications and audit review |
| 8 · Reliability/release | Unit/component/API/integration/Playwright suites, Dockerfiles/nginx, deployment docs | Automated critical-workflow coverage, non-root containers, migration job and explicit production operation instructions |

The phase names describe implementation order and source boundaries. They do not assert that a production host, real restaurant policy, backup restore or every deployment platform has been verified.

## Run and verify

From the repository root:

```sh
npm run env:init
npm ci
npm run db:up
npm run db:generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run test:integration
npm run build
npm run dev
```

Execute `npm run test:e2e` after installing Playwright Chromium, or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an existing supported Chromium binary. The root runner starts isolated API/web servers and a disposable database automatically. See [README](../README.md) for login/configuration and [deployment](deployment.md) for container build commands.

Required correctness checks include authentication/roles, totals/discounts/tax, immutable recipe snapshots, compatible units, stock contention/rollback, consumption once, cancellation releases, payment/receipt retries, partial receiving, approvals, report definitions and business dates. Automated suites cover these rules against real PostgreSQL and browser/component surfaces; inspect the actual test output for counts/results. Do not infer a passed test from file presence or compilation.

## Boundaries of the completed scope

Payment methods are configurable records rather than an integrated gateway. Financial gross profit is estimated and excludes operating expenses. Expiry reminders use ingredient/receipt dates rather than a full batch allocation system. Forecasts are demand-based estimates and disclose insufficient history. The deployment is a single API instance behind trusted HTTPS routing; external database operations, first-owner provisioning, backups and public deployment require the host described in [deployment instructions](deployment.md).

The original Phase 1 network blocker is historical and has been resolved in the current environment; [the old validation note](phase1-validation.md) points to the current workflow.
