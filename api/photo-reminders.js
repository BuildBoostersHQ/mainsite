// /api/photo-reminders — checks which clients are due for a photo ask and returns the list.
//
// POST /api/photo-reminders (internal, BB_INTERNAL_SECRET)
//
// Schedule:
//   - Weeks 1 to 4 after launch: one ask per week
//   - After week 4: one ask per month
//   - Skip if they sent a photo in the last 7 days
//   - Skip if photo_reminders flag is off (they unchecked it on the form)
//
// This endpoint does not send the text (the SMS channel isn't decided). It returns the list
// of clients to ask, with a suggested message, so the sender (Valentina, a GHL workflow,
// or a manual check) can pick it up.
//
// Also records last_photo_ask_at on each client it returns, so the same client isn't
// returned twice in the same window.
const { sb, allowed, configured } = require('./_sb');
const DAY = 86400000;
const WEEK = 7 * DAY;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const rows = await sb('client_onboarding?select=*&submitted_at=not.is.null&order=created_at.desc&limit=500');
    const now = Date.now();
    const due = [];

    for (const r of rows) {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const name = a.preferred_name || r.owner_first_name || '';
      const business = a.business_name || '';

      // Skip if photo reminders are off
      if (a.photo_reminders === false || a.photo_reminders === 'false') continue;

      // Skip if they sent a photo in the last 7 days
      if (r.photos_last_at && (now - new Date(r.photos_last_at).getTime()) < WEEK) continue;

      // Skip if we asked in the last window
      const lastAsk = r.last_photo_ask_at ? new Date(r.last_photo_ask_at).getTime() : 0;
      const submittedAt = new Date(r.submitted_at).getTime();
      const weeksSinceLaunch = Math.floor((now - submittedAt) / WEEK);

      let interval;
      if (weeksSinceLaunch <= 4) {
        interval = WEEK; // weekly for the first month
      } else {
        interval = 30 * DAY; // monthly after that
      }

      if (lastAsk && (now - lastAsk) < interval) continue;

      // This client is due
      const trade = a.trade || 'work';
      const message = weeksSinceLaunch <= 1
        ? `Hey ${name}, how is the first week going? If you finished a job, send me a couple of photos and I will get them on your site.`
        : weeksSinceLaunch <= 4
        ? `Hey ${name}, finished any ${trade} jobs lately? Send me a photo or two and I will add them to your gallery.`
        : `Hey ${name}, it has been a while since we added photos to your site. If you have any recent ${trade} jobs, send them over and I will get them up there.`;

      due.push({
        code: r.code,
        client_id: r.id,
        name,
        business,
        phone: a.cell || a.phone || '',
        weeks_since_launch: weeksSinceLaunch,
        last_photo: r.photos_last_at || null,
        photo_count: r.photo_count || 0,
        message,
      });

      // Mark that we're asking today
      await sb(`client_onboarding?id=eq.${r.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ last_photo_ask_at: new Date().toISOString() }),
      });
    }

    return res.status(200).json({ ok: true, due: due.length, clients: due });
  } catch (e) {
    console.error('photo-reminders', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
