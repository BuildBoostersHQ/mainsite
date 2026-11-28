// Tests for /api/valentina-log, against a pretend Supabase.
process.env.SUPABASE_URL = 'https://db.test';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
process.env.BB_INTERNAL_SECRET = 's'.repeat(32);
const handler = require('../api/valentina-log.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };

const now = Date.now();
const ago = (hours) => new Date(now - hours * 3600000).toISOString();
const db = {
  messages: [ // newest first, the way the endpoint asks for them
    { id: 'm5', phone: '+17275550111', direction: 'out', body: 'I am getting Maddie on this.', status: 'done', client_id: 'c2', media: [], created_at: ago(2) },
    { id: 'm4', phone: '+17275550111', direction: 'handoff', body: 'Valentina: Smith Plumbing wants Maddie', status: 'done', client_id: 'c2', media: [], created_at: ago(2.1) },
    { id: 'm3', phone: '+17275550111', direction: 'in', body: 'no. my HOURS.', status: 'done', client_id: 'c2', media: ['https://carrier/photo1'], created_at: ago(2.2) },
    { id: 'm2', phone: '+13055550199', direction: 'in', body: 'hello?', status: 'failed', client_id: null, media: [], created_at: ago(30) },
    { id: 'm1', phone: '+18135550142', direction: 'in', body: 'old text', status: 'held', client_id: 'c1', media: [], created_at: ago(24 * 9) },
  ],
  reviews: [{ id: '11111111-1111-1111-1111-111111111111', phone: '+17275550111', client_id: 'c2', day: '2026-12-01', flags: ['annoyed', 'handoff'], summary: 'He asked for hours and she tried to book.', status: 'new', note: null }],
  clients: [{ id: 'c1', owner_first_name: 'Dave', prefill: {}, answers: {}, tier: 'essentials' }, { id: 'c2', owner_first_name: 'Sam', prefill: { business_name: 'Smith Plumbing' }, answers: {}, tier: 'all_in_one' }],
};
const patches = [];
global.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const table = u.pathname.split('/').pop();
  const q = u.searchParams;
  const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
  if ((opts.method || 'GET') === 'PATCH') { patches.push({ table, id: q.get('id'), body: JSON.parse(opts.body) }); return reply([]); }
  if (table === 'valentina_messages') return reply(q.get('phone') ? db.messages.filter((m) => `eq.${m.phone}` === q.get('phone')) : db.messages);
  if (table === 'valentina_reviews') return reply(q.get('phone') ? db.reviews.filter((r) => `eq.${r.phone}` === q.get('phone')) : db.reviews);
  if (table === 'client_onboarding') return reply(q.get('id').startsWith('eq.') ? db.clients.filter((c) => `eq.${c.id}` === q.get('id')) : db.clients);
  throw new Error(`unexpected ${url}`);
};

const call = async (req) => {
  const res = { code: 0, body: null, setHeader() {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await handler({ method: 'GET', query: {}, headers: {}, ...req }, res);
  return res;
};
const secret = { 'x-bb-secret': 's'.repeat(32) };

(async () => {
  ok('no secret, no data', (await call({})).code === 401);

  let r = await call({ headers: secret });
  ok('the list loads', r.code === 200 && r.body.reviews.length === 1 && r.body.conversations.length === 3);
  ok('a flagged conversation carries the business name', r.body.reviews[0].business === 'Smith Plumbing');
  const smith = r.body.conversations[0];
  ok('newest conversation first, with its latest text', smith.phone === '+17275550111' && smith.last_text === 'I am getting Maddie on this.' && smith.business === 'Smith Plumbing');
  ok('counts per conversation', smith.texts_in === 1 && smith.texts_out === 1 && smith.handoffs === 1);
  ok('an unanswered text is counted', r.body.conversations.find((c) => c.phone === '+13055550199').unanswered === 1);
  ok('a client with no business name shows his first name', r.body.conversations.find((c) => c.phone === '+18135550142').business === 'Dave');
  ok('the week counts leave out older texts', r.body.week.texts_in === 2 && r.body.week.replies === 1 && r.body.week.handoffs === 1 && r.body.week.unanswered === 1 && r.body.week.held === 0);

  r = await call({ headers: secret, query: { phone: '+17275550111' } });
  ok('one transcript, oldest first', r.code === 200 && r.body.messages.map((m) => m.id).join() === 'm3,m4,m5' && r.body.business === 'Smith Plumbing' && r.body.plan === 'all_in_one');
  ok('photo links are counted, not sent', r.body.messages[0].photos === 1 && !('media' in r.body.messages[0]) && !JSON.stringify(r.body).includes('carrier/photo1'));
  ok('its reviews come with it', r.body.reviews.length === 1);
  r = await call({ headers: secret, query: { phone: ' 17275550111' } });
  ok('a plus sign that arrived as a space still works', r.code === 200 && r.body.messages.length === 3);
  ok('a bad phone is refused', (await call({ headers: secret, query: { phone: '7275550111' } })).code === 400);

  r = await call({ method: 'PATCH', headers: secret, query: { id: '11111111-1111-1111-1111-111111111111' }, body: { status: 'reviewed', note: ' Added a line about hours. ' } });
  ok('marking one reviewed saves the note', r.code === 200 && patches[0].table === 'valentina_reviews' && patches[0].body.status === 'reviewed' && patches[0].body.note === 'Added a line about hours.');
  ok('a bad status is refused', (await call({ method: 'PATCH', headers: secret, query: { id: '11111111-1111-1111-1111-111111111111' }, body: { status: 'deleted' } })).code === 400);
  ok('a bad id is refused', (await call({ method: 'PATCH', headers: secret, query: { id: 'x' }, body: { status: 'reviewed' } })).code === 400);
  ok('other methods are refused', (await call({ method: 'DELETE', headers: secret })).code === 405);

  if (failed) { console.error(`${failed} failed`); process.exit(1); }
  console.log('All valentina-log tests passed.');
})();
