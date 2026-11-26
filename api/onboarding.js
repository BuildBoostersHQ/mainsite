// /api/onboarding — reads and saves one client's onboarding answers in Supabase.
// The page never talks to Supabase directly: this function holds the key, looks the client up by the
// private code in their link, and only accepts the fields listed below. No dependencies.
//
// Needs two environment variables in Vercel: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const TABLE = 'client_onboarding';
const TEXT = ['business_name', 'business_phone', 'address', 'weekday_hours', 'weekends', 'services_other', 'areas_other',
  'vibes_other', 'years_in_business', 'years_experience', 'license', 'preferred_name', 'cell', 'job_software', 'domain_choice', 'domain_own', 'email', 'a2p_legal_name', 'a2p_entity_type', 'trade', 'style', 'brand_color'];
const LONG = ['site_notes'];  // free text for whoever builds the site
const FLAGS = ['photo_reminders', 'show_address', 'google_updates_opt_out'];
// The exact words the client agreed to on the page. Saved with the time, so there is a record of the consent.
const SMS_CONSENT = 'I agree to receive service texts from Build Boosters at the cell number I gave above, about my account, my website and my setup. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.';
// 12 services and 10 towns is what the client site template builds pages for.
const LISTS = { services: 12, areas: 10, vibes: 2, badges: 12 };
const ACTIONS = { request_google: 'google_requested_at', text_link: 'text_link_requested_at', submit: 'submitted_at' };
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const BUCKET = 'client-photos';
const MAX_PHOTOS = 60;           // per client
const MAX_PHOTO_BYTES = 3000000;  // after the phone has shrunk it

function clean(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of TEXT) {
    if (key in input && (typeof input[key] === 'string' || typeof input[key] === 'number')) out[key] = String(input[key]).trim().slice(0, 300);
  }
  for (const key of LONG) if (typeof input[key] === 'string') out[key] = input[key].trim().slice(0, 1500);
  if (out.brand_color && !/^#[0-9a-f]{6}$/i.test(out.brand_color)) out.brand_color = '';
  for (const key of FLAGS) if (typeof input[key] === 'boolean') out[key] = input[key];
  for (const [key, max] of Object.entries(LISTS)) {
    if (Array.isArray(input[key])) {
      out[key] = [...new Set(input[key].filter((v) => typeof v === 'string').map((v) => v.trim().slice(0, 80)).filter(Boolean))].slice(0, max);
    }
  }
  return out;
}

// Pasted values often pick up a stray space, a trailing slash or the /rest/v1 path. Clean those off.
const baseUrl = () => String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const secret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

async function supabase(path, options = {}) {
  const key = secret();
  const headers = { apikey: key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(options.headers || {}) };
  // Old-style service_role keys are JWTs and also go in the Authorization header. New sb_secret_ keys go in apikey only.
  if (!key.startsWith('sb_')) headers.Authorization = `Bearer ${key}`;
  let res;
  try { res = await fetch(`${baseUrl()}/rest/v1/${path}`, { ...options, headers }); }
  catch (e) { const err = new Error('cannot reach Supabase'); err.hint = 'cannot_reach_supabase'; throw err; }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`Supabase ${res.status}: ${text}`);
    // A short reason the page owner can act on. Never includes keys or client data.
    if (res.status === 401 || res.status === 403) err.hint = 'key_rejected';
    else if (/PGRST205|42P01|Could not find the table/i.test(text)) err.hint = 'table_missing';
    else if (/PGRST204|42703|column/i.test(text)) err.hint = 'table_out_of_date';
    else if (res.status === 404) err.hint = 'wrong_project_url';
    throw err;
  }
  return res.json();
}

