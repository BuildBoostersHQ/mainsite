// /api/prospect-link — links a prospect from the outreach pipeline to a client in the onboarding table.
//
// The two live in different Supabase projects (prospects in the maddiejolie database, clients in the
// Build Boosters database). This endpoint bridges them: when a prospect pays, the Stripe webhook
// saves their phone or email, and this endpoint copies useful data from the prospect record into
// the client's prefill.
//
// POST /api/prospect-link  { code, prospect_phone?, prospect_email? }
//   - Looks up the prospect in the maddiejolie Supabase by phone or email
//   - If found, copies their business name, trade, city, owner name, and Google profile URL
//     into the client's prefill and options
//   - Returns what was copied so the caller knows what to show on the form
//
// Needs BB_INTERNAL_SECRET, MJ_SUPABASE_URL and MJ_SUPABASE_KEY (the maddiejolie Supabase project).
const { sb, allowed, configured } = require('./_sb');

const CODE = /^[a-f0-9]{16,64}$/i;

// Talk to the maddiejolie Supabase (the prospect database)
async function mjQuery(path) {
  const url = (process.env.MJ_SUPABASE_URL || '').trim().replace(/\/+$/, '');
  const key = (process.env.MJ_SUPABASE_KEY || '').trim();
  if (!url || !key) return null;
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, { headers });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data) ? data[0] || null : data;
  } catch { return null; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  const { code, prospect_phone, prospect_email } = req.body || {};
  if (!CODE.test(String(code || ''))) return res.status(400).json({ error: 'bad_code' });

  if (!process.env.MJ_SUPABASE_URL || !process.env.MJ_SUPABASE_KEY) {
    return res.status(200).json({ ok: true, linked: false, reason: 'mj_supabase_not_configured' });
  }

  try {
    // Find the prospect by phone first, then email
    let prospect = null;
    const phone = String(prospect_phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    if (phone.length === 10) {
      prospect = await mjQuery(`prospects?phone=ilike.*${phone}&select=name,owner_name,trade,city,state,rating,review_count,google_place_url,demo_slug&limit=1`);
    }
    if (!prospect && prospect_email) {
      // Prospects don't always have email, but try
      prospect = await mjQuery(`prospects?select=name,owner_name,trade,city,state,rating,review_count,google_place_url,demo_slug&limit=1&or=(name.ilike.*${encodeURIComponent(prospect_email.split('@')[0])}*)`);
    }
    if (!prospect) {
      return res.status(200).json({ ok: true, linked: false, reason: 'prospect_not_found' });
    }

    // Build the prefill additions from the prospect data
    const prefill = {};
    if (prospect.name) prefill.business_name = prospect.name;
    if (prospect.owner_name) prefill.preferred_name = prospect.owner_name.split(' ')[0];
    if (prospect.trade) prefill.trade = prospect.trade;
    if (prospect.google_place_url) prefill.google_place_url = prospect.google_place_url;

    // Build options (services and areas from the prospect's trade defaults)
    const options = {};
    if (prospect.city && prospect.state) {
      options.primary_city = prospect.city;
      options.primary_state = prospect.state;
    }

    // Merge into the client's existing prefill (don't overwrite what's already there)
    const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=id,prefill,options&limit=1`);
    if (!rows.length) return res.status(404).json({ error: 'client_not_found' });
    const client = rows[0];
    const merged_prefill = { ...prefill, ...(client.prefill || {}) };
    const merged_options = { ...(client.options || {}), ...options };

    await sb(`client_onboarding?id=eq.${client.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        prefill: merged_prefill,
        options: merged_options,
        prospect_name: prospect.name || null,
        prospect_trade: prospect.trade || null,
      }),
    });

    return res.status(200).json({
      ok: true,
      linked: true,
      prospect: { name: prospect.name, trade: prospect.trade, city: prospect.city, rating: prospect.rating, reviews: prospect.review_count },
      prefilled: Object.keys(prefill),
    });
  } catch (e) {
    console.error('prospect-link', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
