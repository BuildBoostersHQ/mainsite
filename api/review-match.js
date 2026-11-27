// /api/review-match — matches the names on a client's Google reviews to their customer list, so nobody who
// already left a review gets asked for one again.
//
// Internal only (BB_INTERNAL_SECRET in the x-bb-secret header).
//
// POST /api/review-match  { code, reviewers: ["Maya P.", "Mike Torres", ...] }
//   Loads the customer list the client uploaded (saved by /api/customer-list) and returns:
//     exact  the reviewer's name is the same as exactly one customer's full name
//     maybe  ranked guesses for a person to look at, each with a score from 0 to 1 and the reason
//     none   reviewers with no likely customer
//   Each customer's contact_id is their ten-digit phone, or their email when there is no phone.
//
// POST /api/review-match  { action: "confirm", code, pairs: [{ reviewer, contact_id }] }
//   Saves the confirmed pairs to review_matches (supabase/review_matches.sql). /api/review-queue leaves
//   those customers out of the review asks from then on.
const { sb, allowed, configured } = require('./_sb');
const { readList } = require('./customer-list');

const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const MAX_REVIEWERS = 500;
const MAX_PAIRS = 200;
const MAX_MAYBE = 5;

// Short names people go by, each with the full names it can stand for.
const NICKNAMES = {
  mike: ['michael'], mikey: ['michael'], mick: ['michael'], liz: ['elizabeth'], beth: ['elizabeth'], lizzie: ['elizabeth'], eliza: ['elizabeth'], betty: ['elizabeth'],
  bob: ['robert'], bobby: ['robert'], rob: ['robert'], robbie: ['robert'], bill: ['william'], billy: ['william'], will: ['william'], willie: ['william'], liam: ['william'],
  jim: ['james'], jimmy: ['james'], jamie: ['james'], joe: ['joseph'], joey: ['joseph'], tom: ['thomas'], tommy: ['thomas'], dave: ['david'], davey: ['david'],
  dan: ['daniel'], danny: ['daniel'], matt: ['matthew'], tony: ['anthony'], nick: ['nicholas'], rick: ['richard'], rich: ['richard'], dick: ['richard'], ricky: ['richard', 'ricardo'],
  chris: ['christopher', 'christine', 'christina', 'christian'], steve: ['steven', 'stephen'], andy: ['andrew', 'andres'], drew: ['andrew'], ben: ['benjamin'], sam: ['samuel', 'samantha'],
  alex: ['alexander', 'alexandra', 'alejandro', 'alejandra'], ed: ['edward', 'eduardo', 'edwin'], eddie: ['edward', 'eduardo'], ted: ['edward', 'theodore'], greg: ['gregory'],
  jeff: ['jeffrey'], jon: ['jonathan'], josh: ['joshua'], ken: ['kenneth'], kenny: ['kenneth'], larry: ['lawrence'], pat: ['patrick', 'patricia'], patty: ['patricia'], tricia: ['patricia'],
  pete: ['peter'], phil: ['phillip', 'philip'], ron: ['ronald'], ronnie: ['ronald'], tim: ['timothy'], charlie: ['charles'], chuck: ['charles'], hank: ['henry'], harry: ['henry', 'harold'],
  jack: ['john', 'jackson'], johnny: ['john'], frank: ['francis', 'franklin', 'francisco'], fred: ['frederick'], gabe: ['gabriel'], nate: ['nathan', 'nathaniel'], zach: ['zachary'], vince: ['vincent'],
  kate: ['katherine', 'kathryn', 'catherine'], katie: ['katherine', 'kathryn', 'catherine'], kathy: ['katherine', 'kathleen', 'kathryn'], cathy: ['catherine'], kat: ['katherine', 'katrina'],
  jen: ['jennifer'], jenny: ['jennifer'], jess: ['jessica'], sue: ['susan'], susie: ['susan'], deb: ['deborah', 'debra'], debbie: ['deborah', 'debra'], barb: ['barbara'], cindy: ['cynthia'],
  maggie: ['margaret'], meg: ['margaret'], peggy: ['margaret'], becky: ['rebecca'], vicky: ['victoria'], tori: ['victoria'], abby: ['abigail'], angie: ['angela'], mandy: ['amanda'],
  steph: ['stephanie'], nikki: ['nicole'], terry: ['terrence', 'theresa', 'teresa'], manny: ['manuel', 'emmanuel'], pepe: ['jose'], paco: ['francisco'], pancho: ['francisco'], nacho: ['ignacio'],
  memo: ['guillermo'], beto: ['alberto', 'roberto', 'humberto'], lupe: ['guadalupe'], chuy: ['jesus'], javi: ['javier'], rafa: ['rafael'], dani: ['daniel', 'daniela'], gabi: ['gabriela'], nando: ['fernando'],
};

