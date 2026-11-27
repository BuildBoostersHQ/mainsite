// /api/stripe-webhook — creates a client row in Supabase when a Stripe payment comes through.
//
// Listens for checkout.session.completed events. Determines tier from the amount, checks for
// duplicates by email, generates a setup code, and creates the row. The setup link text is sent
// by a separate function or GHL workflow (texting channel not decided yet).
//
// Needs STRIPE_WEBHOOK_SECRET in Vercel, plus the two Supabase variables the other endpoints use.
const crypto = require('crypto');
const { sb, configured } = require('./_sb');

const TABLE = 'client_onboarding';

// Tier mapping from Stripe amount in cents. Annual amounts are 10x monthly (2 months free).
const TIERS = {
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

function firstName(full) {
  return String(full || '').trim().split(/\s+/)[0] || '';
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
  if (!webhookSecret) return res.status(500).json({ error: 'not_configured', reason: 'STRIPE_WEBHOOK_SECRET is not set' });
  if (!configured()) return res.status(500).json({ error: 'not_configured', reason: 'Supabase is not configured' });

  // Vercel parses the body as JSON by default, but we need the raw string for signature verification.
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const sig = req.headers['stripe-signature'] || '';

  if (!verifySignature(rawBody, sig, webhookSecret)) {
    return res.status(400).json({ error: 'invalid_signature' });
  }

  try {
    const event = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Only handle completed checkouts. Everything else gets a silent 200.
    if (event.type !== 'checkout.session.completed') {
      return res.status(200).json({ ok: true, skipped: event.type });
    }

    const session = event.data && event.data.object;
    if (!session) return res.status(200).json({ ok: true, skipped: 'no_session_object' });

    const meta = session.metadata || {};
    const details = session.customer_details || {};
    const email = String(details.email || session.customer_email || meta.email || '').trim().toLowerCase();
    const name = String(details.name || meta.business_name || '').trim();
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
      owner_first_name: firstName(name),
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
      const ownerName = firstName(name);
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
        `${name || 'Unknown'} (${tier}, ${billing_cycle}) just paid. Code: ${code}`
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

    return res.status(200).json({ ok: true, code, tier, billing_cycle, prospect_linked });
  } catch (e) {
    console.error('stripe-webhook', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.tierFromAmount = tierFromAmount;
module.exports.verifySignature = verifySignature;
