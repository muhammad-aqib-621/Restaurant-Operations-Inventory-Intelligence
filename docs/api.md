# REST API reference

The Express API is mounted at `/api`. The complete, machine-readable OpenAPI 3.1 specification is served at `/api/openapi.json`; `/api/docs/` provides interactive Swagger UI using local assets. The specification includes every implemented route, request schema, role restriction, path/query parameter, response model and command header. Its API version is `0.2.0`.

## Authentication and request conventions

Authentication uses the HTTP-only `nk.sid` cookie and a PostgreSQL-backed server session. Production cookies are secure; all cookies use SameSite=Lax. Sessions have a rolling eight-hour expiry. The API reloads the active user and role for each protected request. Passwords are bcrypt hashes with cost 12 and never appear in responses or audit history.

1. `GET /api/auth/me` with cookie persistence enabled. The response is `{data:{user:null,csrfToken}}` before login. Preserve the anonymous session cookie.
2. `POST /api/auth/login` with `Content-Type: application/json`, that cookie, `x-csrf-token`, and `{email,password}`. Successful login regenerates the session and returns a replacement CSRF token and safe user.
3. Send the current cookie on every protected request. Send the latest `x-csrf-token` and JSON content type on every POST/PATCH, including login and logout. When an Origin header is present, it must match `APP_ORIGIN`.
4. `POST /api/auth/logout` with `{}` destroys the session, clears the cookie and disconnects its real-time connections.

Use the current token after login rather than retaining the anonymous token. Missing/expired authentication returns 401. A role, CSRF or Origin rejection returns 403. Invalid login credentials and deactivated accounts share the same error message. Login permits 15 attempts per 15 minutes per IP and returns 429 when limited. Account deactivation, role changes and password rotation revoke existing sessions and sockets.

All monetary and stock inputs are decimal **strings**, for example `"750.00"`, `"1.250000"` or `"-3"`. Monetary input supports two decimal places; stock quantities and unit costs support six. JSON numbers are used only for integer quantities, booleans, pagination and ordering fields. Unknown fields on business request objects are rejected. Never submit browser-computed order prices, tax, totals or stock balances.

Success responses use `{data: ...}`. Paginated lists use:

```json
{"data":[],"pagination":{"page":1,"pageSize":30,"total":0}}
```

`page` is 1–100000 and `pageSize` is 1–100, defaulting to 1 and 30. Recipe revision history returns an unpaginated `{data:[...]}`. Reports use `{data:{rows,...},pagination}`. Dates/timestamps serialize as ISO 8601 strings; persisted instants are UTC.

Errors use `{error:{code,message,requestId}}` and an appropriate HTTP status. The `X-Request-Id` response header supports log correlation without exposing database errors, session tokens or stack traces. Common statuses are 400 for validation, 401 for authentication, 403 for permission/CSRF, 404 for missing resources, 409 for state/idempotency/stock conflicts, 413 for bodies exceeding 256 KiB, and 415 for a non-JSON write.

## Retrying commands

Every order, status, preparation, payment/refund, purchasing/supplier, receiving, waste, stock-count, stock-adjustment, approval/rejection and movement-reversal command requires `Idempotency-Key`. Generate a UUID for each new logical command. If the request times out or the connection fails, retry with **the same key and body**. A successful retry returns the original response; it does not repeat financial or inventory effects. Reusing a key with different request contents returns 409. Keys are scoped to the authenticated actor and operation, and accept 8–128 letters, digits, underscores, dots or hyphens.

User/settings changes, catalog metadata/recipes and marking notifications read currently require CSRF but do not use the idempotency cache. The OpenAPI headers identify exactly which endpoints require a key. Preserve a pending command's key in the client until its result is known.

## Roles and endpoint access

Every permission is enforced by the API. `OWNER` has all permissions; the remaining roles have these boundaries:

| Role | Available operations |
| --- | --- |
| `MANAGER` | Operational reports, menu/recipes, orders, kitchen, inventory, suppliers/purchases, receiving, waste and stock approvals |
| `CASHIER` | Menu availability, orders, permitted discounts, payment records, own pending-order confirmation, pending cancellation and paid completion |
| `KITCHEN` | Menu/recipe notes, order board/detail, confirmation, preparation and cumulative item-ready updates |
| `INVENTORY` | Ingredient/supplier/purchase reads, goods receiving, stock ledger/reservations/alerts, waste/count/adjustment submission |