// Saves one photo into the private client-photos bucket, under that client's own folder.
async function storePhoto(row, base64) {
  const bytes = Buffer.from(String(base64), 'base64');
  const jpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (!jpeg || bytes.length > MAX_PHOTO_BYTES) { const e = new Error('bad photo'); e.status = 400; e.code = 'photo_invalid'; throw e; }
  const key = secret();
  const name = `${row.id}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  let res;
  try {
    res = await fetch(`${baseUrl()}/storage/v1/object/${BUCKET}/${name}`, {
      method: 'POST', body: bytes,
      // Storage wants the key in both places. Supabase allows that when the two values match exactly.
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    });
  } catch (e) { const err = new Error('cannot reach Supabase'); err.hint = 'cannot_reach_supabase'; throw err; }
  if (!res.ok) {
    const text = (await res.text()).slice(0, 300);
    const err = new Error(`Supabase storage ${res.status}: ${text}`);
    err.hint = /bucket.*not found|Bucket not found/i.test(text) ? 'photo_bucket_missing' : (res.status === 401 || res.status === 403) ? 'key_rejected' : 'photo_store_failed';
    throw err;
  }
  return name;
}

const find = async (code) => (await supabase(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`))[0] || null;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (!baseUrl() || !secret()) return res.status(500).json({ error: 'not_configured' });
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(baseUrl())) return res.status(500).json({ error: 'server_error', reason: 'wrong_project_url' });
  try {
    if (req.method === 'GET') {
      const code = String((req.query && req.query.code) || '');
      if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });
      const row = await find(code);
      if (!row) return res.status(404).json({ error: 'not_found' });
      return res.status(200).json({
        first_name: row.owner_first_name || '',
        tier: row.tier || '',
        billing_cycle: row.billing_cycle || '',
        // The EIN itself is never sent back to the page, only whether we have one.
        ein_on_file: !!row.ein_private,
        launch_call_at: row.launch_call_at || '',
        video_url: row.video_url || '',
        photo_folder_url: row.photo_folder_url || '',
        google_requested: !!row.google_requested_at,
        text_link_requested: !!row.text_link_requested_at,
        submitted: !!row.submitted_at,
        photo_count: row.photo_count || 0,
        sms_consent: !!row.sms_consent_at,
        google_approved: !!row.google_approved_at,
        launch_call_start: row.launch_call_start || '',
        // The $30 thank-you runs out 24 hours after the client's page was created.
        credit_deadline: row.created_at ? new Date(new Date(row.created_at).getTime() + 24 * 3600 * 1000).toISOString() : '',
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
      if (body.photo !== undefined) {
        if ((row.photo_count || 0) >= MAX_PHOTOS) return res.status(400).json({ error: 'photo_limit' });
        await storePhoto(row, body.photo);
        patch.photo_count = (row.photo_count || 0) + 1;
        patch.photos_last_at = now;
      }
      if (body.ein !== undefined) {
        // Kept in its own column, away from the other answers, and wiped by the database once texting is registered.
        const ein = String(body.ein).replace(/\D/g, '');
        if (ein.length !== 9) return res.status(400).json({ error: 'ein_invalid' });
        patch.ein_private = ein; patch.ein_provided_at = now; patch.ein_deleted_at = null;
      }
      const column = ACTIONS[body.action];
      if (body.action && !column) return res.status(400).json({ error: 'unknown_action' });
      if (body.action === 'submit') {
        // Setup cannot finish without a cell number and a yes to service texts.
        const cell = String((patch.answers || row.answers || {}).cell || '').replace(/\D/g, '');
        if (cell.length < 10) return res.status(400).json({ error: 'cell_required' });
        if (body.sms_consent !== true && !row.sms_consent_at) return res.status(400).json({ error: 'consent_required' });
        if (!row.sms_consent_at) { patch.sms_consent_at = now; patch.sms_consent_text = SMS_CONSENT; patch.sms_consent_cell = cell; }
      }
      // First time only, so the 24 hour clock and "who asked first" stay honest.
      if (column && !row[column]) patch[column] = now;
      await supabase(`${TABLE}?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(200).json({ ok: true, saved_at: now, photo_count: patch.photo_count });
    }
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.code });
    console.error('onboarding', err.message);
    return res.status(500).json({ error: 'server_error', reason: err.hint || 'unknown' });
  }
};
module.exports.clean = clean;
