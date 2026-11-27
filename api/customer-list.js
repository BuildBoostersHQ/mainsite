// /api/customer-list — a client uploads their past customers from the portal on their website.
//
// Client (their setup code, same as the rest of the portal):
//   GET  /api/customer-list?code=...   → what is on file: { uploaded_at, kept, loaded_to_ghl, ... } or { uploaded: false }
//   POST /api/customer-list?code=...   → { csv: "<the file's text>" }
//     Reads the CSV, cleans it (finds the name, phone and email columns, fixes phone numbers, drops
//     rows with no way to reach the person, drops duplicates), saves the clean list in the private
//     client-photos bucket at {client_id}/customers/list.json, and loads the contacts into the
//     client's HighLevel sub-account tagged "past customer".
//
// Internal (BB_INTERNAL_SECRET):
//   POST /api/customer-list?code=...   → { action: "load" }  loads the saved list into HighLevel again,
//     for a client who uploaded before their sub-account existed.
//
// Nothing is texted from here. The free reactivation text is sent by Maddie from the sub-account
// once the client's texting registration is approved, and she gets an alert when a list arrives.
const { sb, allowed, configured, cors } = require('./_sb');
const { sendAlert } = require('./alert');

const TABLE = 'client_onboarding';
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const BUCKET = 'client-photos';
const MAX_ROWS = 5000;
const MAX_GHL = 2000;
const GHL = 'https://services.leadconnectorhq.com';
const TAGS = ['past customer', 'bb-import'];

// A small CSV reader that handles quoted fields, commas inside quotes, and tab or semicolon files.
function parseCsv(text) {
  const src = String(text || '').replace(/^﻿/, '');
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const delim = [',', '\t', ';'].sort((x, y) => firstLine.split(y).length - firstLine.split(x).length)[0];
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delim) { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows.map((r) => r.map((c) => c.trim()));
}

const phoneOf = (v) => { const d = String(v || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); return d.length === 10 && /^[2-9]/.test(d) ? d : ''; };
const emailOf = (v) => { const e = String(v || '').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : ''; };
const tidyName = (v) => String(v || '').replace(/\s+/g, ' ').trim().split(' ').map((w) => (w === w.toUpperCase() || w === w.toLowerCase()) && w.length > 1 ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w).join(' ');

