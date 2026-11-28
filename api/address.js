// /api/address — looks up a real street address through Google Maps, for texting registration.
//
// The carriers reject a registration whose address is a P.O. box, so the welcome page and the setup
// form make the client pick a real street address from Google's list.
//
// GET /api/address?q=1420+sw+8th        up to 5 matching street addresses: [{ id, text }]
// GET /api/address?id=<place id>        that address split into street, city, state and zip, plus a
//                                       check: 'ok', 'po_box', 'no_street_number' or 'mailbox_store'
//
// Both take an optional s=<token>, the same value for one person's typing session, so Google bills
// the whole lookup as one request.
//
// No auth (the public pages call this). Needs GOOGLE_PLACES_KEY in Vercel, the same key
// /api/business-lookup uses. The mailbox-store check also needs the Address Validation API switched
// on for that key in Google Cloud. Without it the lookup still works and that one check is skipped.

const PO_BOX = /\b(p\.?\s*o\.?\s*b(ox)?\.?|post\s+office\s+box|pob)\s*#?\s*\d+/i;
const isPoBox = (text) => PO_BOX.test(String(text || ''));

const key = () => String(process.env.GOOGLE_PLACES_KEY || '').trim();
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;

// Turns Google's address parts into the four pieces the registration asks for.
function parseComponents(components) {
  const get = (type, short) => {
    const c = (components || []).find((x) => (x.types || []).includes(type));
    return c ? String(short ? c.short_name : c.long_name || '') : '';
  };
  const number = get('street_number');
  const route = get('route', true) || get('route');
  const unit = get('subpremise');
  const street = [number, route].filter(Boolean).join(' ') + (unit ? ` #${unit.replace(/^#/, '')}` : '');
  return {
    street: street.trim(),
    has_number: !!number,
    city: get('locality') || get('sublocality') || get('postal_town') || get('neighborhood') || get('administrative_area_level_3'),
    state: get('administrative_area_level_1', true),
    zip: get('postal_code'),
  };
}

// What the page should do with an address. usps is Google's USPS data for it, when there is any.
function judge(parts, formatted, usps) {
  if (isPoBox(formatted) || isPoBox(parts.street) || (usps && usps.addressRecordType === 'P')) return 'po_box';
  if (!parts.has_number || !parts.street) return 'no_street_number';
  if (usps && usps.dpvCmra === 'Y') return 'mailbox_store';
  return 'ok';
}

async function getJson(url, options, ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms || 4000);
  try {
    const r = await fetch(url, { ...(options || {}), signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

async function suggest(q, token) {
  const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?types=address&components=country:us'
    + `&input=${encodeURIComponent(q)}${token ? `&sessiontoken=${token}` : ''}&key=${key()}`;
  const data = await getJson(url);
  if (!data || (data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) return null;
  return (data.predictions || []).slice(0, 5).map((p) => ({ id: p.place_id, text: String(p.description || '').replace(/, USA$/, '') }));
}

// USPS data for one address, or null when the Address Validation API is off, slow or has nothing.
async function uspsData(formatted) {
  const data = await getJson(`https://addressvalidation.googleapis.com/v1:validateAddress?key=${key()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address: { regionCode: 'US', addressLines: [formatted] }, enableUspsCass: true }),
  }, 2500);
  return (data && data.result && data.result.uspsData) || null;
}

async function details(id, token) {
  const url = 'https://maps.googleapis.com/maps/api/place/details/json?fields=address_component,formatted_address'
    + `&place_id=${encodeURIComponent(id)}${token ? `&sessiontoken=${token}` : ''}&key=${key()}`;
  const data = await getJson(url);
  if (!data || data.status !== 'OK' || !data.result) return null;
  const formatted = String(data.result.formatted_address || '').replace(/, USA$/, '');
  const parts = parseComponents(data.result.address_components);
  const usps = await uspsData(formatted);
  const check = judge(parts, formatted, usps);
  return { formatted, street: parts.street, city: parts.city, state: parts.state, zip: parts.zip, check, usps_checked: !!usps };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); return res.status(405).json({ error: 'method_not_allowed' }); }
  // The page falls back to a typed address when the lookup is not available, so this is a 200.
  if (!key()) return res.status(200).json({ available: false, reason: 'not_configured' });

  const token = TOKEN.test(String(req.query.s || '')) ? String(req.query.s) : '';
  const id = String(req.query.id || '').trim();
  const q = String(req.query.q || '').trim().slice(0, 120);

  if (id) {
    if (!/^[A-Za-z0-9_-]{10,300}$/.test(id)) return res.status(400).json({ error: 'bad_request' });
    const found = await details(id, token);
    if (!found) return res.status(200).json({ available: false, reason: 'lookup_failed' });
    return res.status(200).json({ available: true, address: found });
  }
  if (q.length < 4) return res.status(200).json({ available: true, results: [] });
  if (isPoBox(q)) return res.status(200).json({ available: true, results: [], check: 'po_box' });
  const results = await suggest(q, token);
  if (!results) return res.status(200).json({ available: false, reason: 'lookup_failed' });
  return res.status(200).json({ available: true, results });
};

module.exports.isPoBox = isPoBox;
module.exports.parseComponents = parseComponents;
module.exports.judge = judge;
