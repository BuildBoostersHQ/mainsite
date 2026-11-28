// The setup credit. Files that start with an underscore are not routes.
//
// A client earns it by finishing everything we need from him: the setup form, the texting registration
// (his EIN, or his sole proprietor details when he has no EIN) and the Google profile step.
//   $50  finished on the same calendar day he paid, Eastern time
//   $20  finished the next calendar day
//   $0   after that
// A payment at 8 PM Eastern or later counts as the next day, so a late buyer still gets a full day.
//
// Where the credit goes:
//   monthly plans              his Stripe customer balance, which comes off his next invoice on its own
//   quarterly and yearly plans his HighLevel sub-account wallet, as complimentary credits
// Needs STRIPE_SECRET_KEY for the first and GHL_AGENCY_API_KEY (with the wallet.write scope) for the second.
const TZ = 'America/New_York';
const DAY = 86400000;
const LATE_HOUR = 20;
const SAME_DAY = 50;
const NEXT_DAY = 20;

// The calendar date and hour in Miami for a moment in time.
function eastern(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return { date: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}
const dayNumber = (date) => Math.round(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) / DAY);
const dateOf = (n) => new Date(n * DAY).toISOString().slice(0, 10);

// The moment an Eastern calendar day ends, as a timestamp.
function endOfDay(n) {
  const next = dateOf(n + 1);
  let ms = Date.UTC(Number(next.slice(0, 4)), Number(next.slice(5, 7)) - 1, Number(next.slice(8, 10)), 5);
  if (eastern(ms).hour === 1) ms -= 3600000;  // daylight saving time
  return ms;
}

// The day the clock starts, as a day number. 8 PM or later rolls to the next day.
function payDay(createdIso) {
  const ms = new Date(createdIso).getTime();
  if (!createdIso || isNaN(ms)) return null;
  const e = eastern(ms);
  return dayNumber(e.date) + (e.hour >= LATE_HOUR ? 1 : 0);
}

const noEin = (a) => /no EIN/i.test((a && a.a2p_entity_type) || '');
const isPoBox = (s) => /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb|private\s+mailbox)\b/i.test(String(s || ''));
// A sole proprietor with no EIN registers under his own name: first and last name and a real street address.
function soleDetailsDone(a) {
  const name = String((a && a.a2p_legal_name) || '').trim();
  const addr = String((a && a.a2p_address) || '').trim();
  return name.split(/\s+/).length >= 2 && /\d/.test(addr) && addr.length >= 8 && !isPoBox(addr);
}

const time = (iso) => { const ms = iso ? new Date(iso).getTime() : NaN; return isNaN(ms) ? null : ms; };

// When the texting registration details came in, or null if they have not.
function registrationAt(r, a) {
  if (noEin(a)) return time(r.a2p_details_at);
  return time(r.ein_provided_at) || time(r.a2p_registered_at);
}

// What is still missing before setup counts as finished.
function missing(r, a) {
  const out = [];
  if (!r.submitted_at) out.push('form');
  if (!registrationAt(r, a)) out.push(noEin(a) ? 'sole' : 'ein');
  if (!r.google_requested_at && !r.google_approved_at) out.push('google');
  return out;
}

// Has he finished, when, and what did that earn.
function setupCredit(r, a) {
  const start = payDay(r.created_at);
  const steps = [time(r.submitted_at), registrationAt(r, a), time(r.google_requested_at) || time(r.google_approved_at)];
  if (start === null || steps.some((s) => !s)) return { done: false, amount: 0 };
  const finished = Math.max(...steps);
  const date = eastern(finished).date;
  const late = dayNumber(date) - start;
  return { done: true, finished_at: new Date(finished).toISOString(), onboarding_date: date, amount: late <= 0 ? SAME_DAY : late === 1 ? NEXT_DAY : 0 };
}

// What he can still earn right now, and until when.
function offer(createdIso, now) {
  const start = payDay(createdIso);
  if (start === null) return { amount: 0, until: '' };
  const today = dayNumber(eastern(now).date);
  if (today <= start) return { amount: SAME_DAY, until: new Date(endOfDay(start)).toISOString() };
  if (today === start + 1) return { amount: NEXT_DAY, until: new Date(endOfDay(start + 1)).toISOString() };
  return { amount: 0, until: '' };
}

const isMonthly = (r) => !/^(quarterly|six[_ -]?months?|6[_ -]?months?|annual|annually|yearly)$/i.test(String(r.billing_cycle || '').trim());
const destination = (r) => (isMonthly(r) ? 'stripe' : 'ghl_wallet');

// Puts the credit on his Stripe customer balance. Stripe takes it off the next invoice without anyone touching it.
async function creditStripe(r, amount) {
  const key = String(process.env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { ok: false, reason: 'STRIPE_SECRET_KEY is not set in Vercel' };
  if (!/^cus_[A-Za-z0-9]+$/.test(String(r.stripe_customer_id || ''))) return { ok: false, reason: 'no Stripe customer on his record' };
  const body = new URLSearchParams({
    amount: String(-amount * 100), currency: 'usd',
    description: `Setup credit, $${amount} for finishing setup ${amount === SAME_DAY ? 'the same day' : 'the next day'}`,
    'metadata[client_code]': r.code, 'metadata[reason]': 'setup_credit',
  });
  try {
    const res = await fetch(`https://api.stripe.com/v1/customers/${r.stripe_customer_id}/balance_transactions`, {
      method: 'POST', body,
      // The same key on a retry means Stripe never credits him twice.
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Idempotency-Key': `setup-credit-${r.id}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: `Stripe ${res.status}: ${(data.error && data.error.message) || 'unknown'}`.slice(0, 200) };
    return { ok: true, ref: data.id || '' };
  } catch (e) { return { ok: false, reason: e.message }; }
}

// Adds complimentary credits to his HighLevel wallet. Can only run once his sub-account exists.
async function creditWallet(r, amount) {
  const key = String(process.env.GHL_AGENCY_API_KEY || '').trim();
  if (!key) return { ok: false, reason: 'GHL_AGENCY_API_KEY is not set in Vercel' };
  if (!r.ghl_location_id) return { ok: false, waiting: true, reason: 'his HighLevel sub-account does not exist yet' };
  try {
    const res = await fetch('https://services.leadconnectorhq.com/wallet/balance/complimentary-credits', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, Version: 'v3', 'Content-Type': 'application/json', 'Idempotency-Key': `setup-credit-${r.id}` },
      body: JSON.stringify({ locationId: r.ghl_location_id, complimentaryCreditsAmount: amount }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, reason: `HighLevel ${res.status}: ${data.message || 'unknown'}`.slice(0, 200) };
    return { ok: true, ref: data.walletId || '', balance: data.complimentaryCredits };
  } catch (e) { return { ok: false, reason: e.message }; }
}

const applyCredit = (r, amount) => (destination(r) === 'stripe' ? creditStripe(r, amount) : creditWallet(r, amount));

module.exports = { SAME_DAY, NEXT_DAY, eastern, payDay, noEin, isPoBox, soleDetailsDone, registrationAt, missing, setupCredit, offer, destination, applyCredit };
