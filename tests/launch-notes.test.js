// Tests for the plain-words status note on /api/launch.
const { statusNote } = require('../api/launch.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

const NOW = Date.parse('2026-11-27T15:00:00Z');
const ago = (hours) => new Date(NOW - hours * 3600000).toISOString();
const note = (row) => statusNote(row, NOW);
// A client with everything done, used as the base for each case below.
const done = {
  tier: 'all_in_one', created_at: ago(24 * 20), answers: { business_name: 'Smith Plumbing', cell: '3055550142' },
  submitted_at: ago(24 * 19), google_requested_at: ago(24 * 19), google_approved_at: ago(24 * 18),
  ghl_location_id: 'abc123', a2p_status: 'campaign_approved', a2p_registered_at: ago(24 * 3),
  site_repo: 'BuildBoostersHQ/smith-plumbing', site_created_at: ago(24 * 19), site_domain: 'smithplumbingmiami.com',
  launch_call_start: ago(24 * 2),
};
const with_ = (changes) => ({ ...done, ...changes });
const fresh = { tier: 'all_in_one', created_at: ago(2), answers: {}, prefill: { business_name: 'Smith Plumbing' } };

let n = note(fresh);
ok('paid today, nothing saved', /paid today/.test(n.status_note) && /nothing is saved/.test(n.status_note) && n.needs_attention === false);
n = note({ ...fresh, created_at: ago(24 * 3 + 1) });
ok('paid three days ago, nothing saved, needs attention', /3 days ago/.test(n.status_note) && n.needs_attention === true);
n = note({ ...fresh, created_at: ago(30), answers: { trade: 'Plumbing' } });
ok('started but not sent', /started their setup page and have not sent it/.test(n.status_note) && /yesterday/.test(n.status_note) && n.needs_attention === false);
ok('a photo counts as started', /started/.test(note({ ...fresh, photo_count: 2 }).status_note));

n = note(with_({ google_requested_at: null, google_approved_at: null }));
ok('waiting on Google access', /Waiting on the client to give you access to their Google profile/.test(n.status_note) && n.needs_attention === false);
n = note(with_({ google_approved_at: null }));
ok('client says Google access was sent', /Accept the invite/.test(n.status_note) && n.needs_attention === true);

n = note(with_({ a2p_status: '', a2p_registered_at: null }));
ok('texting registration not submitted', /texting registration has not been submitted/.test(n.status_note) && n.needs_attention === true);
n = note(with_({ a2p_status: '', a2p_registered_at: null, ghl_location_id: null }));
ok('texting registration blocked by missing sub-account', /no HighLevel sub-account/.test(n.status_note));
n = note(with_({ a2p_status: 'brand_rejected', a2p_reason: 'EIN does not match the legal name.', a2p_registered_at: null }));
ok('texting rejected includes the saved reason', /rejected/.test(n.status_note) && /EIN does not match the legal name\.$/.test(n.status_note) && n.needs_attention === true);
n = note(with_({ a2p_status: 'campaign_rejected', a2p_reason: '', a2p_registered_at: null }));
ok('texting rejected with no reason', /no reason was saved/.test(n.status_note));
n = note(with_({ tier: 'website', a2p_status: '', a2p_registered_at: null, ghl_location_id: null }));
ok('website-only clients are never asked about texting', /live/.test(n.status_note));

n = note(with_({ site_created_at: null }));
ok('site build stopped', /started and stopped/.test(n.status_note) && n.needs_attention === true);
n = note(with_({ site_created_at: null, site_repo: null }));
ok('site build never started', /has not started/.test(n.status_note) && n.needs_attention === true);
n = note(with_({ site_created_at: null, site_repo: null, submitted_at: ago(0.2), google_requested_at: null }));
ok('site building right after the form', /site is building/.test(n.status_note) && n.needs_attention === false);

n = note(with_({ answers: { domain_own: 'https://www.SmithPlumbing.com/' }, site_domain: null }));
ok('own domain not pointing yet', /smithplumbing\.com is not pointing at the site yet/.test(n.status_note) && n.needs_attention === false);
n = note(with_({ answers: { domain_own: 'smithplumbing.com' }, site_domain: 'smithplumbing.com' }));
ok('own domain connected is not flagged', /live/.test(n.status_note));
n = note(with_({ site_domain: null }));
ok('built with no domain', /no domain on it/.test(n.status_note) && n.needs_attention === true);

n = note(with_({ a2p_status: 'brand_approved', a2p_registered_at: null }));
ok('waiting on texting approval', /^Waiting on texting approval\. The last update was brand approved\.$/.test(n.status_note) && n.needs_attention === false);

n = note(with_({ launch_call_start: new Date(NOW + 86400000).toISOString() }));
ok('ready for the launch call', /ready for the launch call/.test(n.status_note) && n.needs_attention === false);
n = note(with_({ launch_call_start: null }));
ok('ready with no call time saved', /no call time is saved/.test(n.status_note) && n.needs_attention === true);
n = note(done);
ok('live', /^They are live/.test(n.status_note) && n.needs_attention === false);

// Something Maddie has to act on comes before something she is only waiting on.
n = note(with_({ google_requested_at: null, google_approved_at: null, site_created_at: null }));
ok('an action comes before a wait', /site build/.test(n.status_note) && n.needs_attention === true);
// Two waits: the earlier one in the list wins.
n = note(with_({ google_requested_at: null, google_approved_at: null, a2p_status: 'campaign_pending', a2p_registered_at: null }));
ok('two waits keep their order', /Google/.test(n.status_note));

const all = [fresh, done, with_({ a2p_status: 'brand_rejected', a2p_reason: 'x', a2p_registered_at: null }), {}, null].map(note);
ok('always a string and a boolean', all.every((x) => typeof x.status_note === 'string' && x.status_note.length > 10 && typeof x.needs_attention === 'boolean'));
ok('notes are full sentences with no dashes', all.every((x) => /^[A-Z]/.test(x.status_note) && /\.$/.test(x.status_note) && !/[—–]/.test(x.status_note)));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All launch-notes tests passed.');
