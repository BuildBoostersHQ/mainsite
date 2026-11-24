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
const CHAT = '<script src="https://widgets.leadconnectorhq.com/loader.js" data-resources-url="https://widgets.leadconnectorhq.com/chat-widget/loader.js" data-widget-id="6af53870d6230b40f96f92c5" defer></script>';

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
  const hasForm = /<form[\s>]/.test(body);
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
  html += partial.tracking + '</head>\n<body>\n';

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
  const chat = fm.chat ? fm.chat === 'true' : (layout === 'site' && !hasForm);
  if (chat) html += CHAT + '\n';
  html += '</body>\n</html>\n';
  return { html, urlPath, noindex: /noindex/.test(fm.robots || '') };
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
  fs.writeFileSync(path.join(OUT, name + '.html'), html);
  if (!noindex && fm.sitemap !== 'false') urls.push(urlPath);
}
fs.writeFileSync(path.join(OUT, 'sitemap.xml'),
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  urls.map((u) => `  <url><loc>${SITE}${u === '/' ? '/' : u}</loc></url>`).join('\n') + '\n</urlset>\n');
fs.writeFileSync(path.join(OUT, 'robots.txt'), `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
console.log(`Built ${fs.readdirSync(OUT).filter((f) => f.endsWith('.html')).length} pages, ${urls.length} in the sitemap.`);
