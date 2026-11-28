// /api/client-secret — a one-time page where a client hands over a key (Housecall Pro, Jobber or other)
// instead of texting it. The page is buildboosters.com/key/<token>.
//
// Internal (BB_INTERNAL_SECRET in the x-bb-secret header):
//   POST /api/client-secret  { action: "create", code, label, note }
//     Makes a request for that client and returns { link: "https://buildboosters.com/key/<token>", expires_at }.
//     `label` is whose key it is in plain words ("Housecall Pro"). The page says "your Housecall Pro key".
//   GET  /api/client-secret?action=read&code=...&label=...
//     Returns the decrypted key, for server-side use only: { value, label, used_at }.
//
// Public (the token in the link is the only way in):
//   GET  /api/client-secret?token=...   → { first_name, label, note, state }  state is open, used or expired
//   POST /api/client-secret?token=...   → { value }  saves the key once and closes the link
//
// The key is encrypted with AES-256-GCM before it is saved, using BB_SECRETS_KEY from Vercel (32 random
// bytes, base64). It is never sent back to the page, never logged and never put in an alert. With no
// BB_SECRETS_KEY nothing is stored at all.
const crypto = require('crypto');
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const TABLE = 'client_secret_requests';
const CLIENTS = 'client_onboarding';
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const TOKEN = /^[A-Za-z0-9_-]{32,64}$/;
const MAX_VALUE = 4000;
const NO_KEY = 'BB_SECRETS_KEY is not set in Vercel, or it is not 32 bytes in base64. Nothing was stored.';

// The encryption key from the env var, or null when it is missing or the wrong size.
function secretsKey(raw = process.env.BB_SECRETS_KEY) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const key = Buffer.from(s, 'base64');
  return key.length === 32 ? key : null;
}

// `bind` ties the encrypted value to the request it belongs to, so it cannot be moved to another row and read.
function encrypt(value, key, bind = '') {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(bind)));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') };
}

// Throws when the key is wrong or anything was changed after it was saved.
function decrypt(parts, key, bind = '') {
  const tag = Buffer.from(String(parts.tag || ''), 'base64');
  if (tag.length !== 16) throw new Error('bad tag');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(String(parts.iv || ''), 'base64'));
  decipher.setAAD(Buffer.from(String(bind)));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(Buffer.from(String(parts.ciphertext || ''), 'base64')), decipher.final()]).toString('utf8');
}

// open, used or expired. A used link stays "used" after its expiry date so the client sees the right message.
function stateOf(row, now = Date.now()) {
  if (row.used_at) return 'used';
  const expires = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expires) || expires <= now) return 'expired';
  return 'open';
}

// Trims what the client pasted and says why it cannot be kept, if it cannot.
function cleanValue(input) {
  if (typeof input !== 'string') return { error: 'value_required' };
  const value = input.trim();
  if (!value) return { error: 'value_required' };
  if (value.length > MAX_VALUE) return { error: 'value_too_long' };
  return { value };
}

// "Housecall Pro API key" becomes "Housecall Pro", so the page can say "your Housecall Pro key".
function cleanLabel(input) {
  return String(input || '').replace(/\s+/g, ' ').trim().replace(/\s*\b(api\s*)?(key|token)s?$/i, '').trim().slice(0, 60);
}

const newToken = () => crypto.randomBytes(24).toString('base64url');

