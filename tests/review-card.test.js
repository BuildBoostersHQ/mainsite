// Quick test for the review cards and the QR code maker. Run: node tests/review-card.test.js
const assert = require('assert');
const { qrMatrix, qrSvg } = require('../api/_qr.js');
const { cardHtml, reviewUrlFor } = require('../api/review-card.js');

// Sizes: version 1 is 21 squares, and each version adds 4.
assert.strictEqual(qrMatrix('https://a.co').length, 21);
assert.strictEqual(qrMatrix('https://smithplumbingtampa.com/review-us').length, 29);
assert.throws(() => qrMatrix('x'.repeat(120)), /qr_text_too_long/);

// The three corner squares are always in place.
const m = qrMatrix('https://smithplumbingtampa.com/review-us');
for (const [x, y] of [[0, 0], [m.length - 7, 0], [0, m.length - 7]]) {
  assert.ok(m[y][x] && m[y + 6][x + 6] && m[y + 3][x + 3] && !m[y + 1][x + 1]);
}
assert.ok(qrSvg('https://a.co').startsWith('<svg'));

// Where the code points
const row = { prefill: {}, answers: { domain_choice: 'smithplumbingtampa.com' } };
assert.strictEqual(reviewUrlFor(row), 'https://smithplumbingtampa.com/review-us');
assert.strictEqual(reviewUrlFor({ ...row, site_domain: 'smithplumbing.com' }), 'https://smithplumbing.com/review-us');
assert.strictEqual(reviewUrlFor({ answers: { ...row.answers, google_review_link: 'https://g.page/r/abc/review' } }), 'https://g.page/r/abc/review');
assert.strictEqual(reviewUrlFor(row, 'https://g.page/r/xyz/review'), 'https://g.page/r/xyz/review');
assert.strictEqual(reviewUrlFor(row, 'javascript:alert(1)'), 'https://smithplumbingtampa.com/review-us');
assert.strictEqual(reviewUrlFor({ prefill: {}, answers: {} }), '', 'no link and no domain means no card');

// The page: 8 fronts, 8 backs, the name escaped, no outside scripts
const html = cardHtml({ business: 'Smith & Sons <Plumbing>', reviewUrl: 'https://smithplumbingtampa.com/review-us', style: 'fresh', phone: '8135550142', domain: 'smithplumbingtampa.com' });
assert.strictEqual(html.split('class="card front"').length - 1, 8);
assert.strictEqual(html.split('class="card back"').length - 1, 8);
assert.ok(html.includes('Smith &amp; Sons &lt;Plumbing&gt;'));
assert.ok(!html.includes('<script'));
assert.ok(html.includes('(813) 555-0142'));
assert.ok(!html.includes('—'), 'no em dashes');

console.log('review-card: all checks passed');
