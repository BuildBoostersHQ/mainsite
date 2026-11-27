// /api/churn-check — scans all clients for churn signals and alerts Maddie.
//
// Called once a day by a scheduled task. Checks each active client for:
//   1. No form submission after 7 days (they paid but never filled it in)
//   2. A2P rejected and no resubmission after 5 days
//   3. No photos uploaded after 14 days since form submission
//   4. Site in thin mode more than 30 days after creation (something is stuck)
//
// Each signal generates one alert. The endpoint saves the last check time so the same signal
// is not sent twice within 48 hours.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const DAY = 86400000;

function daysSince(iso) {
  if (!iso) return Infinity;
  return Math.floor((Date.now() - new Date(iso).getTime()) / DAY);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const rows = await sb('client_onboarding?select=*&order=created_at.desc&limit=500');
    const alerts = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = a.business_name || r.owner_first_name || r.code.slice(0, 8);
      const age = daysSince(r.created_at);

      // 1. Paid but never submitted the form
      if (!r.submitted_at && age >= 7) {
        alerts.push({ client: name, signal: 'form_not_submitted', detail: `Signed up ${age} days ago, form not submitted` });
      }

      // 2. A2P rejected with no resubmission
      if (r.a2p_status && /rejected/.test(r.a2p_status) && daysSince(r.a2p_status_at) >= 5 && !r.a2p_registered_at) {
        alerts.push({ client: name, signal: 'a2p_rejected_stale', detail: `A2P rejected ${daysSince(r.a2p_status_at)} days ago: ${r.a2p_reason || 'no reason given'}` });
      }

      // 3. Form submitted but no photos after 14 days
      if (r.submitted_at && (r.photo_count || 0) === 0 && daysSince(r.submitted_at) >= 14) {
        alerts.push({ client: name, signal: 'no_photos', detail: `Form submitted ${daysSince(r.submitted_at)} days ago, still no photos` });
      }

      // 4. Site stuck in thin mode too long
      if (r.site_repo && !r.a2p_registered_at && daysSince(r.created_at) >= 30) {
        alerts.push({ client: name, signal: 'stuck_thin', detail: `Site created ${age} days ago, still thin (no A2P approval)` });
      }

      // 5. No Google access after 10 days
      if (r.submitted_at && !r.google_requested_at && daysSince(r.submitted_at) >= 10) {
        alerts.push({ client: name, signal: 'no_google_access', detail: `Form submitted ${daysSince(r.submitted_at)} days ago, Google access not requested` });
      }
    }

    // Send one combined alert if there are signals
    if (alerts.length) {
      const lines = alerts.map(a => `${a.client}: ${a.detail}`);
      // Group into chunks of 5 to keep texts readable
      for (let i = 0; i < lines.length; i += 5) {
        const chunk = lines.slice(i, i + 5);
        await sendAlert(
          `${alerts.length} client${alerts.length === 1 ? '' : 's'} need attention`,
          chunk.join('\n')
        ).catch(() => {});
      }
    }

    return res.status(200).json({ ok: true, checked: rows.length, alerts });
  } catch (e) {
    console.error('churn-check', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
