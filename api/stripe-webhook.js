// /api/stripe-webhook — creates a client row in Supabase when a Stripe payment comes through.
//
// Listens for checkout.session.completed events. The plan comes from the tags on the payment link
// (metadata tier and billing_cycle), and falls back to the amount paid. Checks for duplicates by
// email, generates a setup code, creates the row, texts the setup link and alerts Maddie.
//
// Stripe signs the exact text it sends, so the signature is checked against the request as it
// arrived, never against a re-built copy of the parsed body. If the original text cannot be read
// and STRIPE_SECRET_KEY is set, the event is fetched back from Stripe by its id instead.
//
// Needs STRIPE_WEBHOOK_SECRET in Vercel, plus the two Supabase variables the other endpoints use.
// STRIPE_SECRET_KEY is optional and only used for that fallback.
const crypto = require('crypto');
const { sb, configured } = require('./_sb');

const TABLE = 'client_onboarding';

// Fallback only, for a payment whose link has no tier tag: the plan worked out from the amount in cents.
// A monthly amount includes the $297 setup fee charged on the first payment.
const TIERS = {
  // Plans from November 2026 (Essentials is the website plan)
  44400:  { tier: 'website',         billing_cycle: 'monthly' },
  42700:  { tier: 'website',         billing_cycle: 'quarterly' },
  147000: { tier: 'website',         billing_cycle: 'annual' },
  57600:  { tier: 'all_in_one',      billing_cycle: 'monthly' },
  82900:  { tier: 'all_in_one',      billing_cycle: 'quarterly' },
  279000: { tier: 'all_in_one',      billing_cycle: 'annual' },
  79400:  { tier: 'dominance',       billing_cycle: 'monthly' },
  142500: { tier: 'dominance',       billing_cycle: 'quarterly' },
  497000: { tier: 'dominance',       billing_cycle: 'annual' },
  // Earlier plans
  7900:   { tier: 'website',         billing_cycle: 'monthly' },
  19700:  { tier: 'all_in_one',      billing_cycle: 'monthly' },
  59100:  { tier: 'all_in_one',      billing_cycle: 'quarterly' },  // 90-day prepay
  99700:  { tier: 'all_in_one_ads',  billing_cycle: 'monthly' },
  79000:  { tier: 'website',         billing_cycle: 'annual' },
  197000: { tier: 'all_in_one',      billing_cycle: 'annual' },
  997000: { tier: 'all_in_one_ads',  billing_cycle: 'annual' },
};

function tierFromAmount(cents) {
  return TIERS[cents] || { tier: 'unknown', billing_cycle: 'monthly' };
}

// Stripe signs webhooks with HMAC-SHA256. Verify without pulling in the Stripe SDK.
function verifySignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const item of sigHeader.split(',')) {
    const [k, v] = item.split('=');
    if (k === 't') parts.t = v;
    if (k === 'v1' && !parts.v1) parts.v1 = v;
  }
  if (!parts.t || !parts.v1) return false;
  const expected = crypto.createHmac('sha256', secret)
    .update(`${parts.t}.${payload}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch { return false; }
}

// The request exactly as Stripe sent it. Reads the request stream first, because touching req.body
// makes the platform parse it and the parsed copy can never be turned back into the signed text.
// Returns '' when the original text is not available.
function readRawBody(req) {
  return new Promise((resolve) => {
    const fromBody = () => {
      const b = req.body;
      if (typeof b === 'string') return b;
      if (Buffer.isBuffer(b)) return b.toString('utf8');
      return '';
    };
    if (!req || typeof req.on !== 'function') return resolve(fromBody());
    const chunks = [];
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text || fromBody());
    };
    // A stream that was already used up never ends, so stop waiting after a moment.
    const timer = setTimeout(finish, 1500);
    req.on('data', (c) => chunks.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', finish);
    req.on('error', finish);
  });
}

// Fetches an event back from Stripe by id. Used only when the signed text could not be read:
// an event that Stripe itself returns for our own key is genuine.
async function fetchEventFromStripe(id) {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key || !/^evt_[A-Za-z0-9]+$/.test(String(id || ''))) return null;
  try {
    const r = await fetch(`https://api.stripe.com/v1/events/${id}`, { headers: { Authorization: `Bearer ${key}` } });
    if (!r.ok) return null;
    const ev = await r.json();
    return ev && ev.id === id ? ev : null;
  } catch { return null; }
}

