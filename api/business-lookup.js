// /api/business-lookup — searches Google Maps for a business and returns its profile data.
//
// Used by the onboarding form for organic signups who found Build Boosters through the website.
// When the form has no prefill data, it shows a "find my business" step that calls this endpoint.
//
// GET /api/business-lookup?q=Smith+Plumbing+Miami
//   Returns up to 5 matching businesses with name, address, phone, hours, rating, reviews.
// GET /api/business-lookup?address=1420+SW+8th+St+Miami+FL
//   Checks that a texting registration address is a real street address and not a mailbox.
//
// No auth required (public form calls this). Rate-limited by keeping it simple.
// Needs: GOOGLE_PLACES_KEY in Vercel.

const FIELDS = 'name,formatted_address,formatted_phone_number,opening_hours,website,reviews,photos,types,business_status,rating,user_ratings_total,place_id';

function formatHours(periods, weekdayText) {
  if (!weekdayText || !weekdayText.length) return { weekday_hours: '', weekends: '' };

  const weekdays = weekdayText.filter(d =>
    /^(Monday|Tuesday|Wednesday|Thursday|Friday)/i.test(d)
  );
  const weekends = weekdayText.filter(d =>
    /^(Saturday|Sunday)/i.test(d)
  );

  // Try to summarize weekday hours if they're all the same
  const weekdayTimes = weekdays.map(d => d.replace(/^[A-Za-z]+:\s*/, ''));
  const uniqueWeekday = [...new Set(weekdayTimes)];
  let weekdayStr = '';
  if (uniqueWeekday.length === 1 && weekdays.length === 5) {
    weekdayStr = `Mon-Fri ${uniqueWeekday[0]}`;
  } else if (weekdays.length > 0) {
    weekdayStr = weekdays.join(', ');
  }

  const weekendTimes = weekends.map(d => d.replace(/^[A-Za-z]+:\s*/, ''));
  const uniqueWeekend = [...new Set(weekendTimes)];
  let weekendStr = '';
  if (uniqueWeekend.length === 1 && weekends.length === 2) {
    weekendStr = uniqueWeekend[0] === 'Closed' ? 'Closed' : `Sat-Sun ${uniqueWeekend[0]}`;
  } else if (weekends.length > 0) {
    weekendStr = weekends.join(', ');
  }

  return { weekday_hours: weekdayStr, weekends: weekendStr };
}

function cleanPhone(phone) {
  if (!phone) return '';
  // Keep the formatted version for display
  return phone.trim();
}

function extractCity(address) {
  if (!address) return '';
  // US addresses: "1420 SW 8th St, Miami, FL 33135, USA"
  const parts = address.split(',').map(s => s.trim());
  if (parts.length >= 3) return parts[parts.length - 3];
  if (parts.length >= 2) return parts[parts.length - 2];
  return '';
}

async function textSearch(query, key) {
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${encodeURIComponent(query)}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Places text search ${res.status}`);
  const data = await res.json();
  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Google Places: ${data.status} ${data.error_message || ''}`);
  }
  return data.results || [];
}

async function placeDetails(placeId, key) {
  const url = `https://maps.googleapis.com/maps/api/place/details/json?place_id=${encodeURIComponent(placeId)}&fields=${FIELDS}&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Google Places details ${res.status}`);
  const data = await res.json();
  if (data.status !== 'OK') {
    throw new Error(`Google Places details: ${data.status}`);
  }
  return data.result || {};
}

function cleanResult(place) {
  const hours = formatHours(
    place.opening_hours?.periods,
    place.opening_hours?.weekday_text
  );
  const topReviews = (place.reviews || [])
    .filter(r => r.rating >= 4)
    .slice(0, 5)
    .map(r => ({
      author: r.author_name || '',
      rating: r.rating,
      text: (r.text || '').slice(0, 300),
    }));

  return {
    business_name: place.name || '',
    business_phone: cleanPhone(place.formatted_phone_number),
    address: place.formatted_address || '',
    city: extractCity(place.formatted_address),
    weekday_hours: hours.weekday_hours,
    weekends: hours.weekends,
    website: (place.website || '').replace(/^https?:\/\//, '').replace(/\/+$/, ''),
    rating: place.rating || 0,
    review_count: place.user_ratings_total || 0,
    place_id: place.place_id || '',
    top_reviews: topReviews,
    business_status: place.business_status || '',
  };
}

// Finds one business by its phone number. Used when someone pays without a prospect record, so
// their setup form still opens filled in. Returns null unless Google has exactly one match.
async function lookupByPhone(phone) {
  const key = (process.env.GOOGLE_PLACES_KEY || '').trim();
  const d = String(phone || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!key || d.length !== 10) return null;
  const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent('+1' + d)}&inputtype=phonenumber&fields=place_id&key=${key}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json();
  const found = data.candidates || [];
  if (found.length !== 1) return null;
  return cleanResult(await placeDetails(found[0].place_id, key));
}

