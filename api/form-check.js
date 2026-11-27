// /api/form-check — the check on every client who is still setting up. It replaces form-nudge.
//
// Texts are signed "Automated Maddie" and only go out during the day, Eastern time.
//
// Three reminder tracks, each with its own texts:
//   form  the setup form has not been submitted
//   ein   the form is in, but there is no EIN (texting plans only)
//   gmb   the form is in, but they have not added us to their Google profile
//
// Timing for each track:
//   first text   20 hours or more after the clock starts, any time from 9 AM to 7 PM
//   later texts  the following mornings, between 8 and 11 AM
// The clock starts at payment for the form track and at form submission for the other two.
//
// Also, once per client:
//   - with the first form text, Maddie gets the client's name and number so she can call
//   - a form finished inside 24 hours (Google step included) is flagged for the $30 credit
//   - at 72 hours with no form, the site is built from the Google profile ("final with basics")
//     and everything still missing goes on the launch call checklist
//   - once the site is built, a text asking them to bring their customer list to the launch call
//
// Built to run every hour. On Vercel's free plan a schedule can only run once a day, so vercel.json
// runs it once each morning (9 to 10 AM Eastern in winter, 10 to 11 in summer) and everything here
// happens at that run. On a paid plan, change the schedule to "0 * * * *" and the timing above is exact.
// Internal only.
const { sb, allowed, configured, isCron } = require('./_sb');
const { sendAlert } = require('./alert');
const { textClient, digits } = require('./_text');

const TABLE = 'client_onboarding';
const HOUR = 3600000;
const GOOGLE_STEPS = 'https://buildboosters.com/give-google-business-profile-access';

const hoursSince = (iso, now) => (iso ? (now - new Date(iso).getTime()) / HOUR : Infinity);

// The hour of the day in Miami, 0 to 23.
function easternHour(now) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(now));
  return Number(h) % 24;
}

const TEXTS = {
  form: [
    (n, url) => `Hey ${n}, Automated Maddie here. Real Maddie warned you I'd start bugging you about your setup page. It takes about 5 minutes and your EIN is the first thing on it: ${url}`,
    (n, url) => `Good morning ${n}, Automated Maddie again. I can't start building your website until your setup page is done, and I really want to start building your website: ${url}`,
    (n, url) => `${n}, it's Automated Maddie, and yes I'm still at it. Give me 5 minutes on your setup page and I'll leave you alone: ${url}`,
  ],
  ein: [
    (n, url) => `Hey ${n}, Automated Maddie here. The one thing I'm still missing is your EIN. The phone carriers won't approve your texting number without it. It stays private and I delete it once you're approved: ${url}`,
    (n, url) => `Good morning ${n}, Automated Maddie again. Carrier approval takes a while, so the sooner I have your EIN the sooner your texts turn on. It's the first box on your setup page: ${url}`,
    (n, url) => `${n}, Automated Maddie here about your EIN again. It's on the letter the IRS sent when you set up the business, and your accountant will have it too: ${url}`,
    (n, url) => `Last one from me about the EIN, ${n}. Real Maddie is going to call you about it next, and she is a lot harder to ignore than I am: ${url}`,
  ],
  gmb: [
    (n) => `Hey ${n}, Automated Maddie here. I still need you to add me as a manager on your Google profile so I can post your job photos and keep your hours right. It takes 2 minutes and here are the steps with pictures: ${GOOGLE_STEPS}`,
    (n) => `Good morning ${n}, Automated Maddie again. You stay the owner of your Google profile and you can remove me any time. I just need manager access to do my job: ${GOOGLE_STEPS}`,
    (n, url) => `${n}, Automated Maddie here about Google again. The email to add as a manager is buildboostersgmb@gmail.com. Once you send the invite, tap "I sent it" on your setup page: ${url}`,
    (n) => `Last one from me about Google, ${n}. Real Maddie can do it with you on a quick call if that's easier. Just reply here and she'll set it up.`,
  ],
  basics: (n, url) => `Hey ${n}, Automated Maddie here. I got tired of waiting, so I built your website with what I found on your Google profile. Real Maddie will go over the rest with you on your launch call. You can still fill in your setup page any time: ${url}`,
  customerList: (n) => `Hey ${n}, Automated Maddie here. Your plan comes with one free text to all of your past customers to bring in repeat work. Bring your customer list to your launch call. A spreadsheet or an export from your invoicing app both work.`,
};

