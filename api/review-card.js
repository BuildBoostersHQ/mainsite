// /api/review-card — the printable QR code review cards a client hands to customers.
//
// GET /api/review-card?code=...              → { ok, business, review_url, style, html }
// GET /api/review-card?code=...&format=html  → the printable page itself
// Add &link=https://... to point the code at a link of your choosing for this print run.
// Internal only (BB_INTERNAL_SECRET).
//
// Two US Letter pages, 8 cards each (2 across, 4 down), every card 3.5 x 2 inches:
//   Page 1, fronts: their logo, phone and website on their main color
//   Page 2, backs:  their logo, "How did we do?", and a QR code to their review link
// A client with no logo of their own (logo_url in their answers) gets the trade emblem beside
// their name, the same lockup as their website header.
// Print double-sided, flipping on the long edge, then cut on the dashed lines. Open the page in
// Chrome and print to PDF with margins set to "None" and background graphics on.
//
// The QR code is drawn here by ./_qr.js, so the page needs no internet to print and the code is
// sharp at any size. It is always printed near-black on white, whatever the brand color, because
// that is what scans reliably off a card in a truck.
//
// Where the code points, first one found:
//   1. ?link= on the request
//   2. the client's Google review link (google_review_link in their answers)
//   3. the /review-us page on their own domain
// With none of these the endpoint says so and prints nothing. A card never points anywhere else.
const { sb, allowed, configured } = require('./_sb');
const { qrSvg } = require('./_qr');
const CODE = /^[a-f0-9]{16,64}$/i;

// The six site looks, mirrored from the client template's src/lib/styles.js and looks.css, so a
// card reads as the same brand as the client's website. `wm` is how that look sets the business
// name in the site header.
const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif';
const LOOKS = {
  classic: { main: '#0b2440', accent: '#f2a20c', bg: '#ffffff', fg: '#121a24', muted: '#5b6878', body: `"Plus Jakarta Sans", ${SANS}`, head: `"Plus Jakarta Sans", ${SANS}`, headWeight: 800,
    wm: `font-family: "Barlow Condensed", ${SANS}; font-weight: 800; text-transform: uppercase; letter-spacing: .01em;`, wmScale: 1.12,
    fonts: 'Plus+Jakarta+Sans:wght@500;600;800&family=Barlow+Condensed:wght@800' },
  fresh: { main: '#1C77C3', accent: '#F39237', bg: '#F1F8FC', fg: '#0E1B2B', muted: '#55657A', body: `Figtree, ${SANS}`, head: `Archivo, ${SANS}`, headWeight: 900,
    wm: `font-family: "Bricolage Grotesque", Archivo, ${SANS}; font-weight: 800; letter-spacing: -.045em;`, wmScale: 1,
    fonts: 'Archivo:wght@900&family=Bricolage+Grotesque:wght@800&family=Figtree:wght@500;600' },
  bold: { main: '#16191d', accent: '#ff6a13', bg: '#0f1114', fg: '#f2f2ef', muted: '#a3a8b0', body: `Archivo, ${SANS}`, head: `Anton, Impact, ${SANS}`, headWeight: 400, upper: true,
    wm: `font-family: Anton, Impact, ${SANS}; font-weight: 400; text-transform: uppercase; letter-spacing: .02em;`, wmScale: 1,
    fonts: 'Anton&family=Archivo:wght@500;600' },
  freeze: { main: '#1E293B', accent: '#4A7CBA', bg: '#ffffff', fg: '#1a1a1a', muted: '#64748B', body: `"DM Sans", ${SANS}`, head: '"Playfair Display", Georgia, serif', headWeight: 500,
    wm: 'font-family: "Playfair Display", Georgia, serif; font-weight: 600;', wmScale: 1,
    fonts: 'Playfair+Display:wght@500;600&family=DM+Sans:wght@500;600' },
  edge: { main: '#18181B', accent: '#22C55E', bg: '#FAFAFA', fg: '#18181B', muted: '#71717A', body: `Outfit, ${SANS}`, head: `Sora, ${SANS}`, headWeight: 700,
    wm: `font-family: Sora, ${SANS}; font-weight: 700; letter-spacing: -.02em;`, wmScale: .92,
    fonts: 'Sora:wght@700&family=Outfit:wght@500;600' },
  earthy: { main: '#2D5F4A', accent: '#C45D3E', bg: '#FFFBF5', fg: '#2A2520', muted: '#7D6E63', body: `"Source Sans 3", ${SANS}`, head: 'Fraunces, Georgia, serif', headWeight: 800,
    wm: 'font-family: Fraunces, Georgia, serif; font-weight: 800;', wmScale: .95,
    fonts: 'Fraunces:wght@800&family=Source+Sans+3:wght@500;600' },
};