// Lower case, no accents, no punctuation, single spaces. "José  O'Brien-Smith" becomes "jose obrien smith".
function normalize(name) {
  return String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/['’`]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// How many single-letter changes turn one word into the other. Stops counting past `max`.
function editDistance(a, b, max = 2) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i]; let low = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (row[j] < low) low = row[j];
    }
    if (low > max) return max + 1;
    prev = row;
  }
  return prev[b.length];
}

// Short names have to be spelled right. Medium ones can be one letter off, long ones two.
const allowedEdits = (length) => (length <= 4 ? 0 : length <= 8 ? 1 : 2);

// 0 when the spelling is too far apart to be the same person, otherwise how many letters are off (1 or 2).
// With the same number of names, each name is checked against its own length, so "Dan Smith" is not "Jan Smith".
function spellingDistance(rv, c) {
  if (rv.parts.length === c.parts.length) {
    let total = 0;
    for (let i = 0; i < rv.parts.length; i++) {
      const max = allowedEdits(Math.min(rv.parts[i].length, c.parts[i].length));
      const d = editDistance(rv.parts[i], c.parts[i], max);
      if (d > max) return 0;
      total += d;
    }
    return total <= 2 ? total : 0;
  }
  const max = allowedEdits(Math.min(rv.full.length, c.full.length));
  const d = max ? editDistance(rv.full, c.full, max) : 0;
  return d <= max ? d : 0;
}

const formalNames = (first) => new Set([first, ...(NICKNAMES[first] || [])]);
function sameByNickname(a, b) {
  if (!a || !b || a === b) return false;
  const fa = formalNames(a);
  for (const n of formalNames(b)) if (fa.has(n)) return true;
  return false;
}

const display = (c) => String(c.full_name || [c.first_name, c.last_name].filter(Boolean).join(' ') || '').replace(/\s+/g, ' ').trim();

function prepare(contact) {
  const name = display(contact);
  const full = normalize(name);
  const parts = full.split(' ').filter(Boolean);
  const first = normalize(contact.first_name).split(' ')[0] || parts[0] || '';
  const lastParts = normalize(contact.last_name).split(' ').filter(Boolean);
  const last = lastParts.length ? lastParts.join(' ') : parts.slice(1).join(' ');
  return { id: contact.id, name, full, parts, first, last, lastWord: last.split(' ').pop() || '' };
}

// The best reason, if any, to think this reviewer is this customer.
function compare(rv, c, firstNameCount) {
  const rFirst = rv.parts[0], rLast = rv.parts.length > 1 ? rv.parts[rv.parts.length - 1] : '';
  const firstSame = rFirst === c.first, firstNick = sameByNickname(rFirst, c.first);

  if (rv.parts.length > 1 && [...rv.parts].sort().join(' ') === [...c.parts].sort().join(' ')) {
    return { score: 0.9, reason: 'The same names in a different order.' };
  }
  if (rv.parts.length > 2 || c.parts.length > 2) {
    if (firstSame && rLast.length > 1 && rLast === c.lastWord && rv.parts.length !== c.parts.length) return { score: 0.85, reason: 'The same first and last name, with a middle name on one of them.' };
  }
  if (rv.parts.length === 2 && rLast.length === 1 && c.last && c.last[0] === rLast) {
    if (firstSame) return { score: 0.85, reason: `The last name is given as an initial, and ${c.name} fits it.` };
    if (firstNick) return { score: 0.7, reason: `The first name is a nickname and the last name is an initial, and ${c.name} fits both.` };
  }
  if (firstNick && rLast.length > 1 && rLast === c.lastWord) {
    return { score: 0.8, reason: `${cap(rFirst)} and ${cap(c.first)} are the same name, and the last name is the same.` };
  }
  if (rv.parts.length === 1) {
    const count = firstNameCount(rFirst);
    if (firstSame && count === 1) return { score: 0.6, reason: `Only a first name was given, and this is the only ${cap(rFirst)} on the list.` };
    if (firstNick && count === 1) return { score: 0.5, reason: `Only a first name was given, and this is the only customer who goes by ${cap(rFirst)}.` };
    return null;
  }
  if (c.parts.length > 1) {
    const d = spellingDistance(rv, c);
    if (d === 1) return { score: 0.75, reason: 'The spelling is one letter off.' };
    if (d === 2) return { score: 0.65, reason: 'The spelling is two letters off.' };
  }
  return null;
}
const cap = (w) => (w ? w[0].toUpperCase() + w.slice(1) : w);

