// /api/auto-build — builds sites for clients who submitted their form 14+ days ago.
//
// Called daily by a scheduled task. Finds clients who:
//   1. Submitted their form (submitted_at is set)
//   2. Don't have a site yet (site_repo is null)
//   3. Have been waiting 14+ days since form submission
//
// Kicks off the build-site endpoint for each one. The site is built thin (auto mode)
// and will flip to full when A2P is approved.
//
// Also catches clients waiting less than 14 days but who have all their data ready
// (photos uploaded, all required fields filled) and alerts Maddie that they're ready
// to build early if she wants.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const DAY = 86400000;
const TABLE = 'client_onboarding';

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
    // Get clients who submitted but don't have a site yet
    const rows = await sb(`${TABLE}?submitted_at=not.is.null&site_repo=is.null&select=*&limit=100`);
    const built = [];
    const readyEarly = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = a.business_name || r.owner_first_name || r.code.slice(0, 8);
      const sinceSub = daysSince(r.submitted_at);

      // Auto-build at 14 days
      if (sinceSub >= 14) {
        try {
          const host = req.headers?.host || 'buildboosters.com';
          const proto = host.includes('localhost') ? 'http' : 'https';
          const buildRes = await fetch(`${proto}://${host}/api/build-site`, {
            method: 'POST',
            headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: r.code }),
          });
          const buildData = await buildRes.json().catch(() => ({}));
          if (buildData.ok) {
            built.push({ code: r.code, name, repo: buildData.repo });
          } else {
            console.error(`auto-build: failed for ${name}:`, buildData.error || buildData.reason);
          }
        } catch (e) {
          console.error(`auto-build: failed for ${name}:`, e.message);
        }
      }
      // Alert about clients who are ready early (submitted, have photos, less than 14 days)
      else if (sinceSub >= 3 && (r.photo_count || 0) >= 3) {
        readyEarly.push({ code: r.code, name, days: sinceSub, photos: r.photo_count });
      }
    }

    // Alert Maddie about builds and early-ready clients
    if (built.length) {
      const names = built.map(b => b.name).join(', ');
      await sendAlert(
        `Auto-built ${built.length} site${built.length === 1 ? '' : 's'}`,
        `Built sites for: ${names}. They are live in thin mode.`
      ).catch(() => {});
    }

    if (readyEarly.length) {
      const lines = readyEarly.map(r => `${r.name} (${r.days} days, ${r.photos} photos)`).join(', ');
      await sendAlert(
        'Clients ready to build early',
        `These clients have their form and photos done: ${lines}. Build them now or wait for day 14.`
      ).catch(() => {});
    }

    return res.status(200).json({ ok: true, checked: rows.length, built, ready_early: readyEarly });
  } catch (e) {
    console.error('auto-build', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
