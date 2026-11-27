// /api/domain-connect — for clients who already own a domain and want their new site on it.
//
// GET /api/domain-connect?code=...            the client's page at /connect-domain/<code> calls this
//   Looks up where the domain is registered and where its DNS is managed, returns step-by-step
//   instructions for that company, and checks whether the domain points at the site yet.
//   The first time it sees the domain pointing correctly, it saves site_domain and tells Maddie.
//
// The instructions only ever change two records (the A record and the www CNAME). Nameservers and
// email records are left alone, so the client's email keeps working.
//
// Auth: the client's setup code. Needs the two Supabase variables. VERCEL_TOKEN is used, when it is
// set, to attach the domain to the client's Vercel project.
const { sb, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const TABLE = 'client_onboarding';
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const A_RECORD = '76.76.21.21';
const WWW_TARGET = 'cname.vercel-dns.com';

function cleanDomain(raw) {
  const d = String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : '';
}

// Who to sign in to. Matched on the nameservers first, because that is where the DNS records live
// (a domain bought at GoDaddy but connected to Wix is edited in Wix), then on the registrar's name.
const PROVIDERS = [
  { key: 'cloudflare', name: 'Cloudflare', ns: /cloudflare\.com$/, reg: /cloudflare/i, url: 'https://dash.cloudflare.com',
    open: ['Sign in at dash.cloudflare.com and click your domain.', 'In the menu on the left, click DNS, then Records.'],
    extra: 'On both records, click the orange cloud so it turns gray and says "DNS only".' },
  { key: 'godaddy', name: 'GoDaddy', ns: /domaincontrol\.com$/, reg: /godaddy|wild west domains/i, url: 'https://dcc.godaddy.com/domains',
    open: ['Sign in at godaddy.com and open My Products.', 'Find your domain and click DNS next to it.'] },
  { key: 'namecheap', name: 'Namecheap', ns: /registrar-servers\.com$/, reg: /namecheap/i, url: 'https://ap.www.namecheap.com/domains/list/',
    open: ['Sign in at namecheap.com and open Domain List.', 'Click Manage next to your domain, then open the Advanced DNS tab.'] },
  { key: 'squarespace', name: 'Squarespace', ns: /squarespacedns\.com$|googledomains\.com$/, reg: /squarespace|google/i, url: 'https://account.squarespace.com/domains',
    open: ['Sign in at account.squarespace.com and open Domains. Domains bought from Google moved here.', 'Click your domain, then DNS Settings.'] },
  { key: 'wix', name: 'Wix', ns: /wixdns\.net$/, reg: /wix\.com/i, url: 'https://manage.wix.com/account/domains',
    open: ['Sign in at wix.com and open Domains.', 'Click the three dots next to your domain, then Manage DNS Records.'] },
  { key: 'networksolutions', name: 'Network Solutions', ns: /worldnic\.com$/, reg: /network solutions/i, url: 'https://www.networksolutions.com/my-account/login',
    open: ['Sign in at networksolutions.com and open Domain Names.', 'Click Manage next to your domain, then Advanced Tools, then Manage next to Advanced DNS Records.'] },
  { key: 'ionos', name: 'IONOS', ns: /ui-dns\.(com|net|org|de|biz)$/, reg: /ionos|1&1/i, url: 'https://my.ionos.com/domains',
    open: ['Sign in at ionos.com and open Domains & SSL.', 'Click your domain, then the DNS tab.'] },
  { key: 'bluehost', name: 'Bluehost', ns: /bluehost\.com$/, reg: /bluehost/i, url: 'https://my.bluehost.com',
    open: ['Sign in at bluehost.com and open Domains.', 'Click Settings next to your domain, then Advanced Tools, then Manage next to Advanced DNS Records.'] },
];

function pickProvider(nameservers, registrar) {
  for (const p of PROVIDERS) if (nameservers.some((n) => p.ns.test(n))) return p;
  for (const p of PROVIDERS) if (p.reg.test(registrar || '')) return p;
  return null;
}

function steps(domain, provider, registrar) {
  const open = provider ? provider.open
    : [`Sign in to the company where you manage ${domain}${registrar ? `, which looks like ${registrar}` : ''}.`, 'Find the page called DNS, DNS Records or Zone Editor for your domain.'];
  const list = [
    ...open,
    `Find the record with Type "A" and Name "@" (some companies leave the name blank). Change its value to ${A_RECORD}. If there is no such record, add one. If there is more than one, delete the extras.`,
    `Find the record with Name "www". Change it to Type "CNAME" with the value ${WWW_TARGET}. If there is no www record, add one.`,
  ];
  if (provider && provider.extra) list.push(provider.extra);
  list.push('Leave everything else alone, especially anything with Type "MX" or "TXT". Those run your email.', 'Save, then come back here and tap the button below. It can take up to an hour to show up.');
  return list;
}

// Registrar and nameservers from the public registration record.
async function whois(domain) {
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, { headers: { Accept: 'application/rdap+json' }, redirect: 'follow' });
    if (!res.ok) return { registrar: '', nameservers: [], registered: res.status !== 404 };
    const data = await res.json();
    const entity = (data.entities || []).find((e) => (e.roles || []).includes('registrar'));
    const fn = entity && entity.vcardArray && (entity.vcardArray[1] || []).find((v) => v[0] === 'fn');
    return {
      registrar: fn ? String(fn[3] || '') : '',
      nameservers: (data.nameservers || []).map((n) => String(n.ldhName || '').toLowerCase()).filter(Boolean),
      registered: true,
    };
  } catch { return { registrar: '', nameservers: [], registered: true }; }
}