// The matcher. `reviewers` is a list of names as they show on Google. `contacts` is a list of
// { id, first_name, last_name, full_name }. Nothing here touches the network or a database.
function matchReviewers(reviewers, contacts) {
  const people = (Array.isArray(contacts) ? contacts : []).filter((c) => c && c.id != null).map(prepare).filter((c) => c.full);
  const byFull = new Map();
  for (const c of people) { if (!byFull.has(c.full)) byFull.set(c.full, []); byFull.get(c.full).push(c); }
  // How many customers go by this first name, counting nicknames.
  const firstNameCount = (first) => people.filter((c) => c.first === first || sameByNickname(first, c.first)).length;

  const out = { exact: [], maybe: [], none: [] };
  const seen = new Set();
  for (const raw of Array.isArray(reviewers) ? reviewers : []) {
    const reviewer = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
    const full = normalize(reviewer);
    if (!reviewer || seen.has(full)) continue;
    seen.add(full);
    if (!full) { out.none.push(reviewer); continue; }

    const same = byFull.get(full) || [];
    if (same.length === 1) { out.exact.push({ reviewer, contact_id: same[0].id, contact_name: same[0].name }); continue; }
    if (same.length > 1) {
      // Two customers with the same name: a person has to pick.
      out.maybe.push({ reviewer, candidates: same.slice(0, MAX_MAYBE).map((c) => ({ contact_id: c.id, contact_name: c.name, score: 0.9, reason: `${same.length} customers have this exact name.` })) });
      continue;
    }
    const rv = { full, parts: full.split(' ') };
    const candidates = [];
    for (const c of people) {
      const hit = compare(rv, c, firstNameCount);
      if (hit) candidates.push({ contact_id: c.id, contact_name: c.name, score: hit.score, reason: hit.reason });
    }
    if (!candidates.length) { out.none.push(reviewer); continue; }
    candidates.sort((x, y) => y.score - x.score || x.contact_name.localeCompare(y.contact_name));
    out.maybe.push({ reviewer, candidates: candidates.slice(0, MAX_MAYBE) });
  }
  return out;
}

// The saved customer list has no ids, so each customer is known by the same thing the upload uses to
// spot duplicates: their phone, or their email when there is no phone.
function contactsFromList(list) {
  return ((list && list.customers) || []).filter((c) => c && (c.phone || c.email)).map((c) => ({
    id: c.phone || c.email, first_name: c.first_name || '', last_name: c.last_name || '',
    full_name: [c.first_name, c.last_name].filter(Boolean).join(' '), phone: c.phone || '', email: c.email || '',
  }));
}

// TODO: tag the contact in the client's HighLevel sub-account (for example "left a review") so automations
// built inside HighLevel can skip them too. The only tagging this repo does today is contacts/upsert in
// customer-list.js, which sends a full tag list and may replace tags added since the
// upload. Until that is checked against HighLevel, nothing is sent there and the skip happens in
// /api/review-queue, which reads review_matches.
async function tagReviewedContactsInSubAccount(locationId, contacts) {
  return { tagged: 0, skipped: contacts.length, reason: 'not_built' };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const b = req.body || {};
    const code = String(b.code || req.query?.code || '').trim();
    if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });
    const client = (await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=id,ghl_location_id&limit=1`))[0];
    if (!client) return res.status(404).json({ error: 'not_found' });
    const list = await readList(client.id);
    if (!list) return res.status(404).json({ error: 'no_list' });
    const contacts = contactsFromList(list);

    if (b.action === 'confirm') {
      const pairs = Array.isArray(b.pairs) ? b.pairs.slice(0, MAX_PAIRS) : [];
      const byId = new Map(contacts.map((c) => [c.id, c]));
      const rows = [], unknown = [], seen = new Set();
      for (const p of pairs) {
        const reviewer = String((p && p.reviewer) || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const contact = byId.get(String((p && p.contact_id) || '').trim());
        if (!reviewer || !contact) { unknown.push(p); continue; }
        if (seen.has(reviewer)) continue;
        seen.add(reviewer);
        rows.push({ client_id: client.id, reviewer_name: reviewer, contact_key: contact.id, contact_name: contact.full_name, contact_phone: contact.phone || null, contact_email: contact.email || null, confirmed_at: new Date().toISOString() });
      }
      if (!rows.length) return res.status(400).json({ error: 'no_valid_pairs', unknown });
      // Confirming the same reviewer again replaces the earlier pick.
      const saved = await sb('review_matches?on_conflict=client_id,reviewer_name', {
        method: 'POST', headers: { Prefer: 'return=representation,resolution=merge-duplicates' }, body: JSON.stringify(rows),
      });
      const ghl = await tagReviewedContactsInSubAccount(client.ghl_location_id, rows);
      const noPhone = rows.filter((r) => !r.contact_phone).length;
      return res.status(200).json({ ok: true, saved: saved.length, unknown, no_phone: noPhone, ghl });
    }
    if (b.action) return res.status(400).json({ error: 'bad_request' });

    if (!Array.isArray(b.reviewers) || !b.reviewers.length) return res.status(400).json({ error: 'reviewers_required' });
    const reviewers = b.reviewers.filter((r) => typeof r === 'string').map((r) => r.slice(0, 200)).slice(0, MAX_REVIEWERS);
    return res.status(200).json({ ok: true, customers: contacts.length, ...matchReviewers(reviewers, contacts) });
  } catch (e) {
    console.error('review-match', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
Object.assign(module.exports, { matchReviewers, normalize, editDistance, contactsFromList, tagReviewedContactsInSubAccount });
