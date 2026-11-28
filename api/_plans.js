// Shared rules about plans and the setup credit. Files that start with an underscore are not routes.
//
// Plans (the tier saved on each client row):
//   essentials   $147 a month, up to 4 services and 5 towns
//   all_in_one   $279 a month, up to 8 services and 10 towns
//   dominance    $497 a month, up to 12 services and 14 towns
// Every one of them includes texting, so every one of them needs a texting registration.
// 'website' is the old $79 website-only plan and is the one plan with no texting.
//
// Setup credit: $50 off when setup is finished on the same calendar day as the payment, $20 when it
// is finished the next day. Days are Eastern time. A payment at 8 PM or later counts as the next day,
// so a late buyer still gets a full day for each amount.
const TZ = 'America/New_York';
const LATE_HOUR = 20;
const CREDITS = { sameDay: 50, nextDay: 20 };

// 12 services and 14 towns is the most the client site template builds pages for.
const MOST = { services: 12, areas: 14 };
const CAPS = {
  essentials: { services: 4, areas: 5 },
  all_in_one: { services: 8, areas: 10 },
  dominance: { services: 12, areas: 14 },
};

const tierKey = (tier) => String(tier || '').trim().toLowerCase().replace(/[\s-]+/g, '_');

// How many services and towns this client's plan holds. A plan we do not recognize gets the template's limits.
function limitsFor(tier) {
  return { ...(CAPS[tierKey(tier)] || MOST) };
}

const isWebsiteOnly = (tier) => /^website/.test(tierKey(tier));

// The date and hour in Miami for a moment in time.
function easternParts(ms) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date(ms))) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value);
  }
  return { y: parts.year, m: parts.month, d: parts.day, h: parts.hour % 24 };
}

// The moment a calendar day starts in Miami. Day numbers past the end of a month roll over.
function easternMidnight(y, m, d) {
  const want = new Date(Date.UTC(y, m - 1, d));
  for (const offset of [4, 5]) {
    const t = Date.UTC(y, m - 1, d, offset);
    const p = easternParts(t);
    if (p.h === 0 && p.d === want.getUTCDate() && p.m === want.getUTCMonth() + 1) return t;
  }
  return Date.UTC(y, m - 1, d, 5);
}

// When each credit runs out for a client who paid at `paidIso`. Both are the end of a day in Miami.
function creditDeadlines(paidIso) {
  const paid = new Date(paidIso).getTime();
  if (!Number.isFinite(paid)) return null;
  const p = easternParts(paid);
  const shift = p.h >= LATE_HOUR ? 1 : 0;
  return {
    sameDay: easternMidnight(p.y, p.m, p.d + 1 + shift),
    nextDay: easternMidnight(p.y, p.m, p.d + 2 + shift),
  };
}

// The credit earned by finishing setup at `doneIso`: 50, 20 or 0.
function creditFor(paidIso, doneIso) {
  const deadlines = creditDeadlines(paidIso);
  const done = new Date(doneIso).getTime();
  if (!deadlines || !Number.isFinite(done)) return 0;
  if (done < deadlines.sameDay) return CREDITS.sameDay;
  if (done < deadlines.nextDay) return CREDITS.nextDay;
  return 0;
}

const noEinNeeded = (row, answers) => isWebsiteOnly(row.tier) || /no EIN/i.test((answers || {}).a2p_entity_type || '');

// When this client finished setup: the form, the Google step and the EIN are all in. Returns '' until then.
function setupDoneAt(row, answers) {
  const google = row.google_requested_at || row.google_approved_at;
  if (!row.submitted_at || !google) return '';
  const times = [row.submitted_at, google];
  if (!noEinNeeded(row, answers)) {
    if (!row.ein_provided_at) return '';
    times.push(row.ein_provided_at);
  }
  return new Date(Math.max(...times.map((t) => new Date(t).getTime()))).toISOString();
}

module.exports = { CREDITS, MOST, limitsFor, isWebsiteOnly, easternParts, creditDeadlines, creditFor, noEinNeeded, setupDoneAt };
