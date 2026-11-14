> **DRAFT for Steve to approve. Not published. Not legal advice.** This describes safeguards already in the code as of November 14, 2026. It does not create a new public commitment. A lawyer should review it before it is adopted as the written information security program under 16 CFR 312.8.

# Information security program (draft)

Coordinator to name: the operator of Hustle Builder (Steve). The program is reviewed at least once a year, or after a change that affects children's information.

## What we protect

Information from a child that can reach the server after a parent agrees: first name, town, business description, services, prices, photos and reviews the parent publishes, and the Venmo username the parent chooses to show. Before agreement, the child's draft stays in the browser.

Also stored for the parent: email address, consent record, plan status, and booking requests from neighbors (name, contact, street, time, note).

## Safeguards already in the code

- The parent session is an HttpOnly cookie. The admin cookie is HttpOnly and SameSite=Strict.
- Publishing, drafts, and account deletion require a verified parent session. Publish also requires the refunded 50¢ card check or a paid plan.
- Public pages are stripped of parent email and phone, including HTML entities and JavaScript escapes. Kid pages are not listed to search engines unless the parent turns that on.
- Public calendar files omit gate codes and key notes, and are deleted when a booking is cancelled.
- Booking and account routes are unlisted and use long random tokens. There is no directory of families.
- Stripe handles card numbers. The app stores a payment id and, to stop a second free trial, a card fingerprint. It does not store the card number, expiration, or security code.
- Database access uses the host's Postgres connection. Secrets stay in the host's environment, not in the repository.
- The home page and published pages send a content security policy. Published pages cannot load outside scripts.
- Webhooks from Stripe are checked with a signature. Paid plans are recorded once per checkout id.

## Risks to review each year

- A stolen parent session cookie.
- A leaked calendar or booking token.
- A service provider (hosting, database, email, or payments) incident.
- A parent publishing more about a child than a first name and a town, such as a photo or a school.

## Service providers

Vercel hosts the site, Neon stores the database, Resend sends email, and Stripe takes payments. Before relying on a new provider for children's information, the operator should confirm the provider's security terms in writing.
