# Hustle Builder v4 — repair validation and deployment handoff

Prepared November 1, 2026. **Repaired v4 source, tested locally; not deployed. This package supersedes the earlier repairs made from the v3 upload.**

## Baseline and preservation

The uploaded v4 ZIP's source matched public GitHub commit **`1b57d7a`** byte-for-byte. The original v4 suite passed **78/78** before edits. Work was done in a separate copy of that source. The earlier v3 source was not substituted for it. No live account, including Maryn's, was accessed or changed. No real mail, payment, booking, or production cron was triggered.

The repaired suite retains the 78 original test cases, including family plans, the seven page designs, picture selection, receipts, admin/comp controls, PWA behavior and saved builds. Security fixtures were updated where the intended behavior is stricter: invitation opening no longer authenticates, billing events include a legitimate pending session and payment fields, renewals never pay on GET, cookie writes use the correct origin, and CSP tests assert an opaque origin. No family or artwork assertions were removed to make the repairs pass.

**Preservation checks:** all **24 supplied asset files** (including job photos, pet art, icons, HEIC helper and records within assets), plus the **560,375-byte embedded cinematic block**, retain their original v4 hashes. The v4 picture styles, crop, dark hero melt, family-page controls and HttpOnly cookie design are retained. `tests/v4-art-manifest.json` records the original hashes and tests them on every run.

## What v4 already fixed, and what still needed repair

| Area | Original v4 finding | Action |
|---|---|---|
| HttpOnly parent/admin cookies | Already present; retained | Preserve cookies; revoke legacy sessions during upgrade; add explicit origin checks for cookie writes |
| Five-minute Stripe signature age check | Already present and passed replay-age check | Retain v4 implementation |
| Duplicate Stripe delivery events | Already deduplicated serially | Preserve legacy ledger; make payment/receipt/outbox updates transactional and deduplicate paid sessions |
| Serial email-send quota | Already present and passed | Keep existing limits; make simultaneous increments atomic |
| Published-page CSP | Already present, but allowed same-origin inline scripts | Add HTTP sandbox without `allow-same-origin`; prove storage and authenticated API access are blocked while booking works |
| Parent invitation | Still issued a session from a token returned to its requester | Require independent email verification; protect completion with verified account ownership |
| Bookings, trials, slug ownership and renewal index | Still lost updates under contention | Add production PostgreSQL transactions, shared resource locks, stable request IDs and per-account index records |
| Checkout recovery | Parallel clicks created multiple sessions; a provider failure left a pending lock | Reuse the provider session, use stable idempotency and clear completed checkout state for the next renewal |
| Billing event validation | A validly signed unpaid/zero-amount event activated a plan | Check payment state, amount, currency, session and attempt before activation |
| Customer data, cancellation and recovery | Request addresses survived deletion; calendar entries survived cancellation | Clean related records and expiry; synchronize cancellation; use a durable mail outbox |

In the **unmodified v4 snapshot**, the 28 adversarial scenarios produced **6 passes and 22 failures, with zero harness errors**. These are scenarios, not 22 distinct vulnerabilities. For example: forty simultaneous paid-site bookings all reported success, but only one request and one calendar job remained; 400 simultaneous publishes left only one renewal-index entry; the parent invitation still allowed account impersonation. The baseline logs and results are included.

## Additional bugs found specifically in v4

Nine new feature checks were first run on unmodified v4: **one passed and eight failed**. The repaired version passes all nine, plus a legacy-payment compatibility check.

