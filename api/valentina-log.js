// /api/valentina-log — what Valentina said and did, for Maddie's dashboard. Internal only.
//
// Valentina's text line (the valentina-ai project) writes every text, reply, action and handoff to
// valentina_messages, and its daily review writes the conversations where something went wrong to
// valentina_reviews. This endpoint reads both from the same Supabase project.
//
// Header x-bb-secret: BB_INTERNAL_SECRET on every call.
//
// GET   /api/valentina-log                   flagged conversations (newest first), recent conversations, and counts
// GET   /api/valentina-log?phone=+18135550142   the full transcript for one number, oldest first
// PATCH /api/valentina-log?id=<review id>    body { status: 'reviewed' | 'new', note? }
const { sb, allowed, configured } = require('./_sb');

const UUID = /^[0-9a-f-]{36}$/i;
const PHONE = /^\+1\d{10}$/;
const DAY = 86400000;

const businessOf = (c) => {
  if (!c) return '';
  const a = { ...(c.prefill || {}), ...(c.answers || {}) };
  return a.business_name || c.owner_first_name || '';
};

// One line per phone number from a list of message rows, newest conversation first.
function conversations(rows, names) {
  const by = new Map();
  for (const r of rows) {
    if (!r.phone) continue;
    let c = by.get(r.phone);
    if (!c) { c = { phone: r.phone, client_id: null, last_at: r.created_at, last_text: '', texts_in: 0, texts_out: 0, handoffs: 0, unanswered: 0 }; by.set(r.phone, c); }
    if (r.client_id && !c.client_id) c.client_id = r.client_id;
    if (String(r.created_at) > String(c.last_at)) c.last_at = r.created_at;
    if (r.direction === 'in') { c.texts_in++; if (r.status === 'failed') c.unanswered++; }
    if (r.direction === 'out') c.texts_out++;
    if (r.direction === 'handoff') c.handoffs++;
    // Rows arrive newest first, so the first text seen for a number is its latest.
    if (!c.last_text && (r.direction === 'in' || r.direction === 'out')) c.last_text = String(r.body || '').slice(0, 140);
  }
  return [...by.values()]
    .map((c) => ({ ...c, business: names.get(c.client_id) || '' }))
    .sort((a, b) => String(b.last_at).localeCompare(String(a.last_at)));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    if (req.method === 'PATCH') {
      const id = String(req.query?.id || '').trim();
      if (!UUID.test(id)) return res.status(400).json({ error: 'bad_id' });
      const { status, note } = req.body || {};
      if (!['new', 'reviewed'].includes(status)) return res.status(400).json({ error: 'bad_status' });
      const patch = { status };
      if (typeof note === 'string') patch.note = note.trim().slice(0, 1000);
      await sb(`valentina_reviews?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    // A plus sign in a web address arrives as a space unless it was encoded, so both are accepted.
    const raw = String(req.query?.phone || '');
    const phone = raw ? raw.trim().replace(/^\+?/, '+') : '';
    if (phone) {
      if (!PHONE.test(phone)) return res.status(400).json({ error: 'bad_phone' });
      const p = encodeURIComponent(phone);
      const [messages, reviews] = await Promise.all([
        sb(`valentina_messages?phone=eq.${p}&select=id,direction,body,media,status,client_id,created_at&order=created_at.desc&limit=400`),
        sb(`valentina_reviews?phone=eq.${p}&select=*&order=day.desc&limit=30`),
      ]);
      const clientId = messages.map((m) => m.client_id).find(Boolean);
      const client = clientId ? (await sb(`client_onboarding?id=eq.${clientId}&select=owner_first_name,prefill,answers,tier&limit=1`))[0] : null;
      return res.status(200).json({
        phone, business: businessOf(client), plan: (client && client.tier) || '',
        // A photo link from the carrier is not sent to the dashboard, only how many there were.
        messages: messages.reverse().map(({ media, ...m }) => ({ ...m, photos: Array.isArray(media) ? media.length : 0 })),
        reviews,
      });
    }

    const since = new Date(Date.now() - 14 * DAY).toISOString();
    const [reviews, recent] = await Promise.all([
      sb('valentina_reviews?select=*&order=day.desc,created_at.desc&limit=200'),
      sb(`valentina_messages?created_at=gte.${encodeURIComponent(since)}&select=phone,direction,body,status,client_id,created_at&order=created_at.desc&limit=3000`),
    ]);
    const ids = [...new Set([...reviews, ...recent].map((r) => r.client_id).filter(Boolean))];
    const clients = ids.length ? await sb(`client_onboarding?id=in.(${ids.join(',')})&select=id,owner_first_name,prefill,answers`) : [];
    const names = new Map(clients.map((c) => [c.id, businessOf(c)]));

    const week = recent.filter((r) => Date.now() - new Date(r.created_at).getTime() < 7 * DAY);
    return res.status(200).json({
      reviews: reviews.map((r) => ({ ...r, business: names.get(r.client_id) || '' })),
      conversations: conversations(recent, names).slice(0, 100),
      week: {
        texts_in: week.filter((r) => r.direction === 'in').length,
        replies: week.filter((r) => r.direction === 'out').length,
        handoffs: week.filter((r) => r.direction === 'handoff').length,
        unanswered: week.filter((r) => r.direction === 'in' && r.status === 'failed').length,
        held: week.filter((r) => r.direction === 'in' && r.status === 'held').length,
      },
    });
  } catch (e) {
    console.error('valentina-log', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

Object.assign(module.exports, { conversations });
