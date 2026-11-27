// /api/change-requests — the client portal reads and writes change requests here.
//
// Auth: the client's onboarding code in the x-client-code header. This is the same code from their
// setup link, so they are already authenticated by having it.
//
// GET  /api/change-requests?code=...        → list of their requests, newest first
// POST /api/change-requests?code=...        → create a new request
//   body: { category, body, location?, photo_keys?: string[] }
//   photo_keys reference photos already uploaded through the onboarding photo endpoint.
//
// Internal (BB_INTERNAL_SECRET):
// PATCH /api/change-requests?id=...         → update status and status_note
// GET   /api/change-requests?all=true       → all requests across all clients (for the dashboard)
const { sb, allowed, configured } = require('./_sb');

const CODE = /^[a-f0-9]{16,64}$/i;
const UUID = /^[0-9a-f-]{36}$/i;
const CATEGORIES = ['text', 'photos', 'hours', 'phone', 'address', 'services', 'areas', 'promo', 'google', 'domain', 'other'];
const STATUSES = ['sent', 'working', 'done', 'closed'];

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!configured()) return res.status(500).json({ error: 'not_configured' });

  try {
    // Internal: update status or list all
    if (allowed(req)) {
      if (req.method === 'PATCH') {
        const id = String(req.query?.id || '').trim();
        if (!UUID.test(id)) return res.status(400).json({ error: 'bad_id' });
        const { status, status_note } = req.body || {};
        if (!STATUSES.includes(status)) return res.status(400).json({ error: 'bad_status' });
        const patch = { status, updated_at: new Date().toISOString() };
        if (typeof status_note === 'string') patch.status_note = status_note.slice(0, 500);
        await sb(`change_requests?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(patch) });
        return res.status(200).json({ ok: true });
      }
      if (req.method === 'GET' && req.query?.all === 'true') {
        const rows = await sb('change_requests?select=*,client_onboarding(code,prefill,answers)&order=created_at.desc&limit=200');
        const out = rows.map(r => {
          const a = { ...(r.client_onboarding?.prefill || {}), ...(r.client_onboarding?.answers || {}) };
          return { ...r, business: a.business_name || '', client_onboarding: undefined };
        });
        return res.status(200).json({ requests: out });
      }
    }

    // Client: authenticate by code
    const code = String(req.query?.code || req.headers?.['x-client-code'] || '').trim();
    if (!CODE.test(code)) return res.status(401).json({ error: 'unauthorized' });
    const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=id,owner_first_name&limit=1`);
    if (!rows.length) return res.status(401).json({ error: 'unauthorized' });
    const client = rows[0];

    if (req.method === 'GET') {
      const requests = await sb(`change_requests?client_id=eq.${client.id}&order=created_at.desc&limit=50`);
      return res.status(200).json({ first_name: client.owner_first_name || '', requests });
    }

    if (req.method === 'POST') {
      const b = req.body || {};
      const body = String(b.body || '').trim().slice(0, 2000);
      if (!body) return res.status(400).json({ error: 'body_required' });
      const category = CATEGORIES.includes(b.category) ? b.category : 'other';
      const location = typeof b.location === 'string' ? b.location.trim().slice(0, 200) : '';
      const photoKeys = Array.isArray(b.photo_keys) ? b.photo_keys.filter(k => typeof k === 'string').slice(0, 20) : [];
      const saved = await sb('change_requests', {
        method: 'POST',
        body: JSON.stringify({
          client_id: client.id,
          category,
          body,
          location: location || null,
          photo_count: photoKeys.length,
        }),
      });
      return res.status(201).json({ ok: true, request: saved[0] || {} });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('change-requests', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
