// /api/review-inbox — what happens after a client gets a new Google review.
//
// A "Review Received" workflow in each client's HighLevel sub-account posts the review here.
//
//   1 to 3 stars: the contractor is texted the link to respond himself, with a calm reply he can use,
//                 and Maddie gets the same alert. Nothing is ever posted for him.
//   4 and 5 stars: HighLevel's Reviews AI answers these for now (REVIEW_45_MODE unset or "reviews_ai"),
//                 so the review is only recorded here. With REVIEW_45_MODE=text the contractor is texted
//                 a draft instead: YES posts it, any other answer posts his wording, and 48 hours of
//                 silence posts the draft. That path waits on Google's own access and an inbound text
//                 handler, so it is built and switched off.
//
// ON HOLD: nothing is texted until REVIEW_TEXTS_ON=true is set in Vercel. Until then every review is
// saved with status "held" so nothing is lost. Turn it on once the Build Boosters line is approved for texting.
//
// POST  /api/review-inbox                       a new review, from the HighLevel workflow
//       { location_id, rating, reviewer, text, review_id, review_url, source, google_review_name }
// POST  /api/review-inbox  { action: "reply", phone, body }   the contractor's answer (from the inbound text handler, not built yet)
// GET   /api/review-inbox                       hourly sweep (Vercel schedule): sends texts that waited for daytime, posts 48-hour drafts
// GET   /api/review-inbox?queue=true            approved replies waiting to be posted by hand in the sub-account
// PATCH /api/review-inbox  { id }               mark a queued reply as posted
//
// Internal only (BB_INTERNAL_SECRET in the x-bb-secret header, or the Vercel schedule).
// Needs the review_replies table (supabase/client_onboarding.sql). ANTHROPIC_API_KEY writes the drafts,
// and a plain fallback is used without it. GOOGLE_BP_CLIENT_ID, GOOGLE_BP_CLIENT_SECRET and
// GOOGLE_BP_REFRESH_TOKEN let approved replies post to Google on their own. Without them they queue.
const { sb, allowed, configured } = require('./_sb');
const { textClient, digits } = require('./_text');

const TABLE = 'review_replies';
const CLIENTS = 'client_onboarding';
const HOUR = 3600000;
const MODEL = 'claude-sonnet-4-20250514';
const UUID = /^[0-9a-f-]{36}$/i;
const DRAFT_MAX = 220;
const GOOGLE_REVIEWS = 'https://business.google.com/reviews';

const on = () => String(process.env.REVIEW_TEXTS_ON || '').trim().toLowerCase() === 'true';
const mode45 = () => (String(process.env.REVIEW_45_MODE || '').trim().toLowerCase() === 'text' ? 'text' : 'reviews_ai');

// The hour of the day in Miami, 0 to 23. Review texts only go out from 10 AM up to 5 PM.
function easternHour(now) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(h) % 24;
}
const inWindow = (now) => { const h = easternHour(now); return h >= 10 && h < 17; };

const stars = (rating) => Math.max(1, Math.min(5, Math.round(Number(rating) || 0)));
const isLow = (rating) => stars(rating) <= 3;
const firstWord = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// What to do with a review the moment it arrives.
//   held        the switch is off
//   reviews_ai  4 or 5 stars and HighLevel answers it, so it is only recorded
//   pending     a text is owed (sent now when it is daytime and nothing else is waiting on him)
function route(rating, { switchedOn = on(), mode = mode45() } = {}) {
  if (!isLow(rating) && mode !== 'text') return 'reviews_ai';
  return switchedOn ? 'pending' : 'held';
}

const isYes = (body) => /^(yes|y|yep|yeah|yup|ok|okay|post it|sounds good|looks good)[\s.!]*$/i.test(String(body || '').trim());

