# Verification results

Verified on 15 October 2026 in the current Linux cloud environment with Node 24.19.0, npm 11.9.0, PostgreSQL 17 and system Chromium. This is evidence for local development and demonstration, plus a local production-container rehearsal. Public deployment and new-task snapshot restoration have not been performed.

## Automated checks

| Check | Result |
| --- | --- |
| TypeScript checks across all workspaces, API tests and browser configuration | Passed |
| Shared validation contracts | 6 passed |
| HTTP foundation and OpenAPI contracts | 12 passed |
| React components, command transport and quoted-unit costs | 15 passed |
| PostgreSQL integration suites | 46 passed |
| Chromium end-to-end workflows | 8 passed, zero skipped |
| Shared/API/web production compilation | Passed |
| Migration status | Both migrations applied; schema up to date |

**Total: 87 passing tests.** Unit tests use controlled fixtures; integration and browser suites migrate and seed real, uniquely named disposable PostgreSQL databases and remove only those databases afterward. They never reset the development database.

Integration checks cover persistent sessions, CSRF, direct role denials, deactivation/session revocation, user updates, tax/discount calculations, recipe snapshots and unit conversion, competing reservations, exactly-once preparation consumption, reservation release, payment/refund bounds and duplicate handling, stock approvals/stale counts/reversals, partial competing receipts, weighted costs, waste, financial reports and rounding, CSV safety, and database history/balance constraints.

Browser checks cover POS → payment → live kitchen update → preparation → ready → completion → receipt, reconciliation with real stock and financial API records, supplier creation and partial receiving, unit-cost conversion, over-receipt rejection, purchase cancellation and waste approval, three restricted role boundaries, responsive keyboard navigation, service-error recovery and logout/relogin.

Additional authenticated browser smoke checks verified the reports page, inventory valuation filter and downloaded CSV, plus optional menu-image URL validation, saving, rendering on menu/POS cards and clearing. The image check restored the original catalog item. These manual checks are separate from the 87 automated tests. The final eight-test browser suite was repeated after the image controls were added and passed with zero skipped tests.

The browser test login helper was corrected to wait for completed authentication rather than the transient “Signing in…” button state. Select locators use actual combobox accessible names. These fixes retain the underlying functional assertions. An intermediate failure did not count as a passing run; the final suite completed successfully with all eight tests executed.

## Containers and security configuration

All three Docker targets built successfully: API runtime, migration tooling and nginx web assets. Production Compose configuration validates. A disposable local production rehearsal applied both migrations, provisioned a non-demo owner, checked bootstrap refusal/repeat guards, and ran the actual API/nginx images as non-root processes with read-only filesystems and dropped capabilities. It verified readiness, secure-cookie attributes with trusted proxy headers, login/logout, CSRF rejection, API/SPA/static routing and authenticated WebSocket upgrades. Temporary rehearsal databases, containers, network and secret files were removed; development PostgreSQL was preserved.

TLS, package signatures and engine checksums remained enabled. Docker's `vfs` driver amplified build-layer storage and briefly filled the disk; task-owned unused build caches were removed and Docker COPY layers consolidated. Database contents were preserved, capacity recovered, and the affected checks were rerun successfully. This is a cloud build-resource observation, not a restaurant application limit.

The pruned API runtime dependency audit reported zero advisories using its documented production omission flags. The complete development/migration tool tree still contains documented Prisma CLI transitive advisories. Review compatible upstream fixes before a public release; the runtime result is not an independent security audit.

## Remaining release work and known limits

- Deploy to the intended host with production-specific credentials, a trusted HTTPS proxy, verified remote database TLS and the real restaurant's tax/discount/payment policies.
- Provision and rehearse backups and restoration, monitoring and operator responsibilities. Local container checks do not establish a public TLS deployment or recovery capability.
- Payment methods record money collected externally; no card gateway or card-data handling is integrated.
- Expiry reminders use receipt dates and an aggregate ingredient expiry. Per-lot balances, traceability and automatic batch allocation are outside the implemented scope.
- Demand forecasts are rule-based estimates and explicitly identify insufficient history; no AI service is claimed.
- The web build passes with a large main-chunk warning. Route-level code splitting is a future performance improvement, not a failed build.

Environment installation/start instructions are saved separately in the cloud draft. A draft save does not publish a new environment snapshot. GitHub source publication and a live production deployment are separate from these local verification results.
