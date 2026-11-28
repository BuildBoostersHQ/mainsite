// Tests for the hourly setup check: which reminders are open, when they are due, and the launch checklist.
const { openTracks, due, launchChecklist, easternHour, TEXTS } = require('../api/form-check.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const H = 3600000;
// 2026-12-01 is in Eastern Standard Time (UTC-5).
const at = (hourET) => Date.UTC(2026, 11, 1, hourET + 5);
const ago = (now, h) => new Date(now - h * H).toISOString();

ok('eastern hour', easternHour(at(9)) === 9 && easternHour(at(20)) === 20);

ok('unsubmitted client is on the form track only', openTracks({ tier: 'all_in_one' }, {}).join() === 'form');
ok('form track closes after a basics build', openTracks({ site_final_basics_at: 'x' }, {}).length === 0);
ok('submitted, nothing else: ein and gmb', openTracks({ submitted_at: 'x', tier: 'all_in_one' }, {}).join() === 'ein,gmb');
ok('the old website tier is asked for an EIN like every other plan', openTracks({ submitted_at: 'x', tier: 'website' }, {}).join() === 'ein,gmb');
const SOLE = { a2p_entity_type: 'Sole proprietor with no EIN' };
ok('sole proprietor with no EIN is reminded for his own details, not an EIN', openTracks({ submitted_at: 'x', tier: 'all_in_one' }, SOLE).join() === 'sole,gmb');
ok('his reminders stop once his legal name and street address are in', openTracks({ submitted_at: 'x', tier: 'all_in_one' }, { ...SOLE, a2p_legal_name: 'Dave Smith', a2p_address: '12 Oak St, Tampa, FL 33602' }).join() === 'gmb');
ok('first and last name count as the legal name', openTracks({ submitted_at: 'x' }, { ...SOLE, a2p_first_name: 'Dave', a2p_last_name: 'Smith', a2p_address: '12 Oak St, Tampa, FL 33602' }).join() === 'gmb');
ok('a P.O. box does not count as his address', openTracks({ submitted_at: 'x' }, { ...SOLE, a2p_legal_name: 'Dave Smith', a2p_address: 'P.O. Box 1234, Tampa, FL' }).join() === 'sole,gmb');
ok('he is not reminded once he is registered', openTracks({ submitted_at: 'x', a2p_registered_at: 'x' }, SOLE).join() === 'gmb');
ok('the sole track has three texts', TEXTS.sole.length === 3 && TEXTS.sole.every((t) => /Automated Maddie|Real Maddie/.test(t('Dave', 'https://x'))));
ok('his launch checklist asks for the details, not an EIN', (() => { const l = launchChecklist({ tier: 'all_in_one' }, SOLE); return l.some((x) => /Sole proprietor registration/.test(x)) && !l.some((x) => /^EIN/.test(x)); })());
ok('all done: no tracks', openTracks({ submitted_at: 'x', tier: 'all_in_one', ein_provided_at: 'x', google_requested_at: 'x' }, {}).length === 0);

let now = at(14);
ok('first text waits for 20 hours', !due('form', [], ago(now, 19), now));
ok('first text goes at 20 hours in the daytime', due('form', [], ago(now, 20.5), now));
now = at(23);
ok('first text never goes at night', !due('form', [], ago(now, 21), now));
now = at(9);
ok('...and goes the next morning instead', due('form', [], ago(now, 31), now));
ok('second text goes the next morning', due('form', [ago(now, 16)], ago(now, 40), now));
ok('second text not the same morning', !due('form', [ago(now, 1)], ago(now, 21), now));
now = at(14);
ok('later texts only in the morning', !due('form', [ago(now, 20)], ago(now, 45), now));
now = at(8);
ok('form track stops at three', !due('form', [1, 2, 3].map((d) => ago(now, d * 24)), ago(now, 99), now));
ok('ein track stops at four', !due('ein', [1, 2, 3, 4].map((d) => ago(now, d * 24)), ago(now, 150), now));

const list = launchChecklist({ tier: 'all_in_one', photo_count: 1 }, { business_name: 'Smith Plumbing', weekday_hours: 'Mon-Fri 8-5' });
ok('checklist asks for services', list.some((x) => /services/.test(x)));
ok('checklist asks for the EIN', list.some((x) => /^EIN/.test(x)));
ok('checklist skips hours when Google had them', !list.some((x) => /hours/.test(x)));
ok('the old website tier is asked for an EIN and has no customer list', (() => { const l = launchChecklist({ tier: 'website' }, {}); return l.some((x) => /^EIN/.test(x)) && !l.some((x) => /Customer list/.test(x)); })());

const all = [...TEXTS.form, ...TEXTS.ein, ...TEXTS.gmb, TEXTS.basics, TEXTS.customerList].map((f) => f('Dave', 'https://buildboosters.com/start/abc'));
ok('every text is signed Automated Maddie or is a last-one text', all.every((t) => /Automated Maddie|Last one from me/.test(t)));
ok('no em dashes or semicolons', all.every((t) => !/[—;]/.test(t)));
ok('texts fit in two segments', all.every((t) => t.length <= 306));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All form-check tests passed.');