// Keeps a draft short enough to text, cut at the end of a sentence where possible.
function trimDraft(text) {
  const t = String(text || '').replace(/\s+/g, ' ').replace(/^["'“]+|["'”]+$/g, '').replace(/—/g, ',').trim();
  if (t.length <= DRAFT_MAX) return t;
  const cut = t.slice(0, DRAFT_MAX);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '));
  return end > 60 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, '') + '.';
}

// Used when the draft writer is not set up or fails, so a text can still go out.
function fallbackDraft(rating, reviewer, business, phone) {
  const name = firstWord(reviewer);
  const hi = name ? `${name}, ` : '';
  if (isLow(rating)) {
    const call = phone ? ` Please call us at ${phone} so we can make it right.` : ' Please call us so we can make it right.';
    return trimDraft(`${hi}thank you for telling us, and we are sorry the job did not go the way you expected.${call}`);
  }
  return trimDraft(`${hi}thank you for the kind words and for trusting ${business || 'us'} with the job. We would be glad to help again any time.`);
}

function draftPrompt({ rating, reviewer, text, business, trade, phone }) {
  const low = isLow(rating);
  return `Write the public reply a contractor posts under a Google review of his business.

Business: ${business || 'a local contractor'}${trade ? ` (${trade})` : ''}
Business phone: ${phone || 'not given'}
Reviewer: ${reviewer || 'a customer'}
Stars: ${stars(rating)} of 5
Review: ${text ? `"${String(text).slice(0, 1200)}"` : '(no words, stars only)'}

Rules:
- Under 200 characters, two sentences at most, written as the owner in plain everyday words.
- Use the reviewer's first name once when there is one.
- ${low ? 'Stay calm and never argue, blame the customer or explain what happened. Thank them for saying so and ask them to call the business phone so it can be made right.' : 'Thank them and mention the kind of work only when the review itself mentions it.'}
- Never repeat private details such as an address, a price or a last name, and never offer money, a discount or a gift.
- No dashes of any kind, no semicolons, no emoji, no exclamation marks${low ? '' : ' beyond one'}, no hashtags.
- Output the reply only, with no quotation marks around it.`;
}

async function writeDraft(review) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const fallback = fallbackDraft(review.rating, review.reviewer, review.business, review.phone);
  if (!key) return fallback;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 200, messages: [{ role: 'user', content: draftPrompt(review) }] }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const out = trimDraft(data.content && data.content[0] && data.content[0].text);
    return out.length > 20 ? out : fallback;
  } catch { return fallback; }
}

const TEXTS = {
  low: (n, rating, reviewer, link, draft) =>
    `${n ? `${n}, you` : 'You'} got a ${stars(rating)}-star review${reviewer ? ` from ${firstWord(reviewer)}` : ''}. Read it and respond here: ${link}\n\nHere's a calm reply you could use: "${draft}"\n\nAutomated Maddie`,
  high: (n, rating, reviewer, draft) =>
    `${n ? `${n}, ` : ''}${reviewer ? firstWord(reviewer) : 'A customer'} just left you ${stars(rating)} stars. Here's a reply we wrote: "${draft}" Text YES to post it, or text back what you'd rather say. If we don't hear from you in 48 hours, we'll post it for you.`,
};

const clientPhone = (row) => {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  return digits(a.cell || a.owner_cell || a.business_phone);
};
const clientFacts = (row) => {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const d = digits(a.business_phone);
  const phone = d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : '';
  return { business: a.business_name || '', trade: a.trade || '', phone, first: row.owner_first_name || '' };
};

// Posts a reply to Google. Returns true when it went up. Without Google's access, or without the
// review's full Google name, it returns false and the reply is queued to be posted by hand.
async function postToGoogle(reviewName, comment) {
  const id = String(process.env.GOOGLE_BP_CLIENT_ID || '').trim();
  const secret = String(process.env.GOOGLE_BP_CLIENT_SECRET || '').trim();
  const refresh = String(process.env.GOOGLE_BP_REFRESH_TOKEN || '').trim();
  if (!id || !secret || !refresh || !/^accounts\/[^/]+\/locations\/[^/]+\/reviews\/[^/]+$/.test(String(reviewName || ''))) return false;
  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
    });
    const token = (await tokenRes.json()).access_token;
    if (!token) return false;
    const res = await fetch(`https://mybusiness.googleapis.com/v4/${reviewName}/reply`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ comment }),
    });
    return res.ok;
  } catch { return false; }
}

