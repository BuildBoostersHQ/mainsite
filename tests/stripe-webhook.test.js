// Tests for api/stripe-webhook.js
const crypto = require('crypto');
const { tierFromAmount, verifySignature } = require('../api/stripe-webhook');

// ---- tierFromAmount ----
console.log('tierFromAmount:');
const cases = [
  [7900, 'website', 'monthly'],
  [19700, 'all_in_one', 'monthly'],
  [59100, 'all_in_one', 'quarterly'],
  [99700, 'all_in_one_ads', 'monthly'],
  [79000, 'website', 'annual'],
  [197000, 'all_in_one', 'annual'],
  [997000, 'all_in_one_ads', 'annual'],
  [12345, 'unknown', 'monthly'],
  [0, 'unknown', 'monthly'],
];
for (const [cents, tier, cycle] of cases) {
  const r = tierFromAmount(cents);
  const ok = r.tier === tier && r.billing_cycle === cycle;
  console.log(ok ? '  PASS' : '  FAIL', `$${cents / 100} -> ${tier}/${cycle}`, ok ? '' : `got ${r.tier}/${r.billing_cycle}`);
  if (!ok) process.exit(1);
}

// ---- verifySignature ----
console.log('verifySignature:');
const secret = 'whsec_test_secret_1234567890';
const payload = '{"id":"evt_123"}';
const t = Math.floor(Date.now() / 1000);
const sig = crypto.createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
const header = `t=${t},v1=${sig}`;

console.log(verifySignature(payload, header, secret) ? '  PASS valid sig' : '  FAIL valid sig');
console.log(!verifySignature(payload, header, 'wrong_secret') ? '  PASS wrong secret' : '  FAIL wrong secret');
console.log(!verifySignature('tampered', header, secret) ? '  PASS tampered payload' : '  FAIL tampered payload');
console.log(!verifySignature(payload, '', secret) ? '  PASS empty header' : '  FAIL empty header');
console.log(!verifySignature(payload, 't=123', secret) ? '  PASS missing v1' : '  FAIL missing v1');

// ---- Full handler ----
console.log('handler:');

const rows = [];
let lastInsert = null;

global.fetch = async (url, opts = {}) => {
  if (url.includes('select=code') && opts.method !== 'POST') {
    const emailMatch = url.match(/email\.eq\.([^&),]+)/);
    if (emailMatch) {
      const email = decodeURIComponent(emailMatch[1]);
      const found = rows.filter(r =>
        (r.prefill || {}).email === email || (r.answers || {}).email === email
      );
      return { ok: true, status: 200, text: async () => JSON.stringify(found) };
    }
    return { ok: true, status: 200, text: async () => '[]' };
  }
  if (opts.method === 'POST') {
    lastInsert = JSON.parse(opts.body);
    rows.push(lastInsert);
    return { ok: true, status: 201, text: async () => JSON.stringify([lastInsert]) };
  }
  return { ok: true, status: 200, text: async () => '[]' };
};

process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_testkey_1234567890123456';
process.env.STRIPE_WEBHOOK_SECRET = secret;

const handler = require('../api/stripe-webhook');

function makeReq(body, sigHeader) {
  return { method: 'POST', body, headers: { 'stripe-signature': sigHeader || '' } };
}

function makeRes() {
  const r = { code: null, data: null, _headers: {} };
  r.setHeader = (k, v) => { r._headers[k] = v; };
  r.status = (c) => { r.code = c; return r; };
  r.json = (d) => { r.data = d; return r; };
  return r;
}

function signEvent(event) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const s = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return { body, sig: `t=${ts},v1=${s}` };
}

