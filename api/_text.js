// Shared texting helper for the scheduled checks. Files that start with an underscore are not routes.
// Sends from the Build Boosters sub-account (GHL_API_KEY, GHL_LOCATION_ID in Vercel).
const GHL = 'https://services.leadconnectorhq.com';

function digits(phone) {
  return String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

// Finds the contact by phone, creating it when `name` is given and nobody is found, then sends the text.
async function textClient(phone, message, name) {
  const apiKey = (process.env.GHL_API_KEY || '').trim();
  const locationId = (process.env.GHL_LOCATION_ID || '').trim();
  if (!apiKey || !locationId) return { sent: false, reason: 'not_configured' };
  const d = digits(phone);
  if (d.length !== 10) return { sent: false, reason: 'bad_phone' };
  const fullPhone = `+1${d}`;
  const headers = { Authorization: `Bearer ${apiKey}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  try {
    const searchRes = await fetch(`${GHL}/contacts/search/duplicate?locationId=${locationId}&number=${encodeURIComponent(fullPhone)}`, { headers });
    let contactId = (await searchRes.json())?.contact?.id;
    if (!contactId && name) {
      const createRes = await fetch(`${GHL}/contacts/`, { method: 'POST', headers, body: JSON.stringify({ locationId, firstName: name, phone: fullPhone }) });
      contactId = (await createRes.json())?.contact?.id;
    }
    if (!contactId) return { sent: false, reason: 'no_contact' };
    const msgRes = await fetch(`${GHL}/conversations/messages`, { method: 'POST', headers, body: JSON.stringify({ type: 'SMS', contactId, message }) });
    return msgRes.ok ? { sent: true } : { sent: false, reason: `ghl_${msgRes.status}` };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

module.exports = { textClient, digits };
