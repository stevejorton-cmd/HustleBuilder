# Pilot rehearsal evidence

November 22, 2026. This is an automated/source rehearsal and a summary of earlier live test evidence. **No new independent family pilot was conducted, and no invitations were sent.** The companion [family checklist](pilot-family-checklist.md) is ready for Steve to send to 2–3 families.

## Focused verification runs

Ran from the local HustleBuilder checkout at commit `46c373330e734a78a29c4fddf2fc2481397e6e1f`:

```sh
node --test tests/readiness.test.mjs tests/kid-flow.test.mjs tests/parent-verification-copy.test.mjs tests/clarity-pricing.test.mjs tests/flow-audit.test.mjs tests/draft-recovery.test.mjs tests/booking-management-ui.test.mjs tests/print-shop.test.mjs
```

**58 tests passed; 0 failed, skipped, or cancelled.** This initial run covered existing behavior in eight test files before the new recurring-visit and explicit kid-code entry changes. It is baseline evidence, not a fresh full-release sign-off for the later changes.

After implementing the recurring-visit controls, ran:

```sh
node --test tests/recurring-ui.test.mjs
```

**9 additional UI tests passed; 0 failed, skipped, or cancelled.** These check parent-only approval, the bounded/default count, exact first-time/count snapshot, edits disabled while reviewing/saving, away-date explanation without a weekly count, series labels for kids, cancellation from terminal cards, stale-view rejection, and escaped metadata. They use an isolated JavaScript harness; they do not exercise the new server series operations or actual notification delivery. Final full-suite/release totals belong to the integrated release check.

| Area | What the focused tests establish | What remains a real-device check |
|---|---|---|
| Publishing and trial | Parent consent before publish; offered-service requirement; private request data omitted from public site; synthetic trial expiry pauses public bookings/exports; saved work can resume after simulated checkout. Expiry itself does not cancel or email customers. | Parent completing real email verification and trial/card flow; bank refund display; behavior at an actual trial boundary. |
| Verification explanation | Visible copy describes a real $0.50 charge and full Stripe refund; accessible “Why do we ask?” explanation; parent invitations agree with the notice. | Whether a parent understands the explanation without help. No real Stripe charge/refund was made in this run. |
| Parent/kid and family navigation | Baseline tests cover kid cancellation request, parent keeps/cancels, exact proposed time approval, and sibling filters that include empty businesses, preserve selection, distinguish equal names, and reset across families. New explicit family-code entry is developed separately from that baseline run. | Independent parent/kid comprehension; new family-code handoff; tapping controls on actual phones; full sibling workflow with an invited family. |
| Draft and shared-device handling | Anonymous/owned draft recovery, archive failure handling, late response/account-switch protections; successful sign-out clears private views, action tokens, and private calendar links. | A native shared-phone walkthrough, including browser Back/refresh and whether a parent remembers to sign out. A logged-in parent session still grants parent controls to whoever holds that device. |
| Booking and privacy | Isolated end-to-end signup/publish/request/confirm/cancel/done flow; duplicate-send protection; parent cancellation email/attachment sanitization; phone-only cancellation gives a direct-contact next step. | New-release delivery and calendar rendering in real parent/customer inboxes; network delays and real customer understanding. Test mail was simulated. |
| Service/pricing clarity | Helper/reading request fields; one hosted send action; snow-only snowfall option; reversible bounded starter-price changes that preserve manual prices. | Real families understanding their chosen services, pricing, and availability. |
| Flyer/shop handoff | Current design goes through PDF export; trial/readiness/print-format gates remain; explicit save action; optional location encoded only into the clicked map link; truthful save/error messages. | Actual font/layout print quality, paper QR scanning, mobile downloads/share sheet, and shop website upload. Test PDF/render/save dependencies were mocked. |

No local headless browser was launched. DOM-oriented tests use isolated JavaScript harnesses; they do not prove visual layout or native phone behavior.

## Earlier public-live evidence