const isWebsiteTier = (r) => /^website/i.test(String(r.tier || '').trim());

// Which reminder tracks are still open for this client.
function openTracks(r, a) {
  if (!r.submitted_at) return r.site_final_basics_at ? [] : ['form'];
  const tracks = [];
  const noEinNeeded = isWebsiteTier(r) || /no EIN/i.test(a.a2p_entity_type || '');
  if (!noEinNeeded && !r.ein_provided_at && !r.ein_private && !r.a2p_registered_at) tracks.push('ein');
  if (!r.google_requested_at && !r.google_approved_at) tracks.push('gmb');
  return tracks;
}

// Is this track's next text due right now? `sent` is the list of times its earlier texts went out.
function due(track, sent, anchorIso, now) {
  const max = TEXTS[track].length;
  if (sent.length >= max) return false;
  const hour = easternHour(now);
  if (sent.length === 0) return hoursSince(anchorIso, now) >= 20 && hour >= 9 && hour < 19;
  return hour >= 8 && hour < 11 && hoursSince(sent[sent.length - 1], now) >= 12;
}

// Everything the launch call has to cover because the form never came in (or came in with gaps).
function launchChecklist(r, a) {
  const items = [];
  const has = (v) => (Array.isArray(v) ? v.length > 0 : !!String(v || '').trim());
  if (!has(a.services) && !has(a.services_other)) items.push('Pick their services (up to 12)');
  if (!has(a.areas) && !has(a.areas_other)) items.push('Pick the towns they work in (up to 10)');
  if (!has(a.vibes) && !has(a.vibes_other)) items.push('How customers would describe them (brand voice for the copy)');
  if (!has(a.badges) && !has(a.license) && !has(a.years_in_business)) items.push('What sets them apart: license, years in business, badges');
  if (!has(a.style)) items.push('Choose one of the six site looks and a brand color');
  if (!has(a.domain_choice) && !has(a.domain_own) && !r.site_domain) items.push('Choose their website name');
  if ((r.photo_count || 0) < 3) items.push(`Get job photos (they have ${r.photo_count || 0})`);
  if (!has(a.weekday_hours)) items.push('Confirm business hours');
  if (!has(a.cell)) items.push('Get their cell number');
  if (!r.sms_consent_at) items.push('Get their yes to service texts');
  if (!r.google_requested_at && !r.google_approved_at) items.push('Add buildboostersgmb@gmail.com as a manager on their Google profile');
  if (!isWebsiteTier(r) && !/no EIN/i.test(a.a2p_entity_type || '')) {
    if (!has(a.a2p_legal_name)) items.push('Legal business name and business type for texting registration');
    if (!r.ein_provided_at && !r.ein_private) items.push('EIN for texting registration');
  }
  if (!isWebsiteTier(r)) items.push('Customer list for their free reactivation text');
  return items;
}