const patch = (id, body) => sb(`${TABLE}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(body) });

// Sends the text a pending review is owed. Low reviews are finished once the link goes out.
// A 4 or 5 star draft waits behind any earlier one he has not answered, so a bare YES is never unclear.
async function sendPending(review, client, now) {
  if (!inWindow(now)) return 'waiting_for_daytime';
  const phone = clientPhone(client);
  const f = clientFacts(client);
  if (isLow(review.rating)) {
    const sent = await textClient(phone, TEXTS.low(f.first, review.rating, review.reviewer, review.review_url || GOOGLE_REVIEWS, review.draft), f.first);
    if (!sent.sent) return `not_sent_${sent.reason}`;
    await patch(review.id, { status: 'link_sent', texted_at: new Date(now).toISOString() });
    return 'link_sent';
  }
  const open = await sb(`${TABLE}?select=id&client_id=eq.${client.id}&status=eq.texted&limit=1`);
  if (open.length) return 'waiting_for_earlier_answer';
  const sent = await textClient(phone, TEXTS.high(f.first, review.rating, review.reviewer, review.draft), f.first);
  if (!sent.sent) return `not_sent_${sent.reason}`;
  await patch(review.id, { status: 'texted', texted_at: new Date(now).toISOString() });
  return 'texted';
}

// Posts an approved reply, or queues it to be posted by hand.
async function finish(review, reply, how, now) {
  const posted = await postToGoogle(review.google_review_name, reply);
  const stamp = new Date(now).toISOString();
  await patch(review.id, { final_reply: reply, approved_by: how, answered_at: stamp, status: posted ? 'posted' : 'queued', posted_at: posted ? stamp : null });
  return posted ? 'posted' : 'queued';
}

async function newReview(body, now) {
  const locationId = String(body.location_id || '').trim();
  if (!locationId) return { status: 400, json: { error: 'location_id_required' } };
  const rating = stars(body.rating);
  const reviewId = String(body.review_id || '').trim().slice(0, 300) || null;
  if (reviewId) {
    const seen = await sb(`${TABLE}?select=id,status&review_id=eq.${encodeURIComponent(reviewId)}&limit=1`);
    if (seen.length) return { status: 200, json: { ok: true, existing: true, status: seen[0].status } };
  }
  const clients = await sb(`${CLIENTS}?select=id,owner_first_name,prefill,answers&ghl_location_id=eq.${encodeURIComponent(locationId)}&limit=1`);
  const client = clients[0] || null;
  const f = client ? clientFacts(client) : {};
  const status = client ? route(rating) : 'unmatched';
  const review = {
    client_id: client ? client.id : null,
    ghl_location_id: locationId,
    source: String(body.source || 'google').slice(0, 40),
    rating,
    reviewer: String(body.reviewer || '').slice(0, 120) || null,
    review_text: String(body.text || '').slice(0, 4000) || null,
    review_id: reviewId,
    review_url: /^https:\/\//.test(String(body.review_url || '')) ? String(body.review_url).slice(0, 500) : null,
    google_review_name: String(body.google_review_name || '').slice(0, 300) || null,
    status,
  };
  // Reviews AI writes its own reply, so a draft is only written when a text will carry it.
  if (status === 'pending' || status === 'held') {
    review.draft = await writeDraft({ rating, reviewer: review.reviewer, text: review.review_text, business: f.business, trade: f.trade, phone: f.phone });
  }
  const saved = (await sb(TABLE, { method: 'POST', body: JSON.stringify(review) }))[0];

  let outcome = status;
  if (status === 'pending') outcome = await sendPending(saved, client, now);
  // Maddie hears about every low review right away, whatever the hour and whether or not texts are on.
  if (isLow(rating)) {
    try {
      const { sendAlert } = require('./alert');
      await sendAlert('Low review', `${f.business || locationId} got ${rating} stars${review.reviewer ? ` from ${review.reviewer}` : ''}. ${status === 'held' ? 'Review texts are on hold, so he has not been told.' : 'He is being sent the link and a draft.'}`);
    } catch (e) { console.error('review-inbox: alert failed:', e.message); }
  }
  return { status: 200, json: { ok: true, id: saved.id, status: outcome } };
}

// The contractor's answer to a 4 or 5 star draft. Called by the inbound text handler once it exists.
async function handleReply(phone, body, now = Date.now()) {
  const d = digits(phone);
  const words = String(body || '').trim();
  if (d.length !== 10 || !words) return { matched: false };
  const waiting = await sb(`${TABLE}?select=*,${CLIENTS}(id,owner_first_name,prefill,answers)&status=eq.texted&order=texted_at.asc&limit=200`);
  const review = waiting.find((r) => r[CLIENTS] && clientPhone(r[CLIENTS]) === d);
  if (!review) return { matched: false };
  const yes = isYes(words);
  const result = await finish(review, yes ? review.draft : trimReply(words), yes ? 'yes' : 'own_words', now);
  await releaseNext(review[CLIENTS], now);
  return { matched: true, id: review.id, result };
}

// His own wording is posted as he wrote it, only tidied and capped at Google's reply length.
const trimReply = (s) => String(s).replace(/\s+/g, ' ').trim().slice(0, 4000);

// After one answer comes in, the next review waiting on the same contractor gets its text.
async function releaseNext(client, now) {
  const next = await sb(`${TABLE}?select=*&client_id=eq.${client.id}&status=eq.pending&order=created_at.asc&limit=1`);
  if (next.length) await sendPending(next[0], client, now);
}

// Hourly: post 4 and 5 star drafts that sat for 48 hours, then send anything that waited for daytime.
async function sweep(now) {
  if (!on()) return { ok: true, on_hold: true };
  const out = { posted_after_48h: 0, sent: 0 };
  const texted = await sb(`${TABLE}?select=*,${CLIENTS}(id,owner_first_name,prefill,answers)&status=eq.texted&limit=200`);
  for (const r of texted) {
    if (!silentFor48(r.texted_at, now)) continue;
    await finish(r, r.draft, 'silence_48h', now);
    out.posted_after_48h++;
  }
  if (inWindow(now)) {
    const pending = await sb(`${TABLE}?select=*,${CLIENTS}(id,owner_first_name,prefill,answers)&status=eq.pending&order=created_at.asc&limit=200`);
    for (const r of pending) {
      if (!r[CLIENTS]) continue;
      const result = await sendPending(r, r[CLIENTS], now);
      if (result === 'texted' || result === 'link_sent') out.sent++;
    }
  }
  return { ok: true, ...out };
}
const silentFor48 = (textedAt, now) => !!textedAt && now - new Date(textedAt).getTime() >= 48 * HOUR;

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  const now = Date.now();
  try {
    if (req.method === 'GET') {
      if (req.query && req.query.queue === 'true') {
        const queue = await sb(`${TABLE}?select=id,ghl_location_id,rating,reviewer,review_text,final_reply,approved_by,answered_at,${CLIENTS}(prefill,answers)&status=eq.queued&order=answered_at.asc&limit=200`);
        return res.status(200).json({ ok: true, queue });
      }
      return res.status(200).json(await sweep(now));
    }
    if (req.method === 'PATCH') {
      const id = String((req.body || {}).id || '');
      if (!UUID.test(id)) return res.status(400).json({ error: 'bad_id' });
      await patch(id, { status: 'posted', posted_at: new Date(now).toISOString() });
      return res.status(200).json({ ok: true });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const body = req.body || {};
    if (body.action === 'reply') return res.status(200).json({ ok: true, ...(await handleReply(body.phone, body.body, now)) });
    const result = await newReview(body, now);
    return res.status(result.status).json(result.json);
  } catch (e) {
    console.error('review-inbox', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

Object.assign(module.exports, { route, isYes, isLow, inWindow, easternHour, trimDraft, fallbackDraft, draftPrompt, silentFor48, handleReply, TEXTS });