// The trade emblems from the client template (src/components/Icons.js). A client with no logo of
// their own gets the emblem beside their name, the same lockup as their website header.
const EMBLEMS = {
  handyman: '<path d="M14.5 3.5l3 3-2 2 3.5 3.5-2 2-3.5-3.5-2 2-3-3z"/><path d="M9.5 10.5L3 17l3 3 6.5-6.5"/>',
  roofing: '<path d="M2 12.5L12 4l10 8.5"/><path d="M5 10v10h14V10"/><path d="M9 20v-5h6v5"/>',
  plumbing: '<path d="M12 3s6 6.8 6 11a6 6 0 0 1-12 0c0-4.2 6-11 6-11z"/><path d="M9.5 15a2.5 2.5 0 0 0 2.5 2.5"/>',
  hvac: '<path d="M12 2v20M3.3 7l17.4 10M20.7 7L3.3 17"/><path d="M9.5 3.5L12 6l2.5-2.5M9.5 20.5L12 18l2.5 2.5"/>',
  electrical: '<path d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12z"/>',
  landscaping: '<path d="M5 20c0-8.5 5-14 15-15-.8 9.5-6.5 14.5-15 15z"/><path d="M5 20l8.5-8.5"/>',
  remodeling: '<path d="M3 11l9-7 9 7"/><path d="M5 9.5V20h14V9.5"/><path d="M9.5 20v-6h5v6"/>',
  painting: '<rect x="3" y="3.5" width="14" height="6" rx="1.5"/><path d="M17 6.5h3.5v5.5H11v3"/><rect x="9.5" y="15" width="3" height="6" rx="1"/>',
  'pressure-washing': '<path d="M3 9h8l2.5 2.5H17"/><path d="M7 9V6h3v3"/><path d="M20 8.5v.01M21.5 11.5v.01M20 14.5v.01M18 17v.01"/>',
  'junk-removal': '<path d="M2 7h11v9H2zM13 10h4l3 3v3h-7z"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="16.5" cy="17.5" r="1.8"/>',
};
const TRADE_ALIASES = { pressure: 'pressure-washing', remodel: 'remodeling', electrician: 'electrical', plumber: 'plumbing', roofer: 'roofing' };

function emblemSvg(trade) {
  const key = String(trade || '').toLowerCase().trim().replace(/\s+/g, '-');
  const d = EMBLEMS[key] || EMBLEMS[TRADE_ALIASES[key]] || EMBLEMS.remodeling;
  return `<svg class="mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function prettyPhone(p) {
  const d = String(p || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
}

// Only a plain https link goes on a card.
function cleanLink(u) {
  const s = String(u || '').trim();
  return /^https:\/\/[^\s"'<>]+$/i.test(s) ? s : '';
}

function cleanDomain(d) {
  const s = String(d || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : '';
}

function reviewUrlFor(row, override) {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const domain = cleanDomain(row.site_domain || a.domain_own || a.domain_choice);
  return cleanLink(override) || cleanLink(a.google_review_link) || (domain ? `https://${domain}/review-us` : '');
}

