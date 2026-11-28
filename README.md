# buildboosters.com

Static site for Build Boosters, deployed on Vercel straight from this repo.

## How it's put together

- `src/pages/` — one file per page. Each starts with a short front-matter block (`title`, `description`, `layout`, `nav`, `robots`), then the page content.
- `src/partials/` — the shared pieces, written once:
  - `header.html` — logo, menu (Pricing, Trades, About, Blog, Contact), phone and the Make My Demo button
  - `footer.html` — footer links, mailing address and the mobile bottom bar
  - `head.html` — title, description, share image, favicon, verification tags
  - `tracking.html` — Meta Pixel and Microsoft Clarity
- `assets/css/site.css` — all shared styles. `assets/js/site.js` — menu, forms, thank-you redirect.
- `assets/js/demo.js` — demo site scripts (only on /demo pages). `assets/js/checkout.js` — the 90-day prepay upsell before checkout.
- `public/` — favicon files, copied to the site root.
- `build.js` — stamps the partials into every page and writes `dist/`, plus `sitemap.xml`, `robots.txt` and a `404.html` that sends unknown addresses to the homepage. No dependencies.

Layouts: `site` (header + footer), `bare` (landing and thank-you pages with their own design), `demo` (client demo sites, no Build Boosters chrome or lead tracking).

## Change the menu or footer

Edit `src/partials/header.html` or `footer.html`. Every page picks it up on the next deploy.

## Add a blog post

Copy any post in `src/pages` (for example `speed-to-lead-contractors.html`), change the front matter, the hero (crumb `Blog · Category`, H1, intro line, byline date and read time) and the article. It shows up on /blog automatically, newest first. City pages are named `contractor-website-design-<city>` and get their own row.

## Add a page

Create `src/pages/my-page.html` with front matter and push. It's served at `/my-page`.

## Client onboarding page

`/start/<code>` is the setup page a new client fills in. `/start` on its own shows a sample client and saves nothing.

- `src/pages/start.html`, `assets/css/start.css`, `assets/js/start.js` are the page.
- `src/pages/start-thank-you.html` and `assets/js/start-thanks.js` are the page they land on after finishing: what is left for the setup credit ($50 for finishing the day they pay, $20 for the next day), the launch call with add-to-calendar buttons, and what happens next.
- `api/onboarding.js` is the only thing that talks to Supabase. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in Vercel.
- `supabase/client_onboarding.sql` creates the table. Run it once in the Supabase SQL editor.

Each client is one row. Put what you pulled from Google in `prefill`, the chips and domain choices to offer in `options`, and send them `buildboosters.com/start/<their code>`. `tier` is `essentials`, `all_in_one` or `dominance`, and it sets how many services and towns the form allows (4 and 5, 8 and 10, 12 and 14). Every plan is asked for texting registration details. The old `website` tier is the one exception. Set `billing_cycle` to `quarterly`, `six_month` or `annual` to show the Google updates note. Set `launch_call_start` to get calendar buttons, and fill `google_approved_at` yourself once their Google access comes through.

Photos a client adds on the page are shrunk on their phone, then saved to the private `client-photos` storage bucket in a folder named with their row id. `photo_count` on their row says how many have arrived.

The EIN a client enters is saved in its own column (`ein_private`), is never sent back to the page, and is deleted by the database as soon as you fill in `a2p_registered_at` on their row. Filling in `a2p_registered_at` also switches the client's website from the thin compliance site to the full one: the database calls the Vercel deploy hook saved in `site_deploy_hook`, and the site's build asks `/api/onboarding?view=site&code=...` whether the registration is approved. The date gets filled in on its own: `tools/a2p-gmail-script.gs` runs in the Gmail inbox that receives HighLevel's A2P emails and posts them to `/api/a2p-inbox` twice a day, which reads the status, saves it to `a2p_events` and fills in the date on a campaign approval. `/api/launch` lists every client's stage for the dashboard. Both need `BB_INTERNAL_SECRET` in Vercel. Both onboarding pages set `tracking: false`, so no analytics, pixel or session recording runs on them.

## Secure key link

When a client has to hand over a key (Housecall Pro, Jobber or other), they paste it on a one-time page instead of texting it.

- `api/client-secret.js` makes the link, saves the key and reads it back. `src/pages/key.html` and `assets/js/key.js` are the page, served at `/key/<token>`.
- Make a link: `POST /api/client-secret` with the `x-bb-secret` header and `{ "action": "create", "code": "<client code>", "label": "Housecall Pro", "note": "optional line shown on the page" }`. It returns `https://buildboosters.com/key/<token>`. The label is whose key it is, so the page can say "your Housecall Pro key".
- The link works once and expires after 7 days. You get an alert text saying which client sent which key. The key is never in the alert and never shown on the page again.
- Read a key back on the server: `GET /api/client-secret?action=read&code=<client code>&label=Housecall Pro` with the `x-bb-secret` header.
- Keys are encrypted with AES-256-GCM before they are saved. This needs `BB_SECRETS_KEY` in Vercel: 32 random bytes in base64. Make one with `openssl rand -base64 32`. Without it, links cannot be made and nothing is stored. Keep a copy somewhere safe and do not change it, because keys saved under the old value cannot be read with a new one.
- `supabase/client_secrets.sql` creates the `client_secret_requests` table. Run it once in the Supabase SQL editor.

## Status note per client

