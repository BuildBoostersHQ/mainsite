// /api/monthly-report — generates a monthly summary for one client or all clients.
//
// GET /api/monthly-report?code=...  — one client's report (internal, BB_INTERNAL_SECRET)
// GET /api/monthly-report?all=true  — every client, one paragraph each (for Maddie's portfolio review)
//
// The report covers the last 30 days and includes:
//   - Site status (thin, full, when it went live)
//   - Photos added this month
//   - Change requests submitted and completed
//   - A2P status
//   - What's missing or stuck
//
// This is the data. Formatting it as an email, PDF or text is a separate step.
const { sb, allowed, configured } = require('./_sb');
const CODE = /^[a-f0-9]{16,64}$/i;
const DAY = 86400000;

function report(row) {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const name = a.business_name || row.owner_first_name || 'Unknown';
  const age = Math.floor((Date.now() - new Date(row.created_at).getTime()) / DAY);
  const thirtyAgo = new Date(Date.now() - 30 * DAY).toISOString();

  return {
    business: name,
    code: row.code,
    tier: row.tier || '',
    age_days: age,
    site: {
      status: row.a2p_registered_at ? 'full' : row.site_repo ? 'thin' : 'not created',
      repo: row.site_repo || null,
      went_full_at: row.a2p_registered_at || null,
      last_rebuild: row.site_rebuild_requested_at || null,
    },
    onboarding: {
      form_submitted: !!row.submitted_at,
      google_access: row.google_approved_at ? 'approved' : row.google_requested_at ? 'requested' : 'not started',
      photos_uploaded: row.photo_count || 0,
      sms_consent: !!row.sms_consent_at,
      ein_on_file: !!row.ein_private,
    },
    a2p: {
      status: row.a2p_status || 'none',
      reason: row.a2p_reason || '',
      approved_at: row.a2p_registered_at || null,
    },
    flags: buildFlags(row, age),
  };
}

function buildFlags(r, age) {
  const flags = [];
  if (!r.submitted_at && age >= 7) flags.push('Form not submitted after ' + age + ' days');
  if (r.a2p_status && /rejected/.test(r.a2p_status)) flags.push('A2P rejected: ' + (r.a2p_reason || 'unknown reason'));
  if (r.submitted_at && (r.photo_count || 0) === 0) flags.push('No photos uploaded');
  if (r.site_repo && !r.a2p_registered_at && age >= 30) flags.push('Site still thin after ' + age + ' days');
  if (!r.ghl_location_id) flags.push('Missing sub-account ID');
  if (!r.site_deploy_hook) flags.push('Missing deploy hook');
  return flags;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    if (req.query.all === 'true') {
      const rows = await sb('client_onboarding?select=*&order=created_at.desc&limit=500');
      const reports = rows.map(report);
      const healthy = reports.filter(r => !r.flags.length).length;
      return res.status(200).json({
        ok: true,
        month: new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        total: reports.length,
        healthy,
        needs_attention: reports.length - healthy,
        clients: reports,
      });
    }

    const code = String(req.query.code || '').trim();
    if (!CODE.test(code)) return res.status(400).json({ error: 'bad_code' });
    const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });

    // Also pull their change requests from the last 30 days
    const thirtyAgo = new Date(Date.now() - 30 * DAY).toISOString();
    let changes = [];
    try {
      changes = await sb(`change_requests?client_id=eq.${rows[0].id}&created_at=gte.${thirtyAgo}&select=id,category,body,status,created_at&order=created_at.desc`);
    } catch {}

    const r = report(rows[0]);
    r.changes_this_month = {
      total: changes.length,
      completed: changes.filter(c => c.status === 'done').length,
      open: changes.filter(c => c.status === 'sent' || c.status === 'working').length,
      items: changes.map(c => ({ category: c.category, summary: c.body.slice(0, 100), status: c.status, date: c.created_at })),
    };
    return res.status(200).json({ ok: true, report: r });
  } catch (e) {
    console.error('monthly-report', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
