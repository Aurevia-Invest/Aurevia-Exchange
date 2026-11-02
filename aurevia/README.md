# Aurevia Exchange

Aurevia Exchange is a Next.js application using TypeScript, PostgreSQL, Prisma, NextAuth, Socket.IO, Zustand, Tailwind CSS, Recharts and Lightweight Charts. Trading and market prices used by the trading engine remain internal simulations; the `/markets` dashboard separately displays live-provider quotes and history. This repository does not connect to a live broker, exchange, bank, or payment network.

## What is implemented

### User application
- Landing page, registration and credential login
- JWT sessions with USER/ADMIN role enforcement
- KYC profile submission, private identity-document uploads, and administrator review states
- Profile and account settings
- 2FA security flag
- Live dashboard with cash equity and open positions
- Realtime market ticker
- Trading terminal with Market, Limit and Stop orders
- Simulated order book and realtime candles/price chart
- Open-order cancellation
- One-click position close
- Unrealized P&L display
- Wallet balance from the ledger
- Deposit and withdrawal requests
- Funding history
- Public Stories feed and fullscreen image/video viewer, available without signing in

### Administration
- Role-protected admin area
- User list and freeze/unfreeze
- Role-separated administrator and customer accounts; administrators cannot access customer account routes
- KYC profile and private document approval/rejection
- Per-user deposit and withdrawal enablement controls
- Deposit/withdrawal approval queue
- Deposit approval posts the exact approved amount to the user's ledger atomically
- Force-close open positions
- Instrument enable/disable and configuration API
- System settings
- Stories management with categories, private media uploads, previews, drafts, scheduling, visibility, archive/delete controls, engagement analytics, and per-story audit history
- Deleted Items recycle bin for waitlist entries, client stories, and broadcasts, with search, filtering, audited restore, and audited permanent deletion
- Audit log
- Realtime operational statistics

Financial, identity-review, and audit records are intentionally not recyclable: account-erasure requests follow the privacy-preserving closure workflow, and immutable financial/audit history remains subject to its retention rules.

### Public Stories

The public `/stories` feed and homepage/dashboard story strips read only published, non-expired content; scheduled stories become visible when their publication time arrives. Administrators manage stories at `/admin/stories`. Default categories are installed by the additive Stories migration, and additional categories are administrator-created. Public and member-only visibility is enforced in the server-side listing and media routes. Story images and videos are stored in the private Supabase `stories` bucket and served through short-lived signed URLs only after the story's visibility and publication state are checked. Configure the existing server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`; never expose the service-role key to the browser. The migration creates the private bucket if absent and refuses to proceed if an existing bucket is public or too small; it does not change any other Storage bucket.

Anonymous views use a random, HTTP-only visitor cookie whose value is hashed before storage; view and external-link counts are deduplicated per story, action, and UTC day. No visitor IP address is stored for Stories analytics.

### Financial engine
- PostgreSQL persistence
- Prisma transactions
- Double-entry ledger
- Ledger balance derived from entries
- Serializable transactions for financial mutations
- Atomic funding approval
- Atomic trade reservation
- Margin release and realized P&L settlement
- Trading fees
- Insufficient-funds protection
- No direct mutable customer cash balance

### Market engine
- Internal simulated instruments
- Random-walk price engine
- One-minute candles
- Automatic Limit/Stop order processing
- Socket.io market:update events
- Socket.io trade:update events
- REST market, candle and order-book endpoints

### Live market dashboard

The `/markets` page uses server-only Finnhub or Alpaca data when configured and current. When external data is unavailable, the informational market view can fall back to clearly labeled Aurevia Internal reference prices and generated reference history; it does not present those values as live provider data. Signed-in users can ask the centralized AI service to explain a quote or history source status; only the verified symbol, timeframe, source class, and provider label are sent, never prices, account records, credentials, or raw provider errors. This explanation does not create or estimate market data. Selected quotes refresh every five seconds and watchlists every 30 seconds. This informational view is separate from paper-order execution.

REAL trade quotes and portfolio marks are provider-only: the internal fallback is not eligible for REAL order submission or REAL valuation. The trade screen displays the available best bid/ask as market quotes, not as Level 2 market depth; feeds without bid/ask data report those fields as unavailable. The quote timestamp and provider are shown, stale quotes cannot be used to submit orders, and provider-confirmed execution remains authoritative.

### AI assistance scope and controls

The centralized server-side AI gateway uses OpenRouter by default, checks that the selected model is free, and can use only explicitly allowlisted free backups. Nova provides multilingual platform help and deterministic, account-mode-scoped lookups; the account-tier page offers AI explanations of the authenticated user's locally determined onboarding checklist; the learning center has a general education assistant; the portfolio page can explain asset-class concentration from user-scoped open-position aggregates and offer a trading-journal reflection from aggregated closed-position outcomes; the markets page can explain the selected watchlist using fresh Finnhub or Alpaca provider quotes only; the news page can analyze framing in the configured recent publisher-sourced articles; administrator tools provide constrained dashboard configuration, draft assistance, normalized-signal ticket-classification suggestions, integration troubleshooting, and summaries from supplied application records. Onboarding prompts contain only account mode, tier, and locally derived checklist steps; identity documents and personal profile values are not sent. REAL portfolio analysis and market analysis use only fresh external provider data; unavailable or simulated marks are excluded. Trade reflections do not send symbols or dollar outcomes to the AI provider. News sentiment is based only on locally stored active articles from enabled sources within the last seven days and is not a verified market signal. Generated analysis is not investment advice or a trading instruction. AI never changes a ledger, approves KYC or funding, changes permissions, or submits an order.

Administrators can enable or disable each registered AI service in `/admin/command-center`; changes are audited. Calls through the central service are limited to 60 requests per actor and service per process per minute, identical sanitized prompts are cached in memory for up to 30 seconds within the same actor/service scope, and request/token metadata is recorded without prompt text. These in-process limits and caches are not distributed across multiple Render instances. The gateway redacts common email, phone/account-number, payment-number, and credential patterns before sending user/assistant message content to a provider. Do not enter identity documents, secrets, or unnecessary personal information in AI prompts.

