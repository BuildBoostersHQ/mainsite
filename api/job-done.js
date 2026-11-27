// /api/job-done — receives a "DONE" keyword text from a contractor via GHL webhook.
//
// When a contractor texts "DONE 3055551234" or "DONE Mike" to their GHL number, the GHL
// inbound-message workflow fires a webhook to this endpoint. It creates a job_event row
// so the review request and photo ask automations know to fire.
//
// POST /api/job-done  { from: "+13055550199", body: "DONE 3055551234" }
//
// Auth: validates the sender's phone matches a client in the system (by ghl_phone_number,
// cell, or business_phone). No BB_INTERNAL_SECRET required since this comes from GHL webhooks.
//
// Needs the two Supabase variables.
const { sb, configured } = require('./_sb');

const DONE_RE = /^done\s+(.+)/i;
const PHONE_RE = /^[\d()+\-.\s]{7,20}$/;

function normalize(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured()) return res.status(500).json({ error: 'not_configured' });

  try {
    const from = normalize(req.body?.from || req.body?.fromNumber || '');
    const body = String(req.body?.body || req.body?.message || '').trim();

    if (!from || from.length < 10) return res.status(400).json({ error: 'missing_from' });

    const match = body.match(DONE_RE);
    if (!match) return res.status(400).json({ error: 'not_a_done_message', hint: 'Text must start with DONE followed by a customer phone or name' });

    const identifier = match[1].trim();

    // Find the client by their phone number (ghl_phone_number, cell, or business_phone)
    // We check all three fields since the contractor might text from any of them
    const clients = await sb(
      `client_onboarding?select=id,code,owner_first_name,prefill,answers,ghl_phone_number&limit=200`
    );

    let client = null;
    for (const c of clients) {
      const a = { ...(c.prefill || {}), ...(c.answers || {}) };
      const phones = [
        normalize(c.ghl_phone_number),
        normalize(a.cell),
        normalize(a.business_phone),
        normalize(a.owner_cell),
      ].filter(Boolean);
      if (phones.includes(from)) {
        client = c;
        break;
      }
    }

    if (!client) return res.status(404).json({ error: 'unknown_sender', hint: 'Phone number does not match any client' });

    // Parse the customer identifier: phone number or name
    const isPhone = PHONE_RE.test(identifier);
    const customerPhone = isPhone ? normalize(identifier) : null;
    const customerName = isPhone ? null : identifier;

    // Create the job event
    const now = new Date();
    const reviewAt = new Date(now.getTime() + 3 * 3600000).toISOString(); // 3 hours
    const photoAt = new Date(now.getTime() + 6 * 3600000).toISOString();  // 6 hours

    const event = {
      client_id: client.id,
      source: 'manual',
      event_type: 'job_completed',
      customer_phone: customerPhone || null,
      customer_name: customerName || null,
      review_ask_at: reviewAt,
      photo_ask_at: photoAt,
    };

    await sb('job_events', { method: 'POST', body: JSON.stringify(event) });

    return res.status(201).json({
      ok: true,
      client: client.owner_first_name || client.code.slice(0, 8),
      customer: customerName || customerPhone,
      review_ask_at: reviewAt,
      photo_ask_at: photoAt,
    });
  } catch (e) {
    console.error('job-done', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};
