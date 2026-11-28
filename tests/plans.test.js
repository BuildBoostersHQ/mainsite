// Tests for the plan limits and the setup credit ($50 same day, $20 next day, Eastern time).
const { limitsFor, isWebsiteOnly, creditDeadlines, creditFor, setupDoneAt } = require('../api/_plans.js');
const { clean, validBirthday, creditInfo } = require('../api/onboarding.js');
const { applyCredit, check } = require('../api/form-check.js');
const { planTier } = require('../api/stripe-webhook.js');
const { checkAddress } = require('../api/business-lookup.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
// Eastern Standard Time is UTC-5 in December.
const et = (day, hour, min = 0) => new Date(Date.UTC(2026, 11, day, hour + 5, min)).toISOString();

(async () => {
  ok('essentials holds 4 services and 5 towns', limitsFor('essentials').services === 4 && limitsFor('essentials').areas === 5);
  ok('all in one holds 8 and 10', limitsFor('all_in_one').services === 8 && limitsFor('All In One').areas === 10);
  ok('dominance holds 12 and 14', limitsFor('dominance').services === 12 && limitsFor('dominance').areas === 14);
  ok('an unknown plan gets the template limits', limitsFor('').areas === 14 && limitsFor('unknown').services === 12);
  ok('only the old website plan is website-only', isWebsiteOnly('website') && !isWebsiteOnly('essentials') && !isWebsiteOnly('all_in_one'));
  ok('the website tag from Stripe is saved as essentials', planTier('website') === 'essentials' && planTier('dominance') === 'dominance');

  const towns = Array.from({ length: 20 }, (_, i) => `Town ${i}`);
  ok('the form keeps 5 towns for essentials', clean({ areas: towns }, 'essentials').areas.length === 5);
  ok('the form keeps 10 towns for all in one', clean({ areas: towns }, 'all_in_one').areas.length === 10);
  ok('the form keeps 14 towns for dominance', clean({ areas: towns }, 'dominance').areas.length === 14);
  ok('the form keeps 4 services for essentials', clean({ services: towns }, 'essentials').services.length === 4);
  ok('registration fields are saved', clean({ a2p_first_name: 'Dave', a2p_address: '1 Main St', place_id: 'abc' }, 'essentials').a2p_address === '1 Main St');

  ok('paid 10 AM, done 11 PM the same day: $50', creditFor(et(1, 10), et(1, 23)) === 50);
  ok('paid 10 AM, done 12:30 AM the next day: $20', creditFor(et(1, 10), et(2, 0, 30)) === 20);
  ok('paid 10 AM, done 11:59 PM the next day: $20', creditFor(et(1, 10), et(2, 23, 59)) === 20);
  ok('paid 10 AM, done two days later: nothing', creditFor(et(1, 10), et(3, 9)) === 0);
  ok('paid 7:59 PM, done the next morning: $20', creditFor(et(1, 19, 59), et(2, 9)) === 20);
  ok('paid 8 PM, done the next evening: still $50', creditFor(et(1, 20), et(2, 22)) === 50);
  ok('paid 8 PM, done two days later: $20', creditFor(et(1, 20), et(3, 12)) === 20);
  ok('paid 8 PM, done three days later: nothing', creditFor(et(1, 20), et(4, 1)) === 0);
  const summer = creditDeadlines('2026-07-01T15:00:00Z'); // 11 AM Eastern Daylight Time
  ok('summer deadline is midnight Eastern', new Date(summer.sameDay).toISOString() === '2026-07-02T04:00:00.000Z');
  ok('the end of a month rolls over', new Date(creditDeadlines(et(31, 10)).nextDay).toISOString() === '2027-01-02T05:00:00.000Z');
  ok('the page is told both deadlines', creditInfo({ created_at: et(1, 10) }).same_day_until === '2026-12-02T05:00:00.000Z' && creditInfo({ created_at: et(1, 10) }).next_day_until === '2026-12-03T05:00:00.000Z');

  const base = { tier: 'all_in_one', submitted_at: et(1, 12), google_requested_at: et(1, 13) };
  ok('not done until the EIN is in', setupDoneAt(base, {}) === '');
  ok('done at the last of the steps', setupDoneAt({ ...base, ein_provided_at: et(1, 15) }, {}) === et(1, 15));
  ok('no EIN type is done without one', setupDoneAt(base, { a2p_entity_type: 'Sole proprietor with no EIN' }) === et(1, 13));
  ok('essentials needs an EIN too', setupDoneAt({ ...base, tier: 'essentials' }, {}) === '');
  ok('not done without the Google step', setupDoneAt({ tier: 'all_in_one', submitted_at: et(1, 12), ein_provided_at: et(1, 12) }, {}) === '');

  ok('birthday must be a real date', validBirthday('1985-07-04', et(1, 10)) && !validBirthday('1985-02-30', et(1, 10)) && !validBirthday('07/04/1985', et(1, 10)));
  ok('birthday must be an adult', !validBirthday('2015-01-01', et(1, 10)));

  ok('a P.O. box is refused', (await checkAddress('P.O. Box 12, Miami, FL 33101')).reason === 'mailbox');
  ok('a rented mailbox is refused', (await checkAddress('82 NE 191st St, PMB 383218, Miami, FL')).reason === 'mailbox');
  ok('a street address passes when Google is not set up', (await checkAddress('1420 SW 8th St, Miami, FL 33135')).ok === true);

  // Applying the credit in Stripe.
  const realFetch = global.fetch;
  let calls = [];
  global.fetch = async (url, opts) => { calls.push({ url: String(url), opts }); return { ok: true, status: 200, json: async () => ({ id: 'cbtxn_1' }), text: async () => '[]' }; };
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  let r = await applyCredit({ id: 'row1', billing_cycle: 'monthly', stripe_customer_id: 'cus_123' }, 50);
  const sent = calls[0] || { opts: { headers: {}, body: '' } };
  ok('monthly credit goes to the Stripe customer balance', r.applied && r.id === 'cbtxn_1' && sent.url.endsWith('/v1/customers/cus_123/balance_transactions'));
  ok('the credit is minus $50', /amount=-5000/.test(sent.opts.body) && /currency=usd/.test(sent.opts.body));
  ok('a repeat can never credit twice', sent.opts.headers['Idempotency-Key'] === 'setup-credit-row1');
  calls = [];
  r = await applyCredit({ id: 'row2', billing_cycle: 'quarterly', stripe_customer_id: 'cus_123' }, 20);
  ok('a quarterly credit is left for Maddie', !r.applied && calls.length === 0 && /HighLevel/.test(r.note));
  r = await applyCredit({ id: 'row3', billing_cycle: 'monthly' }, 20);
  ok('no Stripe customer: left for Maddie', !r.applied && calls.length === 0);
  delete process.env.STRIPE_SECRET_KEY;
  r = await applyCredit({ id: 'row4', billing_cycle: 'monthly', stripe_customer_id: 'cus_123' }, 20);
  ok('no Stripe key: left for Maddie', !r.applied && calls.length === 0);

  // The hourly check, start to finish, for a client who finished the same day.
  process.env.STRIPE_SECRET_KEY = 'sk_test_x';
  process.env.SUPABASE_URL = 'https://x.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'k';
  calls = [];
  const row = { id: 'row5', code: 'abcdefabcdefabcd', tier: 'essentials', billing_cycle: 'monthly', stripe_customer_id: 'cus_9', created_at: et(1, 10),
    submitted_at: et(1, 12), google_requested_at: et(1, 12), ein_provided_at: et(1, 11), answers: { business_name: 'Smith Plumbing' }, nudges_sent: {} };
  const out = { texts: [], credits: [], basics: [], failed: [] };
  await check(row, new Date(et(1, 13)).getTime(), 'https://buildboosters.com', out);
  const patchCall = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  const patch = patchCall ? JSON.parse(patchCall.opts.body) : {};
  ok('same-day finisher earns $50 and it is applied', patch.setup_credit_amount === 50 && !!patch.setup_credit_applied_at && patch.setup_credit_stripe_id === 'cbtxn_1');
  ok('the day setup finished is saved', patch.setup_done_at === et(1, 12));
  ok('the run reports the credit', out.credits.length === 1 && out.credits[0].amount === 50 && out.credits[0].applied);
  calls = [];
  await check({ ...row, id: 'row6', setup_credit_amount: 50, setup_credit_applied_at: et(1, 13), setup_done_at: et(1, 12) }, new Date(et(1, 14)).getTime(), 'https://buildboosters.com', { texts: [], credits: [], basics: [], failed: [] });
  ok('an applied credit is never applied again', !calls.some((c) => /balance_transactions/.test(c.url)));
  calls = [];
  await check({ ...row, id: 'row7', submitted_at: et(4, 12), google_requested_at: et(4, 12) }, new Date(et(4, 13)).getTime(), 'https://buildboosters.com', { texts: [], credits: [], basics: [], failed: [] });
  const late = calls.find((c) => c.opts && c.opts.method === 'PATCH');
  ok('a late finisher gets no credit and Stripe is not called', JSON.parse(late.opts.body).setup_credit_amount === 0 && !calls.some((c) => /balance_transactions/.test(c.url)));
  global.fetch = realFetch;

  console.log(failed ? `\n${failed} failed` : '\nAll passed');
  process.exit(failed ? 1 : 0);
})();