async function findClient(code) {
  return (await sb(`${CLIENTS}?code=eq.${encodeURIComponent(code)}&select=id,owner_first_name,prefill,answers&limit=1`))[0] || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (!configured()) return res.status(500).json({ error: 'not_configured' });
  try {
    const q = req.query || {};
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = null; } }
    b = b && typeof b === 'object' ? b : {};
    const token = String(q.token || '');

    // ---- Public: the client's page ----
    if (token) {
      if (!TOKEN.test(token)) return res.status(404).json({ error: 'not_found' });
      const row = (await sb(`${TABLE}?token=eq.${token}&select=id,client_id,label,note,expires_at,used_at&limit=1`))[0];
      if (!row) return res.status(404).json({ error: 'not_found' });
      const client = (await sb(`${CLIENTS}?id=eq.${row.client_id}&select=owner_first_name,prefill,answers&limit=1`))[0] || {};
      const a = { ...(client.prefill || {}), ...(client.answers || {}) };
      const first_name = client.owner_first_name || a.preferred_name || '';
      const state = stateOf(row);

      if (req.method === 'GET') return res.status(200).json({ first_name, label: row.label || '', note: row.note || '', state });
      if (req.method !== 'POST') { res.setHeader('Allow', 'GET, POST'); return res.status(405).json({ error: 'method_not_allowed' }); }

      if (state !== 'open') return res.status(410).json({ error: state === 'used' ? 'already_used' : 'expired', state });
      const cleaned = cleanValue(b.value);
      if (cleaned.error) return res.status(400).json({ error: cleaned.error });
      const key = secretsKey();
      if (!key) { console.error('client-secret:', NO_KEY); return res.status(500).json({ error: 'secrets_key_missing', message: NO_KEY }); }

      const now = new Date().toISOString();
      const enc = encrypt(cleaned.value, key, row.id);
      // The filters make this single-use even if two tabs send at the same moment: only one of them finds the row still open.
      const saved = await sb(`${TABLE}?id=eq.${row.id}&used_at=is.null&expires_at=gt.${encodeURIComponent(now)}`, {
        method: 'PATCH', body: JSON.stringify({ used_at: now, value_iv: enc.iv, value_tag: enc.tag, value_ciphertext: enc.ciphertext }),
        headers: { Prefer: 'return=representation' },
      });
      if (!saved.length) return res.status(410).json({ error: 'already_used', state: 'used' });

      const business = a.business_name || first_name || 'A client';
      await sendAlert('Key received', `${business} sent their ${row.label} key. It is saved encrypted and the link is now closed.`).catch(() => {});
      return res.status(200).json({ ok: true, state: 'used' });
    }

    // ---- Internal: make a link, or read a key back ----
    if (!process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
    if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'POST') {
      if (b.action !== 'create') return res.status(400).json({ error: 'bad_request' });
      const code = String(b.code || '');
      const label = cleanLabel(b.label);
      if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });
      if (!label) return res.status(400).json({ error: 'label_required' });
      // No point sending a client a link that cannot save what they paste.
      if (!secretsKey()) return res.status(500).json({ error: 'secrets_key_missing', message: NO_KEY });
      const client = await findClient(code);
      if (!client) return res.status(404).json({ error: 'not_found' });
      const made = await sb(TABLE, {
        method: 'POST',
        body: JSON.stringify({ client_id: client.id, label, note: String(b.note || '').trim().slice(0, 500) || null, token: newToken() }),
      });
      const row = made[0];
      return res.status(200).json({ ok: true, link: `https://buildboosters.com/key/${row.token}`, label: row.label, expires_at: row.expires_at });
    }

    if (req.method === 'GET') {
      if (q.action !== 'read') return res.status(400).json({ error: 'bad_request' });
      const code = String(q.code || '');
      const label = cleanLabel(q.label);
      if (!CODE.test(code) || !label) return res.status(404).json({ error: 'not_found' });
      const key = secretsKey();
      if (!key) return res.status(500).json({ error: 'secrets_key_missing', message: NO_KEY });
      const client = await findClient(code);
      if (!client) return res.status(404).json({ error: 'not_found' });
      // The newest key the client sent under that label.
      const rows = await sb(`${TABLE}?client_id=eq.${client.id}&used_at=not.is.null&select=id,label,used_at,value_iv,value_tag,value_ciphertext&order=used_at.desc&limit=50`);
      const row = rows.find((r) => String(r.label || '').toLowerCase() === label.toLowerCase());
      if (!row || !row.value_ciphertext) return res.status(404).json({ error: 'no_key_on_file' });
      let value;
      try { value = decrypt({ iv: row.value_iv, tag: row.value_tag, ciphertext: row.value_ciphertext }, key, row.id); }
      catch (e) { return res.status(500).json({ error: 'cannot_decrypt', message: 'The saved key could not be decrypted. BB_SECRETS_KEY may have changed since it was saved.' }); }
      return res.status(200).json({ ok: true, label: row.label, used_at: row.used_at, value });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    console.error('client-secret', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
Object.assign(module.exports, { secretsKey, encrypt, decrypt, stateOf, cleanValue, cleanLabel, newToken, MAX_VALUE });
