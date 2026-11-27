// /api/domain — search, check availability, and register domains through Cloudflare Registrar.
//
// All actions require x-bb-secret header.
//
// GET  /api/domain?action=search&q=joes+plumbing+miami&limit=5
//   Returns candidate domain names with cached pricing.
//
// POST /api/domain  { action: "check", domains: ["joesplumbing.com", "joesplumbingmiami.com"] }
//   Live availability and pricing from the registry. Up to 20 domains per call.
//
// POST /api/domain  { action: "register", domain: "joesplumbingmiami.com" }
//   Registers the domain on the account's default payment method. Non-refundable.
//   Optionally pass { contact: { ... } } to override the default registrant.
//
// POST /api/domain  { action: "suggest", code: "abc123..." }
//   Generates domain suggestions from a client's onboarding answers, checks them, and returns
//   the available options with pricing. Does not register anything.
//
// Needs: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, BB_INTERNAL_SECRET,
//        plus the two Supabase variables (for the suggest action).
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const CF_BASE = 'https://api.cloudflare.com/client/v4';

function cfHeaders() {
  return {
    Authorization: `Bearer ${(process.env.CLOUDFLARE_API_TOKEN || '').trim()}`,
    'Content-Type': 'application/json',
  };
}

function cfAccount() {
  return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
}

// ---- Search: fast discovery from a keyword or phrase ----
async function searchDomains(query, limit = 10) {
  const url = `${CF_BASE}/accounts/${cfAccount()}/registrar/domain-search?q=${encodeURIComponent(query)}&limit=${limit}`;
  const res = await fetch(url, { headers: cfHeaders() });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare search ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.result?.domains || [];
}