- Renaming a page could overwrite an owned sibling. That now returns a conflict; the sibling is preserved.
- Renaming or republishing a page could clear a moderation hold. Review and pause state, reports and moderation metadata are now retained.
- Republishing reset the daily booking count. It now preserves the quota metadata.
- A renamed page's already-generated booking form still named the old slug and failed. Booking now follows valid redirects, verifies that ownership is unchanged, and saves against the current page. Redirect loops and expired or foreign-owner aliases are rejected.
- Trial usage and family membership could lose updates when sibling pages were booked or published together. The tests now retain all ten simultaneously published siblings and share exactly one three-job trial across 24 simultaneous requests.
- The booking deduplication scope includes the page, so the same customer can book identical work on two siblings without losing the second request.
- Cross-origin writes using an ambient parent cookie are explicitly rejected. Existing v4 payment delivery markers remain recognized after migration.

View counting is also preserved without serializing public-page rendering behind account writes: production counters use an atomic SQL increment after the page snapshot, and counting failures do not fail the page. SQL-engine tests retain 80 concurrent increments and remove expired day buckets. The optional two-pool PostgreSQL test checks this too.

The complete patch was also applied to a fresh checkout of the exact v4 commit and all **111 tests passed there**, with every repaired source file matching the intended result. See `stress/v4-clean-patch-tests.log`.

## Final measured results

| Verification | Result |
|---|---|
| Automated suite | **111 passed, 0 failed, 0 skipped**: 78 retained v4 cases, 20 shared recovery/security cases, 10 v4 feature cases, 3 preservation/counter cases |
| Adversarial scenarios on repaired v4 | **28 passed, 0 failures, 0 harness errors** |
| Forty simultaneous paid-site bookings | 30 accepted, all 30 requests/calendar jobs retained; 10 limited |
| 400 simultaneous publishes | 400 successes; all 400 renewal-index entries retained |
| Family trial contention | 24 requests across two siblings; exactly 3 delivered and 21 held; all 24 retained |
| Cookie browser checks | Secure HttpOnly cookie present; no bearer token saved in localStorage; cookie alone authenticates |
| Browser isolation/PWA/phone suite | **15 checks passed**: storage blocked, authenticated API blocked, booking works, invitation verifies independently, all nine types traversed at 390px, private APIs never cached, saved progress reopens offline |
| Desktop and phone E2E | Build → verify → consent → publish → book → republish passed; 390px layouts have no horizontal overflow |
| Local HTTP load | **6,400 requests, zero HTTP/network failures**, concurrency 1, 25, 100 and 400; malformed JSON returns 400 and server stays healthy |
| Artwork | Original hashes retained for all 24 assets and embedded cinematic block |

All emails/payments were simulated, using temporary data. The database adapter, migration, encrypted backup, restore and atomic counter queries were exercised with a local SQL engine (PGlite). **A hosted PostgreSQL/Neon test, real Vercel load, genuine Stripe purchase/refund and real email deliverability remain unverified.** The local HTTP test uses the dev file adapter; public-page counts are serialized there and therefore its timings do not estimate production SQL throughput. No result here certifies 400 live users.

The package includes encrypted backup/restore tooling, deployment preflight, due-mail selection without starvation, retry backoff after network failures and expiring queued sign-in codes. See `npm run backup`, `backup:verify`, `backup:restore` and `preflight`; configuration values are never printed. No actual customer backup or automation was created.

## Evidence and test commands

`stress/v4-baseline-tests.log`, `v4-baseline-results.json`, `v4-baseline-stress.log` and `v4-extra-baseline.log` are pre-repair evidence. `v4-repaired-tests.log`, `results.json`, `v4-repaired-stress.log`, browser logs and `http-results.json` are repaired-v4 evidence. `tests/v4-art-manifest.json` is the source preservation check. The old baseline capture script is for a separate clean checkout of `1b57d7a`, not a repaired-source acceptance test.

```sh
npm ci
npm test
npm run test:stress
npm run test:http
CHROME=/absolute/path/to/chromium npm run test:browser
npm run preflight
npm run test:postgres
```

The browser needs an installed Chromium executable. `preflight` needs the intended deployment environment; `test:postgres` needs an explicitly configured, isolated `HB_TEST_DATABASE_URL` and uses two independent pools. It refuses to claim success without that database. Keep secrets in the environment, not command literals or chat. Do not use production accounts or the production database for synthetic tests.


