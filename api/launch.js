// /api/launch — every client's launch stage in one list, for the Build Boosters dashboard.
// GET returns the clients and the recent A2P emails. POST takes two small actions:
//   { action: 'approve', id }      mark a client's texting registration approved by hand (same effect as the email)
//   { action: 'dismiss', event }   clear a "needs a look" email once it has been dealt with
//   { action: 'sales_notes', id, text }  save the client's goals from the sales call
//   { action: 'upsell_seo', id }   text the client an offer of monthly SEO work, once
// Internal only: needs BB_INTERNAL_SECRET in the x-bb-secret header. Never returns an EIN.
const { sb, allowed, configured } = require('./_sb');
const { textClient } = require('./_text');
const UUID = /^[0-9a-f-]{36}$/i;

// The one text the "Upsell SEO" button sends. It asks a question and carries no link, because an
// existing client moves plans through Maddie and never through a new payment link.
function seoOfferText(first, business, city) {
  const hi = first ? `Hey ${first}, it's Maddie from Build Boosters.` : `Hey, it's Maddie from Build Boosters.`;
  const who = business || 'your business';
  const where = city ? ` in ${city}` : '';
  return `${hi} I can get ${who} showing up for more Google searches${where} with monthly SEO work on your site. Want me to send over what that would look like?`;
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
      // The "Upsell SEO" button on the dashboard. Sends one text asking whether they want to hear about
      // monthly SEO work, and stamps the time so the button cannot send it twice.
      if (b.action === 'upsell_seo' && UUID.test(String(b.id))) {
        const found = await sb(`client_onboarding?id=eq.${b.id}&select=owner_first_name,prefill,answers,addons&limit=1`);
        if (!found.length) return res.status(404).json({ error: 'not_found' });
        const r = found[0];
        const addons = r.addons || {};
        if (addons.seo_upsell_sent_at) return res.status(200).json({ ok: true, already_sent: addons.seo_upsell_sent_at });
        const a = { ...(r.prefill || {}), ...(r.answers || {}) };
        const phone = a.cell || a.business_phone || '';
        const message = seoOfferText(r.owner_first_name, a.business_name, a.primary_city || a.city);
        // Stamp first: if the addons column is missing this fails before any text goes out.
        await sb(`client_onboarding?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ addons: { ...addons, seo_upsell_sent_at: new Date().toISOString() } }) });
        const sent = await textClient(phone, message, r.owner_first_name || 'Client');
        if (!sent.sent) {
          await sb(`client_onboarding?id=eq.${b.id}`, { method: 'PATCH', body: JSON.stringify({ addons }) });
          return res.status(502).json({ error: 'text_not_sent', reason: sent.reason });
        }
        return res.status(200).json({ ok: true, sent: true });
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
        tier: r.tier || '', created_at: r.created_at, seo_upsell_sent_at: (r.addons || {}).seo_upsell_sent_at || null,
        addons_paid: Object.keys(r.addons || {}).filter((k) => r.addons[k] && r.addons[k].paid_at), launch_call_start: r.launch_call_start || null,
        form_done: !!r.submitted_at, google_requested: !!r.google_requested_at, google_approved: !!r.google_approved_at,
        photo_count: r.photo_count || 0, sms_consent: !!r.sms_consent_at, ein_on_file: !!r.ein_private,
        a2p_status: r.a2p_status || '', a2p_status_at: r.a2p_status_at || null, a2p_reason: r.a2p_reason || '',
        a2p_approved_at: r.a2p_registered_at || null, site_rebuild_requested_at: r.site_rebuild_requested_at || null,
        has_location_id: !!r.ghl_location_id, has_deploy_hook: !!r.site_deploy_hook,
        credit_30: !!r.credit_30_earned_at, built_with_basics: !!r.site_final_basics_at, launch_checklist: r.launch_checklist || [],
        // For the launch deck on the dashboard
        logo_url: a.logo_url || '', site_domain: r.site_domain || '', site_built: !!r.site_created_at, goals: a.sales_notes || a.goals || '',
        services: Array.isArray(a.services) ? a.services : [], areas: Array.isArray(a.areas) ? a.areas : [],
        business_number: r.ghl_phone_number || '', reviews_connected: !!r.ghl_review_widget_id, brand_color: a.brand_color || '',
      };
    });
    return res.status(200).json({ clients, events });
  } catch (e) {
    console.error('launch', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

module.exports.seoOfferText = seoOfferText;
