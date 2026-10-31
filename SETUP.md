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

With `PUBLISH_TEST_MODE=0`, a booking is emailed to the parent and is not stored. With test mode on, the last emails are kept only so you can check them at `/api/test/outbox?email=parent@example.com`.

## 6. Payment

Plans shown in the app:

- $6 a month
- $39 for the season (about six months)
- $59 for the year

`PAYWALL_MODE=test` marks the plan paid and does not call Stripe. Use that to click through the app.

When you are ready to charge:

1. Create a Stripe account.
2. Put the secret key in `STRIPE_SECRET_KEY`. Start with the test key.
3. Add a webhook endpoint `https://your-domain/api/stripe/webhook` for `checkout.session.completed`. Put the signing secret in `STRIPE_WEBHOOK_SECRET`.
4. Set `PAYWALL_MODE=stripe` and redeploy.
5. Stripe’s listed US price for a successful domestic card charge is **2.9% + 30¢**, with no monthly fee. Source: [Stripe pricing](https://stripe.com/pricing). A $39 season charge is about **$1.43** in fees. International cards and currency conversion cost more. See that page.

The parent is marked paid only after Stripe signs the webhook. A test-mode plan does not do that.

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

The host stores a parent’s email, the time they verified it, the time they agreed, the plan, the link name, and the public page they approved. It does not store a child’s account, a last name, or the Boss mode job log. A booking is emailed to the parent and, with test mode off, is not kept.

The in-app step is: the parent proves they can read that email, then checks a box that they agree to publish. That is not the full “verifiable parental consent” the FTC describes for a site that makes a child’s information public. Email-only consent is limited, and a public page with a child’s first name is a disclosure. A charge to the parent’s card, with clear notice, is one method the FTC lists. Test mode does not do that. Turning on Stripe does not, by itself, make this compliant.

Before real families:

- Set `PUBLISH_TEST_MODE=0`.
- Decide with a lawyer whether the parent card charge plus the consent text is enough, or whether you need a signed form or a phone call as well.
- Read the privacy page at `/privacy` and replace it if the lawyer wants different words.
- Do not collect more than the parent email and the public page.