## Required deployment change

**Do not simply deploy this zip over the current Blob-backed site.** Production deliberately fails closed without transactional storage. A developer must provision a PostgreSQL database, migrate state, configure its connection, and verify the preview before releasing traffic. This is a real infrastructure change.

Keep secrets in the hosting environment. Never paste them into chat, commit them, print connection strings, or bundle them. Use a pooled PostgreSQL connection URL suitable for the chosen provider and verified TLS. The application uses `pg`, parameterized queries, and a pool of up to five connections per warm instance; confirm the provider's total connection limits.

Required new environment variable: `DATABASE_URL`.

Preserve the existing production variables: `PUBLIC_ORIGIN`, `CRON_SECRET`, `ADMIN_SECRET`, Stripe and Resend settings, `PAYWALL_MODE=stripe`, `PUBLISH_TEST_MODE=0`, and any trial configuration. `BLOB_READ_WRITE_TOKEN` is needed by the one-time migration, then is no longer required for runtime state. No secrets are included here.

### Cutover procedure

1. Compare with current main and integrate any newer fixes on a fresh branch. Install dependencies with `npm ci` and run the commands below.
2. Run `npm run preflight` for the intended configuration and correct any failures. Create an **isolated preview database**. Set `HB_TEST_DATABASE_URL` to that database and run `npm run test:postgres`. This uses two independent pools and checks concurrent increments and rollback. Test normal application flows using that preview database; do not use the production database for synthetic tests.
3. Back up the current Blob data and hosting configuration through the provider. After migration, rehearse the encrypted snapshot restore in a separate empty database using the utility above. Keep the backup private. Reconcile **all in-flight legacy checkout sessions/payments** with Stripe before cutover. The older app did not save provider session IDs; the strict new webhook cannot automatically reconcile those legacy pending checkouts. Finish/cancel them or record the paid entitlement before migration. Confirm the webhook is configured for the checkout completion events used by your payment methods, including asynchronous success if enabled.
4. Pause writes during cutover. The patched handler supports `HB_MAINTENANCE_MODE=1`, returning 503 before touching storage. **The old app does not implement that flag**: enforce maintenance at the edge or deploy the repaired handler in maintenance mode first. Check that auth, booking, publishing and checkout are actually blocked. Stripe will retry temporarily rejected webhooks; reconcile pending payments as above.
5. In a secure shell, provide the source Blob token and destination `DATABASE_URL` through environment configuration. `npm run db:migrate` only inspects/prepares a dry run and reports counts. The destination must be empty for apply. It creates `hb_kv` inside the transaction. The v4 migration retains family `slugs[]`, comp status, receipts, legacy Stripe delivery records, redirects, photos and page themes. Parent and admin sessions and calendar capabilities are invalidated; sign in again after cutover.
6. After checking the dry run and confirming writes are paused, run `HB_MAINTENANCE_MODE=1 npm run db:migrate -- --apply`. The script preserves source objects, inserts transformed records in one SQL transaction, verifies transformed bytes before commit, rebuilds per-account renewal tracking, invalidates old bearer/calendar links and filters expired request capabilities. It refuses a nonempty destination and rolls back on failure. An interrupted successful commit should be checked before retrying; do not delete an existing destination to force a rerun.
7. Confirm account/site/booking counts against the private source backup. Confirm paid-until dates and trial counters. Review legacy payment reconciliation. Configure the repaired deployment's `DATABASE_URL`, retain production email/payment variables, then remove maintenance mode.
8. Verify a synthetic preview flow first, then a read-only production smoke check. A real purchase/refund remains Steve's task. Verify renewal and five-minute mail cron authorization, queued mail retry, deletion and cancellation in preview. Confirm CSP headers are present on actual `/<slug>` pages through Vercel, fonts render, and an actual mobile browser can book.
9. Tell families and the administrator to sign in again; families reconnect their calendar link. Old links were intentionally invalidated because the previous account-access flaw could have exposed them.