// Works out which column is which from the header row, or from the data when there is no header.
function mapColumns(rows) {
  const head = rows[0].map((h) => h.toLowerCase());
  const find = (re, not) => head.findIndex((h) => re.test(h) && !(not && not.test(h)));
  const hasHeader = head.some((h) => /name|phone|mobile|cell|email|customer|client|address/.test(h)) && !head.some((h) => phoneOf(h) || emailOf(h));
  if (hasHeader) {
    return {
      hasHeader,
      first: find(/first/), last: find(/last|surname/),
      full: find(/^(full ?)?name$|customer|client|contact|display/, /first|last|company|business|phone|email/),
      phone: [find(/mobile|cell/), find(/phone|tel|number/, /mobile|cell|fax|account|invoice|job/)].filter((i) => i >= 0),
      email: find(/e-?mail/), address: find(/address|street/, /e-?mail/),
    };
  }
  // No header: look at the first rows and pick the columns that mostly hold phones and emails.
  const sample = rows.slice(0, 25), width = Math.max(...sample.map((r) => r.length));
  const score = (fn) => { let best = -1, top = 0; for (let c = 0; c < width; c++) { const n = sample.filter((r) => fn(r[c])).length; if (n > top) { top = n; best = c; } } return top >= sample.length / 2 ? best : -1; };
  const phone = score(phoneOf), email = score(emailOf);
  const full = [...Array(width).keys()].find((c) => c !== phone && c !== email && sample.filter((r) => /^[A-Za-z][A-Za-z .,'&-]+$/.test(r[c] || '')).length >= sample.length / 2);
  return { hasHeader, first: -1, last: -1, full: full === undefined ? -1 : full, phone: phone >= 0 ? [phone] : [], email, address: -1 };
}

function clean(csv) {
  const rows = parseCsv(csv);
  if (!rows.length) return { customers: [], stats: { rows: 0, kept: 0, no_contact: 0, duplicates: 0, over_limit: 0 } };
  const cols = mapColumns(rows);
  const data = cols.hasHeader ? rows.slice(1) : rows;
  const seen = new Set(), customers = [];
  let noContact = 0, duplicates = 0;
  for (const r of data.slice(0, MAX_ROWS)) {
    const at = (i) => (i >= 0 ? r[i] || '' : '');
    let first = tidyName(at(cols.first)), last = tidyName(at(cols.last));
    if (!first && !last && cols.full >= 0) {
      const full = at(cols.full);
      const parts = /,/.test(full) ? full.split(',').map((s) => s.trim()).reverse() : full.split(/\s+/);
      first = tidyName(parts[0]); last = tidyName(parts.slice(1).join(' '));
    }
    const phone = cols.phone.map((i) => phoneOf(r[i])).find(Boolean) || '';
    const email = emailOf(at(cols.email));
    if (!phone && !email) { noContact++; continue; }
    const key = phone || email;
    if (seen.has(key) || (phone && email && seen.has(email))) { duplicates++; continue; }
    seen.add(key); if (email) seen.add(email);
    customers.push({ first_name: first, last_name: last, phone, email, address: at(cols.address) });
  }
  return { customers, stats: { rows: data.length, kept: customers.length, no_contact: noContact, duplicates, over_limit: Math.max(0, data.length - MAX_ROWS) } };
}

const storage = () => ({
  base: String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, ''),
  key: String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim(),
});
async function saveList(clientId, payload) {
  const { base, key } = storage();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${clientId}/customers/list.json`, {
    method: 'POST', body: JSON.stringify(payload),
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'x-upsert': 'true' },
  });
  return res.ok;
}
async function readList(clientId) {
  const { base, key } = storage();
  const res = await fetch(`${base}/storage/v1/object/${BUCKET}/${clientId}/customers/list.json`, { headers: { apikey: key, Authorization: `Bearer ${key}` } });
  return res.ok ? res.json().catch(() => null) : null;
}

// Adds the customers to the client's sub-account, five at a time. Existing contacts are updated, not duplicated.
async function loadToGhl(locationId, customers) {
  const apiKey = (process.env.GHL_API_KEY || '').trim();
  if (!apiKey || !locationId) return { loaded: 0, failed: 0, skipped: customers.length, reason: !locationId ? 'no_sub_account' : 'not_configured' };
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const todo = customers.slice(0, MAX_GHL);
  let loaded = 0, failed = 0, next = 0;
  async function worker() {
    while (next < todo.length) {
      const c = todo[next++];
      try {
        const res = await fetch(`${GHL}/contacts/upsert`, {
          method: 'POST', headers,
          body: JSON.stringify({
            locationId, tags: TAGS, source: 'Customer list upload',
            ...(c.first_name ? { firstName: c.first_name } : {}), ...(c.last_name ? { lastName: c.last_name } : {}),
            ...(c.phone ? { phone: `+1${c.phone}` } : {}), ...(c.email ? { email: c.email } : {}), ...(c.address ? { address1: c.address } : {}),
          }),
        });
        if (res.ok) loaded++; else failed++;
      } catch { failed++; }
    }
  }
  await Promise.all([1, 2, 3, 4, 5].map(worker));
  return { loaded, failed, skipped: customers.length - todo.length };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (cors(req, res)) return;
  if (!configured()) return res.status(500).json({ error: 'not_configured' });
  try {
    const code = String(req.query?.code || req.headers?.['x-client-code'] || '').trim();
    if (!CODE.test(code)) return res.status(401).json({ error: 'unauthorized' });
    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=id,owner_first_name,prefill,answers,ghl_location_id,a2p_registered_at&limit=1`);
    const client = rows[0];
    if (!client) return res.status(401).json({ error: 'unauthorized' });
    const a = { ...(client.prefill || {}), ...(client.answers || {}) };
    const business = a.business_name || client.owner_first_name || code.slice(0, 8);

    if (req.method === 'GET') {
      const list = await readList(client.id);
      if (!list) return res.status(200).json({ uploaded: false });
      return res.status(200).json({ uploaded: true, uploaded_at: list.uploaded_at, ...list.stats, loaded_to_ghl: list.ghl?.loaded || 0 });
    }
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    const b = req.body || {};

    // Internal: load a saved list into the sub-account again.
    if (b.action === 'load') {
      if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
      const list = await readList(client.id);
      if (!list) return res.status(404).json({ error: 'no_list' });
      list.ghl = await loadToGhl(client.ghl_location_id, list.customers || []);
      await saveList(client.id, list);
      return res.status(200).json({ ok: true, ...list.stats, ghl: list.ghl });
    }

    const csv = String(b.csv || '');
    if (csv.length < 5) return res.status(400).json({ error: 'empty_file' });
    if (csv.length > 4000000) return res.status(413).json({ error: 'file_too_large' });
    const { customers, stats } = clean(csv);
    if (!customers.length) return res.status(400).json({ error: 'no_customers_found', ...stats });

    const ghl = await loadToGhl(client.ghl_location_id, customers);
    const saved = await saveList(client.id, { uploaded_at: new Date().toISOString(), stats, ghl, customers });
    if (!saved) return res.status(500).json({ error: 'save_failed' });

    const where = ghl.loaded ? `${ghl.loaded} are in their sub-account tagged "past customer"` : 'They are saved but not in HighLevel yet';
    const ready = client.a2p_registered_at ? 'Texting is approved, so the free reactivation text can go out.' : 'Hold the free reactivation text until their texting is approved.';
    await sendAlert('Customer list uploaded', `${business} sent ${stats.kept} customers. ${where}. ${ready}`).catch(() => {});

    return res.status(200).json({ ok: true, ...stats, loaded_to_ghl: ghl.loaded });
  } catch (e) {
    console.error('customer-list', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
Object.assign(module.exports, { parseCsv, clean });