function cardHtml({ business, reviewUrl, style, brandColor, phone, domain, logo, trade }) {
  const look = LOOKS[style] || LOOKS.classic;
  const main = /^#[0-9a-f]{6}$/i.test(String(brandColor || '')) ? brandColor : look.main;
  const name = esc(business);
  const long = business.length > 26 ? 0.72 : business.length > 17 ? 0.86 : 1;
  const dark = style === 'bold';
  const qr = qrSvg(reviewUrl, { dark: '#111111', light: '#ffffff', quiet: 2 });
  const contact = [prettyPhone(phone), domain].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  // Their own logo when there is one. Otherwise the emblem and name, the way their site header has it.
  const lockup = (cls) => logo
    ? `<div class="logo ${cls}"><img src="${esc(logo)}" alt="${name}"></div>`
    : `<div class="logo ${cls}">${emblemSvg(trade)}<b>${name}</b></div>`;

  // Front: their logo, phone and website on their main color.
  const front = `
<div class="card front">
  <div>
    ${lockup('big')}
    ${contact ? `<p class="contact">${contact}</p>` : ''}
  </div>
</div>`;

  // Back: the ask and the code.
  const back = `
<div class="card back">
  <div class="words">
    ${lockup('small')}
    <h2>How did we do?</h2>
    <p>Your feedback helps our small business grow.</p>
    <p class="scan">Scan to review us on Google.</p>
  </div>
  <div class="code">${qr}</div>
</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${name} review cards</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${look.fonts}&display=swap">
<style>
@page { size: letter; margin: 0; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 8.5in; }
body { font-family: ${look.body}; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 8.5in; height: 11in; padding: 1.5in 0.75in; display: grid; grid-template-columns: 3.5in 3.5in; grid-template-rows: repeat(4, 2in); break-after: page; }
.sheet:last-child { break-after: auto; }
.card { width: 3.5in; height: 2in; outline: 0.5pt dashed #c9cfd8; outline-offset: -0.25pt; overflow: hidden; }

.logo { display: flex; align-items: center; min-width: 0; }
.logo .mark { flex: none; color: ${look.accent}; }
.logo b { ${look.wm} line-height: 1; min-width: 0; overflow-wrap: break-word; }
.logo.small { gap: 0.08in; margin-bottom: 0.15in; color: ${dark ? look.fg : main}; }
.logo.small .mark { width: 0.3in; height: 0.3in; }
.logo.small b { font-size: ${(14.5 * look.wmScale * long).toFixed(1)}pt; }
.logo.small img { max-height: 0.4in; max-width: 1.8in; display: block; }
.logo.big { justify-content: center; gap: 0.13in; color: #fff; }
.logo.big .mark { width: 0.44in; height: 0.44in; }
.logo.big b { font-size: ${(25 * look.wmScale * long).toFixed(1)}pt; text-align: left; max-width: 2.45in; }
.logo.big img { max-height: 1in; max-width: 2.6in; display: block; }

.front { background: ${main}; color: #fff; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0.22in; outline-color: rgba(255,255,255,.35); }
.front .contact { margin-top: 0.15in; font-size: 8.8pt; font-weight: 600; opacity: .92; }

.back { display: flex; align-items: center; gap: 0.2in; padding: 0.2in 0.24in; background: ${dark ? look.bg : '#ffffff'}; color: ${look.fg}; }
.words { flex: 1; min-width: 0; }
.back h2 { font-family: ${look.head}; font-weight: ${look.headWeight}; font-size: ${look.upper ? 18 : 15}pt; line-height: 1.05; white-space: nowrap; ${look.upper ? 'text-transform: uppercase; letter-spacing: .01em;' : 'letter-spacing: -.015em;'} margin-bottom: 0.07in; }
.back p { font-size: 8.6pt; line-height: 1.4; font-weight: 500; color: ${look.muted}; max-width: 1.5in; }
.back p.scan { margin-top: 0.13in; max-width: none; font-weight: 700; color: ${dark ? look.accent : main}; white-space: nowrap; }
.code { flex: none; width: 1.14in; height: 1.14in; background: #fff; }
.code svg { display: block; width: 100%; height: 100%; }
@media screen { body { background: #e9edf2; } .sheet { background: #fff; margin: 0.25in auto; box-shadow: 0 6px 30px rgba(0,0,0,.12); } }
</style>
</head>
<body>
<div class="sheet">${front.repeat(8)}
</div>
<div class="sheet">${back.repeat(8)}
</div>
</body>
</html>`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const code = String(req.query.code || '').trim();
  if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });

  try {
    const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const row = rows[0];
    const a = { ...(row.prefill || {}), ...(row.answers || {}) };
    const business = String(a.business_name || '').trim();
    if (!business) return res.status(409).json({ error: 'no_business_name', reason: 'This client has no business name on file yet.' });
    const style = LOOKS[a.style] ? a.style : 'classic';
    const domain = cleanDomain(row.site_domain || a.domain_own || a.domain_choice);

    const reviewUrl = reviewUrlFor(row, req.query.link);
    if (!reviewUrl) {
      return res.status(409).json({
        error: 'no_review_link',
        reason: 'This client has no Google review link and no domain yet, so there is nothing for the code to point at. Add google_review_link to their answers, or pass ?link=.',
      });
    }

    let html;
    try {
      html = cardHtml({
        business, reviewUrl, style, domain,
        brandColor: a.brand_color,
        phone: row.ghl_phone_number || a.business_phone,
        logo: cleanLink(a.logo_url),
        trade: a.trade,
      });
    } catch (e) {
      if (e.message === 'qr_text_too_long') {
        return res.status(409).json({ error: 'link_too_long', reason: 'The review link is over 106 characters, which is too long to scan well off a card. Use a shorter link.' });
      }
      throw e;
    }

    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(200).send(html);
    }

    return res.status(200).json({
      ok: true,
      business,
      review_url: reviewUrl,
      style,
      cards_per_sheet: 8,
      note: 'Add &format=html for the printable page. Print from Chrome to PDF with margins "None" and background graphics on, double-sided, flipping on the long edge.',
      html,
    });
  } catch (e) {
    console.error('review-card', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.cardHtml = cardHtml;
module.exports.reviewUrlFor = reviewUrlFor;
