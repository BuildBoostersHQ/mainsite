// /api/holiday-text — sends a holiday message to all active clients.
//
// POST /api/holiday-text  { message: "..." }
// or POST /api/holiday-text  { holiday: "thanksgiving" }
//
// If a holiday name is passed instead of a custom message, uses a preset.
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');

const TABLE = 'client_onboarding';

const PRESETS = {
  thanksgiving: (name) =>
    `Happy Thanksgiving${name ? `, ${name}` : ''}! Wishing you and your family a great holiday. We are thankful to be working with you.`,
  christmas: (name) =>
    `Merry Christmas${name ? `, ${name}` : ''}! Hope you and your family have a wonderful holiday season. Looking forward to a great year ahead.`,
  new_year: (name) =>
    `Happy New Year${name ? `, ${name}` : ''}! Excited for what 2027 has in store for your business. Here is to a big year.`,
  fourth_of_july: (name) =>
    `Happy 4th of July${name ? `, ${name}` : ''}! Hope you and your crew are enjoying the day. Have a good one.`,
};

async function textClient(phone, message) {
  const apiKey = (process.env.GHL_API_KEY || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || '').trim();
  if (!apiKey || !locationId) return { sent: false, reason: 'not_configured' };

  const fullPhone = phone.startsWith('+') ? phone : `+1${phone.replace(/\D/g, '')}`;
  try {
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(fullPhone)}`,
      { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28' } }
    );
    const searchData = await searchRes.json();
    const contactId = searchData?.contact?.id;
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
    const { message, holiday } = req.body || {};
    const preset = holiday ? PRESETS[holiday] : null;
    if (!message && !preset) {
      return res.status(400).json({
        error: 'bad_request',
        reason: 'Send { message: "..." } or { holiday: "thanksgiving" }',
        holidays: Object.keys(PRESETS),
      });
    }

    // Get all active clients (have submitted their form)
    const rows = await sb(`${TABLE}?submitted_at=not.is.null&select=id,code,owner_first_name,prefill,answers&limit=500`);
    const sent = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = r.owner_first_name || '';
      const phone = a.business_phone || a.owner_cell || '';
      if (!phone || phone.replace(/\D/g, '').length < 10) continue;

      const msg = preset ? preset(name) : (name ? message.replace(/{name}/g, name) : message.replace(/, {name}/g, '').replace(/{name},? ?/g, ''));
      const result = await textClient(phone, msg);
      if (result.sent) {
        sent.push({ code: r.code, name: name || phone });
      }
    }

    return res.status(200).json({ ok: true, clients: rows.length, sent: sent.length, details: sent });
  } catch (e) {
    console.error('holiday-text', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