The earlier November 22 live booking audit recorded **10 accepted practice customer requests, 38 delivered messages, and five parsed family subscription feeds**. All jobs were marked test-only; no actual work or customer payment was arranged. Four cancelled requests were absent from those feeds and the other sibling's events remained. This rehearsal did not repeat those live operations.

That report's original calendar snapshot contained six remaining events but still marked Google client import pending at its capture time. Later in the implementation session, those six events were observed in Google Calendar with the expected dates, times, and statuses. This was a separate observation, not a rerun of the focused tests above.

The same session subsequently tested Quinn's live practice reschedule from **November 28, 11:00 AM to November 29, noon**, America/Chicago. The parent approved it, and four actual request/approval emails were verified. At the first Google check after that change, the subscribed calendar still displayed the old time. The source/app change and delivered messages do not establish that Google's updated display has arrived: **Google refresh of this reschedule remains unobserved here**.

Six other planned practice submissions were blocked or deferred after the site's daily request allowance was reached. Their completion is not claimed here. A continuation is scheduled for November 22 around **7 PM America/Chicago** after the normal allowance reset. Repeated attempts can consume the allowance on a shared network; if the app reports a limit, record it and stop rather than repeat or bypass it.

## Current boundaries to explain during the pilot

- Parent owns the account and makes the publishing/booking decisions. A kid's cancellation request emails the parent and leaves the job active until a parent cancels. There is no automatic SMS notification.
- The new shared-device handoff is **My jobs → Copy family jobs code**, parent **Sign out on this device**, then **My jobs → Use a family jobs code → Family jobs code → View family requests**. The eight-character code grants limited family request access and cancellation requests, not parent approval or access to the parent's saved builder. It can show siblings; keep it private. This code flow still needs the native-phone pilot check.
- Family calendar subscriptions are one-way. Removing a calendar copy does not cancel a booking. Use the app's management links; calendar refresh can be delayed by the calendar provider.
- The earlier live audit's repeat-work preferences and away ranges represented one selected appointment. New code adds explicit parent approval: weekly/every-other-week totals of 2–8 visits, including the original (default four), or daily away visits over 2–14 inclusive dates. Visits retain local clock time across daylight-saving changes. Individual cancellation affects one appointment; **Cancel remaining visits** affects future, uncompleted visits in that series. The nine UI tests above are evidence for the controls, not a claim that the new series workflow has already passed live email/Google/Apple checks.
- The 14-day trial begins at first publication and covers the family's pages. Paid plans are optional and never auto-renew. Eligible pilot access must be provided privately; no access code or private calendar/action token belongs in the public checklist.
- Shop links require a manual PDF upload. This run did not transfer a PDF, order prints, or make a payment.

## Remaining acceptance evidence

| Check | Status for this rehearsal | Evidence to collect |
|---|---|---|
| Two or three independently invited families complete the checklist | Not conducted | Each family's completed checklist and friction notes; at least one multi-kid family. |
| Native iPhone/Android build, sign-out, download, and QR scan | Not observed | Device/browser versions, screenshots with private details hidden, screen-versus-paper QR result. |
| New confirmation/time-change/cancellation invitations in Google and Apple | Quinn's live time-change emails verified; Google still showed old time at first post-change check; native Apple unverified | Before/after appointment time, status, update delay, duplicate handling, and which client was used. |
| Trial's actual refunded card charge | Not performed here | Parent's informed participation; Stripe receipt and bank outcome, without collecting card details. |
| Print-quality check | Not performed here | One actual-size test print and successful phone scan; no paid order required. |
| New recurring-job support | Nine focused UI tests passed; integrated release/live checks separate | Deployed parent/customer/email/calendar checks, including individual versus remaining-visit cancellation and local times across DST. |

A launch decision should use these boundaries alongside the release's full automated/CI checks. Passing the focused tests is evidence for their covered code paths, not a substitute for the unobserved family and native-calendar steps.
