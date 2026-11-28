// /api/photo-reminders — the recurring "send me photos of your work" text to each client.
//
// Schedule for each client:
//   - Weeks 1 to 4 after their setup form came in: one ask a week
//   - After week 4: one ask a month
//   - Skipped when they sent a photo in the last 7 days
//   - Skipped when photo reminders are off (they unticked it on the form, or texted NOPICS)
//
// Run once a day by Vercel's scheduler (see vercel.json), and it only texts from 9 AM up to 7 PM
// Eastern. The text goes from the Build Boosters line, the same one Automated Maddie uses, so a
// photo sent back in reply lands on the client text line. A client is only marked as asked when
// the text really went out, so a failed send is tried again the next day.
//
// POST /api/photo-reminders                    → who is due and what they would get. Nothing is sent.
// POST /api/photo-reminders  { "send": true }  → sends them now.
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured, isCron } = require('./_sb');
const { textClient, digits } = require('./_text');
const { sendAlert } = require('./alert');

const DAY = 86400000;
const WEEK = 7 * DAY;

function easternHour(now) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(h) % 24;
}

// The cell he gave consent on comes first, because that is the phone in his pocket.
function cellFor(r, a) {
  for (const p of [r.sms_consent_cell, a.cell, a.owner_cell, a.phone, a.business_phone]) {
    if (digits(p).length === 10) return digits(p);
  }
  return '';
}

function messageFor(name, trade, weeks) {
  const hey = name ? `Hey ${name}` : 'Hey';
  const stop = ' Reply NOPICS if you would rather not get these.';
  if (weeks <= 1) return `${hey}, how is the first week going? If you finished a job, text me a couple of photos right here and I will get them on your site.${stop}`;
  if (weeks <= 4) return `${hey}, finished any ${trade} jobs lately? Text me a photo or two right here and I will add them to your gallery.${stop}`;
  return `${hey}, it has been a while since we added photos to your site. If you have any recent ${trade} jobs, text them to me here and I will get them up there.${stop}`;
}

// Who is due right now. Changes nothing.
function dueClients(rows, now) {
  const due = [];
  for (const r of rows) {
    if (!r.submitted_at) continue;
    const a = { ...(r.prefill || {}), ...(r.answers || {}) };
    if (a.photo_reminders === false || a.photo_reminders === 'false') continue;
    if (r.photos_last_at && now - new Date(r.photos_last_at).getTime() < WEEK) continue;
    const weeks = Math.floor((now - new Date(r.submitted_at).getTime()) / WEEK);
    const interval = weeks <= 4 ? WEEK : 30 * DAY;
    const lastAsk = r.last_photo_ask_at ? new Date(r.last_photo_ask_at).getTime() : 0;
    // A few hours of slack, so a daily run does not slip a day every week.
    if (lastAsk && now - lastAsk < interval - 6 * 3600000) continue;
    const name = a.preferred_name || r.owner_first_name || '';
    due.push({
      id: r.id,
      code: r.code,
      name,
      business: a.business_name || '',
      phone: cellFor(r, a),
      weeks_since_setup: weeks,
      last_photo: r.photos_last_at || null,
      photo_count: r.photo_count || 0,
      message: messageFor(name, String(a.trade || 'work').replace(/-/g, ' '), weeks),
    });
  }
  return due;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && !isCron(req)) return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const now = Date.now();
    const rows = await sb('client_onboarding?select=*&submitted_at=not.is.null&order=created_at.desc&limit=500');
    const due = dueClients(rows, now);
    const send = isCron(req) || !!(req.body && req.body.send);
    if (!send) return res.status(200).json({ ok: true, sent: 0, due: due.length, clients: due });

    const hour = easternHour(now);
    if (hour < 9 || hour >= 19) return res.status(200).json({ ok: true, sent: 0, due: due.length, held: 'outside 9 AM to 7 PM Eastern' });

    const sent = [], failed = [];
    for (const c of due) {
      if (!c.phone) { failed.push(`${c.business || c.code} (no cell on file)`); continue; }
      const result = await textClient(c.phone, c.message, c.name || undefined);
      if (result.sent) {
        await sb(`client_onboarding?id=eq.${c.id}`, { method: 'PATCH', body: JSON.stringify({ last_photo_ask_at: new Date(now).toISOString() }) });
        sent.push(c.business || c.code);
      } else {
        failed.push(`${c.business || c.code} (${result.reason || 'not sent'})`);
      }
    }
    if (failed.length) await sendAlert('Photo reminders failed', `${failed.length} did not go out: ${failed.slice(0, 3).join('; ')}`).catch(() => {});
    return res.status(200).json({ ok: true, sent: sent.length, due: due.length, clients: sent, failed });
  } catch (e) {
    console.error('photo-reminders', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.dueClients = dueClients;
module.exports.messageFor = messageFor;
module.exports.cellFor = cellFor;