This expansion does not add voice processing, a document/OCR provider, external market-event feeds or event summaries, personalized trade recommendations, automated KYC decisions, free-form database querying, automatic ticket classification or replies, business-report scheduling, or autonomous operations. Ticket classification is a suggestion based only on locally derived keyword signals and must be applied manually by an administrator. The unimplemented capabilities require additional product workflows, verified sources, and—in some cases—separately approved external APIs. Existing Supabase, Prisma, Alpaca, Demo/Real separation, and financial authorization paths remain unchanged.

## Important scope boundary

DEMO and REAL are mutually exclusive active modes backed by separate Aurevia ledgers, balances, orders, funding requests, investments, and P/L. DEMO orders use Aurevia's internal simulator. New REAL trade orders are submitted only to Alpaca Paper Trading when paper submission is configured and enabled; there is no live-broker endpoint. Aurevia's REAL wallet remains the user-specific ledger authority, while Alpaca is a shared paper account: provider cash/equity are not user wallet funds, and only each user's confirmed, linked executions are attributed to their paper positions. REAL paper order commitments reduce that user's available trading and withdrawal balance without posting wallet debits or credits. Paper gains are not withdrawable. The optional administrator-configured Bitcoin reference address on the deposit page is display-only: Aurevia cannot receive, custody, monitor, or verify Bitcoin. Do not send cryptocurrency based on this screen. BTC withdrawals use the user's saved, encrypted Bitcoin mainnet destination; optional TXID, sender, and date/time fields are user-submitted metadata, not evidence that a transfer occurred. An administrator must separately confirm actual external processing and record the outbound TXID before a withdrawal can complete or debit the ledger. REAL BTC deposits remain subject to separate administrator review and an explicitly entered USD credit amount. Administrators can also post audited, mode-specific paper credits directly, with a printable ledger receipt. Live brokerage, payment processing, BTC custody, and automatic external money movement are not enabled. Identity eligibility remains subject to administrator review and existing per-user funding controls.

Two-factor authentication is currently disabled. The legacy database flag is not treated as protection, the profile API reports it as unavailable, and attempts to enable it are rejected until enrollment, login challenges, recovery, and reauthentication are implemented.

Registration remains free, but new accounts must complete Akedly V2 email verification before credential sign-in. Registration verification is enabled independently of legacy environment flags, and missing Akedly configuration fails registration closed. The server signs email-only requests with the documented HMAC payload (email is deliberately excluded from that signature), creates the attempt through `POST https://api.akedly.io/api/v1/widget-sdk/create-attempt`, and embeds only the returned HTTPS `https://auth.akedly.io` widget URL. Signed results are verified against the raw request body with the Svix SDK. For an unsigned V2 verification-result webhook, Aurevia uses only its attempt ID to perform the server-authenticated `POST https://api.akedly.io/api/v1/transactions/status` lookup and applies only that provider result; unsigned event webhooks are rejected. Redirect parameters are hints and never verification evidence. The `/api/webhooks/akedly` endpoint must be configured as the pipeline's backend callback. No Supabase Auth identity creation is used; NextAuth and existing user records remain authoritative. An additive migration adds a separate email-verification timestamp and backfills only records already marked as email-verified; it does not reset or replace any database records. Akedly phone verification is used for REAL-mode KYC when all six Akedly settings are present; the existing Termii flow remains the fallback when Akedly is not configured. Verification changes are idempotent and audit logged, and OTPs, secrets, and contact values are excluded from those audit records. Live delivery and Render configuration still require controlled email/phone tests; repository tests do not prove provider credentials or delivery. Identity review remains a separate administrator-reviewed requirement for eligible REAL-account services. Admin approval requires a submitted profile and an approved identity document, does not bypass email verification or sign-in requirements, and is recorded in the audit log. Customer APIs reject administrator sessions, administrator APIs use a separate role guard, and authenticated administrators are redirected to the administration console. Verified personal profile fields become read-only for two calendar months after identity approval; profile photos remain independently changeable, and users can contact support for corrections to protected identity details.

## Requirements

- Node.js >=20.19 and <21, >=22.13 and <23, or 24+
- Docker Desktop or PostgreSQL 15+
- npm

## Isolated browser tests

Run `npm run test:e2e:isolated` with Docker available. The command starts a disposable PostgreSQL 16 container bound only to a dynamically selected loopback port, applies Prisma migrations only to that container, and removes it after the run. The container has no persistent volume; neither `DATABASE_URL` nor `DIRECT_URL` from `.env` is used for tests. `npm run test:e2e` requires explicit `AUREVIA_E2E_DATABASE_URL` and `AUREVIA_E2E_DIRECT_URL` values that point to the same local PostgreSQL database ending in `_e2e`; it refuses Supabase, Neon, and other remote hosts before fixture setup.

The isolated database bootstraps only the minimal Supabase Storage tables, private bucket metadata, and database roles required by the Storage-policy migration. The Playwright application process has Supabase URL/key configuration cleared, so file workflows fail closed and cannot access the shared Storage service. The isolated runner reserves distinct free loopback ports for the app and mock provider to avoid collisions with unrelated services. `npm run test:e2e` by itself continues to reject non-local or mismatched database URLs.

Playwright runs with two workers. Public-route and responsive-layout checks are in a separate spec so they can run alongside the shared-fixture application suite; the latter remains sequential to prevent races against its seeded accounts.

## Environment

Copy `.env.example` to `.env`.

`.env.example` lists variable names only. Configure the values in the ignored `.env` file or your deployment's secret manager. `DATABASE_URL` is the application connection (use the Supabase pooler URL when appropriate); Prisma uses `DIRECT_URL` for migrations and introspection. Both must point to the intended Supabase Postgres database. The application does not use a browser Supabase client; database access stays on the server through Prisma.

Only `NEXT_PUBLIC_APP_URL` and `NEXT_PUBLIC_SUPABASE_URL` are public configuration. All other values, especially database URLs, `NEXTAUTH_SECRET`, administrator credentials, SMTP credentials, verification API keys, Akedly credentials, and `SUPABASE_SERVICE_ROLE_KEY`, are server-only. Never put a Supabase service-role/secret key or Akedly credential in a `NEXT_PUBLIC_` variable. The Data API roles `anon` and `authenticated` have no table or sequence privileges on the application's `public` schema, and row-level security is enabled for its tables; the application uses its server-side Prisma connection.

`ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` are server-only administrator credentials. On the dedicated admin login form, the first sign-in using the exact configured username or email and password provisions the configured ADMIN account. The password must be at least 12 characters. An existing customer account is never promoted to administrator; configure a separate administrator email. If the configured email is unused but an administrator already exists, that existing admin record adopts the configured email and username after the configured password is verified; a second admin is not created. The seed remains available for explicit provisioning. Restart the server after changing these values.

Signup is free. Before email verification, registration data is kept in a short-lived `RegistrationAttempt`; no `User`, KYC profile, wallet/ledger account, or notification is created. The temporary row stores a bcrypt password hash, not the password, and is bound to an HttpOnly registration cookie. The email link can restore this short-lived session on another device without putting its token in the URL request path. Successful server-side email verification creates the permanent account and its account records atomically. Incorrect codes, expired sessions, and failed delivery remove the temporary attempt and its verification challenge. Phone remains optional at signup and the existing post-registration KYC phone verification flow is unchanged.

Configure both `NEXT_PUBLIC_TURNSTILE_SITE_KEY` and server-only `TURNSTILE_SECRET_KEY` for Cloudflare Turnstile. Registration fails closed when either side is unavailable, and the server verifies the token before persisting temporary registration data. Akedly V2 is the primary email verification option only when `AKEDLY_ENABLED=true` and all of `AKEDLY_API_KEY`, `AKEDLY_PIPELINE_ID`, `AKEDLY_WIDGET_ID`, `AKEDLY_PUBLIC_KEY`, `AKEDLY_WIDGET_SECRET`, and `AKEDLY_WEBHOOK_SECRET` are configured server-side. If Akedly is disabled or unavailable while creating an attempt, registration verification falls back to the existing configured email-code provider. Configure `RESEND_API_KEY` or the supported HTTPS `VERIFICATION_EMAIL_API_URL`/`VERIFICATION_EMAIL_API_KEY` pair for this fallback. If neither provider is available, registration does not retain personal details. Keep Akedly disabled until controlled live delivery and webhook verification pass; Akedly has no read-only health endpoint. REAL-mode KYC phone verification uses Akedly when enabled and falls back to Termii when Akedly is disabled or unavailable. Legacy `REGISTRATION_VERIFICATION_ENABLED` and `PHONE_VERIFICATION_REQUIRED` values do not disable the email gate. The production URL defaults to the current Render hostname; `PORT` and `MARKET_TICK_MS` have runtime defaults.

The authenticated `/api/cron/registration-cleanup` route deletes only expired temporary registration attempts and their cascading temporary verification rows; Vercel schedules it every minute. The Render push-delivery cron runner also invokes this endpoint each minute using `CRON_SECRET`. To prepare an aggregate report of legacy, long-expired unverified accounts, run `npx tsx scripts/registration-cleanup-dry-run.ts --dry-run` in an intentionally configured environment. This report is read-only, returns counts only, and has no apply mode. Review candidate account and financial-history counts before separately authorizing any production cleanup; never use it as authorization to delete permanent users or financial/audit records.

Successfully email-verified users receive a server-generated permanent ID in the form `AEX-YYYY-XXXX-XXXX`, using a cryptographic random suffix and a database unique index. Registration creates the ID in the same transaction as the verified user and account records; legacy pending users receive one only when verification completes. The authenticated profile, dashboard, account card, receipts, and admin user management display the ID, and profile/admin update APIs do not accept changes to it. For existing accounts, first run `npx tsx scripts/aurevia-id-backfill.ts --dry-run` against the explicitly intended database and review its aggregate counts. The additive migration adds a nullable unique column without rewriting user or financial records. The controlled rollout is: separately approve the initial report and migration, apply the additive migration, deploy the ID-aware application, rerun and review the dry run, then separately approve and run `AUREVIA_ID_BACKFILL_CONFIRM=APPLY_VERIFIED_USER_IDS npx tsx scripts/aurevia-id-backfill.ts --apply`. The backfill assigns IDs only to rows with `emailVerifiedAt`, preserves existing IDs, and adds and validates a database check constraint requiring an ID for every email-verified user. Never run the migration, deploy, or apply command against production without separate authorization and a reviewed dry run.

For production on Render, keep `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` set to `https://aurevia-exchange-6hfi.onrender.com` until the custom domain has working DNS and verified HTTPS. Render's `RENDER_EXTERNAL_URL` is used as the canonical auth/public origin unless `AUREVIA_CUSTOM_DOMAIN_VERIFIED=true` explicitly opts into the verified custom domain. Production startup fails closed if `NEXTAUTH_SECRET` is missing or no valid HTTPS app origin can be resolved; it never trusts an arbitrary Host header or a hard-coded fallback secret. Official support contact defaults to `aureviainvest@gmail.com` and can be overridden with `SUPPORT_EMAIL`; `COMPLAINTS_EMAIL` may be set separately. Configure these destinations separately from `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, and `SMTP_FROM`. When SMTP is missing, password recovery is unavailable and support/funding actions report that no email was sent; in-app tickets and notifications remain recorded.

### Vercel deployment

This repository is configured as a Next.js application in `vercel.json`. Vercel runs the App Router routes as serverless functions; it does not run `server.ts`, persistent Socket.IO connections, or the local in-process market timer. Browser market views therefore refresh over HTTP, and the protected `/api/cron/market-tick` route advances the simulated DEMO market once per minute. The registration-cleanup route also runs every minute. Use a Vercel plan that supports one-minute Cron schedules. This market is simulated; the job does not connect to a broker or funding provider.

- Framework preset: Next.js
- Install command: `npm ci`
- Build command: `npm run build`
- Output directory: leave the Vercel default
- No custom start command

Configure production and preview environment variables in the Vercel project settings. Required server values are `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, and `TURNSTILE_SECRET_KEY`; set `NEXT_PUBLIC_TURNSTILE_SITE_KEY` for the registration widget. Configure Supabase private-file variables (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) when those workflows are enabled. Add `ADMIN_USERNAME`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` before provisioning the administrator. Set the canonical HTTPS app origin explicitly in `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL`; use a separate staging database and secrets for Preview deployments. Keep credentials server-only except explicitly public site/URL keys.

