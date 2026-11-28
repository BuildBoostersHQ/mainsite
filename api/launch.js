// /api/launch — every client's launch stage in one list, for the Build Boosters dashboard.
// GET returns the clients and the recent A2P emails. Each client has a status_note (one plain sentence on
// where they stand) and needs_attention (true when that sentence is something Maddie has to act on).
// POST takes these small actions:
//   { action: 'approve', id }      mark a client's texting registration approved by hand (same effect as the email)
//   { action: 'dismiss', event }   clear a "needs a look" email once it has been dealt with
//   { action: 'sales_notes', id, text }  save the client's goals from the sales call
// Internal only: needs BB_INTERNAL_SECRET in the x-bb-secret header. Never returns an EIN.
const { sb, allowed, configured } = require('./_sb');
const UUID = /^[0-9a-f-]{36}$/i;
const DAY = 86400000, HOUR = 3600000;
const cleanDomain = (raw) => String(raw || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
const A2P_WORDS = { brand: 'brand', campaign: 'campaign', registration: 'registration', approved: 'approved', pending: 'in review', rejected: 'rejected' };

// Where one client stands, in one plain sentence for Maddie, worked out only from the client's own row.
// Every open item is collected in the order below. The note is the first one Maddie has to act on, or the
// first thing being waited on when nothing needs her. `needs_attention` is true when the note is one she
// has to act on. `r` is a client_onboarding row. `now` is passed in so the answer can be tested.
function statusNote(r, now = Date.now()) {
  r = r || {};
  const a = { ...(r.prefill || {}), ...(r.answers || {}) };
  const texting = !/^website/i.test(String(r.tier || '').trim());   // website-only clients have no texting registration
  const since = (iso) => (iso ? now - new Date(iso).getTime() : 0);
  const days = Math.floor(since(r.created_at) / DAY);
  const ago = days <= 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
  const started = Object.keys(r.answers || {}).length > 0 || !!r.google_requested_at || !!r.text_link_requested_at || (r.photo_count || 0) > 0 || !!r.ein_private;
  const formIn = !!r.submitted_at;
  const basics = !!r.site_final_basics_at;   // no form after 72 hours, so the site was built from their Google profile
  const items = [];
  const add = (note, act) => items.push({ status_note: note, needs_attention: !!act });

  // 1 and 2: the setup page. The automatic reminders cover the first two days, then it is Maddie's turn.
  if (!formIn && !started) add(`They paid ${ago} and nothing is saved on their setup page yet.`, days >= 2);
  else if (!formIn) add(`They started their setup page and have not sent it yet. They paid ${ago}.`, days >= 2);

  // 3: Google access. Once the client says they sent it, Maddie has to accept it and fill in google_approved_at.
  if (!r.google_approved_at) {
    if (r.google_requested_at) add('They say they added you on Google. Accept the invite and mark their Google access approved.', true);
    else if (formIn || basics) add('Waiting on the client to give you access to their Google profile.', false);
  }

  const status = String(r.a2p_status || '');
  if (texting && !r.a2p_registered_at) {
    // 4: texting registration not submitted. No news from HighLevel means nothing has been sent in yet.
    if (!status && formIn) {
      if (!r.ghl_location_id) add('Their texting registration cannot be submitted yet because they have no HighLevel sub-account.', true);
      else add('Their texting registration has not been submitted yet.', true);
    }
    // 5: texting registration rejected, with the reason HighLevel gave.
    if (/_rejected$/.test(status)) {
      const reason = String(r.a2p_reason || '').trim().replace(/[.\s]+$/, '');
      add(reason ? `Their texting registration was rejected. The reason given was: ${reason}.` : 'Their texting registration was rejected and no reason was saved.', true);
    }
  }

  // 6: the site build. It starts on its own when the form comes in, and site_created_at is set when it finishes.
  if ((formIn || basics) && !r.site_created_at) {
    if (r.site_repo) add('The site build started and stopped before it finished.', true);
    else if (since(r.submitted_at) < HOUR && formIn) add('Their setup form is in and the site is building.', false);
    else add('Their setup form is in and the site build has not started.', true);
  }

  // 7: the domain. site_domain is filled in when a domain is registered for them or their own one points at the site.
  const own = cleanDomain(a.domain_own);
  if (r.site_created_at) {
    if (own && cleanDomain(r.site_domain) !== own) add(`Their own domain ${own} is not pointing at the site yet.`, false);
    else if (!r.site_domain) add('The site is built and has no domain on it yet.', true);
  }

  // 8: waiting on texting approval.
  if (texting && !r.a2p_registered_at && status && !/_rejected$/.test(status)) {
    const [kind, state] = status.split('_');
    const words = A2P_WORDS[kind] && A2P_WORDS[state] ? ` The last update was ${A2P_WORDS[kind]} ${A2P_WORDS[state]}.` : '';
    add(`Waiting on texting approval.${words}`, false);
  }

  if (items.length) return items.find((i) => i.needs_attention) || items[0];

  // 9 and 10: nothing is open. Before the launch call they are ready for it, and after it they are live.
  const call = r.launch_call_start ? new Date(r.launch_call_start).getTime() : NaN;
  if (Number.isFinite(call) && call <= now) return { status_note: 'They are live and the launch call is done.', needs_attention: false };
  if (Number.isFinite(call) || r.launch_call_at) return { status_note: 'Everything is done and they are ready for the launch call.', needs_attention: false };
  return { status_note: 'Everything is done and they are ready for a launch call, and no call time is saved yet.', needs_attention: true };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      if (b.action === 'approve' && UUID.test(String(b.id))) {
        const now = new Date().toISOString();
        await sb(`client_onboarding?id=eq.${b.id}&a2p_registered_at=is.null`, { method: 'PATCH', body: JSON.stringify({ a2p_registered_at: now, a2p_status: 'campaign_approved', a2p_status_at: now, a2p_reason: '' }) });
        return res.status(200).json({ ok: true });
      }
      if (b.action === 'dismiss' && UUID.test(String(b.event))) {
        await sb(`a2p_events?id=eq.${b.event}`, { method: 'PATCH', body: JSON.stringify({ needs_look: false }) });
        return res.status(200).json({ ok: true });
      }
      // Goals from the sales call, saved on the client's record so the launch deck fills itself in.
      if (b.action === 'sales_notes' && UUID.test(String(b.id))) {
        const found = await sb(`client_onboarding?id=eq.${b.id}&select=prefill&limit=1`);
        if (!found.length) return res.status(404).json({ error: 'not_found' });
        const prefill = { ...(found[0].prefill || {}), sales_notes: String(b.text || '').slice(0, 2000) };
        await sb(`client_onboarding?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ prefill }) });
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: 'bad_request' });
    }
    if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
    const [rows, events] = await Promise.all([
      sb('client_onboarding?select=*&order=created_at.desc&limit=500'),
      sb('a2p_events?select=id,sent_at,received_at,from_address,subject,client_id,registration_type,status,reason,needs_look,acted&order=received_at.desc&limit=60'),
    ]);
    const clients = rows.map((r) => {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      return {
        id: r.id, code: r.code, first_name: r.owner_first_name || '', business: a.business_name || '', trade: a.trade || '',
        tier: r.tier || '', created_at: r.created_at, launch_call_start: r.launch_call_start || null,
        form_done: !!r.submitted_at, google_requested: !!r.google_requested_at, google_approved: !!r.google_approved_at,
        photo_count: r.photo_count || 0, sms_consent: !!r.sms_consent_at, ein_on_file: !!r.ein_private,
        a2p_status: r.a2p_status || '', a2p_status_at: r.a2p_status_at || null, a2p_reason: r.a2p_reason || '',
        a2p_approved_at: r.a2p_registered_at || null, site_rebuild_requested_at: r.site_rebuild_requested_at || null,
        has_location_id: !!r.ghl_location_id, has_deploy_hook: !!r.site_deploy_hook,
        credit_30: !!r.credit_30_earned_at, setup_credit: r.setup_credit_amount || (r.credit_30_earned_at ? 30 : 0), setup_credit_applied: !!r.setup_credit_applied_at, setup_done_at: r.setup_done_at || null, built_with_basics: !!r.site_final_basics_at, launch_checklist: r.launch_checklist || [],
        // For the launch deck on the dashboard
        logo_url: a.logo_url || '', site_domain: r.site_domain || '', site_built: !!r.site_created_at, goals: a.sales_notes || a.goals || '',
        services: Array.isArray(a.services) ? a.services : [], areas: Array.isArray(a.areas) ? a.areas : [],
        business_number: r.ghl_phone_number || '', reviews_connected: !!r.ghl_review_widget_id, brand_color: a.brand_color || '',
        // Where they stand in plain words, and whether Maddie has to do something about it
        ...statusNote(r),
      };
    });
    return res.status(200).json({ clients, events });
  } catch (e) {
    console.error('launch', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
module.exports.statusNote = statusNote;
