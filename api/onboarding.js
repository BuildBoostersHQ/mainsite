// /api/onboarding — reads and saves one client's onboarding answers in Supabase.
// The page never talks to Supabase directly: this function holds the key, looks the client up by the
// private code in their link, and only accepts the fields listed below. No dependencies.
//
// Needs two environment variables in Vercel: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const TABLE = 'client_onboarding';
const TEXT = ['business_name', 'business_phone', 'address', 'weekday_hours', 'weekends', 'services_other', 'areas_other',
  'vibes_other', 'years_in_business', 'years_experience', 'license', 'preferred_name', 'cell', 'job_software', 'domain_choice', 'domain_own', 'email', 'a2p_legal_name', 'a2p_entity_type', 'trade', 'style', 'brand_color',
  // The registration address, picked from Google's list on /welcome or /start. a2p_address_check is what /api/address said about it.
  'a2p_address', 'a2p_street', 'a2p_unit', 'a2p_city', 'a2p_state', 'a2p_zip', 'a2p_address_check',
  // The person the registration is filed under: legal first and last name, a personal email the carriers accept, and a date of birth.
  'a2p_first_name', 'a2p_last_name', 'a2p_email', 'a2p_dob'];
const LONG = ['site_notes'];  // free text for whoever builds the site
const FLAGS = ['photo_reminders', 'show_address', 'google_updates_opt_out', 'a2p_ein_recent'];
// The exact words the client agreed to on the page. Saved with the time, so there is a record of the consent.
const SMS_CONSENT = 'I agree to receive service texts from Build Boosters at the cell number I gave above, about my account, my website and my setup. Message frequency varies. Message and data rates may apply. Reply STOP to opt out or HELP for help.';
// 12 services and 10 towns is what the client site template builds pages for.
const LISTS = { services: 12, areas: 10, vibes: 2, badges: 12 };
const ACTIONS = { request_google: 'google_requested_at', text_link: 'text_link_requested_at', submit: 'submitted_at' };
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
// A Stripe checkout id, which Stripe puts in the /welcome address after payment.
const SESSION = /^cs_(live|test)_[A-Za-z0-9]{10,200}$/;
// The carriers turn down a registration whose address is a P.O. box.
const PO_BOX = /\b(p\.?\s*o\.?\s*b(ox)?\.?|post\s+office\s+box|pob)\s*#?\s*\d+/i;
const BUCKET = 'client-photos';
const MAX_PHOTOS = 60;           // per client
const MAX_PHOTO_BYTES = 3000000;  // after the phone has shrunk it

function validDob(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) return false;
  const age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
  return age >= 18 && age <= 100;
}