Use Supabase's pooled connection string for `DATABASE_URL` where appropriate and its direct PostgreSQL connection for `DIRECT_URL`. Apply reviewed Prisma migrations to the target database before promoting the deployment; the Vercel build does not run migrations or seed an administrator. Do not point Preview deployments at production customer data. Configure the private Storage buckets and restrictive policies documented above before enabling uploads.

Generate a high-entropy `CRON_SECRET` and store it in Vercel project settings. Vercel Cron sends it as a Bearer token to the market-tick route; calls without that exact secret are rejected. Cron jobs run for production deployments. Local development and the Render Node service continue to use the custom server's ticker; Render remains the option when persistent Socket.IO/WebSocket delivery is required.

### Render deployment

Use a Render **Node web service** connected to the existing GitHub repository. Set its Root Directory to `aurevia` (the app and `package.json` are in that repository subdirectory). Render's persistent web service supports this custom Next.js/Socket.IO HTTP server and WebSocket upgrades; do not deploy it as a static site or serverless function. Keep the service on an always-on plan (the Blueprint uses `starter`); a sleeping/free instance cannot guarantee continuous market updates or WebSocket delivery. The in-process simulated-market ticker runs while the server is running, and the optional external quote broadcaster polls configured providers every 30 seconds. Selecting or upgrading the Render plan is a dashboard/billing action, not something a Git push or application environment variable can do. Signing out only ends the user's session and does not stop an always-on server. Use one instance while the in-process Socket.IO market engine is enabled; horizontal scaling requires a shared Socket.IO adapter and coordinated market worker, which are not currently configured.

- Build command: `npm ci --include=dev && npm run build`
- Start command: `npm start`
- If Render reports a build command of `yarn`, update the service's Build Command in **Settings → Build & Deploy** to the command above. Installing dependencies alone does not generate the `.next` production build required by the start command.
- Docker is not required for Render's native Node runtime. The checked-in multi-stage `Dockerfile` is an alternative if the Render service is explicitly configured as a Docker service.

Configure these variables in Render's environment settings (secrets stay in Render, never in source). A local `.env` file is not automatically uploaded to Render:

- Required: `DATABASE_URL`, `DIRECT_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`, `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, `TURNSTILE_SECRET_KEY`, `NEXT_PUBLIC_TURNSTILE_SITE_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
- Required for browser push: `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (for example `mailto:aureviainvest@gmail.com`), `PUSH_SUBSCRIPTION_ENCRYPTION_KEY` (32 random bytes encoded as Base64), and `PUSH_DELIVERY_CRON_SECRET`. Generate a VAPID pair with `npx web-push generate-vapid-keys`; set its public and private values in the correspondingly named Render variables, and never commit the private key. Generate the encryption and cron secrets with `openssl rand -base64 32` and `openssl rand -hex 32`, respectively. Keep the VAPID private key, encryption key and cron secret server-only. Back up the encryption key securely and retain it: changing it makes existing stored subscriptions undecryptable.
- Required for administrator sign-in: `ADMIN_USERNAME`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`. Use the exact configured username or email and password at `/admin/login`; first sign-in provisions the admin or adopts the existing admin record when the configured email is unused. SMTP/support variables and `MARKET_TICK_MS` are optional. Email ownership verification is mandatory before creating a permanent account; phone remains optional at signup and may be verified later through KYC. Identity status is administrator-reviewed; it does not indicate external identity verification.
- Optional external market data: set `FINNHUB_API_KEY` for Finnhub quotes/history. The application marks only current provider quotes as live; unavailable symbols fall back to explicitly labeled Aurevia Internal data, not fabricated live activity. Market coverage and quote availability depend on the provider plan and supported symbols.
- Optional REAL-mode Alpaca Paper order submission: configure `ALPACA_PROVIDER=alpaca`, `ALPACA_TRADING_BASE_URL=https://paper-api.alpaca.markets/v2` (the paper endpoint is also the default), `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` (or the supported legacy `ALPACA_API_SECRET`), and `ALPACA_PAPER_ORDERS_ENABLED=true` as server-side settings. Keep `REAL_EXECUTION_ENABLED=false`. The adapter rejects live and non-Alpaca endpoints. Without credentials or the enable flag, REAL orders fail with a configuration status instead of falling back to simulated execution. Never use paper account cash or equity as Aurevia user wallet funds.
- Optional AI assistance: set server-only `OPENROUTER_API_KEY`; `AI_PROVIDER` defaults to `openrouter` and `AI_MODEL` defaults to `openrouter/free`. The gateway rejects OpenRouter models unless the provider reports zero prompt and completion pricing. Gemini and Groq backups are opt-in through `AI_BACKUP_PROVIDERS` and require explicit `AI_FREE_MODEL_ALLOWLIST`, `GEMINI_FREE_MODEL`, or `GROQ_FREE_MODEL` entries; verify provider pricing/free-tier terms before allowlisting. Provider/model failures never route to an unapproved or paid model. `DEMO_AI_ENABLED=true` enables DEMO recommendations only; recommendations require fresh internal DEMO data and never place orders. Users must review and submit orders through the existing authorized workflow.
- The administrator-only **AI & API command center** at `/admin/command-center` runs read-only provider checks and records redacted health/usage metadata. To submit AI credentials through its approval queue, configure `AI_SECRETS_ENCRYPTION_KEY` as a stable 32-byte Base64 secret (`openssl rand -base64 32`). A second administrator must approve a submitted credential. Environment variables take precedence; Render deployment secrets remain managed in Render. If the encryption key is unavailable, configure credentials directly in Render rather than submitting them in-app.

Set both `NEXTAUTH_URL` and `NEXT_PUBLIC_APP_URL` to the same canonical HTTPS origin assigned to the Render service (or its verified custom domain). The database URLs must be the existing Supabase PostgreSQL connections; use Supabase's pooler for application traffic where appropriate and its direct connection for Prisma schema management. Render injects these environment variables during the build. Keep production migrations out of the build command: first reconcile the target database's migration history with the checked-in migrations, review the migration plan for compatibility with the running release, and obtain explicit approval before applying migrations using `DIRECT_URL`. Confirm migration status and take appropriate database backups before any approved production migration; do not use `db:push` or reset commands in production.