// Returns the verified event, or null with a reason.
async function loadEvent(req, webhookSecret) {
  const sig = (req.headers && req.headers['stripe-signature']) || '';
  const raw = await readRawBody(req);
  if (raw) {
    if (!verifySignature(raw, sig, webhookSecret)) return { event: null, reason: 'invalid_signature' };
    try { return { event: JSON.parse(raw) }; } catch { return { event: null, reason: 'bad_json' }; }
  }
  const parsed = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : null;
  const fetched = parsed ? await fetchEventFromStripe(parsed.id) : null;
  if (fetched) return { event: fetched };
  console.error('stripe-webhook: the signed request text was not available, so the event could not be verified');
  return { event: null, reason: 'raw_body_unavailable' };
}

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) return res.status(500).json({ error: 'not_configured', reason: 'STRIPE_WEBHOOK_SECRET is not set' });
  if (!configured()) return res.status(500).json({ error: 'not_configured', reason: 'Supabase is not configured' });

  const { event, reason } = await loadEvent(req, webhookSecret);
  if (!event) return res.status(400).json({ error: reason });

  try {
    // Only handle completed checkouts. Everything else gets a silent 200.
    if (event.type !== 'checkout.session.completed') {
      return res.status(200).json({ ok: true, skipped: event.type });
    }

    const session = event.data && event.data.object;
    if (!session) return res.status(200).json({ ok: true, skipped: 'no_session_object' });

    const meta = session.metadata || {};
    const details = session.customer_details || {};
    const email = String(details.email || session.customer_email || meta.email || '').trim().toLowerCase();
    const collected = session.collected_information || {};
    // The business name box on the payment page, when the link collects one. Otherwise the cardholder's name.
    const business = String(details.business_name || collected.business_name || meta.business_name || '').trim();
    const person = String(details.individual_name || collected.individual_name || details.name || '').trim();
    const name = business || person;
    const phone = String(details.phone || meta.prospect_phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
    const amount = session.amount_total || 0;

    const { tier, billing_cycle } = meta.tier
      ? { tier: meta.tier, billing_cycle: meta.billing_cycle || 'monthly' }
      : tierFromAmount(amount);

    // Check for an existing row by email to avoid duplicates.
    if (email) {
      const existing = await sb(
        `${TABLE}?select=code&or=(prefill->>email.eq.${encodeURIComponent(email)},answers->>email.eq.${encodeURIComponent(email)})&limit=1`
      );
      if (existing.length) {
        return res.status(200).json({ ok: true, existing: true, code: existing[0].code });
      }
    }

    const code = crypto.randomBytes(16).toString('hex');

    const prefill = {};
    if (name) prefill.business_name = name;
    if (email) prefill.email = email;
    if (phone.length === 10) prefill.business_phone = phone;
    if (meta.trade) prefill.trade = meta.trade;
    if (meta.city) prefill.primary_city = meta.city;

    const row = {
      code,
      owner_first_name: firstName(person),
      tier,
      billing_cycle,
      prefill,
      options: { services: [], areas: [], domains: [] },
      stripe_session_id: session.id || null,
      stripe_customer_id: session.customer || null,
    };

    await sb(TABLE, { method: 'POST', body: JSON.stringify(row) });

    // Text the client their setup link through GHL and alert Maddie
    if (phone.length === 10 && process.env.GHL_API_KEY && process.env.GHL_LOCATION_ID) {
      const setupUrl = `https://buildboosters.com/start/${code}`;
      const ownerName = firstName(person);
      const smsBody = ownerName
        ? `Hey ${ownerName}, it's Maddie from Build Boosters! Here's your setup page, takes about 5 minutes: ${setupUrl}`
        : `Hey, it's Maddie from Build Boosters! Here's your setup page, takes about 5 minutes: ${setupUrl}`;
      try {
        const ghlKey = process.env.GHL_API_KEY.trim();
        const locId = process.env.GHL_LOCATION_ID.trim();
        const fullPhone = `+1${phone}`;
        // Find or create the client as a GHL contact
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
            body: JSON.stringify({
              locationId: locId,
              firstName: ownerName || 'Client',
              phone: fullPhone,
              ...(email ? { email } : {}),
            }),
          });
          const created = await createRes.json();
          contactId = created?.contact?.id;
        }
        if (contactId) {
          await fetch('https://services.leadconnectorhq.com/conversations/messages', {
            method: 'POST',
            headers: { Authorization: `Bearer ${ghlKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'SMS', contactId, message: smsBody }),
          });
        }
      } catch (e) {
        console.error('stripe-webhook: setup text failed:', e.message);
      }
    }
    // Alert Maddie about the new client
    try {
      const { sendAlert } = require('./alert');
      await sendAlert(
        'New client paid',
        `${name || 'Unknown'} (${tier}, ${billing_cycle}) just paid. Code: ${code}${tier === 'unknown' ? '. The payment link has no tier tag, so set the plan by hand.' : ''}`
      );
    } catch (e) {
      console.error('stripe-webhook: alert failed:', e.message);
    }

    // Try to link this client to their prospect record for prefill data.
    // Best-effort: if the prospect DB is not configured or not found, the form still works fine.
    let prospect_linked = false;
    if (process.env.BB_INTERNAL_SECRET) {
      try {
        const host = req.headers?.host || 'buildboosters.com';
        const proto = host.includes('localhost') ? 'http' : 'https';
        const linkRes = await fetch(`${proto}://${host}/api/prospect-link`, {
          method: 'POST',
          headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code, prospect_phone: phone, prospect_email: email }),
        });
        const linkData = await linkRes.json().catch(() => ({}));
        prospect_linked = linkData.linked || false;
      } catch {}
    }

    // No prospect record means they found us on their own. Look their business up on Google by
    // phone so the setup form still opens filled in. Never overwrites what is already there.
    let google_prefilled = false;
    if (!prospect_linked && phone.length === 10) {
      try {
        const { lookupByPhone } = require('./business-lookup');
        const biz = await lookupByPhone(phone);
        if (biz && biz.business_name) {
          const found = {};
          for (const k of ['business_name', 'business_phone', 'address', 'city', 'weekday_hours', 'weekends', 'website', 'place_id']) {
            if (biz[k]) found[k] = biz[k];
          }
          // A business name typed at checkout wins. Without one the name Stripe has is the cardholder, so Google's wins.
          const merged = { ...found, ...prefill, business_name: business || found.business_name };
          await sb(`${TABLE}?code=eq.${code}`, { method: 'PATCH', body: JSON.stringify({ prefill: merged }) });
          google_prefilled = true;
        }
      } catch (e) {
        console.error('stripe-webhook: Google lookup failed:', e.message);
      }
    }

    return res.status(200).json({ ok: true, code, tier, billing_cycle, prospect_linked, google_prefilled });
  } catch (e) {
    console.error('stripe-webhook', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.tierFromAmount = tierFromAmount;
module.exports.verifySignature = verifySignature;
module.exports.readRawBody = readRawBody;
