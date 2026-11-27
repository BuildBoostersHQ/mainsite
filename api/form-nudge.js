// /api/form-nudge — texts clients who paid but haven't finished their setup form.
//
// Called once a day by a scheduled task. Sends up to two nudges per client:
//   1. 24 hours after payment: a friendly reminder with the link
//   2. 4 days after payment: a second nudge, slightly more urgent
//
// Tracks which nudges have been sent in the nudges_sent jsonb column so nothing repeats.
// Skips clients who have already submitted.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');

const DAY = 86400000;
const TABLE = 'client_onboarding';

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 3600000;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

async function textClient(phone, message) {
  const apiKey = (process.env.GHL_API_KEY || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || '').trim();
  if (!apiKey || !locationId) return { sent: false, reason: 'not_configured' };

  const fullPhone = phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '')}`;
  try {
    // Find or create contact
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(fullPhone)}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28' } }
    );
    const searchData = await searchRes.json();
    let contactId = searchData?.contact?.id;
    if (!contactId) return { sent: false, reason: 'no_contact' };

    const msgRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'SMS', contactId, message }),
    });
    return { sent: msgRes.ok };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    // Get all clients who have not submitted yet
    const rows = await sb(`${TABLE}?submitted_at=is.null&order=created_at.desc&limit=200`);
    const sent = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = r.owner_first_name || '';
      const phone = a.business_phone || a.owner_cell || '';
      const nudges = r.nudges_sent || {};
      const hours = hoursSince(r.created_at);
      const setupUrl = `https://buildboosters.com/start/${r.code}`;

      if (!phone || phone.replace(/\D/g, '').length < 10) continue;

      // Nudge 1: 24 hours after payment
      if (hours >= 24 && hours < 96 && !nudges.day1) {
        const msg = name
          ? `Hey ${name}, just checking in. Whenever you have 5 minutes, your setup page is ready: ${setupUrl}`
          : `Hey, just checking in. Whenever you have 5 minutes, your setup page is ready: ${setupUrl}`;
        const result = await textClient(phone, msg);
        if (result.sent) {
          nudges.day1 = new Date().toISOString();
          await sb(`${TABLE}?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ nudges_sent: nudges }) });
          sent.push({ code: r.code, nudge: 'day1', name: name || phone });
        }
      }

      // Nudge 2: 4 days after payment
      if (hours >= 96 && !nudges.day4) {
        const msg = name
          ? `Hey ${name}, wanted to make sure you saw the setup page. We can knock it out together on a quick call if that is easier, just reply here: ${setupUrl}`
          : `Hey, wanted to make sure you saw the setup page. We can knock it out together on a quick call if that is easier, just reply here: ${setupUrl}`;
        const result = await textClient(phone, msg);
        if (result.sent) {
          nudges.day4 = new Date().toISOString();
          await sb(`${TABLE}?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify({ nudges_sent: nudges }) });
          sent.push({ code: r.code, nudge: 'day4', name: name || phone });
        }
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, sent });
  } catch (e) {
    console.error('form-nudge', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