All authenticated roles can read restaurant settings and their own role-scoped/personal notifications. Only owners administer users/settings or read audit history. Cashier and kitchen menu/order responses omit internal cost snapshots, margins and ingredient stock details. Printable receipt data excludes internal costs and employee identifiers for every role.

## Implemented endpoints

Paths in the tables are relative to `/api`. The OpenAPI request schemas are the authoritative field-by-field reference.

| Method and path | Purpose and access |
| --- | --- |
| `GET /health` | Public process liveness; does not check the database |
| `GET /readiness` | Public database/configuration/active-owner check; 503 until ready |
| `GET /openapi.json`, `GET /docs` | Public API specification/documentation |
| `GET /auth/me`, `POST /auth/login`, `POST /auth/logout` | Session/CSRF lifecycle |
| `GET /users`, `POST /users`, `PATCH /users/{id}` | Owner-only account management; email is immutable after creation |
| `GET /settings`, `PATCH /settings` | Read for all roles; owner-only writes |
| `GET /audit` | Owner-only immutable audit history; `action`, `entityType`, pagination |
| `GET /notifications`, `POST /notifications/{id}/read` | Current user's authorized notifications only |
| `GET /categories`, `POST /categories`, `PATCH /categories/{id}` | All roles read; owner/manager write |
| `GET /menu`, `GET /menu/{id}`, `POST /menu`, `PATCH /menu/{id}` | All roles read; owner/manager write |
| `GET /menu/{id}/recipes`, `POST /menu/{id}/recipes` | All roles read revisions; owner/manager create immutable revisions |
| `GET /ingredients`, `GET /ingredients/{id}` | Owner/manager/inventory ingredient metadata and stock |
| `POST /ingredients`, `PATCH /ingredients/{id}` | Owner/manager metadata; no direct balance updates |
| `GET /inventory/movements` | Owner/manager/inventory immutable stock ledger |
| `GET /inventory/reservations` | Owner/manager/inventory reservations; defaults to `ACTIVE` |
| `GET /inventory/alerts` | Owner/manager/inventory low-stock, expiry and usage estimates |
| `GET /inventory/counts`, `POST /inventory/counts` | Owner/manager/inventory read and submit physical counts |
| `POST /inventory/counts/{id}/approve`, `POST /inventory/counts/{id}/reject` | Owner/manager review; rejection requires a reason |
| `GET /inventory/adjustments`, `POST /inventory/adjustments` | Owner/manager/inventory read and request signed deltas |
| `POST /inventory/adjustments/{id}/approve`, `POST /inventory/adjustments/{id}/reject` | Owner/manager review |
| `POST /inventory/movements/{id}/reverse` | Owner-only compensating reversal of an adjustment/count |
| `GET /orders`, `GET /orders/{id}`, `GET /orders/{id}/receipt` | Owner/manager/cashier/kitchen order information |
| `POST /orders` | Owner/manager/cashier authoritative checkout |
| `POST /orders/{id}/status` | Role-specific order transitions described below |
| `POST /orders/{id}/items/{itemId}/ready` | Owner/manager/kitchen cumulative preparation progress |
| `POST /orders/{id}/payments` | Owner/manager/cashier settlement records |
| `POST /orders/{id}/refunds` | Owner/manager bounded refunds with reasons |
| `GET /suppliers`, `POST /suppliers`, `PATCH /suppliers/{id}` | Owner/manager/inventory read; owner/manager write |
| `GET /purchases`, `GET /purchases/{id}`, `POST /purchases` | Owner/manager/inventory read; owner/manager draft creation |
| `POST /purchases/{id}/status` | Owner/manager order/cancellation transitions |
| `POST /purchases/{id}/receipts` | Owner/manager/inventory actual partial/full goods receipts |
| `GET /waste`, `POST /waste` | Owner/manager/inventory waste read/submission |
| `POST /waste/{id}/approve` | Owner/manager approval and stock deduction |
| `GET /reports/dashboard`, `GET /reports/{type}` | Owner/manager analytics and CSV exports |

