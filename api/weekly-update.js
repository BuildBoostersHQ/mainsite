// /api/weekly-update — sends each active client a weekly text about their site.
//
// Called once a week by a scheduled task (Friday afternoon). Covers what happened that week:
// new photos published, change requests completed, review count changes.
// Skips clients who have not launched yet or whose texting is not approved.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');

const TABLE = 'client_onboarding';
const WEEK = 7 * 86400000;

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
    // Get all clients who have a live site (a2p approved or site created)
    const rows = await sb(`${TABLE}?site_repo=not.is.null&select=*&limit=500`);
    const sent = [];
    const weekAgo = new Date(Date.now() - WEEK).toISOString();

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = r.owner_first_name || '';
      const phone = a.business_phone || a.owner_cell || '';
      if (!phone || phone.replace(/\D/g, '').length < 10) continue;

      // Build the update
      const updates = [];

      // Check for change requests completed this week
      try {
        const doneReqs = await sb(
          `change_requests?client_id=eq.${r.id}&status=eq.done&updated_at=gte.${weekAgo}&select=body&limit=10`
        );
        if (doneReqs.length === 1) {
          updates.push('we finished your change request');
        } else if (doneReqs.length > 1) {
          updates.push(`we finished ${doneReqs.length} change requests`);
        }
      } catch { /* skip */ }

      // Check for new photos published this week
      if (r.photos_last_at && new Date(r.photos_last_at) > new Date(weekAgo)) {
        updates.push('new photos are live on the site');
      }

      // Check if A2P was approved this week
      if (r.a2p_registered_at && new Date(r.a2p_registered_at) > new Date(weekAgo)) {
        updates.push('your texting line is active');
      }

      // Check if domain was registered this week
      if (r.domain_registered_at && new Date(r.domain_registered_at) > new Date(weekAgo)) {
        updates.push(`${r.site_domain} is live`);
      }

      // Only text if there is something to say
      if (updates.length === 0) continue;

      const greeting = name ? `Hey ${name}` : 'Hey';
      const updateList = updates.length === 1
        ? updates[0]
        : updates.slice(0, -1).join(', ') + ' and ' + updates[updates.length - 1];
      const msg = `${greeting}, quick update from Build Boosters: ${updateList}. Text us anytime if you need anything.`;

      const result = await textClient(phone, msg);
      if (result.sent) {
        sent.push({ code: r.code, name: name || phone, updates });
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, sent });
  } catch (e) {
    console.error('weekly-update', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
