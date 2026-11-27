// /api/dns-setup — configures Cloudflare DNS records for a client domain to point at Vercel.
//
// POST /api/dns-setup  { domain: "example.com" }
//
// Sets up:
//   A record for @ → 76.76.21.21 (Vercel)
//   CNAME record for www → cname.vercel-dns.com
//
// Also assigns the domain to the client's Vercel project if a client code is provided.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');

const CF_BASE = 'https://api.cloudflare.com/client/v4';
const VERCEL_IP = '76.76.21.21';
const VERCEL_CNAME = 'cname.vercel-dns.com';

function cfHeaders() {
  return {
    Authorization: `Bearer ${(process.env.CLOUDFLARE_API_TOKEN || '').trim()}`,
    'Content-Type': 'application/json',
  };
}

function cfAccount() {
  return (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
}

// Get the zone ID for a domain. Cloudflare creates a zone automatically when a domain is registered.
async function getZoneId(domain) {
  const res = await fetch(`${CF_BASE}/zones?name=${encodeURIComponent(domain)}&account.id=${cfAccount()}`, {
    headers: cfHeaders(),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.result?.[0]?.id || null;
}

// Create or update a DNS record
async function upsertRecord(zoneId, type, name, content, proxied = true) {
  // Check if the record already exists
  const listRes = await fetch(
    `${CF_BASE}/zones/${zoneId}/dns_records?type=${type}&name=${encodeURIComponent(name)}`,
    { headers: cfHeaders() }
  );
  const listData = await listRes.json();
  const existing = listData.result?.[0];

  if (existing) {
    // Update
    const updateRes = await fetch(`${CF_BASE}/zones/${zoneId}/dns_records/${existing.id}`, {
      method: 'PATCH',
      headers: cfHeaders(),
      body: JSON.stringify({ content, proxied }),
    });
    return { action: 'updated', ok: updateRes.ok, id: existing.id };
  }

  // Create
  const createRes = await fetch(`${CF_BASE}/zones/${zoneId}/dns_records`, {
    method: 'POST',
    headers: cfHeaders(),
    body: JSON.stringify({ type, name, content, proxied, ttl: 1 }),
  });
  if (!createRes.ok) {
    const text = await createRes.text();
    return { action: 'failed', ok: false, error: text.slice(0, 300) };
  }
  const created = await createRes.json();
  return { action: 'created', ok: true, id: created.result?.id };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!cfAccount() || !process.env.CLOUDFLARE_API_TOKEN)
    return res.status(500).json({ error: 'not_configured', reason: 'Cloudflare credentials not set' });

  try {
    const { domain, code } = req.body || {};
    if (!domain) return res.status(400).json({ error: 'bad_request', reason: 'domain is required' });

    // Find the zone
    const zoneId = await getZoneId(domain);
    if (!zoneId) {
      return res.status(404).json({ error: 'zone_not_found', reason: `No Cloudflare zone found for ${domain}. Register the domain first.` });
    }

    // Set up DNS records
    const aRecord = await upsertRecord(zoneId, 'A', domain, VERCEL_IP, true);
    const cnameRecord = await upsertRecord(zoneId, 'CNAME', `www.${domain}`, VERCEL_CNAME, true);

    // If a client code was provided, also assign the domain to their Vercel project
    let vercelAssigned = false;
    if (code && process.env.VERCEL_TOKEN) {
      try {
        const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=site_project_id&limit=1`);
        const projectId = rows[0]?.site_project_id;
        if (projectId) {
          const vcQuery = process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';
          // Add both root and www
          for (const d of [domain, `www.${domain}`]) {
            await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains${vcQuery}`, {
              method: 'POST',
              headers: { Authorization: `Bearer ${process.env.VERCEL_TOKEN}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: d }),
            }).catch(() => {});
          }
          vercelAssigned = true;
        }
      } catch (e) {
        console.error('dns-setup: Vercel domain assignment failed:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      domain,
      zone_id: zoneId,
      records: { a: aRecord, cname: cnameRecord },
      vercel_assigned: vercelAssigned,
    });
  } catch (e) {
    console.error('dns-setup', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.message || 'unknown' });
  }
};