#### Browser push notification deployment

1. In **Render → Aurevia web service → Environment**, add `NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_SUBSCRIPTION_ENCRYPTION_KEY`, and `PUSH_DELIVERY_CRON_SECRET`. Generate a fresh VAPID pair locally using `npx web-push generate-vapid-keys`; store its public output in `NEXT_PUBLIC_VAPID_PUBLIC_KEY` and its private output in `VAPID_PRIVATE_KEY`. Set `VAPID_SUBJECT` to a valid contact URI such as `mailto:aureviainvest@gmail.com`. Generate separate values for the encryption and worker secrets using `openssl rand -base64 32` and `openssl rand -hex 32`; do not reuse the VAPID private key for encryption.
2. Review the additive migration `prisma/migrations/20261025153000_browser_push_notifications/migration.sql` against the target database's actual Prisma migration history and data. This checkout's production migration history has previously shown divergence; reconcile it with the database owner, take a backup, and approve the migration plan before applying it. Do not run `db:push`, reset, or an unreviewed migration on production. After reconciliation and approval, run `npm run db:migrate` against the production service's `DIRECT_URL` as a deliberate one-off operation, not in the build command.
3. Deploy the existing Node web service over its canonical HTTPS origin. The service serves `/sw.js` at origin scope and must be reachable at `https://<your-domain>/sw.js`.
4. In **Render → New → Cron Job**, connect the same repository, set Root Directory to `aurevia`, Build Command to `npm ci --include=dev`, and Command to `node scripts/push-delivery-cron.mjs`. Add `PUSH_DELIVERY_WORKER_URL=https://<your-domain>/api/cron/push-delivery`, the same `NEXTAUTH_URL` as the web service, the web service's `PUSH_DELIVERY_CRON_SECRET`, and the web service's `CRON_SECRET`. Set the schedule to every minute (`* * * * *`) and save. The job calls the authenticated same-origin workers; push attempts are persisted/retried and expired subscriptions and temporary registration attempts are cleaned up.
5. After both services are deployed, sign in using a supported HTTPS browser, open **Settings → Preferences**, enable notifications, grant permission from that button, and send a test notification. Verify that the test arrives and that clicking it opens the account page. Actual offline delivery must be verified on each supported browser/device; it is not guaranteed across unsupported browsers, disabled permissions, operating-system focus modes, or push-service outages.

The development command uses `.next-dev` so it does not collide with production builds in `.next`; `server.ts` loads the repository `.env` and honors the configured database URLs. The Docker build context excludes `.env*`; supply runtime configuration only through the hosting environment. The application has no production localhost URL dependency: its localhost URL fallback is for local development, and production startup requires `NEXTAUTH_URL`.

### Simulated account workflows and external provider readiness

DEMO customer orders use Aurevia's internal simulator, and REAL trade orders use the paper-only Alpaca adapter when enabled. Every order, execution, and position remains associated with the authenticated Aurevia user and REAL account; confirmed fills are reconciled idempotently and paper orders never post to the wallet ledger. The adapter checks user-specific collateral from the Aurevia ledger, filled paper cost basis, open buy reservations, and pending withdrawals. It does not import the shared Alpaca cash or equity into any user's balance. When the initial provider submission has an ambiguous result, the service looks up the deterministic client order ID and does not blindly submit again. Admins can manually reconcile an unresolved order from the admin operations panel; the endpoint requires an authenticated administrator and verifies the order/user association. REAL BTC deposits still require user evidence and separate manual verification before an audited USD ledger credit. The application does not verify Bitcoin confirmations or provide a receiving address. REAL withdrawal eligibility excludes pending withdrawals and paper-trading commitments; administrator-confirmed external processing is still required to complete a withdrawal. Historical investment allocations and target returns remain subject to their existing simulated settlement behavior; they do not represent Alpaca funds or paper-trading profits. No live brokerage, custody, or automatic external payout is enabled.

DEMO customer actions are limited to viewing supported markets, simulated orders and positions, trading history/P&L, and resetting the virtual account. DEMO funding, withdrawals, investment allocations, cards, and KYC submissions are disabled in server-side routes as well as the interface. New DEMO ledgers start at exactly USD 5,000; reset returns the virtual cash to that starting amount, closes open positions, cancels open orders, audits the operation, and retains historical ledger entries. AI trade ideas are server-generated recommendations only: the user must review and submit an order, and the order service independently validates active mode, fresh prices, cash, exposure, fees, and slippage. AI recommendations are disabled by default; enable them with `DEMO_AI_ENABLED=true` only when the central server-side AI gateway has an approved free model configured. The `DEMO_AI_*` values in `.env.example` control strategy selection, supported symbols, risk sizing, thresholds, simulated costs, and the evaluation interval. No provider key belongs in a browser-visible variable.

### Activity visibility and retention

The account Activity page supports search, category/status/date filters, pagination, archive/restore, removal from the visible feed, and clear-history actions. These actions create mode-scoped visibility preferences and do not erase or alter orders, positions, investments, funding requests, ledger entries, balances, or audit history. Open orders and positions cannot be archived or removed from the feed. Read notifications can be permanently deleted only when they have no push-delivery record; notification deletion does not delete the related account record. The administrator Activity Management page is role-checked server-side, scopes every action to a selected user and account mode, and writes administrative outcomes to the protected audit log.

The additive `20261027083000_activity_visibility_management` migration adds notification archive timestamps and the activity visibility preference table. It does not reset or rewrite existing account data. Apply it through the normal reviewed deployment migration process before deploying the application version that uses these fields.

The current provider interfaces describe broker order submission/cancellation/status, balances/positions, reconciliation, quotes/bars, funding confirmations, identity/sanctions checks, and webhook signature verification. The admin-only `/api/admin/providers/status` endpoint performs a read-only `GET /v2/account` check and reports configuration, connectivity, and sanitized provider errors without returning credentials. Alpaca paper account details are visible only to admins and are not Aurevia balances or ledger funds. REAL-side orders persist provider references and reconcile confirmed fill deltas into user-attributed paper positions; the wallet ledger is not posted from paper fills. DEMO orders remain entirely internal. The paper-order adapter is hard-limited to Alpaca's paper endpoint; `REAL_EXECUTION_ENABLED` remains false and does not enable live execution. The additive migration `20261027100000_alpaca_paper_execution_reconciliation` adds provider order/execution state and must be reviewed and applied through the existing migration process before deployment; it has not been applied by this work.

