// /api/change-requests — the client portal reads and writes change requests here.
//
// Auth: the client's onboarding code in the x-client-code header. This is the same code from their
// setup link, so they are already authenticated by having it.
//
// GET  /api/change-requests?code=...        → list of their requests, newest first
// POST /api/change-requests?code=...        → create a new request
//   body: { category, body, location?, photos?: string[] }
//   photos is an array of base64-encoded JPEG strings. Each photo is stored in the client-photos
//   bucket under change-requests/{request_id}/. Max 20 photos per request, 3MB each.
//
// Internal (BB_INTERNAL_SECRET):
// PATCH /api/change-requests?id=...         → update status and status_note
// GET   /api/change-requests?all=true       → all requests across all clients (for the dashboard)
const { sb, allowed, configured, cors } = require('./_sb');

const CODE = /^[a-f0-9]{16,64}$/i;
const UUID = /^[0-9a-f-]{36}$/i;
const CATEGORIES = ['text', 'photos', 'hours', 'phone', 'address', 'services', 'areas', 'promo', 'google', 'domain', 'other'];
const STATUSES = ['sent', 'working', 'done', 'closed'];
const BUCKET = 'client-photos';
const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 3000000;

// Store one photo into the client-photos bucket under change-requests/{requestId}/
async function storePhoto(clientId, requestId, base64) {
  const bytes = Buffer.from(String(base64), 'base64');
  if (bytes.length < 3 || bytes.length > MAX_PHOTO_BYTES) return null;
  const baseUrl = String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
  const key = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const name = `${clientId}/change-requests/${requestId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.jpg`;
  const res = await fetch(`${baseUrl}/storage/v1/object/${BUCKET}/${name}`, {
    method: 'POST', body: bytes,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
  });
  return res.ok ? name : null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;
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
      const photos = Array.isArray(b.photos) ? b.photos.filter(p => typeof p === 'string' && p.length > 100).slice(0, MAX_PHOTOS) : [];

      // Create the request first to get its ID for the photo storage path
      const saved = await sb('change_requests', {
        method: 'POST',
        body: JSON.stringify({
          client_id: client.id,
          category,
          body,
          location: location || null,
          photo_count: photos.length,
        }),
      });
      const request = saved[0] || {};

      // Store photos if any were sent as base64
      if (photos.length > 0 && request.id) {
        let stored = 0;
        for (const photo of photos) {
          try {
            const path = await storePhoto(client.id, request.id, photo);
            if (path) stored++;
          } catch (e) {
            console.error('change-requests: photo store failed:', e.message);
          }
        }
        // Update the actual count of successfully stored photos
        if (stored !== photos.length) {
          await sb(`change_requests?id=eq.${request.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ photo_count: stored }),
          }).catch(() => {});
        }
      }

      return res.status(201).json({ ok: true, request });
    }

    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('change-requests', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
