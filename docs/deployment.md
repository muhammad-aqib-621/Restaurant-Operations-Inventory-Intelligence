# Build and deployment

The repository supplies development services and a single-instance production container layout. It does not deploy a public service automatically. Use a separate production PostgreSQL database, production-specific secrets and an HTTPS reverse proxy. Never use the development seed or development `.env` as production provisioning.

## Artifacts and topology

- `apps/api/Dockerfile`: Node 24 multi-stage build, generated Prisma client, production-only runtime dependencies, non-root API and readiness health check. The `migration` target retains the Prisma CLI for a controlled release job.
- `apps/web/Dockerfile`: compiled React assets in an unprivileged nginx image on port 8080.
- `apps/web/nginx.conf`: SPA fallback plus same-origin `/api` and `/socket.io` proxying, including WebSocket upgrades.
- `docker-compose.production.yml`: private API, explicit migration job, read-only runtime filesystems, dropped capabilities and loopback-only web port.
- `.dockerignore`: excludes credentials, dependencies, Git metadata and generated test/build outputs from build context.

The public HTTPS proxy forwards to `127.0.0.1:8080`. Nginx forwards internally to `api:4000`; that API has no published host port. PostgreSQL is externally provisioned and privately reachable. The production Compose example does not reuse the development database container or its volume.

Use the repository root as build context. Build from the committed lockfile, inspect dependency advisories and select immutable release tags. Base image tags should be updated through review and pinned by registry digest for your release policy. No TLS, checksum or package verification should be disabled to make a build pass.

## Required production configuration

Inject configuration through the deployment platform or a private environment file **outside** the checkout. The examples use a shell variable `PRODUCTION_ENV_FILE` pointing to that file; do not print its contents or commit it.

| Variable | Production requirement |
| --- | --- |
| `DATABASE_URL` | The intended PostgreSQL database, restricted application credentials and `sslmode=verify-full` with certificate trust for a non-loopback connection |
| `SESSION_SECRET` | Production-specific cryptographic randomness of at least 32 characters; stable between restarts |
| `APP_ORIGIN` | Exact public HTTPS origin, for example `https://restaurant.example.com` |
| `IMAGE_TAG` | Immutable application release tag; default `local` is only for rehearsal |
| `NODE_ENV` | Set to `production` by the production Compose configuration |
| `API_HOST` / `API_PORT` | Set by Compose to `0.0.0.0` / `4000` inside the private container network |
| `TRUST_PROXY` | Set to `true` only with the trusted routing described below |

The migration and bootstrap jobs need schema/data provisioning privileges. In a managed deployment, supply a separate migration connection and a least-privilege runtime database connection through job-specific variables. The sample Compose file shares `DATABASE_URL` for simplicity; split credentials in your deployment configuration rather than granting the runtime unnecessary schema privileges.

Production cookies require HTTPS. The outer reverse proxy must replace incoming `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` with trusted values and set `X-Forwarded-Proto: https`. Nginx preserves the trusted scheme for Express. Keep nginx's port inaccessible to untrusted clients: only the local HTTPS proxy may reach it. `TRUST_PROXY=true` trusts forwarded information, so this network restriction is part of the configuration, not an optional browser setting. If the TLS proxy runs in another network namespace, connect it through a private shared network instead of publishing nginx publicly.

The API rejects a production origin without HTTPS and rejects a non-loopback production database URL without `sslmode=verify-full`. Owner bootstrap enforces the same database rule. Configure the database certificate authority through the PostgreSQL driver's supported trust settings, such as an available `sslrootcert` file, and mount that file read-only when necessary. Do not use `sslmode=disable`, an invalid-certificate override or disabled Node TLS verification. A loopback-only database is allowed for local release rehearsals; it does not demonstrate a verified remote database connection.

## Build and migrate

After setting `PRODUCTION_ENV_FILE` to the private file path:

```sh
docker compose --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml --profile release build

docker compose --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml --profile release run --rm migrate
```

Run migrations once as a release job before the new API serves traffic. `migrate deploy` applies reviewed migrations without development resets. Back up before a production schema change, inspect its locks/data effects, and preserve compatibility with the previous application during rollout. A code rollback does not reverse a database migration; use a reviewed forward correction or an explicit restore plan.

For builds behind an organization-managed HTTPS proxy, use Docker's standard proxy build arguments and supply the existing trusted proxy CA as the optional BuildKit secret `build_ca`. For example, add `--secret id=build_ca,src="$TRUSTED_BUILD_CA"` to `docker build`, where the variable points to the verified CA file. That certificate is mounted only during package downloads and Prisma generation; it is not copied into the application image. Resolve the proxy hostname through the build host's supported networking when nested Docker cannot use its DNS. Package signatures and TLS verification remain enabled.

The API runtime intentionally omits the Prisma CLI and demo seed. Do not try `db:migrate:dev`, `db:seed`, database resets or volume deletion in production.

## Provision the first owner

An empty migrated production database needs its restaurant settings and first owner. The one-off `scripts/bootstrap-owner.mjs` requires explicit environment variables, refuses non-production mode and demonstration settings, and refuses to run if **any** owner already exists, including an inactive owner. It creates the owner, non-demo settings and an audit record in one serializable transaction. It never loads the local development `.env` or prints credential values.

Provision secrets through your platform's one-off job environment. For a local operator terminal, Bash can capture the password without shell history or terminal echo:

