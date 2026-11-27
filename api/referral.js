// /api/referral — tracks when a client refers someone to Build Boosters.
//
// POST /api/referral  { code: "client-code", referred_name: "Mike", referred_phone: "3055551234", referred_trade: "plumbing" }
//
// Alerts Maddie with the referral details so she can follow up. Texts the referring client
// a thank-you. Does not create a prospect row automatically since Maddie handles outreach
// to referrals personally.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const TABLE = 'client_onboarding';
const CODE = /^[a-f0-9]{16,64}$/i;

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
    const { code, referred_name, referred_phone, referred_trade } = req.body || {};
    if (!code || !CODE.test(code)) return res.status(400).json({ error: 'bad_request', reason: 'code is required' });
    if (!referred_name && !referred_phone) return res.status(400).json({ error: 'bad_request', reason: 'referred_name or referred_phone is required' });

    // Look up the referring client
    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=id,code,owner_first_name,prefill,answers&limit=1`);
    const referrer = rows[0];
    if (!referrer) return res.status(404).json({ error: 'not_found' });

    const a = { ...(referrer.prefill || {}), ...(referrer.answers || {}) };
    const referrerName = referrer.owner_first_name || a.preferred_name || '';
    const referrerBiz = a.business_name || '';
    const referrerPhone = a.cell || a.business_phone || '';

    // Alert Maddie with the referral details
    const refName = referred_name || 'Unknown';
    const refPhone = referred_phone || 'no phone';
    const refTrade = referred_trade || 'unknown trade';
    await sendAlert(
      'New referral',
      `${referrerName} (${referrerBiz}) referred ${refName} (${refPhone}, ${refTrade}). Follow up personally.`
    ).catch(() => {});

    // Thank the referring client
    if (referrerPhone && referrerPhone.replace(/\D/g, '').length >= 10) {
      const thankMsg = referrerName
        ? `${referrerName}, thank you for the referral. We will take good care of them and keep you posted.`
        : `Thank you for the referral. We will take good care of them and keep you posted.`;
      await textClient(referrerPhone, thankMsg).catch(() => {});
    }

    return res.status(201).json({
      ok: true,
      referrer: referrerName || referrer.code.slice(0, 8),
      referred: { name: refName, phone: refPhone, trade: refTrade },
    });
  } catch (e) {
    console.error('referral', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};
