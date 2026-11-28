// Tests for the setup credit: $50 the day he paid, $20 the day after, the 8 PM rule, and where it goes.
const c = require('../api/_credit.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
// Eastern Standard Time in December 2026 is UTC-5. et(1, 14) is December 1 at 2 PM in Miami.
const et = (day, hour, min = 0) => new Date(Date.UTC(2026, 11, day, hour + 5, min)).toISOString();
const row = (paid, form, ein, google, extra = {}) => ({ id: 'r1', code: 'abc', created_at: paid, submitted_at: form, ein_provided_at: ein, google_requested_at: google, ...extra });
const amount = (...args) => c.setupCredit(row(...args), {}).amount;

ok('same day earns $50', amount(et(1, 10), et(1, 15), et(1, 15), et(1, 23, 59)) === 50);
ok('one minute past midnight earns $20', amount(et(1, 10), et(1, 15), et(1, 15), et(2, 0, 1)) === 20);
ok('end of the next day still earns $20', amount(et(1, 10), et(2, 23, 59), et(1, 15), et(1, 15)) === 20);
ok('two days later earns nothing', amount(et(1, 10), et(3, 0, 1), et(1, 15), et(1, 15)) === 0);
ok('the slowest step sets the day', amount(et(1, 10), et(1, 11), et(3, 9), et(1, 11)) === 0);
ok('paid at 7:59 PM is still that day', amount(et(1, 19, 59), et(2, 9), et(2, 9), et(2, 9)) === 20);
ok('paid at 8 PM counts as the next day', amount(et(1, 20), et(2, 22), et(2, 22), et(2, 22)) === 50);
ok('paid at 8 PM, finished that night', amount(et(1, 20), et(1, 21), et(1, 21), et(1, 21)) === 50);
ok('paid at 8 PM, finished two days on earns $20', amount(et(1, 20), et(3, 9), et(3, 9), et(3, 9)) === 20);

ok('no EIN means not finished', !c.setupCredit(row(et(1, 10), et(1, 11), null, et(1, 11)), {}).done);
ok('no Google step means not finished', !c.setupCredit(row(et(1, 10), et(1, 11), et(1, 11), null), {}).done);
ok('the website tag needs an EIN too', !c.setupCredit(row(et(1, 10), et(1, 11), null, et(1, 11), { tier: 'website' }), {}).done);
ok('Google access approved by hand counts', c.setupCredit(row(et(1, 10), et(1, 11), et(1, 11), null, { google_approved_at: et(1, 12) }), {}).amount === 50);
const done = c.setupCredit(row(et(1, 10), et(1, 23, 30), et(1, 12), et(1, 12)), {});
ok('saves the onboarding date in Eastern time', done.onboarding_date === '2026-12-01' && done.finished_at === et(1, 23, 30));

const sole = { a2p_entity_type: 'Sole proprietor with no EIN' };
ok('sole proprietor with no EIN finishes with his details', c.setupCredit(row(et(1, 10), et(1, 11), null, et(1, 11), { a2p_details_at: et(1, 12) }), sole).amount === 50);
ok('...and is not finished without them', !c.setupCredit(row(et(1, 10), et(1, 11), null, et(1, 11)), sole).done);
ok('sole proprietor with an EIN needs the EIN', !c.setupCredit(row(et(1, 10), et(1, 11), null, et(1, 11), { a2p_details_at: et(1, 12) }), { a2p_entity_type: 'Sole proprietor with an EIN' }).done);
ok('sole details need two names and a street address', c.soleDetailsDone({ a2p_legal_name: 'Dave Smith', a2p_address: '1420 SW 8th St, Miami, FL' }));
ok('one name is not enough', !c.soleDetailsDone({ a2p_legal_name: 'Dave', a2p_address: '1420 SW 8th St, Miami, FL' }));
ok('a P.O. box is turned down', !c.soleDetailsDone({ a2p_legal_name: 'Dave Smith', a2p_address: 'P.O. Box 123, Miami, FL' }));
ok('a mailbox number is turned down', c.isPoBox('82 NE 191st St, PMB 383218, Miami') && c.isPoBox('PO Box 9') && !c.isPoBox('12 Boxwood Lane'));

ok('missing list', c.missing(row(et(1, 10), null, null, null), {}).join() === 'form,ein,google' && c.missing(row(et(1, 10), et(1, 11), null, et(1, 11)), sole).join() === 'sole');

const at = (iso) => new Date(iso).getTime();
ok('offer is $50 on the day', c.offer(et(1, 10), at(et(1, 22))).amount === 50 && c.offer(et(1, 10), at(et(1, 22))).until === et(2, 0));
ok('offer is $20 the day after', c.offer(et(1, 10), at(et(2, 9))).amount === 20 && c.offer(et(1, 10), at(et(2, 9))).until === et(3, 0));
ok('offer is gone after that', c.offer(et(1, 10), at(et(3, 9))).amount === 0);
ok('8 PM buyer has $50 through the next day', c.offer(et(1, 21), at(et(2, 23))).amount === 50 && c.offer(et(1, 21), at(et(2, 23))).until === et(3, 0));
// July is daylight saving time (UTC-4): paid July 1 at 10 AM, the day ends at 4:00 UTC.
ok('end of day is right in summer', c.offer('2026-07-01T14:00:00Z', Date.parse('2026-07-01T15:00:00Z')).until === '2026-07-02T04:00:00.000Z');

ok('monthly goes to Stripe', c.destination({ billing_cycle: 'monthly' }) === 'stripe' && c.destination({}) === 'stripe');
ok('quarterly and yearly go to the HighLevel wallet', c.destination({ billing_cycle: 'quarterly' }) === 'ghl_wallet' && c.destination({ billing_cycle: 'annual' }) === 'ghl_wallet');

(async () => {
  const realFetch = global.fetch; let call = null;
  global.fetch = async (url, opts) => { call = { url, opts }; return { ok: true, json: async () => ({ id: 'cbtxn_1', walletId: 'w1', complimentaryCredits: 50 }) }; };
  delete process.env.STRIPE_SECRET_KEY;
  let r = await c.applyCredit({ id: 'r1', code: 'abc', billing_cycle: 'monthly', stripe_customer_id: 'cus_1' }, 50);
  ok('no Stripe key: not applied, nothing sent', !r.ok && call === null);
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  r = await c.applyCredit({ id: 'r1', code: 'abc', billing_cycle: 'monthly', stripe_customer_id: 'cus_1' }, 50);
  ok('Stripe: credits $50 on the customer balance', r.ok && r.ref === 'cbtxn_1' && /customers\/cus_1\/balance_transactions$/.test(call.url) && call.opts.body.get('amount') === '-5000' && call.opts.headers['Idempotency-Key'] === 'setup-credit-r1');
  call = null;
  r = await c.applyCredit({ id: 'r1', code: 'abc', billing_cycle: 'monthly' }, 50);
  ok('Stripe: no customer id, nothing sent', !r.ok && call === null);
  process.env.GHL_AGENCY_API_KEY = 'pit-x';
  r = await c.applyCredit({ id: 'r1', code: 'abc', billing_cycle: 'quarterly' }, 20);
  ok('wallet: waits for the sub-account', !r.ok && r.waiting && call === null);
  r = await c.applyCredit({ id: 'r1', code: 'abc', billing_cycle: 'quarterly', ghl_location_id: 'loc1' }, 20);
  const sent = JSON.parse(call.opts.body);
  ok('wallet: adds $20 of complimentary credits', r.ok && sent.locationId === 'loc1' && sent.complimentaryCreditsAmount === 20 && call.opts.headers.Version === 'v3' && call.opts.headers['Idempotency-Key'] === 'setup-credit-r1');
  global.fetch = realFetch;
  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('All credit tests passed.');
})();