```sh
read -r -p 'Owner name: ' OWNER_NAME
read -r -p 'Owner email: ' OWNER_EMAIL
read -r -s -p 'Owner password (14+ characters): ' OWNER_PASSWORD
printf '\n'
export OWNER_NAME OWNER_EMAIL OWNER_PASSWORD

docker compose --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml run --rm --no-deps \
  -e OWNER_NAME -e OWNER_EMAIL -e OWNER_PASSWORD api node scripts/bootstrap-owner.mjs

unset OWNER_PASSWORD OWNER_NAME OWNER_EMAIL
```

Passwords must contain at least 14 characters and fit within 72 UTF-8 bytes; hashes use bcrypt cost 12. Use a unique production password. Re-running bootstrap is not a password reset. Existing owners manage accounts through the authenticated Team interface; owner recovery is an explicit administrative operation.

The created settings use the restaurant name, PKR, `Asia/Karachi`, a provisional zero tax rate and default configured payment records. Before entering real business activity, the owner must configure applicable tax/discount/payment policies and create real suppliers, catalog, recipes and approved opening stock. Production provisioning never creates demo suppliers or sample sales.

## Start and verify

```sh
docker compose --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml up -d api web

docker compose --env-file "$PRODUCTION_ENV_FILE" -f docker-compose.production.yml ps
curl --fail https://restaurant.example.com/api/health
curl --fail https://restaurant.example.com/api/readiness
```

Replace the public URL with the configured HTTPS origin. Readiness checks the database and restaurant singleton. API liveness alone does not verify business correctness. Confirm secure session cookies, login/logout, CSRF rejection, role access and authenticated WebSocket updates through the public HTTPS path. Rehearse a complete order/payment/receipt and purchasing/approval workflow in staging before live use.

For changes, build/tag the next images, run the migration job, and recreate application services. Keep previous immutable image tags available. Container stdout/stderr provides structured redacted request logging; direct logs to your operator's log service. Never print full Compose configuration, connection strings, passwords or cookie/session values into shared logs.

## Operation and recovery

PostgreSQL requires persistent storage, monitored capacity, automated encrypted backups, a defined retention period and a tested restore procedure. Record recovery objectives and restore rehearsals. Monitor readiness, HTTP errors, authentication failures, database connections, storage and backup freshness. Decide who owns incidents, policy changes and audit review.

Sessions persist in PostgreSQL across API restarts and expire after eight hours; changing the session secret invalidates existing cookies. User deactivation/password/access changes invalidate existing sessions. Maintain at least one active owner. Audit and stock/financial history use append-only constraints; corrections are compensating records, not destructive edits.

Expiry support is aggregate ingredient/receipt tracking, not a batch traceability system. Payments are staff-entered records, not gateway processing. Estimated gross profit excludes expenses. Forecasts use recorded demand and may report insufficient history. Understand these definitions before using reports for restaurant decisions.

This layout runs one API instance. Multiple instances require shared Socket.IO delivery and suitable load-balancing/session behavior. Inventory/financial database safety remains transactional, but real-time delivery cannot be assumed to cross API instances without the additional adapter.

## Validate before release

Use a separate local/staging database to run:

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
# With the dedicated demo services running and Chromium installed:
npm run test:e2e
```

Then build the production containers and test the actual HTTPS/proxy/database path. A successful compile, test run or container build does not establish a successful production deployment or restore rehearsal. The [API reference](api.md), [business rules](architecture.md) and [database guide](database.md) explain the behaviors the rehearsal must preserve.

The runtime dependency set omits development, optional and peer-only packages; generated Prisma clients remain available, while the migration CLI and TypeScript compiler stay in the build/release target. Audit that exact set with `npm audit --omit=dev --omit=optional --omit=peer`. Audit the complete development/release dependency tree separately: CLI-only findings must still be reviewed for release jobs even when they are absent from the served API.

## Recorded local release rehearsal

On October 15, 2026, all three production Docker targets built from the lockfile: API runtime, migration job and web runtime. A disposable database on the local PostgreSQL server was used to apply both migrations with the actual non-root migration image. The production owner job rejected demonstration settings, created exactly one owner, non-demo settings and one bootstrap audit record without sample suppliers or sales, and rejected a second provisioning attempt.

The actual API and nginx images then ran with non-root users, read-only filesystems and all capabilities dropped. Checks passed for database readiness, owner login/logout, CSRF rejection, authenticated dashboard access, secure/HttpOnly/SameSite cookie attributes with the trusted proxy scheme header, nginx assets and SPA fallback, same-origin API forwarding and authenticated WebSocket upgrades through nginx. Runtime inspection confirmed that the Prisma CLI, TypeScript compiler, `mysql2` and `deepmerge-ts` were absent. The temporary database, containers, network and generated rehearsal secrets were removed; the development database was retained.

The web image was subsequently rebuilt from the final source after the money formatting, purchase unit-cost, empty-filter and request cancellation corrections, including the optional menu-image form and catalog/order rendering. Prisma generation, the complete web TypeScript check and Vite compilation passed. That refreshed image also passed an isolated non-root, read-only startup check for nginx health, SPA fallback and the final compiled JavaScript and CSS assets. The earlier API, migration and authenticated proxy rehearsal results remain applicable; those components were not rebuilt unnecessarily.

`npm audit --omit=dev --omit=optional --omit=peer` reported zero advisories for that runtime dependency set. The complete development/release dependency audit still reported Prisma CLI transitive advisories involving `mysql2` and `deepmerge-ts`; these require dependency review before a public release. No automatic breaking dependency upgrade or verification bypass was applied.

This was a local rehearsal using a loopback database and trusted proxy headers. A public HTTPS endpoint, verified TLS connection to the intended remote production database, backups/restoration, monitoring and a live production rollout remain operator acceptance steps.
