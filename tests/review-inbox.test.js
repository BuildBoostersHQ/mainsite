// Tests for the review inbox: where a new review goes, when texts may send, and what the texts say.
const { route, isYes, isLow, inWindow, trimDraft, fallbackDraft, draftPrompt, silentFor48, TEXTS } = require('../api/review-inbox.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const H = 3600000;
// 2026-12-01 is in Eastern Standard Time (UTC-5).
const at = (hourET) => Date.UTC(2026, 11, 1, hourET + 5);

ok('3 stars and under are low', isLow(1) && isLow(3) && !isLow(4) && !isLow(5));

ok('on hold: a low review is held', route(2, { switchedOn: false, mode: 'reviews_ai' }) === 'held');
ok('on hold: a 5 star review still goes to Reviews AI', route(5, { switchedOn: false, mode: 'reviews_ai' }) === 'reviews_ai');
ok('on: a low review is texted', route(1, { switchedOn: true, mode: 'reviews_ai' }) === 'pending');
ok('on: a 4 star review goes to Reviews AI by default', route(4, { switchedOn: true, mode: 'reviews_ai' }) === 'reviews_ai');
ok('text mode: a 5 star review is texted', route(5, { switchedOn: true, mode: 'text' }) === 'pending');
ok('text mode and on hold: a 5 star review is held', route(5, { switchedOn: false, mode: 'text' }) === 'held');

ok('texts go out at 10 AM', inWindow(at(10)));
ok('texts go out at 4 PM', inWindow(at(16)));
ok('no texts at 5 PM', !inWindow(at(17)));
ok('no texts at 9 AM or 9 PM', !inWindow(at(9)) && !inWindow(at(21)));

ok('YES in any case', isYes('YES') && isYes(' yes. ') && isYes('Yep!') && isYes('ok'));
ok('his own wording is not a yes', !isYes('Yes but say thanks Maria') && !isYes('Thanks Maria, it was a pleasure') && !isYes(''));

ok('48 hours of silence', silentFor48(new Date(at(10) - 48 * H).toISOString(), at(10)));
ok('47 hours is not enough', !silentFor48(new Date(at(10) - 47 * H).toISOString(), at(10)));
ok('never texted is never silent', !silentFor48(null, at(10)));

const long = 'Thank you so much for the kind words about the deck. '.repeat(8);
ok('a long draft is cut to fit', trimDraft(long).length <= 220 && /[.!]$/.test(trimDraft(long)));
ok('quotes and long dashes are removed', trimDraft('"Thanks Maria — it was a pleasure."') === 'Thanks Maria , it was a pleasure.');

const lowDraft = fallbackDraft(2, 'Maria Lopez', 'Smith Plumbing', '(305) 555-0199');
const highDraft = fallbackDraft(5, 'Maria Lopez', 'Smith Plumbing', '(305) 555-0199');
ok('low fallback asks for a call and uses the first name only', /call us at \(305\) 555-0199/.test(lowDraft) && /^Maria,/.test(lowDraft) && !/Lopez/.test(lowDraft));
ok('high fallback thanks them', /thank you/i.test(highDraft) && /Smith Plumbing/.test(highDraft));
ok('the prompt tells a low reply never to argue', /never argue/.test(draftPrompt({ rating: 1, reviewer: 'Maria', text: 'Late twice.' })));
ok('the prompt never offers money', /never offer money/.test(draftPrompt({ rating: 5 })));

const link = 'https://business.google.com/reviews';
const full = 'x'.repeat(220);
const all = [
  TEXTS.low('Dave', 2, 'Maria Lopez', link, lowDraft),
  TEXTS.low('', 1, '', link, full),
  TEXTS.high('Dave', 5, 'Maria Lopez', highDraft),
  TEXTS.high('', 4, '', full),
];
ok('low text names the stars, the reviewer and the link', /2-star review from Maria\./.test(all[0]) && all[0].includes(link) && all[0].includes(lowDraft));
ok('low text never offers to post for him', !/YES|post it for you/.test(all[0]));
ok('high text explains YES and the 48 hours', /Text YES to post it/.test(all[2]) && /48 hours/.test(all[2]));
ok('texts work without a name', /^You got a 1-star review\./.test(all[1]) && /^A customer just left you 4 stars/.test(all[3]));
ok('no em dashes or semicolons', all.every((t) => !/[—;]/.test(t)));
ok('texts fit in three segments', all.every((t) => t.length <= 459));

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All review-inbox tests passed.');
