// Tests for matching Google reviewer names to a client's customers.
const { matchReviewers, normalize, editDistance, contactsFromList } = require('../api/review-match.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

const contacts = [
  { id: 'c1', first_name: 'Maya', last_name: 'Patel' },
  { id: 'c2', first_name: 'Michael', last_name: 'Torres' },
  { id: 'c3', first_name: 'Elizabeth', last_name: 'Nguyen' },
  { id: 'c4', first_name: 'José', last_name: "O'Brien-Smith" },
  { id: 'c5', full_name: 'Dave Smith' },
  { id: 'c6', first_name: 'Dave', last_name: 'Smith' },
  { id: 'c7', first_name: 'Katherine', last_name: 'Johnson' },
  { id: 'c8', first_name: 'Stephanie', last_name: 'Rodriguez' },
  { id: 'c9', first_name: 'Dan', last_name: 'Reyes' },
  { id: 'c10', first_name: 'Maya', last_name: 'Perez' },
  { id: 'c11', first_name: 'Ana Maria', last_name: 'Lopez' },
];
const run = (names) => matchReviewers(names, contacts);
const maybeFor = (r, name) => (r.maybe.find((m) => m.reviewer === name) || { candidates: [] }).candidates;

ok('normalize: case, accents, punctuation, spaces', normalize("  JOSÉ   O'Brien-Smith. ") === 'jose obrien smith');
ok('edit distance', editDistance('kitten', 'sitten') === 1 && editDistance('patel', 'patel') === 0 && editDistance('abc', 'xyz', 2) === 3);

let r = run(['maya patel', 'MICHAEL  TORRES', "Jose O’Brien Smith", 'Elizabeth Nguyen.']);
ok('exact after tidying the name', r.exact.length === 4 && r.maybe.length === 0 && r.none.length === 0);
ok('exact says which contact', r.exact[0].contact_id === 'c1' && r.exact[0].contact_name === 'Maya Patel' && r.exact[2].contact_id === 'c4');

r = run(['Dave Smith']);
ok('the same name twice is never exact', r.exact.length === 0 && maybeFor(r, 'Dave Smith').length === 2);
ok('and says why', /2 customers have this exact name/.test(maybeFor(r, 'Dave Smith')[0].reason));

r = run(['Michael T.']);
ok('last name as an initial', maybeFor(r, 'Michael T.')[0].contact_id === 'c2' && /initial/.test(maybeFor(r, 'Michael T.')[0].reason));
r = run(['Maya P.']);
ok('an initial that fits two customers lists both', maybeFor(r, 'Maya P.').map((c) => c.contact_id).sort().join() === 'c1,c10' && r.exact.length === 0);
r = run(['Mike T']);
ok('nickname with an initial scores lower than a plain initial', maybeFor(r, 'Mike T')[0].contact_id === 'c2' && maybeFor(r, 'Mike T')[0].score < 0.85);

r = run(['Elizabeth', 'Maya', 'Liz']);
ok('first name only when it is the only one', maybeFor(r, 'Elizabeth')[0].contact_id === 'c3' && /only Elizabeth/.test(maybeFor(r, 'Elizabeth')[0].reason));
ok('first name only is not offered when two customers share it', r.none.includes('Maya'));
ok('nickname on its own finds the only match', maybeFor(r, 'Liz')[0].contact_id === 'c3');

r = run(['Mike Torres', 'Liz Nguyen', 'Kate Johnson', 'Steph Rodriguez']);
ok('common nicknames', r.maybe.length === 4 && maybeFor(r, 'Mike Torres')[0].contact_id === 'c2' && maybeFor(r, 'Liz Nguyen')[0].contact_id === 'c3'
  && maybeFor(r, 'Kate Johnson')[0].contact_id === 'c7' && maybeFor(r, 'Steph Rodriguez')[0].contact_id === 'c8');
ok('nickname reason names both', /Mike and Michael/.test(maybeFor(r, 'Mike Torres')[0].reason));

r = run(['Maya Patell', 'Stephanie Rodrigues', 'Stephane Rodrigues', 'Katherine Jonson']);
ok('one letter off', maybeFor(r, 'Maya Patell')[0].contact_id === 'c1' && /one letter/.test(maybeFor(r, 'Maya Patell')[0].reason));
ok('two letters off on long names', maybeFor(r, 'Stephane Rodrigues')[0].contact_id === 'c8' && /two letters/.test(maybeFor(r, 'Stephane Rodrigues')[0].reason));
ok('closer spelling scores higher', maybeFor(r, 'Stephanie Rodrigues')[0].score > maybeFor(r, 'Stephane Rodrigues')[0].score);
r = run(['Jan Reyes', 'Don Reyes', 'Dan Rayos']);
ok('short names have to be spelled right', r.none.includes('Jan Reyes') && r.none.includes('Don Reyes'));
ok('two letters off in a five letter name is too far', r.none.includes('Dan Rayos'));

r = run(['Torres Michael', 'Ana Lopez', 'Maya R Patel']);
ok('names in the other order', maybeFor(r, 'Torres Michael')[0].contact_id === 'c2');
ok('a missing middle name', maybeFor(r, 'Ana Lopez')[0].contact_id === 'c11' && maybeFor(r, 'Maya R Patel')[0].contact_id === 'c1');

r = run(['Zed Unknown', 'A Google User', '', '   ', '!!!', null]);
ok('no match goes to none', r.none.includes('Zed Unknown') && r.none.includes('A Google User') && r.exact.length === 0 && r.maybe.length === 0);
ok('blank reviewers are dropped and symbols go to none', r.none.length === 3 && r.none.includes('!!!'));

r = run(['Maya Patel', 'maya  patel', 'Mike Torres', 'Zed Unknown']);
ok('every reviewer lands in exactly one list, with repeats counted once', r.exact.length + r.maybe.length + r.none.length === 3);

r = run(['Michael T.']);
const c = maybeFor(r, 'Michael T.')[0];
ok('candidates carry id, name, score and reason', c.contact_id && c.contact_name === 'Michael Torres' && c.score > 0 && c.score <= 1 && typeof c.reason === 'string');
const many = matchReviewers(['Sam'], [{ id: 1, full_name: 'Samuel Ortiz' }, { id: 2, full_name: 'Samantha Lee' }]);
ok('a nickname shared by two customers is not offered', many.none.length === 1);
const ranked = matchReviewers(['Mike T.'], [{ id: 1, full_name: 'Mike Thompson' }, { id: 2, full_name: 'Michael Tran' }]).maybe[0].candidates;
ok('candidates are ranked best first', ranked.length === 2 && ranked[0].contact_id === 1 && ranked[0].score > ranked[1].score);
ok('empty inputs are safe', matchReviewers([], []).none.length === 0 && matchReviewers(null, null).exact.length === 0 && matchReviewers(['Maya Patel'], []).none.length === 1);

// The saved customer list from /api/customer-list has no ids: phone first, then email.
const fromList = contactsFromList({ customers: [
  { first_name: 'Maya', last_name: 'Patel', phone: '3055550142', email: 'maya@example.com' },
  { first_name: 'Tom', last_name: 'Reyes', phone: '', email: 'tom@example.com' },
  { first_name: 'No', last_name: 'Contact', phone: '', email: '' },
] });
ok('customer list contacts are keyed by phone, then email', fromList.length === 2 && fromList[0].id === '3055550142' && fromList[1].id === 'tom@example.com' && fromList[0].full_name === 'Maya Patel');
ok('the matcher works on the saved list', matchReviewers(['maya patel'], fromList).exact[0].contact_id === '3055550142');

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All review-match tests passed.');