Catalog list filters: `active=true`; menu additionally supports `categoryId` and `search`; ingredients support `search`. Supplier filters are `q` and `active=true|false`. Purchases filter by `status` and `supplierId`. Waste/adjustments filter by approval `status` and `ingredientId`; counts by approval `status`. Reservations filter by `ingredientId` and reservation `status`. Movement filters are `ingredientId`, movement `type`, `from` and `to`. Orders filter by order `status`, `from` and `to`. `active=true` selects confirmed/preparing/ready orders oldest first and overrides `status`. All these resource lists support pagination.

## Orders, stock and kitchen workflow

Create an order with menu IDs and integer quantities, optional line/order notes, optional customer `{name,phone}`, and an optional discount amount:

```json
{
  "items":[{"menuItemId":"copy-an-existing-menu-id","quantity":2,"notes":"No chilli"}],
  "discount":"20.00",
  "notes":"Takeaway",
  "customer":{"name":"Customer name"},
  "confirm":true
}
```

`confirm` defaults to true. The API snapshots current menu names/prices, the latest recipe version **at creation**, and estimated ingredient costs. It calculates subtotal, discount, tax and total. Tax is `(subtotal − discount) × taxRate`, rounded half up to two decimals. The discount cannot exceed subtotal; cashiers are additionally capped at `subtotal × cashierDiscountLimit`.

Confirmed orders reserve the sum of canonical recipe quantities multiplied by ordered quantities. Concurrent reservations cannot oversell. `confirm:false` creates an unreserved `PENDING` order; later confirmation still uses its original recipe snapshot. Active menu/category and valid active ingredients are required for new orders. Availability displayed by the menu is advisory; the confirmation transaction is authoritative.

The forward lifecycle is:

```text
PENDING → CONFIRMED → PREPARING → READY → COMPLETED
```

Kitchen/manager/owner can confirm pending orders and start preparation. First entry into `PREPARING` consumes each reservation exactly once, reduces on-hand/reserved balances and appends a signed `CONSUMPTION` movement. Repeated commands cannot consume stock twice.

`POST /orders/{id}/items/{itemId}/ready` uses `{quantity:2}` to mean **two cumulatively prepared items**, not two more items. Counts cannot decrease or exceed the ordered quantity. When every item is fully prepared, the order becomes `READY` automatically. A direct `READY` transition also requires every item prepared. Completion requires full net recorded payment. Cashiers can confirm their own pending orders, cancel pending orders, and complete paid ready orders.

Owner/manager can cancel open orders. Cancellation before preparation releases reservations without consuming stock. Cancellation after preparation preserves consumed inventory and requires a separate approved stock correction if ingredients can actually be recovered. It does not automatically refund payments. Cancelled/completed orders are terminal in the status lifecycle.

Payment bodies use `{amount:"100.00",method:"CASH",reference:"optional"}`. Exact configured payment methods are required. Positive payments cannot exceed the net outstanding balance; refunds require an additional reason and cannot exceed net recorded payments. The API records staff-entered external settlements. It does not process card credentials or claim that a payment gateway authorized a charge.

`GET /orders/{id}/receipt` returns customer-safe JSON with line totals, subtotal/discount/tax/total, payment/refund history, paid/refunded/net-paid/outstanding figures, restaurant name/currency/timezone and the development demo flag. The web client renders/prints this data.

## Inventory, receiving and approvals

Ingredients store canonical `G`, `ML` or `PIECE`. Recipe/purchase/count/waste inputs also accept `KG` and `L`, converting by 1000 within compatible unit families. Mass, volume and pieces cannot be mixed. Purchase and receipt `unitCost` is **per supplied unit**: for `quantity:"2",unit:"KG",unitCost:"500"`, canonical quantity is 2000 G and canonical unit cost is 0.5/G. Canonical costs must fit six decimal places.

Every physical stock change requires an immutable signed ledger movement in the same transaction. PostgreSQL constraints reconcile cached on-hand/reserved balances against ledger entries and active reservations at commit. Negative inventory and removing reserved stock are forbidden.

New ingredient records start with zero stock. Establish stock using an approved positive adjustment or a genuine purchase receipt. Counts record an absolute physical quantity and the current on-hand snapshot; approval fails if that snapshot is stale. Adjustment quantities are signed deltas. Submission alone does not alter stock. Owner/manager approval applies the correction and writes its ledger movement. Rejection records the reviewer and reason without altering stock. Only owners may append one reversal for a `COUNT` or `ADJUSTMENT` movement; original history remains intact.