// ---- Check: live registry availability for specific domains (up to 20) ----
async function checkDomains(domains) {
  if (!Array.isArray(domains) || domains.length === 0 || domains.length > 20) {
    throw new Error('domains must be an array of 1-20 domain names');
  }
  const url = `${CF_BASE}/accounts/${cfAccount()}/registrar/domain-check`;
  const res = await fetch(url, {
    method: 'POST',
    headers: cfHeaders(),
    body: JSON.stringify({ domains }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Cloudflare check ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.result?.domains || [];
}

// ---- Register: starts a registration workflow ----
async function registerDomain(domainName, contact) {
  const url = `${CF_BASE}/accounts/${cfAccount()}/registrar/registrations`;
  const body = { domain_name: domainName };
  if (contact) body.contacts = { registrant: contact };

  const res = await fetch(url, {
    method: 'POST',
    headers: cfHeaders(),
    body: JSON.stringify(body),
  });

  const data = await res.json();

  if (!res.ok) {
    const errMsg = data.errors?.map((e) => e.message).join('; ') || JSON.stringify(data).slice(0, 300);
    throw new Error(`Cloudflare register ${res.status}: ${errMsg}`);
  }

  return data.result;
}

// ---- Suggest: build domain candidates from a client's onboarding answers ----
async function suggestForClient(code) {
  const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=answers,prefill&limit=1`);
  const row = rows[0];
  if (!row) throw new Error('client_not_found');

  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const biz = a.business_name || '';
  const city = a.city || '';
  const trade = a.trade || '';

  if (!biz) throw new Error('no_business_name');

  // Build several search queries to get diverse suggestions
  const queries = [biz, `${biz} ${city}`, `${biz} ${trade}`].filter(Boolean);
  const seen = new Set();
  let all = [];

  for (const q of queries) {
    try {
      const results = await searchDomains(q, 5);
      for (const d of results) {
        if (!seen.has(d.name)) {
          seen.add(d.name);
          all.push(d);
        }
      }
    } catch (e) {
      console.error(`domain suggest search failed for "${q}":`, e.message);
    }
  }

  // Also build obvious slugs and check them directly
  function slugify(s) {
    return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 60);
  }

  const bizSlug = slugify(biz);
  const citySlug = slugify(city);
  const manualCandidates = [
    `${bizSlug}.com`,
    `${bizSlug}.net`,
    `${bizSlug}${citySlug}.com`,
    `${bizSlug}llc.com`,
  ].filter((d) => !seen.has(d));

  if (manualCandidates.length > 0) {
    try {
      const checked = await checkDomains(manualCandidates.slice(0, 20));
      for (const d of checked) {
        if (!seen.has(d.name)) {
          seen.add(d.name);
          all.push(d);
        }
      }
    } catch (e) {
      console.error('domain suggest manual check failed:', e.message);
    }
  }

  // Sort: registrable first, then by price ascending
  all.sort((a, b) => {
    if (a.registrable !== b.registrable) return a.registrable ? -1 : 1;
    const pa = parseFloat(a.pricing?.registration_cost || '999');
    const pb = parseFloat(b.pricing?.registration_cost || '999');
    return pa - pb;
  });

  return all;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (!configured() || !process.env.BB_INTERNAL_SECRET)
    return res.status(500).json({ error: 'not_configured', reason: 'Supabase or BB_INTERNAL_SECRET not set' });
  if (!allowed(req))
    return res.status(401).json({ error: 'unauthorized' });
  if (!cfAccount() || !process.env.CLOUDFLARE_API_TOKEN)
    return res.status(500).json({ error: 'not_configured', reason: 'CLOUDFLARE_API_TOKEN or CLOUDFLARE_ACCOUNT_ID not set' });

  try {
    // GET requests are search only
    if (req.method === 'GET') {
      const action = req.query?.action;
      if (action !== 'search') return res.status(400).json({ error: 'bad_request', reason: 'GET only supports action=search' });
      const q = req.query?.q;
      if (!q) return res.status(400).json({ error: 'bad_request', reason: 'q is required' });
      const limit = Math.min(Math.max(parseInt(req.query?.limit || '10', 10) || 10, 1), 20);
      const domains = await searchDomains(q, limit);
      return res.status(200).json({ ok: true, domains });
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

    const { action } = req.body || {};

    // ---- Check ----
    if (action === 'check') {
      const { domains } = req.body;
      const results = await checkDomains(domains);
      return res.status(200).json({ ok: true, domains: results });
    }

    // ---- Register ----
    if (action === 'register') {
      const { domain, contact, code } = req.body;
      if (!domain || typeof domain !== 'string') return res.status(400).json({ error: 'bad_request', reason: 'domain is required' });

      // Run a live check right before registration
      const liveCheck = await checkDomains([domain]);
      const info = liveCheck[0];
      if (!info?.registrable) {
        return res.status(409).json({
          error: 'domain_unavailable',
          domain,
          reason: info?.reason || 'not registrable',
        });
      }

      const result = await registerDomain(domain, contact || null);

      // If a client code was provided, save the domain to their record
      if (code) {
        try {
          await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}`, {
            method: 'PATCH',
            body: JSON.stringify({
              site_domain: domain,
              domain_registered_at: new Date().toISOString(),
            }),
          });
        } catch (e) {
          console.error('domain: failed to save domain to client record:', e.message);
        }
      }

      // Alert Maddie
      const cost = info.pricing?.registration_cost || '?';
      await sendAlert('Domain registered', `${domain} registered ($${cost}/yr). ${code ? `Client code: ${code}` : 'No client code.'}`).catch(() => {});

      return res.status(201).json({
        ok: true,
        domain,
        registration: result,
        pricing: info.pricing,
      });
    }

    // ---- Suggest ----
    if (action === 'suggest') {
      const { code } = req.body;
      if (!code) return res.status(400).json({ error: 'bad_request', reason: 'code is required' });
      const suggestions = await suggestForClient(code);
      return res.status(200).json({ ok: true, domains: suggestions });
    }

    return res.status(400).json({ error: 'bad_request', reason: 'action must be search, check, register, or suggest' });
  } catch (e) {
    console.error('domain', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.message || 'unknown' });
  }
};

// Exports for build-site to call directly
module.exports.searchDomains = searchDomains;
module.exports.checkDomains = checkDomains;
module.exports.registerDomain = registerDomain;
module.exports.suggestForClient = suggestForClient;
