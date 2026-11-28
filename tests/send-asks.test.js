// Tests for the two senders: finished jobs handed to HighLevel, and the recurring photo reminder.
const { decide, inWindow, splitName } = require('../api/send-asks.js');
const { dueClients, messageFor, cellFor } = require('../api/photo-reminders.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const H = 3600000, D = 24 * H;
const at = (hourET) => Date.UTC(2026, 11, 1, hourET + 5); // December is UTC-5
const now = at(11);
const ago = (ms) => new Date(now - ms).toISOString();

ok('window opens at 10', inWindow(at(10)) && !inWindow(at(9)));
ok('window closes at 5', inWindow(at(16)) && !inWindow(at(17)) && !inWindow(at(23)));
ok('names split', splitName('Maria Lopez Garcia').firstName === 'Maria' && splitName('Maria Lopez Garcia').lastName === 'Lopez Garcia' && splitName('').firstName === '');

const client = { id: 'c1', ghl_location_id: 'loc', a2p_registered_at: 'x' };
const job = { event_type: 'job_completed', customer_phone: '(813) 555-0142', review_ask_at: ago(2 * H) };
const none = new Set();
ok('finished job goes', decide(job, client, none, now).action === 'send');
ok('paid invoice goes', decide({ ...job, event_type: 'invoice_paid' }, client, none, now).action === 'send');
ok('quote never goes', decide({ ...job, event_type: 'quote_created' }, client, none, now).action === 'skip');
ok('no client match is closed out', decide(job, null, none, now).why === 'no_client_match');
ok('no phone is closed out', decide({ ...job, customer_phone: '555' }, client, none, now).why === 'no_customer_phone');
ok('repeat customer inside 30 days is skipped', decide(job, client, new Set(['8135550142']), now).why === 'asked_in_last_30_days');
ok('waits for the sub-account', decide(job, { ...client, ghl_location_id: null }, none, now).action === 'wait');
ok('waits for texting approval', decide(job, { ...client, a2p_registered_at: null }, none, now).action === 'wait');
ok('closed out after 14 days', decide({ ...job, review_ask_at: ago(15 * D) }, { ...client, a2p_registered_at: null }, none, now).why === 'waited_too_long');

const base = { id: '1', code: 'abc', owner_first_name: 'Dave', prefill: { business_name: 'Smith Plumbing' }, answers: { trade: 'pressure-washing', cell: '8135550142' } };
ok('not due before the form is in', dueClients([{ ...base }], now).length === 0);
ok('due in week one', dueClients([{ ...base, submitted_at: ago(3 * D) }], now).length === 1);
ok('not due when asked two days ago', dueClients([{ ...base, submitted_at: ago(10 * D), last_photo_ask_at: ago(2 * D) }], now).length === 0);
ok('due again a week later', dueClients([{ ...base, submitted_at: ago(10 * D), last_photo_ask_at: ago(7 * D) }], now).length === 1);
ok('monthly after the first month', dueClients([{ ...base, submitted_at: ago(60 * D), last_photo_ask_at: ago(10 * D) }], now).length === 0
  && dueClients([{ ...base, submitted_at: ago(60 * D), last_photo_ask_at: ago(30 * D) }], now).length === 1);
ok('skipped after a recent photo', dueClients([{ ...base, submitted_at: ago(10 * D), photos_last_at: ago(2 * D) }], now).length === 0);
ok('skipped when reminders are off', dueClients([{ ...base, submitted_at: ago(10 * D), answers: { ...base.answers, photo_reminders: false } }], now).length === 0);
ok('consent cell comes first', cellFor({ sms_consent_cell: '(561) 555-0100' }, { cell: '8135550142' }) === '5615550100');
const texts = [0, 3, 9].map((w) => messageFor('Dave', 'pressure washing', w));
ok('every text says how to stop', texts.every((t) => /NOPICS/.test(t)));
ok('no em dashes, no "leads"', texts.every((t) => !/—|leads?\b/i.test(t)));
ok('trade reads naturally', dueClients([{ ...base, submitted_at: ago(20 * D) }], now)[0].message.includes('pressure washing jobs'));

console.log(failed ? `\n${failed} FAILED` : '\nsend-asks: all checks passed');
process.exit(failed ? 1 : 0);
