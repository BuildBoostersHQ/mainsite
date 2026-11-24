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

## Preview locally

```
node build.js
npx serve dist   # or any static server with clean URLs
```

## Still connected to GoHighLevel

Forms are read by GHL's external tracking script; the chat widget, booking calendars, payment links, demo webhooks and images all come from GHL and work on any domain.
