// /api/jobber-webhook — receives Jobber webhook events and records them for review/photo asks.
//
// Jobber's native GHL integration handles the CRM side. This endpoint tracks job completions,
// quotes and payments so the review and photo ask systems know when to fire.
//
// POST /api/jobber-webhook
// Header: x-jobber-secret must match JOBBER_WEBHOOK_SECRET in Vercel.
//
// Events stored in the job_events table. Review asks queue at completed_at + 3h,
// photo asks at completed_at + 6h. Nothing sends a text from here; /api/send-asks hands each
// finished job to the client's sub-account when it comes due, and the review-queue
// endpoint serves the queue to whatever sends them.
const { sb, configured } = require('./_sb');
const { sendAlert } = require('./alert');
const crypto = require('crypto');

const HOUR = 3600000;

function allowed(req) {
  const want = (process.env.JOBBER_WEBHOOK_SECRET || '').trim();
  const got = (req.headers['x-jobber-secret'] || '').trim();
  if (want.length < 16 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

async function findClient(name, phone) {
  if (!name && !phone) return null;
  const clients = await sb('client_onboarding?select=id,prefill,answers&limit=500');
  const norm = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const p = norm(phone);
  for (const c of clients) {
    const a = { ...(c.prefill || {}), ...(c.answers || {}) };
    if (p && p.length === 10 && norm(a.business_phone) === p) return c;
    const bn = String(a.business_name || '').toLowerCase();
    if (bn.length >= 4 && name && name.toLowerCase().includes(bn)) return c;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured()) return res.status(500).json({ error: 'not_configured' });
  if (!process.env.JOBBER_WEBHOOK_SECRET) return res.status(500).json({ error: 'not_configured', reason: 'JOBBER_WEBHOOK_SECRET not set' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const body = req.body || {};
    const eventType = String(body.event || body.type || body.topic || '').toLowerCase();
    const data = body.data || body.payload || body;

    const customerName = data.customer_name || data.client_name || (data.customer && data.customer.name) || '';
    const customerPhone = data.customer_phone || data.client_phone || (data.customer && (data.customer.phone || data.customer.mobile)) || '';
    const jobTitle = data.title || data.job_title || data.description || '';
    const amountCents = data.total ? Math.round(parseFloat(data.total) * 100) : (data.amount_cents || null);
    const completedAt = data.completed_at || data.closed_at || data.paid_at || new Date().toISOString();

    const client = await findClient(data.company_name || data.account_name || '', customerPhone);
    const isJob = /job[._](completed|closed|done)/i.test(eventType);
    const isQuote = /quote[._](created|sent)/i.test(eventType);
    const isInvoice = /invoice[._](paid|completed)/i.test(eventType);

    if (!isJob && !isQuote && !isInvoice) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'unhandled_event_type' });
    }

    const mapped = isJob ? 'job_completed' : isQuote ? 'quote_created' : 'invoice_paid';
    const reviewAt = (isJob || isInvoice) ? new Date(new Date(completedAt).getTime() + 3 * HOUR).toISOString() : null;
    const photoAt = isJob ? new Date(new Date(completedAt).getTime() + 6 * HOUR).toISOString() : null;

    const row = {
      client_id: client ? client.id : null,
      source: 'jobber',
      event_type: mapped,
      customer_name: String(customerName).slice(0, 200),
      customer_phone: String(customerPhone).slice(0, 30),
      job_title: String(jobTitle).slice(0, 300),
      amount_cents: amountCents,
      review_ask_at: reviewAt,
      photo_ask_at: photoAt,
    };

    const saved = await sb('job_events', { method: 'POST', body: JSON.stringify(row) });

    if (!client) {
      sendAlert('Jobber event with no client match', `${mapped}: ${customerName || 'unknown customer'}, phone ${customerPhone || 'none'}`).catch(() => {});
    }

    return res.status(200).json({ ok: true, event_type: mapped, matched: !!client, id: saved[0]?.id });
  } catch (e) {
    console.error('jobber-webhook', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
