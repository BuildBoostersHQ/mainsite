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


// Structured data (JSON-LD) added at build time, so every page gets it without hand-writing it.
const ORG = { '@type': ['Organization', 'ProfessionalService'], '@id': SITE + '/#org', name: 'Build Boosters', url: SITE + '/', description: 'Websites and lead systems for contractors and home service businesses.', image: 'https://files.leadconnectorhq.com/file/6af6120de2f577d4a30a6670/bb-share-image.png', priceRange: '$79-$997 per month',
  contactPoint: { '@type': 'ContactPoint', telephone: '+1-786-479-8856', contactType: 'customer service', areaServed: 'US', availableLanguage: 'English' },
  sameAs: ['https://github.com/BuildBoostersHQ'],
  logo: 'https://files.leadconnectorhq.com/file/6af6120d4a2360a4d7beffc8/bb-icon.png', telephone: '+1-786-479-8856',
  address: { '@type': 'PostalAddress', streetAddress: '82 NE 191st St, PMB 383218', addressLocality: 'Miami', addressRegion: 'FL', postalCode: '33179', addressCountry: 'US' } };
const PLANS = [['Website', 79], ['All-In-One', 197], ['All-In-One + Google Ads', 997]];
const textOf = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
function schema(name, fm, body) {
  const out = [];
  if (name === 'about' || name === 'contact') out.push({ '@context': 'https://schema.org', ...ORG });
  if (name === 'madeleine-jolie') out.push({ '@context': 'https://schema.org', '@type': 'Person', name: 'Madeleine Jolie', url: SITE + '/madeleine-jolie', jobTitle: 'Founder and CEO', worksFor: { '@id': SITE + '/#org', ...ORG } });
  if (name === 'index') {
    out.push({ '@context': 'https://schema.org', ...ORG });
    out.push({ '@context': 'https://schema.org', '@type': 'WebSite', name: 'Build Boosters', url: SITE + '/', publisher: { '@id': SITE + '/#org' } });
  }
  if (name === 'pricing') {
    out.push({ '@context': 'https://schema.org', '@type': 'Service', serviceType: 'Websites and marketing systems for contractors', provider: { '@id': SITE + '/#org', ...ORG },
      offers: PLANS.map(([n, p]) => ({ '@type': 'Offer', name: n, price: String(p), priceCurrency: 'USD', url: SITE + '/pricing' })) });
  }
  const city = name.match(/^contractor-website-design-(.+)$/);
  if (city) {
    const c = city[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
    out.push({ '@context': 'https://schema.org', '@type': 'Service', serviceType: 'Contractor website design', name: `Contractor websites in ${c}`,
      provider: { '@id': SITE + '/#org', ...ORG }, areaServed: { '@type': 'City', name: `${c}, FL` } });
  }
  // Breadcrumbs: Home > Blog > Post, Home > Trades > Trade, Home > Areas > City, Home > Page.
  if (name !== 'index' && fm.layout !== 'demo' && !/noindex/.test(fm.robots || '')) {
    const label = (fm.title || name).replace(/\s*\|\s*Build Boosters\s*$/, '').trim();
    const h1 = ((body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    const trail = [['Home', SITE + '/']];
    if (/^contractor-website-design-/.test(name)) trail.push(['Areas we serve', SITE + '/blog#areas']);
    else if (/^websites-for-/.test(name)) trail.push(['Trades', SITE + '/#trades']);
    else if (/<span class="crumb"><a href="\/blog"/.test(body)) trail.push(['Blog', SITE + '/blog']);
    trail.push([label || h1, SITE + '/' + name]);
    out.push({ '@context': 'https://schema.org', '@type': 'BreadcrumbList',
      itemListElement: trail.map(([n, u], i) => ({ '@type': 'ListItem', position: i + 1, name: textOf(n), item: u })) });
  }
  // FAQ blocks become FAQPage data, unless the page already has its own.
  if (!/"@type":\s*"FAQPage"/.test(body)) {
    const f = body.match(/<div class="faqs">([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/);
    const qa = f ? [...f[1].matchAll(/<h3[^>]*>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>/g)] : [];
    if (qa.length) out.push({ '@context': 'https://schema.org', '@type': 'FAQPage',
      mainEntity: qa.map((m) => ({ '@type': 'Question', name: textOf(m[1]), acceptedAnswer: { '@type': 'Answer', text: textOf(m[2]) } })) });
  }
  return out.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>\n`).join('');
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
  // Demo sites: apply the visitor's saved light/dark choice before paint (toggle lives in demo.js).
  if (layout === 'demo') html += '<script>try{var bbT=localStorage.getItem("bbTheme");if(bbT)document.documentElement.setAttribute("data-theme",bbT)}catch(e){}</script>\n';
  if (layout === 'site') html += FONTS + '\n<link rel="stylesheet" href="/assets/css/site.css">\n';
  // Chat widget on every page except the client demo sites (and any page that sets chat: false).
  const chat = layout !== 'demo' && fm.chat !== 'false';
  if (chat) html += CHAT;
  html += schema(name, fm, body);
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

// Blog index: every page with a "Blog ·" breadcrumb and a byline is listed on /blog automatically,
// newest first. City pages (contractor-website-design-*) and client guides get their own rows.
const MONTHS = 'January February March April May June July August September October November December'.split(' ');
function postInfo(name, body) {
  if (!/<span class="crumb"><a href="\/blog"/.test(body) || !/class="bb-meta"/.test(body)) return null;
  const pick = (re) => { const m = body.match(re); return m ? m[1].trim() : ''; };
  const meta = pick(/<div class="bb-meta">([\s\S]*?)<\/div>/).replace(/<[^>]+>/g, '|');
  const dm = meta.match(/([A-Z][a-z]+) (\d{1,2}, )?(\d{4})/);
  const date = dm ? new Date(+dm[3], MONTHS.indexOf(dm[1]), dm[2] ? parseInt(dm[2]) : 1) : new Date(0);
  const category = pick(/<span class="crumb"><a href="\/blog"[^>]*>Blog<\/a>\s*(?:&#xb7;|·)\s*([^<]*)</);
  const cat = category.replace('Follow-Up', 'follow-up');
  return {
    href: "/" + name, date, category, cat,
    kind: name.startsWith('contractor-website-design-') ? 'city' : /client guide/i.test(category) ? 'guide' : 'post',
    title: pick(/<h1>([\s\S]*?)<\/h1>/).replace(/<[^>]+>/g, ''),
    desc: pick(/<section class="phero"[\s\S]*?<\/h1>\s*<p>([\s\S]*?)<\/p>/),
    image: pick(/--pimg:url\('([^']+)'\)/),
    read: pick(/(\d+ min read)/),
  };
}
const ALT = { remodeling: 'Kitchen remodeling contractor at work', roofing: 'Roofing contractor installing shingles', plumbing: 'Plumber repairing pipes under a sink', hvac: 'HVAC technician servicing an AC unit', electrical: 'Electrician working on an electrical panel', handyman: 'Handyman doing home repairs', landscaping: 'Landscaper maintaining a lawn and garden', painting: 'House painter painting a wall', pressure: 'Pressure washing a driveway' };
const card = (p) => {
  const k = (p.image.match(/bb-t-([a-z0-9]+)\./) || [])[1];
  return `<a class="bb-card" href="${p.href}"><img src="${p.image}" alt="${ALT[k] || ''}" loading="lazy"><div><small>${p.kind === 'city' ? 'Local' : p.cat}</small><h3>${p.title}</h3><p>${p.desc}</p><span class="rd">${p.read} &#x2192;</span></div></a>`;
};
const CATS = [
  ['Websites', /^websites?$/i], ['Reviews', /^reviews?$/i], ['Lead follow-up', /follow-up|follow up/i], ['Local SEO', /local seo/i],
  ['Getting more work', /^(leads|getting leads|getting work|marketing)$/i], ['Comparisons', /comparison/i], ['Guides and tools', /guide|tool/i],
];
function blogIndex(body, posts) {
  const by = (k) => posts.filter((p) => p.kind === k).sort((a, b) => b.date - a.date || a.title.localeCompare(b.title));
  const list = by('post'), cities = by('city').sort((a, b) => a.title.localeCompare(b.title)), guides = by('guide');
  const rest = list.slice(1), used = new Set();
  let cats = '';
  for (const [name, re] of CATS) {
    const items = rest.filter((p) => !used.has(p) && re.test(p.category));
    if (!items.length) continue;
    items.forEach((p) => used.add(p));
    const id = name.toLowerCase().replace(/[^a-z]+/g, '-');
    cats += `<div style="margin-top:56px" id="${id}"><span class="eyebrow">${name}</span><div class="bb-cards">${items.map(card).join('')}</div></div>`;
  }
  const other = rest.filter((p) => !used.has(p));
  if (other.length) cats += `<div style="margin-top:56px"><span class="eyebrow">More articles</span><div class="bb-cards">${other.map(card).join('')}</div></div>`;
  const jsonld = { '@context': 'https://schema.org', '@type': 'Blog', name: 'Build Boosters Blog', url: SITE + '/blog',
    blogPost: list.map((p) => ({ '@type': 'BlogPosting', headline: p.title, url: SITE + p.href, datePublished: p.date.toISOString().slice(0, 10) })) };
  return body
    .replace('{{blog:featured}}', list.length ? `<div class="bb-cards feat">${card(list[0])}</div>` : '')
    .replace('{{blog:categories}}', cats)
    .replace('{{blog:cities}}', `<div class="bb-cards">${cities.map(card).join('')}</div>`)
    .replace('{{blog:guides}}', `<div class="bb-cards two">${guides.map(card).join('')}</div>`)
    .replace('{{blog:jsonld}}', `<script type="application/ld+json">${JSON.stringify(jsonld)}</script>`);
}

// Author box under every blog post, and a link from the byline to the author page.
const AUTHOR_URL = '/madeleine-jolie';
const AUTHOR_BOX = '<aside class="bb-author" aria-label="About the author"><span class="av"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20h18"/><path d="M5 20V10l7-6 7 6v10"/><path d="M9 15l3-3 3 3"/><path d="M12 12v8"/></svg></span><div><h3>Written by <a href="' + AUTHOR_URL + '">Madeleine Jolie</a></h3><p>Maddie is the founder of Build Boosters, which builds websites and follow-up systems for contractors. Before starting it, she worked at GoHighLevel with the agency owners who set up these systems for small businesses.</p></div></aside>';
function addAuthor(body) {
  if (!/<span class="crumb"><a href="\/blog"/.test(body) || !/class="bb-meta"/.test(body)) return body;
  body = body.replace('<span>By <b>Madeleine Jolie</b></span>', `<span>By <a href="${AUTHOR_URL}" style="color:inherit"><b>Madeleine Jolie</b></a></span>`);
  body = body.replace('</article>', '</article>' + AUTHOR_BOX);
  return body.replace(/"author": \{"@type": "Person", "name": "Madeleine Jolie"\}/, `"author": {"@type": "Person", "name": "Madeleine Jolie", "url": "${SITE}${AUTHOR_URL}", "jobTitle": "Founder and CEO, Build Boosters"}`);
}


// Article tables: label each cell with its column name, so on phones each row can stack as a card.
function labelTables(html) {
  return html.replace(/<table>([\s\S]*?)<\/table>/g, (t, inner) => {
    const head = (inner.match(/<thead>([\s\S]*?)<\/thead>/) || [])[1] || '';
    const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => m[1].replace(/<[^>]+>/g, '').replace(/"/g, '&quot;'));
    const body = inner.replace(/<tr>([\s\S]*?)<\/tr>/g, (r, cells) => {
      if (/<thead>/.test(r)) return r;
      let i = 0;
      return '<tr>' + cells.replace(/<(td|th)( scope="row")?>/g, (m, tag, sc) => { const lab = cols[i++] || ''; return `<${tag}${sc || ''}${lab ? ` data-label="${lab}"` : ''}>`; }) + '</tr>';
    });
    return '<table>' + body.replace(/(<thead>[\s\S]*?<\/thead>)/, (h) => h.replace(/ data-label="[^"]*"/g, '')) + '</table>';
  });
}

const pages = fs.readdirSync(path.join(SRC, 'pages')).filter((f) => f.endsWith('.html')).sort()
  .map((f) => ({ name: f.slice(0, -5), ...parse(path.join(SRC, 'pages', f)) }));
const posts = pages.map((p) => postInfo(p.name, p.body)).filter(Boolean);

// Sitemap lastmod: the page's own dateModified if it has one, otherwise the last git commit that touched it.
const { execSync } = require('child_process');
function lastmod(name, body) {
  const m = body.match(/"dateModified":\s*"(\d{4}-\d{2}-\d{2})/);
  if (m) return m[1];
  try { return execSync(`git log -1 --format=%cs -- src/pages/${name}.html`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || ''; } catch (e) { return ''; }
}
const urls = [];
for (const { name, fm, body } of pages) {
  const content = name === 'blog' ? blogIndex(body, posts) : addAuthor(body);
  const { html, urlPath, noindex } = render(name, fm, content);
  fs.writeFileSync(path.join(OUT, name + '.html'), linkPhone(labelTables(html)));
  if (!noindex && fm.sitemap !== 'false') urls.push([urlPath, lastmod(name, body)]);
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
  urls.map(([u, d]) => `  <url><loc>${SITE}${u}</loc>${d ? `<lastmod>${d}</lastmod>` : ''}</url>`).join('\n') + '\n</urlset>\n');
fs.writeFileSync(path.join(OUT, 'robots.txt'), fs.readFileSync(path.join(SRC, 'robots.txt'), 'utf8'));
console.log(`Built ${fs.readdirSync(OUT).filter((f) => f.endsWith('.html')).length} pages, ${urls.length} in the sitemap, ${posts.length} on the blog.`);
