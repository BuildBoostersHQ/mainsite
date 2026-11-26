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
- `src/pages/start-thank-you.html` and `assets/js/start-thanks.js` are the page they land on after finishing: what is left for the $30, the launch call with add-to-calendar buttons, and what happens next.
- `api/onboarding.js` is the only thing that talks to Supabase. It needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` set in Vercel.
- `supabase/client_onboarding.sql` creates the table. Run it once in the Supabase SQL editor.

Each client is one row. Put what you pulled from Google in `prefill`, the chips and domain choices to offer in `options`, and send them `buildboosters.com/start/<their code>`. Set `tier` to `website` to hide the texting registration section. Set `billing_cycle` to `quarterly`, `six_month` or `annual` to show the Google updates note. Set `launch_call_start` to get calendar buttons, and fill `google_approved_at` yourself once their Google access comes through.

Photos a client adds on the page are shrunk on their phone, then saved to the private `client-photos` storage bucket in a folder named with their row id. `photo_count` on their row says how many have arrived.

The EIN a client enters is saved in its own column (`ein_private`), is never sent back to the page, and is deleted by the database as soon as you fill in `a2p_registered_at` on their row. Filling in `a2p_registered_at` also switches the client's website from the thin compliance site to the full one: the database calls the Vercel deploy hook saved in `site_deploy_hook`, and the site's build asks `/api/onboarding?view=site&code=...` whether the registration is approved. The date gets filled in on its own: `tools/a2p-gmail-script.gs` runs in the Gmail inbox that receives HighLevel's A2P emails and posts them to `/api/a2p-inbox` twice a day, which reads the status, saves it to `a2p_events` and fills in the date on a campaign approval. `/api/launch` lists every client's stage for the dashboard. Both need `BB_INTERNAL_SECRET` in Vercel. Both onboarding pages set `tracking: false`, so no analytics, pixel or session recording runs on them.

## Preview locally

```
node build.js
npx serve dist   # or any static server with clean URLs
```

## Still connected to GoHighLevel

Forms are read by GHL's external tracking script; the chat widget, booking calendars, payment links, demo webhooks and images all come from GHL and work on any domain.
