# Hustle Builder

Build and publish a neighborhood-service page for kids (lawn care, snow shoveling, pet care, and more), with parent-owned accounts, parental consent, booking notifications, printable flyers with QR codes, and a family job calendar.

**Live site:** [https://hustlebuilder.org](https://hustlebuilder.org)

---

## Features

- **Kid-friendly page builder (`index.html`):** Step-by-step builder for services, rates, availability, before/after photos (with optional HEIC conversion), and Poster Studio flyers.
- **Parent-owned publishing & consent:** Parents verify email, own the account, manage custom page links, and receive every booking alert.
- **Booking & calendar workflow:** Neighbors book directly from the published page; parents receive email alerts with `.ics` calendar attachments, Google Calendar links, and call/text quick actions.
- **Serverless API & storage (`api/`, `host/`):** Vercel serverless handler backed by PostgreSQL (Neon/Postgres), Stripe checkout/webhooks, and Resend transactional email.
- **Offline/PWA support:** Includes `manifest.webmanifest`, service worker (`sw.js`), and installable home-screen icons.

---

## Project Structure

```text
.
├── index.html              # Single-file frontend builder & customer site shell
├── api/handler.js          # Vercel serverless API entrypoint
├── host/
│   ├── dev-server.mjs      # Local development server
│   ├── demo/               # Demo fixtures
│   └── lib/                # Storage, email, Stripe, booking, and auth helpers
├── config/                 # Runtime & feature configuration
├── scripts/                # Preflight checks, DB migration, encrypted backups
├── tests/                  # Unit, security, migration, and browser E2E suites
├── stress/                 # Adversarial & HTTP load audit suites
├── assets/ & icons/        # Static illustrations, HEIC helper, and PWA icons
├── .env.example            # Required & optional environment variable template
└── SETUP.md                # Production deployment, Stripe, Resend, and DNS guide
```

---

## Local Development

### Requirements

- [Node.js](https://nodejs.org/) 20 or newer

### Setup & Run

```bash
npm ci
cp .env.example .env.local
npm run dev
```

For local testing without live email or card charges, keep `PUBLISH_TEST_MODE=1` and `PAYWALL_MODE=test` in `.env.local`. Never commit `.env.local` or real secrets.

See [`.env.example`](.env.example) for all environment variables and [`SETUP.md`](SETUP.md) for full production setup instructions (Vercel, PostgreSQL, Stripe, Resend, and domain configuration).

---

## Automated Tests & Checks

| Command | What it runs |
| --- | --- |
| `npm test` | Unit, security, recovery, and migration tests (`node --test tests/*.test.mjs`) |
| `npm run test:stress` | Strict adversarial security & workflow audit (`stress/audit.mjs --strict`) |
| `npm run test:browser` | End-to-end headless browser checks (set `CHROME=/usr/bin/google-chrome` if needed) |
| `npm run test:all` | Runs unit, stress, and browser suites sequentially |
| `npm run test:http` | HTTP load test (`stress/http-load.mjs`) |
| `npm run test:postgres` | Live Postgres integration suite (requires isolated `HB_TEST_DATABASE_URL`) |
| `npm run preflight` | Validates required production environment variables |

CI runs `npm test`, `npm run test:stress`, and `npm run test:browser` automatically on every push and pull request via [`.github/workflows/test.yml`](.github/workflows/test.yml).

---

## Deployment & Operations

- **Hosting:** Deployed via Vercel Git integration from `main` (see [`vercel.json`](vercel.json) and [`SETUP.md`](SETUP.md)).
- **Database migrations:** `npm run db:migrate`
- **Encrypted backups:** `npm run backup`, `npm run backup:verify`, `npm run backup:restore` (uses `HB_BACKUP_KEY`).
- **Security note:** This repository is public. Never commit `.env` files, API keys, webhook secrets, or real family/customer data.
