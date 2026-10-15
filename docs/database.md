# Database and demonstration fixtures

The PostgreSQL schema is in `prisma/schema.prisma`. `npm run db:migrate` applies the existing settings migration followed by the operations migration. The original migration is preserved. Use `npm run db:migrate:dev -- --name <change>` only when designing a future schema change in a disposable development database; production and shared environments use reviewed migrations with `migrate deploy`.

## Model and integrity decisions

- This is a single restaurant. `RestaurantSettings` has one `primary` row, with a currency, IANA business timezone, tax fraction, cashier discount fraction and permitted payment method names.
- Operational records use opaque cuid identifiers. Human-facing order and purchase numbers are PostgreSQL sequences; gaps after rolled back transactions are expected.
- All timestamps use PostgreSQL `timestamptz`, representing UTC instants. Business dates are interpreted by the API in the configured restaurant timezone (the default is `Asia/Karachi`). Session expiry uses the table layout required by `connect-pg-simple`.
- Money is `Decimal(14,2)`. Ingredient balances, canonical quantities and unit costs are `Decimal(18,6)`. Tax and discount limits are fractions in `[0,1]`. The API takes decimal strings and does its calculations on the server.
- Ingredient storage units are restricted in PostgreSQL to grams (`G`), millilitres (`ML`) and pieces (`PIECE`). Kilograms and litres are supported at input boundaries by explicit same-dimension conversion. A piece never converts to a mass or volume.
- Ingredient `onHand` and `reserved` are cached balances. Deferred constraint triggers require `onHand = sum(InventoryMovement.quantity)` and `reserved = sum(ACTIVE InventoryReservation.quantity)` at transaction commit. A balance edit or ledger entry without its corresponding business transaction fails. `0 <= reserved <= onHand` also holds. Transactions may update balances and insert ledger rows in either order, but neither can commit alone.
- Each stock ledger movement has a responsible user, canonical signed quantity, unit cost, timestamp, reason and optional order/receipt/reversal reference. Stock changes are never anonymous. Purchase/opening movements are positive, consumption/waste movements negative, and all movements are nonzero.
- Inventory movements, audit logs, payments, goods receipts and recipe versions/ingredients reject updates and deletes through database triggers. Stock corrections create compensating ledger entries; refunds are positive `REFUND` records. The unique reversal reference prevents reversing the same movement twice. Counts with no stock difference create no movement.
- Recipe revisions create a new version instead of editing historical ingredients. Order lines retain menu label, selling price, estimated unit cost and exact recipe version. Deactivating catalog records preserves this history; foreign keys restrict deletion of referenced entities.
- Order confirmation reserves ingredients; preparation consumes the reservations. A cancellation before preparation releases stock. A cancellation after consumption does not silently restock food. Serializable application transactions with retry protect reservations, payments, approvals and receiving from concurrent writes.
- Purchase receipt lines cannot exceed the ordered amount; received totals are maintained in the receiving transaction. Weighted-average ingredient cost changes only when actual receipts are posted. Waste and adjustments are proposals until an authorized approval posts the ledger entry. Count approval compares its stored stock snapshot to current stock to avoid accepting a stale count.
- Idempotency records are unique by actor, operation scope and request key, retaining a request hash and response JSON. Their record and business mutation commit atomically, so an interrupted client can safely retry the same request.
- Notifications contain an authorized role audience and optional user target. Read markers are separate per-user records. Audit details must contain business context only, never passwords, cookies or session secrets.

Database checks provide the final safety boundary. Backend role checks and validation still determine which operations are permitted; database constraints alone do not establish user authorization. Administrators should use a separate migration role and an application database role without schema-altering privileges in production.

## Safe development seed

The seed is explicitly demonstration data. It refuses `NODE_ENV=production` and refuses a database whose existing settings are not marked `isDemo`. Use a dedicated local/demo database. The normal empty-database workflow is:

```sh
npm run env:init
# Set DEMO_PASSWORD securely in the ignored .env; do not commit it.
npm run db:generate
npm run db:migrate
npm run db:seed
```

`DEMO_PASSWORD` is required, must have at least 12 characters, and must fit within bcrypt's 72-byte input limit. The seed hashes it with bcrypt cost 12. Store the value only in your ignored local `.env` or secret manager; never paste it into source files, a commit or shared documentation. It is used for these development accounts:

| Email | Role |
| --- | --- |
| `owner@newkarachi.test` | Owner |
| `manager@newkarachi.test` | Manager |
| `cashier@newkarachi.test` | Cashier |
| `kitchen@newkarachi.test` | Kitchen |
| `inventory@newkarachi.test` | Inventory |

The seed creates three explicitly named demo suppliers, sixteen ingredient SKUs prefixed `DEMO-`, four menu categories and eight menu items with their first immutable recipe version. Every opening ingredient balance has a matching `OPENING` ledger row and demo reference. It creates no artificial orders, revenue, payments or profitability. An empty sales dashboard is expected until you run actual demonstration workflows.

Re-running the seed is additive and idempotent: deterministic fixture identifiers and unique keys avoid duplicates, existing catalog and configuration fields are preserved, opening inventory is not replenished, and existing account passwords/roles are not overwritten. Changing `DEMO_PASSWORD` and running the seed again does **not** reset accounts. Use owner user management or a separate explicit administrative process for password changes.

Never run reset commands against real business data. For a new demonstration, create a fresh dedicated development database, apply migrations and seed it. Production needs real suppliers, approved opening stock and securely provisioned users rather than these fixtures.