async function check(r, now, origin, out) {
  const a = { ...(r.prefill || {}), ...(r.answers || {}) };
  const first = r.owner_first_name || a.preferred_name || 'there';
  const business = a.business_name || r.owner_first_name || r.code.slice(0, 8);
  const phone = digits(a.cell || a.owner_cell || a.business_phone);
  const url = `https://buildboosters.com/start/${r.code}`;
  const nudges = { ...(r.nudges_sent || {}) };
  const patch = {};
  const stamp = new Date(now).toISOString();
  const hour = easternHour(now);
  const daytime = hour >= 9 && hour < 19;

  // The $30 credit: form and Google step both finished inside 24 hours of payment.
  if (r.submitted_at && !r.credit_30_earned_at && r.created_at) {
    const deadline = new Date(r.created_at).getTime() + 24 * HOUR;
    const googleAt = r.google_requested_at || r.google_approved_at;
    if (new Date(r.submitted_at).getTime() <= deadline && googleAt && new Date(googleAt).getTime() <= deadline) {
      patch.credit_30_earned_at = stamp;
      await sendAlert('$30 credit earned', `${business} finished setup inside 24 hours. Take $30 off their next bill.`).catch(() => {});
      out.credits.push(business);
    }
  }

  // The three reminder tracks.
  for (const track of openTracks(r, a)) {
    const sent = Array.isArray(nudges[track]) ? nudges[track] : [];
    const anchor = track === 'form' ? r.created_at : r.submitted_at;
    if (!due(track, sent, anchor, now)) continue;
    const index = sent.length;
    const result = phone ? await textClient(phone, TEXTS[track][index](first, url), first) : { sent: false, reason: 'no_phone' };
    if (result.sent) {
      nudges[track] = [...sent, stamp];
      out.texts.push({ client: business, track, number: index + 1 });
    } else {
      out.failed.push({ client: business, track, reason: result.reason });
    }
    // With the first form reminder, hand Maddie the name and number so she can call.
    if (track === 'form' && index === 0 && !nudges.call_alert) {
      await sendAlert('Call this client', `${first} at ${business} has not done the setup form. ${phone ? `Call ${phone}.` : 'No phone number on file.'}`).catch(() => {});
      nudges.call_alert = stamp;
    }
    // The last EIN or Google text promises a call from the real Maddie.
    if (track !== 'form' && index === TEXTS[track].length - 1 && result.sent) {
      await sendAlert('Call this client', `${first} at ${business} still owes ${track === 'ein' ? 'their EIN' : 'Google profile access'} after four texts. ${phone ? `Call ${phone}.` : ''}`).catch(() => {});
    }
  }

  // 72 hours with no form: build from the Google profile and move the gaps to the launch call.
  const attempts = Number(nudges.basics_attempts || 0);
  if (!r.submitted_at && !r.site_final_basics_at && hoursSince(r.created_at, now) >= 72 && daytime && attempts < 2) {
    nudges.basics_attempts = attempts + 1;
    patch.launch_checklist = launchChecklist(r, a);
    let built = {};
    try {
      const res = await fetch(`${origin}/api/build-site`, {
        method: 'POST',
        headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: r.code, basics: true }),
      });
      built = await res.json().catch(() => ({}));
    } catch (e) { built = { reason: e.message }; }
    if (built.ok) {
      if (phone) await textClient(phone, TEXTS.basics(first, url), first);
      await sendAlert('Built with basics', `${business} never sent the form, so the site is built from Google. ${patch.launch_checklist.length} items moved to their launch call checklist.`).catch(() => {});
      out.basics.push(business);
    } else {
      await sendAlert('Basics build failed', `${business}: ${built.step || built.reason || built.error || 'unknown'}. Try ${attempts + 1} of 2.`).catch(() => {});
      out.failed.push({ client: business, track: 'basics', reason: built.step || built.reason || built.error || 'unknown' });
    }
  }

  // Once there is a site, ask them to bring their customer list to the launch call.
  if (!isWebsiteTier(r) && r.site_created_at && !nudges.customer_list && daytime && hoursSince(r.site_created_at, now) >= 2 && phone) {
    const result = await textClient(phone, TEXTS.customerList(first), first);
    if (result.sent) { nudges.customer_list = stamp; out.texts.push({ client: business, track: 'customer_list', number: 1 }); }
  }

  if (JSON.stringify(nudges) !== JSON.stringify(r.nudges_sent || {})) patch.nudges_sent = nudges;
  if (Object.keys(patch).length) await sb(`${TABLE}?id=eq.${r.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST' && !isCron(req)) return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    // Launched clients are done with setup. Anything older than 45 days is churn-check's job.
    const since = new Date(Date.now() - 45 * 24 * HOUR).toISOString();
    const rows = await sb(`${TABLE}?a2p_registered_at=is.null&created_at=gte.${encodeURIComponent(since)}&select=*&order=created_at.desc&limit=300`);
    const host = req.headers?.host || 'buildboosters.com';
    const origin = `${host.includes('localhost') ? 'http' : 'https'}://${host}`;
    const out = { texts: [], credits: [], basics: [], failed: [] };
    const now = Date.now();
    for (const r of rows) {
      try { await check(r, now, origin, out); }
      catch (e) { out.failed.push({ client: r.code.slice(0, 8), track: 'check', reason: e.message }); }
    }
    return res.status(200).json({ ok: true, checked: rows.length, ...out });
  } catch (e) {
    console.error('form-check', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};

// Exported for testing
Object.assign(module.exports, { openTracks, due, launchChecklist, easternHour, TEXTS });
