// /api/hcp-webhook — receives Housecall Pro webhook events.
//
// The client pastes this URL into their HCP settings and enables events. One endpoint
// serves every HCP client. HCP webhooks have no signature verification, so we validate
// by checking the event structure and matching the client by phone or business name.
//
// POST /api/hcp-webhook
// Same job_events table as the Jobber webhook, source = 'hcp'.
const { sb, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const HOUR = 3600000;

async function findClient(accountId, phone, companyName) {
  const clients = await sb('client_onboarding?select=id,prefill,answers&limit=500');
  const norm = (s) => String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  const p = norm(phone);
  for (const c of clients) {
    const a = { ...(c.prefill || {}), ...(c.answers || {}) };
    if (p && p.length === 10 && norm(a.business_phone) === p) return c;
    const bn = String(a.business_name || '').toLowerCase();
    if (bn.length >= 4 && companyName && companyName.toLowerCase().includes(bn)) return c;
  }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured()) return res.status(500).json({ error: 'not_configured' });

  try {
    const body = req.body || {};

    // HCP sends events with varying structures. Normalize.
    const eventType = String(body.event || body.event_type || body.type || '').toLowerCase();
    const data = body.data || body;

    // Extract fields from HCP's event payload
    const customer = data.customer || data.client || {};
    const customerName = customer.first_name
      ? `${customer.first_name} ${customer.last_name || ''}`.trim()
      : (data.customer_name || '');
    const customerPhone = customer.mobile_number || customer.phone_number || data.customer_phone || '';
    const jobTitle = data.line_items
      ? data.line_items.map(li => li.name || li.description).filter(Boolean).join(', ')
      : (data.description || data.title || '');
    const amountCents = data.total_amount ? Math.round(parseFloat(data.total_amount) * 100)
      : (data.total ? Math.round(parseFloat(data.total) * 100) : null);
    const completedAt = data.completed_at || data.closed_at || data.paid_at || new Date().toISOString();
    const companyName = data.company_name || data.company || '';
    const accountId = data.account_id || data.company_id || '';

    const isJob = /job[._]?(completed|closed|done|finished)/i.test(eventType);
    const isQuote = /estimate[._]?(created|sent)|quote[._]?(created|sent)/i.test(eventType);
    const isInvoice = /invoice[._]?(paid|completed)|payment[._]?(received|completed)/i.test(eventType);

    if (!isJob && !isQuote && !isInvoice) {
      return res.status(200).json({ ok: true, skipped: true, reason: 'unhandled_event_type' });
    }

    const client = await findClient(accountId, customerPhone, companyName);
    const mapped = isJob ? 'job_completed' : isQuote ? 'quote_created' : 'invoice_paid';
    const reviewAt = (isJob || isInvoice) ? new Date(new Date(completedAt).getTime() + 3 * HOUR).toISOString() : null;
    const photoAt = isJob ? new Date(new Date(completedAt).getTime() + 6 * HOUR).toISOString() : null;

    const row = {
      client_id: client ? client.id : null,
      source: 'hcp',
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
      sendAlert('HCP event with no client match', `${mapped}: ${customerName || 'unknown'}, phone ${customerPhone || 'none'}, company ${companyName || 'none'}`).catch(() => {});
    }

    return res.status(200).json({ ok: true, event_type: mapped, matched: !!client, id: saved[0]?.id });
  } catch (e) {
    console.error('hcp-webhook', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
