// Shared by the internal endpoints (a2p-inbox, launch). Files that start with an underscore are not routes.
const crypto = require('crypto');

const baseUrl = () => String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const secret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function sb(path, options = {}) {
  const key = secret();
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(options.headers || {}) };
  // Old-style service_role keys are JWTs and also go in the Authorization header. New sb_secret_ keys go in apikey only.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  const res = await fetch(`${baseUrl()}/rest/v1/${path}`, { ...options, headers });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`Supabase ${res.status}: ${text}`);
    err.hint = res.status === 401 || res.status === 403 ? 'key_rejected'
      : /PGRST205|42P01|Could not find the table/i.test(text) ? 'table_missing'
      : /PGRST204|42703|column/i.test(text) ? 'table_out_of_date' : 'unknown';
    throw err;
  }
  const body = await res.text();
  return body ? JSON.parse(body) : [];
}

// These endpoints are for Build Boosters' own tools only. The caller sends BB_INTERNAL_SECRET in the
// x-bb-secret header. Returns true when it matches.
function allowed(req) {
  const want = String(process.env.BB_INTERNAL_SECRET || '').trim();
  const got = String(req.headers['x-bb-secret'] || '').trim();
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

const configured = () => !!baseUrl() && !!secret();
module.exports = { sb, allowed, configured };
