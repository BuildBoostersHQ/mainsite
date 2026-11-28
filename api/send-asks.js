// /api/send-asks — hands finished jobs to the client's HighLevel sub-account so the review request
// and the photo request go out. This is the piece that sends what /api/review-queue only lists.
//
// Jobs arrive from Jobber, Housecall Pro or the DONE keyword and sit in job_events with a review
// time three hours after the job closed. Once that time has passed, this endpoint:
//   1. finds or adds the customer in the client's own sub-account
//   2. takes the tag "job-done" off (so it can fire again for a repeat customer) and puts it back on
//   3. marks the job as sent
// The tag is what starts the client's own workflows, so the texts come from the contractor's number
// with the wording in the GHL build pack: the review request to the customer, and "Photo Request
// After Job" to the contractor three hours later. Nothing is texted from this file.
//
// Rules:
//   - Daytime only: jobs are handed over from 10 AM up to 5 PM Eastern. A job that comes due at
//     night waits for the next morning.
//   - Finished work only: quotes are never handed over.
//   - Texting has to be approved first. A job waits while the client's registration is pending.
//   - A job that has waited more than 14 days is closed out without an ask, because a review
//     request that late reads as strange.
//   - Nobody gets asked twice: a customer who was handed over in the last 30 days is skipped. This
//     also covers Jobber sending "job closed" and "invoice paid" for the same job.
//
// Run every hour by Vercel's scheduler (see vercel.json). Internal only.
// POST { "dry_run": true } shows what it would do and changes nothing.
//
// Needs GHL_API_KEY (the same token the customer list uses to reach client sub-accounts),
// BB_INTERNAL_SECRET and the two Supabase variables.
const { sb, allowed, configured, isCron } = require('./_sb');
const { digits } = require('./_text');
const { sendAlert } = require('./alert');

const GHL = 'https://services.leadconnectorhq.com';
const TAG = 'job-done';
const DAY = 86400000;
const MAX_WAIT_DAYS = 14;
const REPEAT_DAYS = 30;

function easternHour(now) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(h) % 24;
}

const inWindow = (now) => { const h = easternHour(now); return h >= 10 && h < 17; };

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { firstName: parts[0] || '', lastName: parts.slice(1).join(' ') };
}

// What to do with one due job. `recent` is the set of customer phones this client already had
// handed over in the last 30 days. Returns { action: 'send' | 'wait' | 'skip', why }.
function decide(event, client, recent, now) {
  if (event.event_type !== 'job_completed' && event.event_type !== 'invoice_paid') return { action: 'skip', why: 'not_finished_work' };
  if (!client) return { action: 'skip', why: 'no_client_match' };
  const phone = digits(event.customer_phone);
  if (phone.length !== 10) return { action: 'skip', why: 'no_customer_phone' };
  if (recent.has(phone)) return { action: 'skip', why: 'asked_in_last_30_days' };
  if (now - new Date(event.review_ask_at).getTime() > MAX_WAIT_DAYS * DAY) return { action: 'skip', why: 'waited_too_long' };
  if (!client.ghl_location_id) return { action: 'wait', why: 'no_sub_account_yet' };
  if (!client.a2p_registered_at) return { action: 'wait', why: 'texting_not_approved_yet' };
  return { action: 'send', why: '' };
}

async function ghl(path, method, body) {
  const key = (process.env.GHL_API_KEY || '').trim();
  const res = await fetch(`${GHL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${key}`, Version: '2021-07-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`ghl_${res.status}`);
  return data;
}

// Finds or adds the customer in the client's sub-account and fires the tag.
async function handToGhl(locationId, event) {
  const { firstName, lastName } = splitName(event.customer_name);
  const up = await ghl('/contacts/upsert', 'POST', {
    locationId,
    phone: `+1${digits(event.customer_phone)}`,
    source: `Job finished (${event.source})`,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
  });
  const contactId = up && up.contact && up.contact.id;
  if (!contactId) throw new Error('no_contact_id');
  // Off first, because HighLevel only fires "tag added" when the tag is new on the contact.
  await ghl(`/contacts/${contactId}/tags`, 'DELETE', { tags: [TAG] }).catch(() => {});
  await ghl(`/contacts/${contactId}/tags`, 'POST', { tags: [TAG] });
  return contactId;
}

async function run({ now = Date.now(), dryRun = false } = {}) {
  const out = { sent: [], waiting: [], skipped: [], failed: [], window_open: inWindow(now) };
  if (!out.window_open && !dryRun) return out;

  const nowIso = new Date(now).toISOString();
  const due = await sb(
    `job_events?select=*,client_onboarding(id,prefill,answers,ghl_location_id,a2p_registered_at)` +
    `&review_ask_at=not.is.null&review_ask_at=lte.${nowIso}&review_sent_at=is.null&ask_skipped_at=is.null&order=review_ask_at.asc&limit=200`
  );
  if (!due.length) return out;

  // Who was already handed over in the last 30 days, per client.
  const since = new Date(now - REPEAT_DAYS * DAY).toISOString();
  const sentLately = await sb(`job_events?select=client_id,customer_phone&review_sent_at=gte.${since}&limit=2000`);
  const recentByClient = {};
  for (const r of sentLately) {
    if (!r.client_id) continue;
    (recentByClient[r.client_id] = recentByClient[r.client_id] || new Set()).add(digits(r.customer_phone));
  }

  for (const event of due) {
    const client = event.client_onboarding || null;
    const a = client ? { ...(client.prefill || {}), ...(client.answers || {}) } : {};
    const label = `${a.business_name || 'unmatched'}: ${event.customer_name || 'customer'}`;
    const recent = (client && recentByClient[client.id]) || new Set();
    const { action, why } = decide(event, client, recent, now);

    if (action === 'wait') { out.waiting.push(`${label} (${why})`); continue; }
    if (action === 'skip') {
      out.skipped.push(`${label} (${why})`);
      if (!dryRun) await sb(`job_events?id=eq.${event.id}`, { method: 'PATCH', body: JSON.stringify({ ask_skipped_at: nowIso, ask_note: why }) });
      continue;
    }
    if (dryRun) { out.sent.push(`${label} (dry run)`); recent.add(digits(event.customer_phone)); continue; }
    try {
      await handToGhl(client.ghl_location_id, event);
      const patch = { review_sent_at: nowIso };
      if (event.photo_ask_at) patch.photo_sent_at = nowIso;
      await sb(`job_events?id=eq.${event.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      recent.add(digits(event.customer_phone));
      if (client) recentByClient[client.id] = recent;
      out.sent.push(label);
    } catch (e) {
      out.failed.push(`${label} (${e.message})`);
    }
  }

  if (out.failed.length && !dryRun) {
    await sendAlert('Review asks failed', `${out.failed.length} finished job${out.failed.length === 1 ? '' : 's'} could not be handed to HighLevel: ${out.failed.slice(0, 3).join('; ')}`).catch(() => {});
  }
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && !isCron(req)) return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!(process.env.GHL_API_KEY || '').trim()) return res.status(500).json({ error: 'not_configured', reason: 'GHL_API_KEY is not set' });
  try {
    const dryRun = !!(req.body && req.body.dry_run);
    const out = await run({ dryRun });
    return res.status(200).json({ ok: true, dry_run: dryRun, ...out });
  } catch (e) {
    console.error('send-asks', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.decide = decide;
module.exports.inWindow = inWindow;
module.exports.splitName = splitName;
module.exports.TAG = TAG;