The added five-minute cron requires a hosting plan that supports that frequency (the historical handoff identifies a Pro project, but verify the current configuration). Watch queue age/failures and provider limits during rollout. Messages are retried after commit; booking success means the booking is saved, not that an email was delivered. Provider idempotency windows are finite, so this is durable retry with duplicate suppression, not a claim of unlimited exactly-once external delivery.

### Rollback

Keep the site in maintenance if migration or smoke checks fail. If no production writes have reached PostgreSQL, roll back to the previous code/configuration using the untouched Blob source. Once PostgreSQL has accepted live writes, do **not** switch blindly back to the stale Blob copy: export/reconcile the newer records first. Do not discard a nonempty database or restore a backup over accepted bookings.

## Test commands

```sh
npm ci
npm test
npm run test:stress
npm run test:http
CHROME=/absolute/path/to/chromium npm run test:browser
npm run test:postgres
```

The last command needs an isolated PostgreSQL server. Never paste a real connection string into a shared command transcript; use the environment's secret manager. `test:http` binds loopback port 18977; the security browser test uses 18978; the existing browser E2E uses 8799. Test scripts use temporary data and simulated email/payments. Browser executables and `node_modules` are not bundled.

## Remaining limits

- No deployment, production migration, real email deliverability check, real checkout/refund, cold-start benchmark, multi-region/soak test or production-equivalent database load test has been done.
- SQL locks and rollback were exercised against a local embedded SQL engine; distributed locking/connection pooling still requires the provided two-pool test and preview load on the chosen PostgreSQL service.
- An opaque-origin HTTP sandbox is the implemented content isolation boundary. A dedicated separate origin for user sites would add defense in depth. Do not add `allow-same-origin` to the sandbox.
- Phone hiding is a fallback for generated pages and common representations, not a comprehensive detector of arbitrary personal information embedded in uploaded HTML or photographs. Retain the structured builder's first-name-only and private-contact design; perform the pending privacy/legal review separately.
- The deployable v4 source is `hustlebuilder-repo-main/index.html` with `api/`, `host/`, dependencies, the existing PWA files and `vercel.json`. Artwork records outside the source folder are preserved. Use this v4 package instead of the earlier v3 repair package.

<!-- Preview rebuilt Nov 1, 2026 ~9:45 PM CT so the deployment picks up the Neon DATABASE_URL (preview branch) for the Phase 2 rehearsal. -->

<!-- Preview rebuilt Nov 1, 2026 ~9:50 PM CT: preview PUBLISH_TEST_MODE set to 1 so the rehearsal uses on-screen test codes. -->

<!-- rebuild Nov 1 late: pick up HB_MAINTENANCE_MODE + MIGRATE_TOKEN_SHA env for the cutover endpoint test -->

## Cutover complete (Nov 1, 2026, ~11:20 PM CT)
PR #49 merged to main; the Blob -> PostgreSQL migration ran inside the production deployment via a temporary token-gated endpoint (api/migrate-once.js, removed by the cleanup PR right after). One snag, fixed by PR #50: the 6 leftover handoff-art/* binaries in Blob are not valid UTF-8 text and PostgreSQL rejected them; nothing in the app references that prefix, so the migration skipped exactly those files (byte-exact copies saved to the cutover backup folder first; originals remain in Blob). Final apply: 49 objects -> 48 rows, 1 account (Maryn's family), hash-verified inside the transaction. HB_MAINTENANCE_MODE was set to 1 for the window and set back to 0 after; the MIGRATE_TOKEN_SHA env value was emptied. All sessions/calendar links were invalidated by the migration as designed — families sign in again. Blob data is frozen and untouched as the backup of record (plus a local export in the cutover folder).