`GET /api/launch` gives every client a `status_note` (one plain sentence on where they stand) and `needs_attention` (true when the note is something you have to act on, false when you are waiting on the client or on the carriers). It is worked out by `statusNote` in `api/launch.js` from the client's row, in this order: nothing saved on the setup page, setup page started and not sent, Google access, texting registration not submitted, texting registration rejected (with the saved reason), site build stopped or not started, their own domain not pointing at the site, waiting on texting approval, ready for the launch call, live. When more than one applies, the note is the first one you have to act on. No new columns and no SQL to run.

## Match Google reviews to customers

So nobody who already left a review gets asked again.

- `POST /api/review-match` with the `x-bb-secret` header and `{ "code": "<client code>", "reviewers": ["Maya P.", "Mike Torres"] }` compares the reviewer names to the customer list the client uploaded. It returns `exact` (the name is the same as exactly one customer), `maybe` (ranked guesses with a score and the reason, for you to check) and `none`.
- Confirm the ones that are right: `{ "action": "confirm", "code": "<client code>", "pairs": [{ "reviewer": "Maya P.", "contact_id": "3055550142" }] }`. Use the `contact_id` from the first call. It is the customer's ten-digit phone, or their email when the list has no phone for them.
- Confirmed pairs are saved in `review_matches`, and `/api/review-queue` leaves those customers out of the review asks by phone number. A customer with no phone on the list is saved but cannot be skipped. Tagging the contact inside their HighLevel sub-account is not built yet (`tagReviewedContactsInSubAccount` in `api/review-match.js`).
- `supabase/review_matches.sql` creates the table. Run it once in the Supabase SQL editor.

## Welcome page and texting registration

`/welcome` is where Stripe sends a buyer after payment. Each payment link's confirmation address has to be `https://buildboosters.com/welcome?session_id={CHECKOUT_SESSION_ID}`, so the page can tell who just paid. With that, the page asks for the texting registration details first: whether they have an EIN, legal name, business type, EIN and the street address on their IRS letter. Without it, or on a plan tagged `website`, the page shows the plain "check your phone" message. `/welcome?sample=1` shows the form and saves nothing.

- `src/pages/welcome.html` and `assets/js/welcome.js` are the page.
- `assets/js/address-lookup.js` is the address picker, shared with `/start`. It calls `/api/address`, which looks the address up through Google Maps with the same `GOOGLE_PLACES_KEY` as the business lookup, and turns away P.O. boxes. Switch on the Address Validation API for that key in Google Cloud to also catch rented mailboxes; the picker works without it.
- The address is saved in the client's answers as `a2p_address`, `a2p_street`, `a2p_unit`, `a2p_city`, `a2p_state`, `a2p_zip` and `a2p_address_check` (`ok`, `mailbox_store` or `typed`).

## After a job is finished

`/api/jobber-webhook`, `/api/hcp-webhook` and `/api/job-done` write each finished job to `job_events`. `/api/send-asks` runs every hour and, from 10 AM up to 5 PM Eastern, hands each due job to the client's HighLevel sub-account by putting the tag `job-done` on the customer. That tag is what starts the client's own review request and "Photo Request After Job" workflows, so the texts come from the contractor's number. A job waits while the client's texting registration is pending, and a customer who was handed over in the last 30 days is skipped. `POST /api/send-asks` with `{ "dry_run": true }` shows what it would do.

`/api/photo-reminders` runs once a day and texts each client who is due for the recurring photo ask (weekly for the first month, then monthly) from the Build Boosters line. `POST` with no body lists who is due and sends nothing.

Both need the two new columns blocks at the end of the `job_events` section in `supabase/client_onboarding.sql` run once in the Supabase SQL editor.

## Review cards

`/api/review-card?code=...&format=html` is the printable sheet of QR code review cards: 8 fronts on page 1, 8 backs on page 2, each 3.5 x 2 inches. Print from Chrome to PDF with margins "None" and background graphics on, double-sided on the long edge. The QR code is drawn by `api/_qr.js` with no outside script. It points at the client's `google_review_link` when their answers have one, otherwise at `/review-us` on their domain, and `&link=` overrides both for one print run.

## Preview locally

```
node build.js
npx serve dist   # or any static server with clean URLs
```

## Still connected to GoHighLevel

Forms are read by GHL's external tracking script; the chat widget, booking calendars, payment links, demo webhooks and images all come from GHL and work on any domain.

## Competitor section on demo sites

Add `comp` (the competitor's name) and `compkw` (up to four searches, separated by `|`) to any demo link and a section appears under the hero naming that competitor and the searches they show up for. Leave either one off and the section stays hidden. Only use searches that were checked for that prospect's town.

```
/demo?biz=Dave%27s%20Pressure%20Washing&city=Hialeah&comp=Ruiz%20Pressure%20Cleaning&compkw=pressure%20washing%20hialeah|driveway%20cleaning%20near%20me
```

## Add-on on the setup page

`/start/<code>` offers Google Business Profile optimization ($349, one time) to clients on the website plan. It stays hidden until a Stripe payment link is set in `GBP_ADDON_LINK` at the top of the add-on block in `assets/js/start.js` (or in one client's `options.gbp_addon_link`). The payment link needs the tag `addon` = `gbp_optimization`. The page adds the client's code to the link, and `/api/stripe-webhook` saves the payment in the `addons` column and texts Maddie. Run the latest `supabase/client_onboarding.sql` once to add that column.