function clean(input) {
  const out = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const key of TEXT) {
    if (key in input && (typeof input[key] === 'string' || typeof input[key] === 'number')) out[key] = String(input[key]).trim().slice(0, 300);
  }
  for (const key of LONG) if (typeof input[key] === 'string') out[key] = input[key].trim().slice(0, 1500);
  if (out.brand_color && !/^#[0-9a-f]{6}$/i.test(out.brand_color)) out.brand_color = '';
  // A date of birth is kept only as a real date for an adult, and an email only when it looks like one.
  if ('a2p_dob' in out && !validDob(out.a2p_dob)) delete out.a2p_dob;
  if (out.a2p_email && !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(out.a2p_email)) delete out.a2p_email;
  if (PO_BOX.test(out.a2p_address || '') || PO_BOX.test(out.a2p_street || '')) for (const k of Object.keys(out)) if (/^a2p_(address|street|unit|city|state|zip)/.test(k)) delete out[k];
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
      // /welcome only knows the Stripe checkout id from its address. This trades it for the client's
      // setup code. The payment webhook creates the row, so a 404 here can simply mean "not yet".
      const session = String((req.query && req.query.session) || '');
      if (session) {
        if (!SESSION.test(session)) return res.status(404).json({ error: 'not_found' });
        const hit = (await supabase(`${TABLE}?stripe_session_id=eq.${encodeURIComponent(session)}&select=code&limit=1`))[0];
        if (!hit) return res.status(404).json({ error: 'not_found' });
        return res.status(200).json({ code: hit.code });
      }
      const code = String((req.query && req.query.code) || '');
      if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });
      const row = await find(code);
      if (!row) return res.status(404).json({ error: 'not_found' });
      // The client's website asks this on every build: thin site until the texting registration is approved, full after.
      if (req.query.view === 'site') return res.status(200).json({ a2p_approved: !!row.a2p_registered_at });
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
        // Like the EIN, the date of birth is never sent back to the page, only whether we have one.
        dob_on_file: !!(row.answers || {}).a2p_dob,
        // What we pulled from Google first, then anything the client has confirmed or changed on top.
        answers: { ...(row.prefill || {}), ...(row.answers || {}), a2p_dob: undefined },
      });
    }
    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
      if (!body || !CODE.test(String(body.code || ''))) return res.status(404).json({ error: 'not_found' });
      const row = await find(body.code);
      if (!row) return res.status(404).json({ error: 'not_found' });
      const code = row.code;
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

      // On first submit: send a thank-you text with the personalized video (if set)
      if (body.action === 'submit' && !row.submitted_at) {
        try {
          const ghlKey = (process.env.GHL_API_KEY || '').trim();
          const locId = (process.env.GHL_LOCATION_ID || '').trim();
          const a = { ...(row.prefill || {}), ...(row.answers || {}), ...(patch.answers || {}) };
          const ownerName = row.owner_first_name || a.preferred_name || '';
          const ownerCell = String(a.cell || a.business_phone || '').replace(/\D/g, '');
          if (ghlKey && locId && ownerCell.length >= 10) {
            const fullPhone = `+1${ownerCell}`;
            // Find the contact
            const searchRes = await fetch(
              `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locId}&number=${encodeURIComponent(fullPhone)}`,
              { headers: { Authorization: `Bearer ${ghlKey}`, Version: '2021-07-28' } }
            );
            const searchData = await searchRes.json();
            let contactId = searchData?.contact?.id;
            if (!contactId) {
              const createRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
                method: 'POST',
                headers: { Authorization: `Bearer ${ghlKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
                body: JSON.stringify({ locationId: locId, firstName: ownerName || 'Client', phone: fullPhone }),
              });
              contactId = (await createRes.json())?.contact?.id;
            }
            if (contactId) {
              let msg = ownerName
                ? `${ownerName}, you are all set! We are building your site now and you will hear from us soon.`
                : `You are all set! We are building your site now and you will hear from us soon.`;
              // If a personalized video URL is set, include it
              if (row.video_url) msg += ` Here is a quick message from me: ${row.video_url}`;
              await fetch('https://services.leadconnectorhq.com/conversations/messages', {
                method: 'POST',
                headers: { Authorization: `Bearer ${ghlKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
                body: JSON.stringify({ type: 'SMS', contactId, message: msg }),
              });
            }
          }
          // Alert Maddie
          const { sendAlert } = require('./alert');
          const bizName = a.business_name || ownerName || code.slice(0, 8);
          await sendAlert('Form submitted', `${bizName} just finished their setup form. Ready to build.`).catch(() => {});
        } catch (e) {
          console.error('onboarding: thank-you text failed:', e.message);
        }

        // Trigger the initial site build in the background. The site goes live as thin immediately
        // (auto mode shows thin on the live domain until A2P is approved). The copy writer runs
        // separately via ?with_copy=true or as a follow-up call. This is non-blocking so the form
        // submission response is not delayed by the build.
        if (process.env.BB_INTERNAL_SECRET) {
          const host = req.headers?.host || 'buildboosters.com';
          const proto = host.includes('localhost') ? 'http' : 'https';
          fetch(`${proto}://${host}/api/build-site?with_ghl=true`, {
            method: 'POST',
            headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
            // rebuild: a client who went 72 hours without the form already has a basics site.
            body: JSON.stringify({ code, rebuild: true }),
          }).catch((e) => console.error('onboarding: build-site trigger failed:', e.message));
        }
      }

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
module.exports.validDob = validDob;
