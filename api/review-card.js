// /api/review-card — the printable QR code review cards a client hands to customers.
//
// GET /api/review-card?code=...              → { ok, business, review_url, style, html }
// GET /api/review-card?code=...&format=html  → the printable page itself
// Add &link=https://... to point the code at a link of your choosing for this print run.
// Internal only (BB_INTERNAL_SECRET).
//
// Two US Letter pages, 8 cards each (2 across, 4 down), every card 3.5 x 2 inches:
//   Page 1, fronts: the business name, a one-line ask, and a QR code to their review link
//   Page 2, backs:  the business name (or their logo), phone and website on their main color
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

// The six site looks, mirrored from the client template's src/lib/styles.js.
const LOOKS = {
  classic: { main: '#0b2440', accent: '#f2a20c', head: '"Plus Jakarta Sans"', fonts: 'Plus+Jakarta+Sans:wght@500;800', weight: 800 },
  fresh:   { main: '#1C77C3', accent: '#F39237', head: 'Archivo', fonts: 'Archivo:wght@500;900', weight: 900 },
  bold:    { main: '#16191d', accent: '#ff6a13', head: 'Anton', fonts: 'Anton&family=Archivo:wght@500', weight: 400, upper: true },
  freeze:  { main: '#1E293B', accent: '#4A7CBA', head: '"Playfair Display"', fonts: 'Playfair+Display:wght@500&family=DM+Sans:wght@500', weight: 500 },
  edge:    { main: '#18181B', accent: '#22C55E', head: 'Sora', fonts: 'Sora:wght@500;700', weight: 700 },
  earthy:  { main: '#2D5F4A', accent: '#C45D3E', head: 'Fraunces', fonts: 'Fraunces:wght@500;800', weight: 800 },
};

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

function cardHtml({ business, reviewUrl, style, brandColor, phone, domain, logo }) {
  const look = LOOKS[style] || LOOKS.classic;
  const main = /^#[0-9a-f]{6}$/i.test(String(brandColor || '')) ? brandColor : look.main;
  const name = esc(business);
  // A long name steps down in size so it never crowds the code.
  const frontSize = business.length > 28 ? 12 : business.length > 18 ? 14 : 17;
  const backSize = business.length > 28 ? 15 : business.length > 18 ? 18 : 22;
  const qr = qrSvg(reviewUrl, { dark: '#111111', light: '#ffffff', quiet: 2 });
  const contact = [prettyPhone(phone), domain].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');

  const front = `
<div class="card front">
  <div class="words">
    <h2>${name}</h2>
    <p class="ask">Happy with the work? A quick Google review helps our small business more than you know.</p>
    <p class="how">Point your phone's camera at the code and tap the link.</p>
  </div>
  <div class="code">${qr}</div>
</div>`;

  const back = `
<div class="card back">
  <div class="back-inner">
    ${logo ? `<img src="${esc(logo)}" alt="${name}">` : `<div class="name">${name}</div>`}
    ${contact ? `<div class="contact">${contact}</div>` : ''}
    <div class="thanks">Thank you for your business.</div>
  </div>
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
body { font-family: ${look.head}, "Helvetica Neue", Helvetica, Arial, sans-serif; color: #141b24; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
.sheet { width: 8.5in; height: 11in; padding: 1.5in 0.75in; display: grid; grid-template-columns: 3.5in 3.5in; grid-template-rows: repeat(4, 2in); break-after: page; }
.sheet:last-child { break-after: auto; }
.card { width: 3.5in; height: 2in; outline: 0.5pt dashed #c9cfd8; outline-offset: -0.25pt; overflow: hidden; }
.front { display: flex; align-items: center; gap: 0.14in; padding: 0.2in 0.2in 0.2in 0.26in; border-left: 0.09in solid ${main}; background: #fff; }
.words { flex: 1; min-width: 0; }
.front h2 { font-size: ${frontSize}pt; line-height: 1.12; font-weight: ${look.weight}; color: ${main}; ${look.upper ? 'text-transform: uppercase; letter-spacing: 0.01em;' : 'letter-spacing: -0.01em;'} margin-bottom: 0.09in; overflow-wrap: break-word; }
.ask { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 8.4pt; line-height: 1.38; color: #2a3340; margin-bottom: 0.08in; }
.how { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 6.8pt; line-height: 1.35; color: #6b7684; }
.code { flex: none; width: 1.32in; height: 1.32in; }
.code svg { display: block; width: 100%; height: 100%; }
.back { background: ${main}; color: #fff; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0.2in; outline-color: rgba(255,255,255,.35); }
.back img { max-width: 2.4in; max-height: 0.95in; display: block; margin: 0 auto 0.1in; }
.back .name { font-size: ${backSize}pt; line-height: 1.1; font-weight: ${look.weight}; ${look.upper ? 'text-transform: uppercase; letter-spacing: 0.01em;' : 'letter-spacing: -0.01em;'} margin-bottom: 0.1in; overflow-wrap: break-word; }
.back .contact { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 8.6pt; font-weight: 600; margin-bottom: 0.07in; }
.back .thanks { font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; font-size: 7.4pt; opacity: 0.8; }
.back-inner::before { content: ""; display: block; width: 0.42in; height: 0.035in; background: ${look.accent}; margin: 0 auto 0.11in; }
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