async function resolve(name, type) {
  try {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`, { headers: { Accept: 'application/dns-json' } });
    const data = await res.json();
    return (data.Answer || []).map((a) => String(a.data || '').replace(/\.$/, '').toLowerCase());
  } catch { return []; }
}

async function pointing(domain) {
  const [root, www] = await Promise.all([resolve(domain, 'A'), resolve(`www.${domain}`, 'A')]);
  const onVercel = (list) => list.some((v) => v === A_RECORD || /vercel-dns/.test(v) || /^76\.76\.21\./.test(v) || /^216\.198\.79\./.test(v));
  return { root: onVercel(root), www: onVercel(www) };
}

async function attachToVercel(projectId, domain) {
  const token = (process.env.VERCEL_TOKEN || '').trim();
  if (!token || !projectId) return false;
  const q = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';
  let ok = true;
  for (const name of [domain, `www.${domain}`]) {
    const res = await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains${q}`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    }).catch(() => null);
    if (!res || (!res.ok && res.status !== 409)) ok = false;
  }
  return ok;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured()) return res.status(500).json({ error: 'not_configured' });
  try {
    const code = String(req.query?.code || '').trim();
    if (!CODE.test(code)) return res.status(401).json({ error: 'unauthorized' });
    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=id,owner_first_name,prefill,answers,site_domain,site_project_id,nudges_sent&limit=1`);
    const row = rows[0];
    if (!row) return res.status(401).json({ error: 'unauthorized' });
    const a = { ...(row.prefill || {}), ...(row.answers || {}) };
    const domain = cleanDomain(a.domain_own);
    const first_name = row.owner_first_name || a.preferred_name || '';
    if (!domain) return res.status(200).json({ ok: true, first_name, domain: '' });

    const [who, status] = await Promise.all([whois(domain), pointing(domain)]);
    const provider = pickProvider(who.nameservers, who.registrar);
    const connected = status.root && status.www;

    const nudges = { ...(row.nudges_sent || {}) };
    const patch = {};
    if (row.site_project_id && !nudges.own_domain_attached && await attachToVercel(row.site_project_id, domain)) {
      nudges.own_domain_attached = new Date().toISOString(); patch.nudges_sent = nudges;
    }
    if (connected && row.site_domain !== domain) {
      patch.site_domain = domain;
      await sendAlert('Client domain connected', `${a.business_name || first_name || code.slice(0, 8)} pointed ${domain} at their new site. Check it loads with the padlock.`).catch(() => {});
    }
    if (Object.keys(patch).length) await sb(`${TABLE}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });

    return res.status(200).json({
      ok: true, first_name, domain,
      registered: who.registered,
      registrar: who.registrar,
      managed_at: provider ? provider.name : '',
      sign_in_url: provider ? provider.url : '',
      // When the DNS lives somewhere other than where the domain was bought, say so.
      note: provider && who.registrar && !provider.reg.test(who.registrar) ? `Your domain was bought through ${who.registrar}, but its settings are managed at ${provider.name}, so that is where you sign in.` : '',
      records: [{ type: 'A', name: '@', value: A_RECORD }, { type: 'CNAME', name: 'www', value: WWW_TARGET }],
      steps: steps(domain, provider, who.registrar),
      status: { ...status, connected },
    });
  } catch (e) {
    console.error('domain-connect', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
Object.assign(module.exports, { cleanDomain, pickProvider, steps });
