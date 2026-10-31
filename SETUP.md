# One-time setup for family hosting

Steve does this once. After it works, a parent publishes from the app. There is no per-site step and no Netlify drop.

The builder stays the same `index.html`. This repo also deploys that file, plus a small host, as one Vercel project. GitHub Pages can keep serving the builder. Publish from GitHub Pages only works after you set `window.HB_PUBLISH_ORIGIN` in `index.html` to the Vercel domain. On the Vercel domain itself, leave that string empty. The app then uses the same origin, which is the path to use with families.

Prices below were read from the vendors’ own pages on October 31, 2026. They do not include tax.

## 1. Vercel project

1. Sign in at [vercel.com](https://vercel.com) with the GitHub account that owns this repo.
2. Import this GitHub repo as a new project. Framework preset: Other. Root directory: the repo root. Do not set a build command. Output is the repo itself.
3. Use the **Pro** plan, not Hobby. Vercel describes Hobby as personal, non-commercial use, and this product takes payment from families. Pro is **$20 per month**, which includes one deploying seat and **$20 of usage credit**. Extra deploying seats are $20 each. Viewer seats are free. Sources: [Vercel pricing](https://vercel.com/pricing), [Pro plan](https://vercel.com/docs/plans/pro-plan).
4. Pro teams also include one free first-year domain on an eligible TLD. After year one it renews at the normal rate. Source: [Pro plan](https://vercel.com/docs/plans/pro-plan).

## 2. Blob store

1. In the Vercel project, open Storage and create a **Blob** store. Connect it to this project. Vercel adds `BLOB_READ_WRITE_TOKEN` for you.
2. Pages are private blobs. The site is served by the app, so taking a page down stops the link. Blob’s shortest cache is 60 seconds, so an update can take up to a minute to replace the previous copy.
3. Pricing, from [Blob usage and pricing](https://vercel.com/docs/vercel-blob/usage-and-pricing) and [regional pricing](https://vercel.com/docs/pricing/regional-pricing):
   - Storage: about **$0.023 to $0.041 per GB-month**. The [pricing table](https://vercel.com/pricing) lists Pro blob storage at **$0.023 per GB**.
   - Simple operations (reads): about **$0.35 to $0.56 per million**. The pricing table lists **$0.40 per million**.
   - Advanced operations (writes and lists): about **$4.50 to $7 per million**. The pricing table lists **$5 per million**.
   - Data transfer on Pro is included in the flat-rate CDN. Hobby includes 1 GB storage, 10,000 simple operations, 2,000 advanced operations, and 10 GB transfer, then stops. Do not use Hobby for a paid product.
4. A few dozen kid pages are tens of megabytes. That is cents, and it fits inside the Pro credit.

## 3. Environment variables

Set these on the Vercel project for Production (and Preview if you want to try a branch):

| Name | Value |
| --- | --- |
| `PUBLIC_ORIGIN` | `https://your-domain` with no slash at the end. This is the link families see. |
| `ADMIN_SECRET` | A long random string. Only you use it, to take a page down. |
| `PUBLISH_TEST_MODE` | `1` while you are trying it. The verify code is shown on screen and booking emails are saved for the test inbox. Set to `0` before any real family uses it. Leaving `1` on skips real email and shows the code to whoever is at the keyboard. |
| `PAYWALL_MODE` | `test` until Stripe is ready. `stripe` when you want a real card charge. `off` marks every plan paid and does not charge. |
| `RESEND_API_KEY` | From Resend. Required when `PUBLISH_TEST_MODE` is `0`. |
| `BOOKING_FROM` | A sender on a domain you verified in Resend, such as `Hustle Builder <bookings@your-domain>`. |
| `REPLY_TO` | A mailbox a person reads, such as `steve@your-domain`. Code emails reply here. Booking emails reply to the customer when they leave an email. If this is empty, those code emails say replies are not read. Do not point it at `bookings@`, which has no mailbox. |
| `ALLOWED_ORIGINS` | Optional. Comma-separated origins that may call the API, such as `https://stevejorton-cmd.github.io`. Localhost and `*.github.io` are already allowed. |
| `STRIPE_SECRET_KEY` | Only when `PAYWALL_MODE=stripe`. Use the test key `sk_test_...` first. |
| `STRIPE_WEBHOOK_SECRET` | Only when `PAYWALL_MODE=stripe`. From the webhook endpoint below. |
| `BLOB_READ_WRITE_TOKEN` | Added when you connect the Blob store. |

Redeploy after changing variables.

## 4. Domain

1. Add the domain in the Vercel project: Settings, Domains.
2. At the registrar, point DNS the way Vercel shows (usually an A record or CNAME).
3. Set `PUBLIC_ORIGIN` to that `https://` domain and redeploy.
4. If families still open the GitHub Pages link, set this in `index.html` and push:

```html
<script>window.HB_PUBLISH_ORIGIN="https://your-domain";</script>
```

Leave it as an empty string on the copy Vercel serves.

A kid’s page is `https://your-domain/sam-yard`. The builder is `https://your-domain/`.

## 5. Resend

1. Create an account at [resend.com](https://resend.com).
2. Add the domain you send from and turn on the DNS records Resend shows (SPF and DKIM).
3. Create an API key and set `RESEND_API_KEY` and `BOOKING_FROM`.
4. Pricing, from [Resend pricing](https://resend.com/pricing) (October 31, 2026):
   - Free: **$0**, **3,000 emails a month**, **100 a day**, 3 domains.
   - Pro: **$20 a month** for 50,000 emails, then **$0.90 per extra 1,000**. No daily cap.
5. Verification emails and booking emails both count. A handful of families stay on the free plan. If you pass 100 emails in a day, move to Pro.

With `PUBLISH_TEST_MODE=0`, a booking is emailed to the parent from `BOOKING_FROM`. The email has the job attached as an `.ics` file, an Add to Google Calendar link, and Call / Text links for the customer at the top. If the customer left an email, Resend `reply_to` is that address. If they left only a phone number, the email says replies are not read. The same job is stored for the family calendar (service, customer name, address, date and time, note) and deleted about 30 days after the job. With test mode on, the last emails, including that HTML and `.ics` text, are kept only so you can check them at `/api/test/outbox?email=parent@example.com`. Set `PUBLISH_TEST_MODE=0` before a real family uses it.

Empty and bot bookings do not count toward the 30-a-day page cap. The form has a hidden field and a short wait, and one internet address can send only a limited number per day.

After Stripe Checkout, the parent returns to Go live. The app waits until the payment is recorded, then publishes. A second tap does not open another checkout while that payment is still processing, or after the account is paid. Card statements use the suffix `HUSTLE BLDR`.

A parent’s phone is not on the kid page unless they turn on “Show my parent’s phone.” Search engines are asked not to list the page unless they turn on “Let Google show this page.” The texted link includes a title, description, and a preview image at `/api/card/<link-name>.png`.

## 6. Payment

Plans shown in the app:

- $19.99 for the current season. Summer is May–August. Winter is November–March. The app names the season and the end date.
- $29.99 for 365 days from the day a parent pays.

There is no monthly plan.

A family can also go live with no payment. The parent still verifies their email and checks the consent box. The page stays up for **14 days** from the first publish, or until **3** real booking requests are delivered, whichever comes first. `TRIAL_DAYS` changes the 14. It defaults to 14 and can be set in the environment. The parent sees “14 days / 3 free jobs left,” and that count goes down. The third free request emails that the jobs are used up. The daily cron also emails 3 days before the trial time ends and on the day it ends, each with a pay link, and it does not send the same note twice. When the trial ends, the public link, including a flyer QR code, shows a taking-a-break page. The saved page and the kid’s draft stay put. New booking requests are saved and held. Paying brings the page back right away and sends the held requests. One trial belongs to the parent’s email. A new link under the same email does not start it over, and deleting the account does not reset it. Flyers are still free to make.

`PAYWALL_MODE=test` marks the plan paid and does not call Stripe. Use that to click through the app. Renewal emails, the trial-used email, and the held-request email stay in the test outbox. They are not sent.

When you are ready to charge:

1. Create a Stripe account.
2. Put the secret key in `STRIPE_SECRET_KEY`. Start with the test key.
3. Add a webhook endpoint `https://your-domain/api/stripe/webhook` for `checkout.session.completed`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Set `PAYWALL_MODE=stripe` and redeploy.
5. Checkout does not use a Stripe Price ID. Each session sends `line_items[0][price_data]` with `currency` `usd` and `unit_amount` **1999** for a season or **2999** for a year. You do not create a price in the Stripe dashboard.
6. A parent who already paid keeps the end date stored on their account. These amounts apply the next time they check out.
7. Stripe’s listed US price for a successful domestic card charge is **2.9% + 30¢**, with no monthly fee. Source: [Stripe pricing](https://stripe.com/pricing). A $19.99 season charge is about **$0.88** in fees. International cards and currency conversion cost more. See that page.
8. Checkout sets `payment_intent_data[statement_descriptor_suffix]` to `HUSTLE BLDR`. With the account’s statement prefix `KEYSTONE`, the card line reads `KEYSTONE* HUSTLE BLDR` (21 characters, under Stripe’s 22-character limit).

The parent is marked paid only after Stripe signs the webhook. A test-mode plan does not do that.

## Ask a parent, drafts, and booking notes

- **Ask my parent.** On Go live, the kid enters the parent’s email and taps Ask my parent. The server emails a link that expires in 7 days and says the first 3 jobs are free. It also says a season is $19.99 and a year is $29.99 after that. Opening it on the parent’s phone signs that email in, loads the kid’s page, and the parent still checks the consent box. They can publish with the free trial or pay. Sends are limited to 5 per email per day and 8 per IP per day.
- **My jobs.** The kid’s builder lists incoming requests: service, day and time, neighbor first name, and status (new, confirmed, done, cancelled, or waiting). The list is loaded with the kid’s draft code or the parent’s sign-in. It never includes the neighbor’s email, phone, or house number. A parent can turn on the street name. The parent marks confirmed or done from the link in the booking email. A badge counts new requests.
- **Renewals.** A daily cron calls `GET /api/cron/renewals` with `Authorization: Bearer` set to `CRON_SECRET` or `ADMIN_SECRET`. It emails the parent 14 days before a paid plan ends, 3 days before, and on the end day, each with a one-tap renew link. The same job also emails 3 days before a free trial’s time ends and on the day it ends. The same reminder is not sent twice. `?dry=1` lists what would send and does not email. For 7 days after a paid plan’s end date the page stays up. The builder shows the parent a banner. Neighbors do not see it. After those 7 days the link shows a taking-a-break page and new bookings are paused. A free trial does not get that extra week: the taking-a-break page starts as soon as the 14 days or the 3 jobs are used.
- **Drafts.** The page also saves on the server under an 8-character code, so another phone can open `/?draft=CODE`. The phone still keeps a local copy. GitHub Pages with no host skips the server save. A signed-in parent’s account keeps the latest code. Drafts older than 90 days are dropped.
- **More work.** Besides lawn and snow, a kid can pick pet care, odd jobs, car washing, a parent’s helper, reading buddy, or something else. Pet care has its own prices, booking questions, and flyers. The dog, cat, fish, bird, and small-animal pictures are original drawings in this app, not stock art. The kid chooses which of those pets appear on the page, the flyer, and the link preview. Helper and reading copy says a parent stays home or nearby. A gate or key note from a pet booking goes only to the parent’s email and the private family calendar.
- **Neighbor note.** If a booking leaves an email, that person gets “We got your request,” what they asked for, and a cancel link. The cancel page needs a tap so mail scanners do not cancel it by opening the link. Cancelling emails the parent. The neighbor note does not include the parent’s email or phone. Reply-to is `REPLY_TO` when that is set. Otherwise the note says replies are not read.

## Family calendar

After a parent verifies their email, the publish step shows **Family calendar**. They add it once:

- **Add to Google Calendar** opens Google’s subscribe page for a private `webcal://` link.
- **Add to iPhone / Mac** uses that same `webcal://` link.
- **Copy link** is the `https://` `.ics` address for Outlook or Skylight.

Skylight does not get its own link. Add the feed to the Google or Apple calendar that Skylight already shows. Google can take a few hours to show a new job. iPhone refreshes faster.

The link looks like `https://your-domain/api/cal/<token>.ics`. The token is at least 32 characters, is not the parent’s login token, and lives only on the private account record. **Make a new link** stops the old one. Times are America/Chicago, one hour long, with a stable id so updates replace the same event.

Neighbor bookings are added when the email goes out. Jobs the kid schedules in Boss mode are added too, when a parent is signed in on that device and **Sync jobs I schedule here to the family calendar** is on (that is the default). Removing or finishing a job removes it from the feed. Jobs older than about 30 days are dropped. Deleting the account deletes the jobs and the link. Taking a page down does not.

## 7. Take a page down

```bash
curl -X POST https://your-domain/api/admin/takedown \
  -H "content-type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{"slug":"sam-yard"}'
```

The link then says the page was taken down. The parent cannot publish it back. They can still delete the account from the app. There is no teacher or class screen.

## 8. Try it locally

```bash
npm install
npm test
PUBLISH_TEST_MODE=1 PAYWALL_MODE=test ADMIN_SECRET=dev-admin-secret npm run dev
```

Open `http://127.0.0.1:8787`. The code appears on the page because test mode is on. No Blob token and no Resend key are required.

## What a month costs at a small start

| Piece | About | Why |
| --- | --- | --- |
| Vercel Pro | $20 | Required if you charge families. Includes $20 of usage credit. |
| Blob | under $1 | Dozens of pages are a fraction of a gigabyte. Covered by the credit. |
| Resend | $0 | Free until 3,000 emails a month and 100 a day. |
| Stripe | $0 until a parent pays | Then 2.9% + 30¢ per charge. |
| Domain | $0 the first year on Pro if you use the included domain, then the registrar’s price | Optional if you already have one. |

About **$20 a month** until booking email outgrows the Resend free plan. Then about **$40 a month** if you add Resend Pro at $20. These are vendor list prices, not a quote.

## COPPA, in plain language

This is not legal advice. Have a lawyer read it before a real 11- or 12-year-old uses hosting.

The host stores a parent’s email, the time they verified it, the time they agreed, the plan, the link name, and the public page they approved. It also stores booked jobs for the family calendar: the service, the customer name as typed, the address, the date and time, and a short note. Those jobs are deleted about 30 days after the job, and immediately if the parent deletes the account. It does not store a child’s account or a last name. The phone number on a booking is in the email to the parent, with a call or text link. It is not on the public page unless the parent turns that on. The page asks search engines not to list it unless the parent turns that on. The rest of the Boss mode money log stays on the device unless the parent is signed in and calendar sync is on.

The in-app step is: the parent proves they can read that email, then checks a box that they agree to publish. That is not the full “verifiable parental consent” the FTC describes for a site that makes a child’s information public. Email-only consent is limited, and a public page with a child’s first name is a disclosure. A charge to the parent’s card, with clear notice, is one method the FTC lists. Test mode does not do that. Turning on Stripe does not, by itself, make this compliant.

Before real families:

- Set `PUBLISH_TEST_MODE=0`.
- Decide with a lawyer whether the parent card charge plus the consent text is enough, or whether you need a signed form or a phone call as well.
- Read the privacy page at `/privacy` and replace it if the lawyer wants different words.
- Do not collect more than the parent email, the public page, and the calendar jobs described above.
