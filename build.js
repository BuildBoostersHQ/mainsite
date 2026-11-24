// Build Boosters static site build. No dependencies: `node build.js` writes the finished site to dist/.
// Each page in src/pages is page content plus a small front-matter block. The shared header, footer,
// head tags and tracking live once in src/partials and are stamped into every page here.
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const OUT = path.join(ROOT, 'dist');
const SITE = 'https://buildboosters.com';
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8');
const partial = {
  head: read('partials/head.html'),
  header: read('partials/header.html'),
  footer: read('partials/footer.html'),
  tracking: read('partials/tracking.html'),
};
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n' +
  '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Dancing+Script:wght@600&family=Barlow+Condensed:wght@600;700;800&display=swap">';
const GHL_TRACKING = '<script src="https://api.buildboosters.com/js/external-tracking.js" data-tracking-id="tk_53b0e0def7d74d778248b3245d390098" defer></script>';
// GHL chat widget. It goes in the <head> with preconnects so it starts loading with the page instead of after it,
// and it fades in (see the chat-widget rule below) instead of popping in.
const CHAT = '<link rel="preconnect" href="https://widgets.leadconnectorhq.com">\n<link rel="preconnect" href="https://services.leadconnectorhq.com">\n<link rel="preconnect" href="https://stcdn.leadconnectorhq.com">\n' +
  '<style>chat-widget{animation:bb-chat-in .35s ease-out both}@keyframes bb-chat-in{from{opacity:0}to{opacity:1}}</style>\n' +
  '<link rel="preload" as="script" href="https://widgets.leadconnectorhq.com/loader.js">\n';
// The loader itself goes first thing in <body>, since it attaches the widget to the body.
const CHAT_SCRIPT = '<script src="https://widgets.leadconnectorhq.com/loader.js" data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js" data-widget-id="6af53870d6230b40f96f92c5" async></script>\n';

function parse(file) {
  const raw = fs.readFileSync(file, 'utf8');
  const m = raw.match(/^---\n([\s\S]*?)\n---\n/);
  const fm = {};
  if (m) m[1].split('\n').forEach((l) => { const i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  return { fm, body: m ? raw.slice(m[0].length) : raw };
}

function render(name, fm, body) {
  const urlPath = name === 'index' ? '/' : '/' + name;
  const layout = fm.layout || 'site';
  const usesCheckout = /payment-link\//.test(body);
  let head = partial.head
    .replace(/{{title}}/g, esc(fm.title || 'Build Boosters'))
    .replace('{{description_tag}}', fm.description ? `<meta name="description" content="${esc(fm.description)}">\n` : '')
    .replace('{{og_description_tag}}', fm.description ? `<meta property="og:description" content="${esc(fm.description)}">\n` : '')
    .replace('{{robots_tag}}', fm.robots ? `<meta name="robots" content="${esc(fm.robots)}">\n` : '')
    .replace(/{{path}}/g, urlPath);
  const year = String(new Date().getFullYear());
  let html = '<!doctype html>\n<html lang="en">\n<head>\n' + head;
  if (layout === 'site') html += FONTS + '\n<link rel="stylesheet" href="/assets/css/site.css">\n';
  // Chat widget on every page except the client demo sites (and any page that sets chat: false).
  const chat = layout !== 'demo' && fm.chat !== 'false';
  if (chat) html += CHAT;
  html += partial.tracking + '</head>\n<body>\n';
  if (chat) html += CHAT_SCRIPT;

  if (layout === 'site') {
    let header = partial.header;
    if (fm.nav) header = header.replace(`data-nav="${fm.nav}"`, `data-nav="${fm.nav}" class="on" aria-current="page"`);
    header = header.replace(`<a href="${urlPath}">`, `<a href="${urlPath}" aria-current="page">`);
    let footer = partial.footer.replace('{{year}}', year);
    if (name === 'index') { header = header.replace(/href="\/#build"/g, 'href="#build"'); footer = footer.replace(/href="\/#build"/g, 'href="#build"'); }
    html += header + '\n' + body + '\n' + footer + '\n';
  } else {
    html += body + '\n';
  }

  if (layout !== 'demo') html += GHL_TRACKING + '\n';
  if (layout === 'site') html += '<script src="/assets/js/site.js" defer></script>\n';
  else if (layout === 'bare') html += '<script src="/assets/js/site.js" defer></script>\n';
  if (layout === 'demo') html += '<script src="/assets/js/demo.js" defer></script>\n';
  if (usesCheckout) html += '<script src="/assets/js/checkout.js" defer></script>\n';
  html += '</body>\n</html>\n';
  return { html, urlPath, noindex: /noindex/.test(fm.robots || '') };
}

// Make the business phone number tap-to-call everywhere it appears as plain text
// (skips text already inside a link, and anything inside <head>, <script>, <style> or <title>).
const PHONE = '(786) 479-8856';
function linkPhone(html) {
  const out = []; let skip = 0; const SKIP = /^<(\/?)(a|script|style|title|head|textarea)\b/i;
  for (const part of html.split(/(<[^>]+>)/)) {
    if (part.startsWith('<')) { const m = part.match(SKIP); if (m) skip += m[1] ? -1 : 1; out.push(part); continue; }
    out.push(skip > 0 ? part : part.split(PHONE).join(`<a class="tel" href="tel:+17864798856">${PHONE}</a>`));
  }
  return out.join('');
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    const a = path.join(from, f), b = path.join(to, f);
    if (fs.statSync(a).isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
copyDir(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
if (fs.existsSync(path.join(ROOT, 'public'))) copyDir(path.join(ROOT, 'public'), OUT);

const urls = [];
for (const f of fs.readdirSync(path.join(SRC, 'pages')).filter((f) => f.endsWith('.html')).sort()) {
  const name = f.slice(0, -5);
  const { fm, body } = parse(path.join(SRC, 'pages', f));
  const { html, urlPath, noindex } = render(name, fm, body);
  fs.writeFileSync(path.join(OUT, name + '.html'), linkPhone(html));
  if (!noindex && fm.sitemap !== 'false') urls.push(urlPath);
}
// Any address that doesn't exist sends the visitor to the homepage. Vercel serves dist/404.html for unknown
// paths with a 404 status, so Google drops dead links instead of indexing them as copies of the homepage.
fs.writeFileSync(path.join(OUT, '404.html'), '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>Page not found | Build Boosters</title>\n<meta name="robots" content="noindex">\n' +
  '<link rel="icon" href="/favicon.ico" sizes="any">\n<meta http-equiv="refresh" content="0; url=/">\n<script>location.replace("/")</script>\n' +
  '</head>\n<body style="font-family:system-ui,sans-serif;background:#0b2440;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0">\n' +
  '<p>Taking you to the <a href="/" style="color:#f2a20c">Build Boosters homepage</a>.</p>\n</body>\n</html>\n');
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc></url>`).join('\n') + '\n</urlset>\n');
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`Built ${fs.readdirSync(OUT).filter((f) => f.endsWith('.html')).length} pages, ${urls.length} in the sitemap.`);
