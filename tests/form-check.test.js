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
ok('every plan is asked for an EIN, the website tag included', openTracks({ submitted_at: 'x', tier: 'website' }, {}).join() === 'ein,gmb');
ok('sole proprietor with no EIN is asked for his details instead', openTracks({ submitted_at: 'x', tier: 'all_in_one' }, { a2p_entity_type: 'Sole proprietor with no EIN' }).join() === 'sole,gmb');
ok('...and not once they are in', openTracks({ submitted_at: 'x', a2p_details_at: 'x' }, { a2p_entity_type: 'Sole proprietor with no EIN' }).join() === 'gmb');
ok('sole proprietor with an EIN is asked for it', openTracks({ submitted_at: 'x' }, { a2p_entity_type: 'Sole proprietor with an EIN' }).join() === 'ein,gmb');
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
ok('website tag still owes an EIN but has no customer list', launchChecklist({ tier: 'website' }, {}).some((x) => /^EIN/.test(x)) && !launchChecklist({ tier: 'website' }, {}).some((x) => /Customer list/.test(x)));

const all = [...TEXTS.form, ...TEXTS.ein, ...TEXTS.sole, ...TEXTS.gmb, TEXTS.basics, TEXTS.customerList].map((f) => f('Dave', 'https://buildboosters.com/start/abc'));
ok('every text is signed Automated Maddie or is a last-one text', all.every((t) => /Automated Maddie|Last one from me/.test(t)));
ok('no em dashes or semicolons', all.every((t) => !/[—;]/.test(t)));
ok('texts fit in two segments', all.every((t) => t.length <= 306));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All form-check tests passed.');
