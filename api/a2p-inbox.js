// /api/a2p-inbox — takes the A2P registration emails HighLevel sends and turns them into action.
//
// A small script in the Gmail inbox posts new A2P emails here. Each one is saved to a2p_events, matched
// to a client, and read for three things: brand or campaign, the status, and the reason if it was rejected.
//   Campaign approved  -> a2p_registered_at is filled in, which deletes the EIN and rebuilds the site as full.
//   Rejected           -> saved on the client with the reason, and flagged on the launch dashboard.
//   Pending            -> saved, nothing else happens.
// Anything it cannot read or match is kept and flagged "needs a look". Nothing is ever dropped.
//
// Needs BB_INTERNAL_SECRET in Vercel, plus the two Supabase variables the onboarding API already uses.
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const SENDERS = () => String(process.env.A2P_SENDER_DOMAINS || 'gohighlevel.com,leadconnectorhq.com,msgsndr.com')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

function fromTrusted(from) {
  const m = /@([a-z0-9.-]+)/i.exec(String(from || ''));
  const host = m ? m[1].toLowerCase() : '';
  return SENDERS().some((d) => host === d || host.endsWith('.' + d));
}

// A first reading of the email. HighLevel can change its wording, so anything unclear comes back as
// 'unknown' and gets flagged instead of guessed at.
function read(subject, body) {
  const s = String(subject || '').toLowerCase();
  const all = `${s}\n${String(body || '').toLowerCase()}`;
  const has = (re, t) => re.test(t);
  let type = 'unknown';
  if (has(/campaign/, s)) type = 'campaign';
  else if (has(/brand/, s)) type = 'brand';
  else if (has(/campaign/, all) && !has(/brand/, all)) type = 'campaign';
  else if (has(/brand/, all) && !has(/campaign/, all)) type = 'brand';
  let status = 'unknown';
  if (has(/reject|declin|denied|not approved|unsuccessful|failed|could not be (verified|approved)/, all)) status = 'rejected';
  else if (has(/\bapproved\b|\bverified\b|successfully registered|is now active/, all)) status = 'approved';
  else if (has(/submitted|in review|under review|in progress|pending|has been received/, all)) status = 'pending';
  const r = /reason[s]?\s*(?:for (?:the )?rejection)?\s*[:\-]\s*([^\n]{3,300})/i.exec(String(body || ''));
  const loc = /(?:location[\/=]|locationId=|sub-?account id[:\s]+)([A-Za-z0-9]{18,24})/i.exec(String(body || ''));
  return { type, status, reason: r ? r[1].trim() : '', locationId: loc ? loc[1] : '' };
}

const nameOf = (row) => String({ ...(row.prefill || {}), ...(row.answers || {}) }.business_name || '').trim();

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const messages = Array.isArray(req.body && req.body.messages) ? req.body.messages.slice(0, 50) : [];
    const clients = await sb('client_onboarding?select=id,code,prefill,answers,ghl_location_id,a2p_registered_at&limit=1000');
    const out = [];
    for (const m of messages) {
      const gmailId = String(m.id || '').slice(0, 64);
      if (!gmailId) continue;
      const subject = String(m.subject || '').slice(0, 300);
      const body = String(m.body || '').slice(0, 8000);
      const from = String(m.from || '').slice(0, 200);
      const got = read(subject, body);
      const text = `${subject}\n${body}`.toLowerCase();
      // Match by sub-account id first. Fall back to the business name, and only when exactly one client fits.
      let hits = got.locationId ? clients.filter((c) => c.ghl_location_id === got.locationId) : [];
      if (!hits.length) hits = clients.filter((c) => { const n = nameOf(c).toLowerCase(); return n.length >= 4 && text.includes(n); });
      const client = hits.length === 1 ? hits[0] : null;
      const trusted = fromTrusted(from);
      const flips = !!client && trusted && got.type === 'campaign' && got.status === 'approved';
      const needsLook = !client || !trusted || got.status === 'unknown' || got.status === 'rejected' || (got.status === 'approved' && got.type === 'unknown');
      const saved = await sb('a2p_events?on_conflict=gmail_id', {
        method: 'POST',
        headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
        body: JSON.stringify({
          gmail_id: gmailId, sent_at: m.date || null, from_address: from, subject, body,
          client_id: client ? client.id : null, registration_type: got.type, status: got.status, reason: got.reason,
          needs_look: needsLook, acted: flips,
        }),
      });
      if (!saved.length) { out.push({ id: gmailId, result: 'already_seen' }); continue; }
      if (client && trusted && got.status !== 'unknown') {
        const patch = { a2p_status: `${got.type === 'unknown' ? 'registration' : got.type}_${got.status}`, a2p_status_at: new Date().toISOString(), a2p_reason: got.status === 'rejected' ? got.reason : '' };
        if (flips && !client.a2p_registered_at) {
          patch.a2p_registered_at = new Date().toISOString(); client.a2p_registered_at = patch.a2p_registered_at;
          // The database deletes the EIN at this point. The date of birth goes with it.
          if (client.answers && client.answers.a2p_dob) { const kept = { ...client.answers }; delete kept.a2p_dob; patch.answers = kept; client.answers = kept; }
        }
        await sb(`client_onboarding?id=eq.${client.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      }
      out.push({ id: gmailId, result: flips ? 'approved_site_going_full' : needsLook ? 'needs_look' : 'saved', type: got.type, status: got.status, matched: !!client });
    }
    // Alert Maddie about anything that needs her attention
    const looks = out.filter(r => r.result === 'needs_look');
    const approvals = out.filter(r => r.result === 'approved_site_going_full');
    if (looks.length) sendAlert('A2P emails need a look', `${looks.length} email${looks.length === 1 ? '' : 's'} could not be matched or read. Check the Launch page.`).catch(() => {});
    if (approvals.length) sendAlert('A2P approved', approvals.map(r => r.id).join(', ') + ' got campaign approval. Site is going full.').catch(() => {});
    return res.status(200).json({ ok: true, results: out });
  } catch (e) {
    console.error('a2p-inbox', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
module.exports.read = read;