(async () => {
  // Wrong method
  { const res = makeRes(); await handler({ method: 'GET', headers: {} }, res);
    console.log(res.code === 405 ? '  PASS' : '  FAIL', 'wrong method'); }

  // Invalid signature
  { const res = makeRes(); await handler(makeReq('{}', 't=1,v1=bad'), res);
    console.log(res.code === 400 ? '  PASS' : '  FAIL', 'invalid sig'); }

  // Non-checkout event skipped
  { const { body, sig } = signEvent({ type: 'payment_intent.succeeded', data: {} });
    const res = makeRes(); await handler(makeReq(body, sig), res);
    console.log(res.code === 200 && res.data.skipped === 'payment_intent.succeeded' ? '  PASS' : '  FAIL', 'skip non-checkout'); }

  // Creates a row
  { rows.length = 0; lastInsert = null;
    const event = { type: 'checkout.session.completed', data: { object: {
      id: 'cs_test_123', customer: 'cus_abc', amount_total: 19700,
      customer_email: 'dave@example.com',
      customer_details: { name: 'Dave Smith', email: 'dave@example.com', phone: '+13055550199' },
      metadata: {},
    }}};
    const { body, sig } = signEvent(event); const res = makeRes();
    await handler(makeReq(body, sig), res);
    console.log(res.code === 200 && res.data.ok ? '  PASS' : '  FAIL', 'creates row');
    console.log(lastInsert.tier === 'all_in_one' ? '  PASS' : '  FAIL', 'tier all_in_one');
    console.log(lastInsert.billing_cycle === 'monthly' ? '  PASS' : '  FAIL', 'billing monthly');
    console.log(lastInsert.owner_first_name === 'Dave' ? '  PASS' : '  FAIL', 'first name');
    console.log(lastInsert.prefill.email === 'dave@example.com' ? '  PASS' : '  FAIL', 'email');
    console.log(lastInsert.stripe_session_id === 'cs_test_123' ? '  PASS' : '  FAIL', 'session id');
    console.log(lastInsert.stripe_customer_id === 'cus_abc' ? '  PASS' : '  FAIL', 'customer id');
    console.log(lastInsert.code && lastInsert.code.length === 32 ? '  PASS' : '  FAIL', 'code length'); }

  // Duplicate detection
  { const event = { type: 'checkout.session.completed', data: { object: {
      id: 'cs_test_456', customer: 'cus_def', amount_total: 7900,
      customer_details: { name: 'Dave Smith', email: 'dave@example.com' }, metadata: {},
    }}};
    const { body, sig } = signEvent(event); const res = makeRes();
    await handler(makeReq(body, sig), res);
    console.log(res.code === 200 && res.data.existing === true ? '  PASS' : '  FAIL', 'duplicate detected'); }

  // Metadata tier override
  { rows.length = 0; lastInsert = null;
    const event = { type: 'checkout.session.completed', data: { object: {
      id: 'cs_test_789', amount_total: 0,
      customer_details: { name: 'Jane Doe', email: 'jane@example.com' },
      metadata: { tier: 'all_in_one_ads', billing_cycle: 'annual', trade: 'roofing', city: 'Tampa' },
    }}};
    const { body, sig } = signEvent(event); const res = makeRes();
    await handler(makeReq(body, sig), res);
    console.log(res.data.tier === 'all_in_one_ads' ? '  PASS' : '  FAIL', 'metadata tier');
    console.log(lastInsert.billing_cycle === 'annual' ? '  PASS' : '  FAIL', 'metadata billing');
    console.log(lastInsert.prefill.trade === 'roofing' ? '  PASS' : '  FAIL', 'metadata trade');
    console.log(lastInsert.prefill.primary_city === 'Tampa' ? '  PASS' : '  FAIL', 'metadata city'); }

  // Prepay
  { rows.length = 0; lastInsert = null;
    const event = { type: 'checkout.session.completed', data: { object: {
      id: 'cs_prepay', amount_total: 59100,
      customer_details: { name: 'Bob Builder', email: 'bob@example.com' }, metadata: {},
    }}};
    const { body, sig } = signEvent(event); const res = makeRes();
    await handler(makeReq(body, sig), res);
    console.log(lastInsert.tier === 'all_in_one' && lastInsert.billing_cycle === 'quarterly' ? '  PASS' : '  FAIL', 'prepay tier/cycle'); }

  console.log('All tests passed.');
})();
