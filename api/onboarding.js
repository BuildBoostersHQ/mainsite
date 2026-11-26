// /api/onboarding — reads and saves one client's onboarding answers in Supabase.
// The page never talks to Supabase directly: this function holds the key, looks the client up by the
// private code in their link, and only accepts the fields listed below. No dependencies.
//
// Needs two environment variables in Vercel: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const TABLE = 'client_onboarding';
const TEXT = ['business_name', 'business_phone', 'address', 'weekday_hours', 'weekends', 'services_other', 'areas_other',
  'vibes_other', 'years_in_business', 'years_experience', 'license', 'preferred_name', 'cell', 'job_software'];
const LISTS = { services: 40, areas: 60, vibes: 2, badges: 12 };
const ACTIONS = { request_google: 'google_requested_at', text_link: 'text_link_requested_at', submit: 'submitted_at' };
const CODE = /^[A-Za-z0-9_-]{12,64}$/;

function clean(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of TEXT) {
    if (key in input && (typeof input[key] === 'string' || typeof input[key] === 'number')) out[key] = String(input[key]).trim().slice(0, 300);
  }
  for (const [key, max] of Object.entries(LISTS)) {
    if (Array.isArray(input[key])) {
      out[key] = [...new Set(input[key].filter((v) => typeof v === 'string').map((v) => v.trim().slice(0, 80)).filter(Boolean))].slice(0, max);
    }
  }
  return out;
}

async function supabase(path, options = {}) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const find = async (code) => (await supabase(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`))[0] || null;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(500).json({ error: 'not_configured' });
  try {
    if (req.method === 'GET') {
      const code = String((req.query && req.query.code) || '');
      if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });
      const row = await find(code);
      if (!row) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({
        first_name: row.owner_first_name || '',
        launch_call_at: row.launch_call_at || '',
        video_url: row.video_url || '',
        photo_folder_url: row.photo_folder_url || '',
        google_requested: !!row.google_requested_at,
        text_link_requested: !!row.text_link_requested_at,
        submitted: !!row.submitted_at,
        options: row.options || {},
        // What we pulled from Google first, then anything the client has confirmed or changed on top.
        answers: { ...(row.prefill || {}), ...(row.answers || {}) },
      });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || !CODE.test(String(body.code || ''))) return res.status(404).json({ error: 'not_found' });
      const row = await find(body.code);
      if (!row) return res.status(404).json({ error: 'not_found' });
      const now = new Date().toISOString();
      const patch = { updated_at: now };
      const changes = clean(body.answers);
      if (Object.keys(changes).length) patch.answers = { ...(row.answers || {}), ...changes };
      const column = ACTIONS[body.action];
      if (body.action && !column) return res.status(400).json({ error: 'unknown_action' });
      // First time only, so the 24 hour clock and "who asked first" stay honest.
      if (column && !row[column]) patch[column] = now;
      await supabase(`${TABLE}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(200).json({ ok: true, saved_at: now });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    console.error('onboarding', err);
    return res.status(500).json({ error: 'server_error' });
  }
};
module.exports.clean = clean;
