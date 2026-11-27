// /api/alert — sends Maddie a text when something needs her attention.
//
// Internal only (BB_INTERNAL_SECRET). Other endpoints call this when they hit an error worth
// surfacing: a build that failed, an A2P email that needs a look, a photo upload that broke.
//
// Uses the GHL API to send a text from the Build Boosters sub-account to Maddie's cell.
// Needs GHL_API_KEY (a private integration token with conversations.message.write scope)
// and GHL_LOCATION_ID (the Build Boosters sub-account location ID) in Vercel.
// Falls back to console.error so a missing key never blocks the caller.
//
// POST /api/alert  { subject, body }
//   subject: short label like "A2P email" or "Site build failed"
//   body: the detail, one or two sentences
const { allowed, configured } = require('./_sb');

const MADDIE_PHONE = '+17864798856';

async function sendAlert(subject, body) {
  const apiKey = (process.env.GHL_API_KEY || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || '').trim();
  if (!apiKey || !locationId) {
    console.error(`[alert] ${subject}: ${body} (GHL_API_KEY or GHL_LOCATION_ID not set, cannot text)`);
    return { sent: false, reason: 'not_configured' };
  }
  const message = `BB alert: ${subject}\n${body}`;
  try {
    // Find or create Maddie as a contact in the BB sub-account
    const searchRes = await fetch(`https://services.leadconnectorhq.com/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(MADDIE_PHONE)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28' },
    });
    const searchData = await searchRes.json();
    let contactId = searchData?.contact?.id;
    if (!contactId) {
      const createRes = await fetch('https://services.leadconnectorhq.com/contacts/', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationId, firstName: 'Maddie', lastName: 'Stonbely', phone: MADDIE_PHONE }),
      });
      const created = await createRes.json();
      contactId = created?.contact?.id;
    }
    if (!contactId) {
      console.error(`[alert] Could not find or create contact for alerts: ${subject}`);
      return { sent: false, reason: 'no_contact' };
    }
    const msgRes = await fetch('https://services.leadconnectorhq.com/conversations/messages', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'SMS', contactId, message }),
    });
    if (!msgRes.ok) {
      const err = await msgRes.text();
      console.error(`[alert] GHL message failed ${msgRes.status}: ${err.slice(0, 200)}`);
      return { sent: false, reason: 'ghl_error' };
    }
    return { sent: true };
  } catch (e) {
    console.error(`[alert] ${subject}: ${e.message}`);
    return { sent: false, reason: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  const { subject, body } = req.body || {};
  if (!subject || !body) return res.status(400).json({ error: 'subject_and_body_required' });
  const result = await sendAlert(String(subject).slice(0, 100), String(body).slice(0, 500));
  return res.status(200).json({ ok: true, ...result });
};

// Export for other endpoints to call directly without going through HTTP
module.exports.sendAlert = sendAlert;
