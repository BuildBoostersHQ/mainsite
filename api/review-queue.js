// /api/review-queue — returns job events that are due for a review ask or a photo ask.
//
// GET /api/review-queue             → review asks that are due (review_ask_at in the past, review_sent_at null)
// GET /api/review-queue?photos=true → photo asks that are due
// GET /api/review-queue?all=true    → everything, including already-sent
//
// PATCH /api/review-queue  { id, field }  → mark a review or photo ask as sent
//   field: "review_sent_at" or "photo_sent_at"
//
// The review asks leave out customers already matched to a Google review (the review_matches table,
// filled by /api/review-match). ?all=true still shows everyone.
//
// Internal only (BB_INTERNAL_SECRET). The future Valentina system or a scheduled task reads this
// queue to know who to text.
const { sb, allowed, configured } = require('./_sb');

const UUID = /^[0-9a-f-]{36}$/i;
const tenDigits = (phone) => String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    if (req.method === 'PATCH') {
      const { id, field } = req.body || {};
      if (!UUID.test(String(id || ''))) return res.status(400).json({ error: 'bad_id' });
      if (field !== 'review_sent_at' && field !== 'photo_sent_at') return res.status(400).json({ error: 'bad_field' });
      await sb(`job_events?id=eq.${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: new Date().toISOString() }),
      });
      return res.status(200).json({ ok: true });
    }

    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

    const photos = req.query?.photos === 'true';
    const all = req.query?.all === 'true';
    const now = new Date().toISOString();

    let filter = 'job_events?select=*,client_onboarding(code,prefill,answers)&order=created_at.desc&limit=200';

    if (all) {
      // Return everything
    } else if (photos) {
      filter += `&photo_ask_at=not.is.null&photo_ask_at=lte.${now}&photo_sent_at=is.null`;
    } else {
      filter += `&review_ask_at=not.is.null&review_ask_at=lte.${now}&review_sent_at=is.null`;
    }

    let rows = await sb(filter);

    // Leave out anyone already matched to a Google review (confirmed through /api/review-match), so they
    // are not asked again. If the review_matches table is not there yet, the queue works as it did before.
    let alreadyReviewed = 0;
    if (!photos && !all && rows.length) {
      try {
        const matches = await sb('review_matches?select=client_id,contact_phone&contact_phone=not.is.null&limit=10000');
        const done = new Set(matches.map((m) => `${m.client_id}:${m.contact_phone}`));
        const before = rows.length;
        rows = rows.filter((r) => !(r.client_id && done.has(`${r.client_id}:${tenDigits(r.customer_phone)}`)));
        alreadyReviewed = before - rows.length;
      } catch (e) {
        console.error('review-queue: could not read review_matches:', e.message);
      }
    }
    const events = rows.map(r => {
      const a = { ...(r.client_onboarding?.prefill || {}), ...(r.client_onboarding?.answers || {}) };
      return {
        id: r.id,
        client_id: r.client_id,
        business: a.business_name || '',
        owner_first_name: a.preferred_name || '',
        source: r.source,
        event_type: r.event_type,
        customer_name: r.customer_name,
        customer_phone: r.customer_phone,
        job_title: r.job_title,
        amount_cents: r.amount_cents,
        review_ask_at: r.review_ask_at,
        photo_ask_at: r.photo_ask_at,
        review_sent_at: r.review_sent_at,
        photo_sent_at: r.photo_sent_at,
        created_at: r.created_at,
      };
    });

    // Group by client for easier consumption
    const byClient = {};
    for (const e of events) {
      const key = e.client_id || 'unmatched';
      if (!byClient[key]) byClient[key] = { business: e.business, events: [] };
      byClient[key].events.push(e);
    }

    return res.status(200).json({ ok: true, type: photos ? 'photo_asks' : 'review_asks', total: events.length, already_reviewed_skipped: alreadyReviewed, by_client: byClient });
  } catch (e) {
    console.error('review-queue', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