Server-only broker configuration includes `ALPACA_PROVIDER`, `ALPACA_TRADING_BASE_URL`, `ALPACA_API_KEY`, `ALPACA_SECRET_KEY` (or legacy `ALPACA_API_SECRET`), and the explicit `ALPACA_PAPER_ORDERS_ENABLED` toggle. `REAL_EXECUTION_ENABLED` must remain false. Payment-provider names are `PAYMENT_PROVIDER`, `PAYMENT_API_URL`, `PAYMENT_API_KEY`, and `PAYMENT_WEBHOOK_SECRET`; external payment processing remains disabled. Select jurisdictions and obtain legal/compliance approval before evaluating broker, payment, market-data, and identity/AML providers. Administrators can grant simulated credits to configured REAL ledgers. A REAL BTC request is only a report of an asserted transfer: an administrator must independently inspect it and choose a USD credit amount; no blockchain verification or exchange-rate conversion is automated. The product does not provide a REAL BTC destination, so configure and operationally verify any actual receiving wallet and confirmation process outside this feature before soliciting transfers. Admin allocations update only the internal ledger; no payment, transfer, bank/card activity, or custody occurs. REAL withdrawal approval leaves funds reserved and incomplete; no external payout provider is configured, and the settlement endpoint refuses to mark REAL withdrawals complete. REAL investment requests can be reserved, reviewed, activated, completed, and settled only as simulated ledger activity; settlement returns reserved principal and does not credit configured target estimates as earnings. These actions do not create an external investment or return. Manual KYC status is explicitly an administrator review and is not external identity/AML or regulatory verification.

Private file workflows require server-only `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. The key must never be placed in a `NEXT_PUBLIC_*` variable or imported into client components. Configure these existing private buckets (the application does not create buckets): `kyc-documents` (10 MB), `profile-avatars` (5 MB), `wallet-receipts` (10 MB), and `support-attachments` (10 MB). Their restrictive `storage.objects` RLS policies are `aurevia_kyc_documents_block_client_access`, `aurevia_profile_avatars_block_client_access`, `aurevia_wallet_receipts_block_client_access`, and `aurevia_support_attachments_block_client_access`; each blocks all operations by `anon` and `authenticated` for its bucket. Trusted server routes use the service role only after session, record-ownership, or administrator checks. New object keys use `<userId>/<generated-UUID>.<extension>`. Upload routes verify signatures, MIME type, extension, size, and owning database record; file replacement is non-upserting and owner-scoped. File access uses signed URLs for at most five minutes. Users can retrieve their own KYC documents through the owner-filtered document route; administrator KYC review requires `requireAdmin`. KYC accepts JPEG, PNG, WebP, and PDF up to 8 MB; administrators can review uploaded files from `/admin`. No external identity, AML, sanctions, or malware-scanning provider is connected.

### Provider status and safe fallbacks

| Capability | Provider/configuration | Current behavior without provider |
| --- | --- | --- |
| Database | Supabase Postgres; `DATABASE_URL`, `DIRECT_URL` | Server operations fail explicitly; no in-memory financial fallback |
| Market information | Finnhub or Alpaca when configured and responsive; Aurevia Internal simulated reference data otherwise | The market screen shows `Market data: Live` only for current provider quotes and `Market data: Internal reference` for fallback prices and reference history |
| Display currency | Finnhub exchange quotes when available; last known database rate, then an internal reference-rate table | Approximate display conversion only; source and stale/internal status are disclosed; ledger values are never converted |
| Broker/execution | Aurevia internal simulated execution for each mode, with ledger and position isolation | Customer orders do not reach an external broker; live execution disabled |
| Deposits and withdrawals | Funding-provider contract only; no bank, card, blockchain, or custody adapter | REAL BTC credits require separate manual verification and approval; withdrawals are capped to verified BTC-funded balance and remain incomplete without a payout provider |
| Investments | No investment execution/settlement provider | Allocations reserve internal funds; settlement returns reserved principal only and never converts an estimated target return into earnings |
| Identity/KYC | No identity verification provider configured | Documents/details can be submitted for human review only; approval is an administrator decision |
| Email/OTP | Email-code fallback: `RESEND_API_KEY` plus `VERIFICATION_EMAIL_FROM` (or the legacy HTTPS `VERIFICATION_EMAIL_API_URL` and `VERIFICATION_EMAIL_API_KEY` pair); `VERIFICATION_CODE_SECRET` is recommended, with `NEXTAUTH_SECRET` as a server-side fallback. Akedly is optional and requires `AKEDLY_ENABLED=true` plus all six Akedly values. `NEXT_PUBLIC_APP_URL` (or `NEXTAUTH_URL`) supplies verification links. Optional Termii `TERMII_API_KEY` and `TERMII_SENDER_ID` support KYC phone challenges. | With Akedly disabled or unavailable, registration verification uses configured email-code delivery. With no email provider, registration remains pending and verification is unavailable. Provider acceptance does not prove delivery; actual email/phone delivery and callback receipt have not been verified. |
| Private files | Supabase Storage URL, private bucket, service-role key | Upload and signed access fail closed; no public-file fallback |
| Deployment | No deployment provider configuration is checked into this repository | Production secret injection, domains, TLS, backups, monitoring, and release controls must be configured in the hosting environment |
| SMS/OTP | Akedly V2 when all six credentials are configured; otherwise optional Termii Send Token/Verify Token fallback | REAL-mode KYC phone verification uses the configured provider; browser redirects alone do not verify a number |

Set the following server-side environment variables for Akedly V2 (all six values are server-only). The pipeline backend callback URL must be `https://<application-host>/api/webhooks/akedly`. For example:

