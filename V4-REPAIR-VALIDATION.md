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