Purchases start `DRAFT`, advance to `ORDERED`, then `PARTIAL` or `RECEIVED` according to actual deliveries. Receipts must name unique purchase line IDs and cannot exceed outstanding ordered quantities. One transaction creates the receipt/history, updates actual received quantities and weighted-average costs, appends `PURCHASE` movements and updates status. Retrying the same receipt key returns the same receipt. A partial order can be cancelled to close its remainder; received stock/history remain intact. Resolve delivery discrepancies with actual quantities/costs and an explanatory invoice reference/notes; do not invent extra received stock.

Waste submissions capture quantity/reason and a provisional cost. Only approval removes stock. Approval rechecks current unreserved availability and snapshots the inventory cost then. Waste has no rejection endpoint; do not assume one exists because the shared approval enum includes `REJECTED`.

`GET /inventory/alerts` returns current low stock, ingredients expired or expiring within seven days, and basic demand estimates. Its forecast requires seven days of recorded history and estimates seven future days plus minimum stock. `/reports/reorder` uses a different documented gate: three distinct consumption dates within 30 calendar days. Both expose insufficient-history status/null estimates and are rule-based estimates, not an AI service.

## Reports and financial definitions

Report/dashboard `from` and `to` are inclusive `YYYY-MM-DD` business dates in the configured IANA timezone, default `Asia/Karachi`. They become UTC instants with an exclusive next-day end. Dashboard defaults to today. Reports default to the last 30 business dates; the maximum range is 366 dates. With only `to`, a report selects that one date; with only `from`, it ends today. Order lists have no implicit date range. Inventory movements additionally accept UTC timestamp filters, whose end instant is inclusive.

| Report type | Rows and meaning |
| --- | --- |
| `sales` | Daily sales; `granularity=month` gives monthly rows |
| `items` | Historical menu names, proportionally paid/refunded item quantities, sales, estimated COGS and gross profit |
| `hourly` | Sales by local calendar hour, including empty hours |
| `consumption` | Actual immutable consumption quantities and movement-cost snapshots |
| `valuation` | Current on-hand/reserved/available stock and weighted-average inventory value |
| `movements` | Signed ledger history, reasons, references and responsible users |
| `waste` | Submitted/approved waste, estimated costs, reviewers and timestamps |
| `purchases` | Orders created in range or received in range; actual received costs use receipt timestamps |
| `reorder` | Current availability, minimums, preferred suppliers, insufficient-history flags and demand-based suggestions |

Financial reports use a **cash basis**: payment and refund timestamps select the reporting interval. Sales exclude tax and include discounts. Refunds reduce sales/tax by the original order proportions. Gross collected payments and positive refund amounts are reported separately. Estimated COGS allocates the immutable creation-time order cost in proportion to net payment; refunds proportionally reverse this financial estimate. Physical stock consumption remains in the ledger even after cancellation/refund.

Estimated gross profit is sales minus estimated COGS. It excludes operating expenses and is **not net profit**. Order count is distinct orders with a positive payment in the selected range; average order value is net sales divided by that count. Current low-stock/pending-purchase counts and valuation/reorder balances are snapshots, even when the report has a historical date range. Every JSON report includes `definitions` explaining its attribution rules and `columns` describing row fields.

`GET /reports/sales?from=2026-10-01&to=2026-10-15&format=csv` returns an attachment containing **all** matching rows; JSON pagination does not truncate CSV. Spreadsheet formula prefixes in string cells are escaped. The JSON form retains `{data:{type,from,to,timezone,columns,rows,summary,definitions},pagination}`.

## Real-time behavior

Socket.IO shares the authenticated PostgreSQL session. The server authorizes role rooms and disconnects revoked accounts/sessions. Clients subscribe to `orders:changed`, `inventory:changed`, `catalog:changed`, `purchasing:changed` and `settings:changed` as relevant. Business events publish after database commit. Event payloads identify changed resources; clients refetch the API as their source of truth. Initial fetch, reconnect refetch and polling recover missed events. Socket messages do not create payments, consume stock or replace command idempotency.

The readiness response reports `phase:8` and requires database connectivity, restaurant configuration and an active owner. It returns public restaurant identity, currency, timezone, tax rate and demo status without credentials. A successful readiness check is an operational prerequisite; it does not replace tests or deployment validation.
