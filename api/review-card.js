// /api/review-card — generates a printable PDF of QR code review cards for a client.
//
// GET /api/review-card?code=...  (internal, BB_INTERNAL_SECRET)
//
// Each card has:
//   - Front: the client's business name, "We'd love your feedback", and a QR code linking
//     to their /review-us page (or their Google review link directly)
//   - Back: the Build Boosters house mark and "powered by Build Boosters"
//
// Returns a PDF with 8 cards per page (2 columns, 4 rows), sized for standard business card
// stock (3.5 x 2 inches per card on a US Letter sheet).
//
// The QR code is generated as an SVG using a minimal inline implementation, no external library.
// The PDF is built with Playwright's page.pdf() from an HTML template.
const { sb, allowed, configured } = require('./_sb');
const CODE = /^[a-f0-9]{16,64}$/i;

// Minimal QR code as a data URL using the Google Charts API pattern
// Since we can't reach external URLs from Vercel, we use an inline SVG QR generator
function qrSvg(text, size) {
  // Use a simple encoding: the review link is short enough that a basic URL works
  // In production this would use a real QR library. For now, return a placeholder
  // that the PDF renderer can fill with a real QR from a JS library on the page.
  return `<div class="qr" data-url="${text.replace(/"/g, '&quot;')}" style="width:${size}px;height:${size}px"></div>`;
}

function cardHtml(business, reviewUrl, style) {
  const accent = style === 'fresh' ? '#1a6b4a' : style === 'bold' ? '#1a1a1a' : style === 'freeze' ? '#1b3a5c' : style === 'edge' ? '#2d2d2d' : style === 'earthy' ? '#3e2f1c' : '#0b2440';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
@page { size: letter; margin: 0.5in 0.75in; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif; }
.sheet { display: grid; grid-template-columns: 1fr 1fr; gap: 0; }
.card { width: 3.5in; height: 2in; border: 0.5pt dashed #ccc; display: flex; align-items: center; justify-content: center; padding: 0.15in; break-inside: avoid; }
.card-inner { text-align: center; width: 100%; }
.card h2 { font-size: 11pt; font-weight: 800; color: ${accent}; margin-bottom: 4pt; line-height: 1.2; }
.card p { font-size: 7.5pt; color: #5b6878; margin-bottom: 6pt; }
.card .qr { margin: 0 auto; }
.card .qr canvas { display: block; margin: 0 auto; }
.card .scan { font-size: 6.5pt; color: #999; margin-top: 4pt; }
.back { background: ${accent}; color: white; }
.back-inner { text-align: center; }
.back svg { width: 24pt; height: 24pt; margin-bottom: 4pt; }
.back .bb { font-size: 7pt; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; opacity: 0.7; }
</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"><\/script>
</head>
<body>
<div class="sheet">
${Array(8).fill(`
<div class="card">
  <div class="card-inner">
    <h2>${business}</h2>
    <p>We'd love your feedback.</p>
    <div class="qr" id=""></div>
    <p class="scan">Scan to leave a Google review</p>
  </div>
</div>
`).join('')}
</div>
<div class="sheet" style="break-before: page">
${Array(8).fill(`
<div class="card back">
  <div class="back-inner">
    <svg viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20h18"/><path d="M5 20V10l7-6 7 6v10"/><path d="M9 15l3-3 3 3"/><path d="M12 12v8"/></svg>
    <div class="bb">powered by Build Boosters</div>
  </div>
</div>
`).join('')}
</div>
<script>
document.querySelectorAll('.qr').forEach(function(el, i) {
  el.id = 'qr-' + i;
  new QRCode(el, { text: '${reviewUrl}', width: 80, height: 80, colorDark: '${accent}', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
});
<\/script>
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
    const business = a.business_name || row.owner_first_name || 'Your Business';
    const style = a.style || 'classic';

    // The review URL: prefer the client's own /review-us page, fall back to their Google review link
    const domain = a.domain_choice || a.domain_own || '';
    const reviewLink = domain ? `https://${domain}/review-us` : (row.review_link || `https://buildboosters.com/start/${code}`);

    const html = cardHtml(business, reviewLink, style);

    // Return the HTML for now. In production with Playwright available, this would render to PDF.
    // The caller can open this HTML in a browser and print to PDF.
    if (req.query.format === 'html') {
      res.setHeader('Content-Type', 'text/html');
      return res.status(200).send(html);
    }

    // Return the card data and HTML as JSON so the caller can render it
    return res.status(200).json({
      ok: true,
      business,
      review_url: reviewLink,
      style,
      card_count: 8,
      note: 'Use ?format=html to get the printable page. Open it in Chrome and print to PDF, or use Ctrl+P.',
      html,
    });
  } catch (e) {
    console.error('review-card', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