// Checks that a texting registration address is a real street address. The carriers turn down P.O. boxes
// and rented mailboxes, so those are refused before Google is even asked.
// Returns { ok, formatted, checked, reason }. When Google cannot be asked, the address passes unchecked
// so a client is never stuck on this step.
const MAILBOX = /\b(p\.?\s*o\.?\s*box|post\s+office\s+box|pmb|private\s+mail\s*box|mail\s*stop)\b/i;
const REAL_PLACE = ['street_address', 'premise', 'subpremise', 'establishment', 'point_of_interest'];

async function checkAddress(address) {
  const text = String(address || '').trim().slice(0, 300);
  if (text.length < 8 || !/\d/.test(text)) return { ok: false, reason: 'too_short' };
  if (MAILBOX.test(text)) return { ok: false, reason: 'mailbox' };
  const key = (process.env.GOOGLE_PLACES_KEY || '').trim();
  if (!key) return { ok: true, checked: false, formatted: text };
  try {
    const url = `https://maps.googleapis.com/maps/api/place/findplacefromtext/json?input=${encodeURIComponent(text)}&inputtype=textquery&fields=formatted_address,types&key=${key}`;
    const res = await fetch(url);
    const data = res.ok ? await res.json() : null;
    if (!data || (data.status !== 'OK' && data.status !== 'ZERO_RESULTS')) return { ok: true, checked: false, formatted: text };
    const hit = (data.candidates || [])[0];
    if (!hit) return { ok: false, reason: 'not_found' };
    const types = hit.types || [];
    if (types.includes('post_office') || types.includes('post_box')) return { ok: false, reason: 'mailbox' };
    if (!types.some((t) => REAL_PLACE.includes(t))) return { ok: false, reason: 'not_specific' };
    const formatted = String(hit.formatted_address || text).replace(/,\s*(USA|United States)$/i, '');
    return { ok: true, checked: true, formatted };
  } catch (e) {
    return { ok: true, checked: false, formatted: text };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // CORS for the form page
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });

  // GET /api/business-lookup?address=... checks a texting registration address.
  if (req.query && req.query.address !== undefined) {
    return res.status(200).json(await checkAddress(req.query.address));
  }

  const key = (process.env.GOOGLE_PLACES_KEY || '').trim();
  if (!key) {
    return res.status(200).json({ found: false, results: [], reason: 'not_configured' });
  }

  const q = String(req.query?.q || '').trim();
  if (!q || q.length < 3) {
    return res.status(400).json({ error: 'bad_request', reason: 'q must be at least 3 characters' });
  }

  try {
    // Step 1: Text search to find matching businesses
    const searchResults = await textSearch(q, key);
    if (searchResults.length === 0) {
      return res.status(200).json({ found: false, results: [] });
    }

    // Step 2: Get details for top 5 results
    const top = searchResults.slice(0, 5);
    const detailed = [];

    for (const sr of top) {
      try {
        const details = await placeDetails(sr.place_id, key);
        detailed.push(cleanResult(details));
      } catch (e) {
        // Fall back to the search result data if details fail
        detailed.push({
          business_name: sr.name || '',
          business_phone: '',
          address: sr.formatted_address || '',
          city: extractCity(sr.formatted_address),
          weekday_hours: '',
          weekends: '',
          website: '',
          rating: sr.rating || 0,
          review_count: sr.user_ratings_total || 0,
          place_id: sr.place_id || '',
          top_reviews: [],
          business_status: sr.business_status || '',
        });
      }
    }

    return res.status(200).json({ found: true, results: detailed });
  } catch (e) {
    console.error('business-lookup', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.message || 'unknown' });
  }
};
module.exports.lookupByPhone = lookupByPhone;
module.exports.checkAddress = checkAddress;
