// /api/auto-build — the daily retry for site builds that did not finish.
//
// The site build starts on its own when the client submits the setup form. This catches the ones
// that failed or never started: submitted an hour or more ago and the build never finished (no site_created_at). It calls
// build-site again and tells Maddie what it did, including the ones that failed a second time.
//
// Run once a day by Vercel's scheduler (see vercel.json). Internal only.
const { sb, allowed, configured, isCron } = require('./_sb');
const { sendAlert } = require('./alert');

const HOUR = 3600000;
const TABLE = 'client_onboarding';

function hoursSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / HOUR;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && !isCron(req)) return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    // Get clients who submitted but don't have a site yet
    const rows = await sb(`${TABLE}?submitted_at=not.is.null&site_created_at=is.null&select=*&limit=100`);
    const built = [];
    const failed = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = a.business_name || r.owner_first_name || r.code.slice(0, 8);
      if (hoursSince(r.submitted_at) < 1) continue;
      try {
        const host = req.headers?.host || 'buildboosters.com';
        const proto = host.includes('localhost') ? 'http' : 'https';
        const buildRes = await fetch(`${proto}://${host}/api/build-site?with_ghl=true`, {
          method: 'POST',
          headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code: r.code }),
        });
        const buildData = await buildRes.json().catch(() => ({}));
        if (buildData.ok) built.push({ code: r.code, name, repo: buildData.repo });
        else failed.push({ code: r.code, name, reason: buildData.step || buildData.reason || buildData.error || 'unknown' });
      } catch (e) {
        failed.push({ code: r.code, name, reason: e.message });
      }
    }

    if (built.length) {
      await sendAlert('Build retry worked', `Built on the second try: ${built.map(b => b.name).join(', ')}.`).catch(() => {});
    }
    if (failed.length) {
      await sendAlert('Site build failing', failed.map(f => `${f.name} (${f.reason})`).join(', ').slice(0, 400)).catch(() => {});
    }

    return res.status(200).json({ ok: true, checked: rows.length, built, failed });
  } catch (e) {
    console.error('auto-build', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