```dotenv
AKEDLY_API_KEY=
AKEDLY_PIPELINE_ID=
AKEDLY_WIDGET_ID=
AKEDLY_PUBLIC_KEY=
AKEDLY_WIDGET_SECRET=
AKEDLY_WEBHOOK_SECRET=
NEXT_PUBLIC_APP_URL=https://aureviaexchanged.dpdns.org
# Optional fallback for REAL-mode phone verification when Akedly is not configured.
TERMII_API_KEY=
TERMII_SENDER_ID=
```

The official integration contracts are documented at [Akedly V2 create attempt](https://docs.akedly.io/authentication/v2/start), [widget client](https://docs.akedly.io/authentication/v2/client), [result callbacks](https://docs.akedly.io/authentication/v2/results), and [transaction status lookup](https://docs.akedly.io/authentication/transaction-status). The Svix package verifies raw-body webhook signatures. Configure the Akedly pipeline's backend callback to the route above and test delivery and callback receipt in staging before relying on verification in production. Email-code fallback uses `RESEND_API_KEY` or the supported HTTPS `VERIFICATION_EMAIL_API_URL` / `VERIFICATION_EMAIL_API_KEY` pair; the provider's acceptance response is not proof of delivery.

Password recovery tokens are random, single-use, expire after 30 minutes, and are stored only as SHA-256 hashes. Resetting a password revokes the active account session. Successful and failed credential attempts are written to the existing admin-only audit log with a validated IP when available, bounded user-agent text, and a hashed identifier for unknown accounts; no password or raw token is stored.

For a real deployment, use a unique high-entropy `NEXTAUTH_SECRET`, a strong administrator password, and managed secret storage.

## Local setup

```bash
npm install
cp .env.example .env
# For the local Postgres container, set DATABASE_URL and DIRECT_URL to its connection URL.
docker compose up -d postgres
npx prisma generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run build
npm run dev
```

Open `http://localhost:3000`.

The application server owns the HTTP server and Socket.io endpoint, so use `npm run dev` rather than `next dev` when realtime functionality is required.

## Administrator provisioning

```text
Username: configured with ADMIN_USERNAME
Email: configured with ADMIN_EMAIL
Password: configured with ADMIN_PASSWORD
```

Set `ADMIN_USERNAME`, `ADMIN_EMAIL`, and a unique, strong `ADMIN_PASSWORD` in the deployment secret manager or an ignored local `.env` file. No administrator password is included in the repository. On a fresh database, use those exact credentials at `/admin/login`; first sign-in provisions the ADMIN account. If an admin already exists and the configured email is unused, first sign-in updates that existing admin record to the configured identity rather than creating a second one. Alternatively, run `npm run db:seed` to provision explicitly.

## Docker

```bash
docker compose up --build
```

The included compose file starts PostgreSQL and the app. It requires the database, NextAuth, and administrator values from `.env`; it contains no default credentials.

## Test workflow

### 1. Health

Open:

```text
GET /api/health
```

Expected response includes `ok: true` and `database: "ok"`.

### 2. Admin login

Open `/login` and use the configured administrator credentials. `/admin` must be accessible only to an ADMIN JWT.

### 3. User registration

Create a normal account from `/register`, sign in, and confirm `/dashboard`, `/trade`, `/wallet`, `/kyc` and `/settings` are protected routes.

### 4. Identity review

Submit the profile and identity documents for private administrator review. Tier 3 is granted only after an authorized administrator approves the request. This is an internal review, not external identity, bank, broker, government, or regulatory verification; simulated account access is separate from identity status.

### 5. Simulated funding

From `/wallet`, deposit requests remain internal and pending administrator review; the optional configured Bitcoin address is display-only and does not receive or verify funds. Administrators can fund a selected user/mode directly; that action creates an audited ledger entry and printable receipt. DEMO withdrawals are simulated; an authorized administrator can complete a virtual debit. REAL BTC withdrawal requests use a saved, encrypted Bitcoin mainnet destination and may include optional user-reported TXID/sender/date-time details. Those details are not verified; actual outbound transaction confirmation and the processing TXID remain administrator responsibilities. REAL withdrawal requests are limited to the available eligible balance; admin approval reserves the request but does not complete it. No external payout provider is configured, so REAL withdrawals remain incomplete and no money is paid. Rejection or cancellation releases a reservation. No bank, card, custody wallet, or payout provider is connected.

New DEMO accounts start with a one-time $5,000 virtual USD balance; REAL accounts start at $0.00. Each opening amount is kept in its corresponding double-entry ledger, and no DEMO balance is transferred into REAL. Account-mode balances, orders, positions, transactions, and P&L remain isolated. Administrators may issue audited credits to either account mode. The `/admin/markets` page can generate bounded, audited price changes for supported paper instruments; it does not publish live quotes. Users can select a persistent display currency across wallet, dashboard, portfolio, activity, and USD transaction history; conversions are informational only and never change underlying ledger balances.

### 6. Trading

After initializing a DEMO account or approving a simulated deposit request:

1. Open `/trade`.
2. Select an instrument.
3. Place a Market order.
4. Confirm an execution and position appear.
5. Watch the price update through Socket.io.
6. Confirm unrealized P&L changes.
7. Close the position.
8. Confirm margin plus realized P&L is returned to the user ledger.

For Limit and Stop orders, place an order outside the current trigger price, then wait for the market simulator to reach its trigger. The server processes eligible open orders on market ticks.

### 7. Ledger invariant

Every posted monetary transaction contains exactly one debit and one credit for the same amount. The test suite also covers positive monetary quantities.

### 8. Admin controls

From `/admin`, test:

- Freeze/unfreeze a user
- Approve/reject KYC
- Change USER/ADMIN role
- Approve/reject funding
- Reject historical DEMO funding requests; release only stale DEMO withdrawal reservations
- Force-close positions
- Enable/disable instruments
- Generate audited SIMULATED price ticks from `/admin/markets`

Client stories are private drafts until an administrator links and verifies the client, records a completed REAL withdrawal with its settlement reference, records publication consent, and approves the story. The repository does not include the supplied story photos or a configured image-storage provider, so seeded drafts have no image reference. No story, financial amount, or verification badge is published by seeding.
- Change system settings
- Inspect audit logs

### 9. API checks

Useful endpoints:

```text
GET  /api/health
GET  /api/market
GET  /api/candles?instrumentId=<id>&limit=100
GET  /api/orderbook?instrumentId=<id>
GET  /api/orders
POST /api/orders
DELETE /api/orders
GET  /api/positions
POST /api/positions
GET  /api/wallet
POST /api/wallet
GET  /api/kyc
POST /api/kyc
```

## Production hardening checklist

Before any real-money use, add and independently verify:

- Managed PostgreSQL with backups and point-in-time recovery
- Distributed rate limiting rather than process-memory rate limiting
- TOTP/WebAuthn 2FA with recovery codes
- Email/phone verification
- Independent KYC verification provider and document malware scanning
- AML and sanctions screening
- Real payment/custody integrations
- External market-data and execution integrations
- Reconciliation jobs
- Idempotency keys for every financial POST operation
- CSRF/origin controls appropriate to the deployment topology
- Structured security logging and alerting
- Secrets manager
- WAF/DDoS controls
- Database connection pooling
- Penetration testing
- Dependency/SBOM scanning
- Disaster recovery testing
- Regulatory review for every operating jurisdiction

## Project structure

```text
app/
  api/                 REST API routes
  admin/               admin control center
  dashboard/           portfolio dashboard
  trade/               trading terminal
  wallet/              funding interface
  kyc/                 KYC interface
  settings/            account settings
  login/               authentication UI
  register/            onboarding UI
components/            reusable React components
lib/                    authentication, ledger, market and order engines
prisma/                 schema and seed
server.ts               Next.js + Socket.io application server
tests/                  automated tests
Dockerfile              application image
docker-compose.yml      PostgreSQL + application orchestration
```

## Final implemented application surface

The current source includes:

- Dedicated `/admin/login` administrator entry point with role enforcement.
- Realtime Socket.io market ticks and execution broadcasts.
- Synthetic depth/order-book endpoint at `/api/orderbook`.
- Historical candle endpoint at `/api/candles`.
- User ledger transaction endpoint at `/api/ledger`.
- Full order retrieval and cancellation API.
- Market, limit and stop order triggering.
- Serializable order execution and leverage-aware margin reservation.
- Trading-fee ledger postings.
- Open-position unrealized P&L on the dashboard and trading terminal.
- Pending-withdrawal balance reservation checks.
- Admin instrument creation, enable/disable, price and leverage editing.
- Admin self-protection against freezing or demoting the currently logged-in administrator.
- Global loading, error and not-found UI states.
- Health endpoint suitable for container/load-balancer checks.

## Verification evidence

A final verification run completed successfully: `npm run typecheck`; `npm test` (33 files, 166 tests); `npm run build`; `npm run test:e2e:isolated` (369 Playwright tests against disposable loopback PostgreSQL, with all 29 local migrations); `npm run lint`; `npx prisma validate`; and `npm audit --audit-level=high` (zero vulnerabilities). Vitest 4 addresses advisories in the prior test runner; Tailwind CSS 4 requires Safari 16.4+, Chrome 111+, or Firefox 128+; and the Next lint-plugin dependency tree uses ESLint's compatibility shim and a scoped patched `glob` override. Receipt image/PDF export uses a renderer that supports Tailwind's modern CSS color functions. The isolated E2E harness removed its temporary database container. No production migration or deployment was performed.

This verification does not clear production for release. The last read-only migration-status check found `20261019103000_alpaca_paper_order_account` and `20261019120000_btc_funding_and_paper_buying_power` unapplied in the configured database, while its history recorded `20261013110000_payment_method_network`, which is absent from this checkout and Git history. Reconcile that history with the database owner and review existing BTC transaction references for duplicates before considering the partial unique index; do not mark migrations applied or run SQL until the intended migration contents and production data are verified and an authorized migration plan is approved. The additional additive migration `20261027100000_alpaca_paper_execution_reconciliation` was not applied. Alpaca Paper account retrieval and order submission have not been verified with configured credentials; keep paper submission disabled until credentials, enablement, migration status, and an isolated end-to-end paper test are confirmed. Live execution remains disabled.

For local development only, point `DATABASE_URL` and `DIRECT_URL` at a disposable local database before running database setup commands. Never run migrations or database reset/push commands against production without an explicitly reviewed migration plan and authorization.

```bash
npm ci
npx prisma generate
npm run db:migrate
npm run db:seed
npm run typecheck
npm test
npm run build
npm run dev
```

This remains a simulated/internal trading and accounting platform. It is not, by itself, a licensed real-money brokerage, payment processor, custodian, KYC provider, or external execution venue.

## Aurevia stability and UX upgrade (2026-09)

This revision incorporates the recurring issues identified during the Aurevia deployment journey:

- Explicit client-side registration/login actions prevent the browser's native form GET from racing React hydration.
- Registration and login now expose network/API failures instead of silently stalling.
- Authentication keeps the existing NextAuth JWT session model; logout returns to `/login` without invalidating a valid session on ordinary refresh.
- A single startup shell provides an 8-second first-entry animation and a 3-second transition for subsequent route changes. It uses session storage to avoid an endless loading loop.
- The loading UI is finite and deterministic; there is no perpetual page reload or blinking redirect loop.
- Mobile navigation is full-width, touch-friendly, and avoids desktop side gutters/zoom-style layouts.
- The Aurevia metallic gold emblem supplied in the project assets is included at `public/aurevia-logo.png` and used in startup, navigation, login, registration, and the landing page.
- The interface uses a forest-green/black/gold visual system and broker-style trading cards, market views, order ticket, positions, notifications, KYC and account controls.
- The Stanbic IBTC E-Trade page was used only as a UX/functionality reference: mobile/web trading, live market data, account control, order workflows, portfolio visibility and trade notifications. Proprietary logos, copy, artwork and source code are not copied.

### Regression checklist

1. First visit: startup overlay completes once in 8 seconds.
2. Internal navigation: transition completes in 3 seconds.
3. Browser refresh: session is not deliberately cleared.
4. Logout: returns to login and does not trigger an infinite startup/redirect loop.
5. Registration: no native `/register?` submission; request goes to `/api/register` only after the user presses Continue.
6. Login: failed authentication shows an error and does not silently hang.
7. Mobile: navigation opens as an overlay and content remains within the viewport.
8. Branding: supplied Aurevia logo is loaded from the app's public assets.
