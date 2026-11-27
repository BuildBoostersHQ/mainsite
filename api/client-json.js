// /api/client-json — reads a client's onboarding answers and outputs a valid client.json
// for the site template. Internal only: needs BB_INTERNAL_SECRET.
//
// GET /api/client-json?code=<code>           → { ok, client_json }
// GET /api/client-json?code=<code>&download  → client.json file download
const { sb, allowed, configured } = require('./_sb');

const TABLE = 'client_onboarding';
const CODE = /^[A-Za-z0-9_-]{12,64}$/;

// Known trades and their default services, mirrored from the template's trades.js.
const TRADES = {
  handyman: {
    label: 'Handyman Services', noun: 'handyman',
    services: [
      { name: 'Repairs Around the House', blurb: 'We fix the doors that stick, the drywall with holes in it, the loose railings and the rest of the list you have been putting off.' },
      { name: 'Installations', blurb: 'We hang TVs, shelves, blinds, light fixtures and ceiling fans, and we clean up when we are done.' },
      { name: 'Carpentry and Trim', blurb: 'We replace trim, baseboards and rotted wood so the job looks finished instead of patched.' },
    ],
  },
  painting: {
    label: 'Painting', noun: 'painting',
    services: [
      { name: 'Interior Painting', blurb: 'We paint walls, ceilings, trim and doors, and we cover your floors and furniture before the first coat goes on.' },
      { name: 'Exterior Painting', blurb: 'We wash, scrape and prime before we paint, because paint only lasts as long as the prep underneath it.' },
      { name: 'Cabinet Painting', blurb: 'We take the doors off, sand and prime them, and spray them so your kitchen looks new without paying for new cabinets.' },
    ],
  },
  'junk-removal': {
    label: 'Junk Removal', noun: 'junk removal',
    services: [
      { name: 'Household Junk Removal', blurb: 'We haul away old furniture, appliances and everything else you point at, and you do not have to lift a thing.' },
      { name: 'Garage and Attic Cleanouts', blurb: 'We clear out the garage, attic or storage unit in one trip and sweep up before we leave.' },
      { name: 'Construction Debris', blurb: 'We pick up the leftover drywall, wood and tile after a remodel so it is gone before your next project starts.' },
    ],
  },
  'pressure-washing': {
    label: 'Pressure Washing', noun: 'pressure washing',
    services: [
      { name: 'House Washing', blurb: 'We soft wash siding and stucco to take off the mildew and dirt without damaging the surface.' },
      { name: 'Driveways and Walkways', blurb: 'We clean the oil stains, mold and buildup off your concrete and pavers so they look close to new.' },
      { name: 'Roof Cleaning', blurb: 'We clear the black streaks off your roof with a low pressure treatment that is safe for shingles and tile.' },
    ],
  },
  landscaping: {
    label: 'Landscaping', noun: 'landscaping',
    services: [
      { name: 'Lawn Care', blurb: 'We mow, edge and blow on a regular schedule so your yard looks taken care of every week.' },
      { name: 'Landscape Installation', blurb: 'We plant beds, lay sod and put down mulch and rock so the yard looks the way you pictured it.' },
      { name: 'Yard Cleanups', blurb: 'We trim hedges, pull weeds and haul off the debris when the yard has gotten away from you.' },
    ],
  },
};

function tradeKey(raw) {
  return String(raw || '').toLowerCase().trim().replace(/\s+/g, '-');
}

function tradeDefaults(raw) {
  const k = tradeKey(raw);
  return TRADES[k] || null;
}

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function digits(s) {
  return String(s || '').replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

// Parse address from a single string like "123 Main St, Tampa, FL 33602" or from separate fields.
function parseAddress(a) {
  if (!a) return { street: '', city: '', state: '', zip: '' };
  if (typeof a === 'object') return { street: a.street || '', city: a.city || '', state: a.state || '', zip: a.zip || '' };
  const s = String(a).trim();
  // Try "street, city, ST zip" or "street, city, ST"
  const m = s.match(/^(.+?),\s*(.+?),\s*([A-Z]{2})\s*(\d{5})?$/i);
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3].toUpperCase(), zip: (m[4] || '').trim() };
  return { street: s, city: '', state: '', zip: '' };
}

// Extract years and boolean flags from badges and dedicated fields.
function extractFacts(a) {
  const badges = Array.isArray(a.badges) ? a.badges : [];
  const facts = {
    yearsInBusiness: a.years_in_business || '',
    yearsExperience: a.years_experience || '',
    license: a.license || '',
    insured: false,
    cleanBadges: [],
  };

  for (const b of badges) {
    const low = String(b).toLowerCase();
    if (/insured/i.test(low) && /licensed/i.test(low)) {
      facts.insured = true;
      // Try to pull a license number: "Licensed #12345"
      const lm = b.match(/#?\s*(\d{4,})/);
      if (lm && !facts.license) facts.license = lm[1];
    } else if (/insured/i.test(low)) {
      facts.insured = true;
    } else if (/licensed/i.test(low)) {
      const lm = b.match(/#?\s*(\d{4,})/);
      if (lm && !facts.license) facts.license = lm[1];
    } else if (/(\d+)\+?\s*years?\s*(in\s*business|experience)/i.test(low)) {
      const ym = low.match(/(\d+)\+?\s*years?\s*(in\s*business|experience)/i);
      if (ym) {
        if (/experience/i.test(ym[2]) && !facts.yearsExperience) facts.yearsExperience = ym[1];
        else if (!facts.yearsInBusiness) facts.yearsInBusiness = ym[1];
      }
    } else {
      facts.cleanBadges.push(b);
    }
  }
  return facts;
}

function buildClientJson(row) {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const code = row.code || '';
  const trade = a.trade || '';
  const defaults = tradeDefaults(trade);
  const addr = parseAddress(a.address);
  const facts = extractFacts(a);

  // Services: use what the client picked, or fall back to trade defaults.
  const pickedServices = Array.isArray(a.services) ? a.services : [];
  let services;
  if (pickedServices.length > 0) {
    // Check if any defaults match and carry over the blurb.
    const defaultMap = {};
    if (defaults) for (const d of defaults.services) defaultMap[d.name.toLowerCase()] = d.blurb;
    services = pickedServices.map((name) => ({
      name,
      blurb: defaultMap[name.toLowerCase()] || '',
      page: {},
    }));
  } else if (defaults) {
    services = defaults.services.map((d) => ({ name: d.name, blurb: d.blurb, page: {} }));
  } else {
    services = [];
  }

  // Service areas: each one becomes { city, page: {} }.
  const pickedAreas = Array.isArray(a.areas) ? a.areas : [];
  const serviceArea = pickedAreas.map((city) => ({ city, page: {} }));

  // The primary city is the first area, or the city from the address.
  const primaryCity = (pickedAreas.length > 0 ? pickedAreas[0] : addr.city) || '';

  // Hours.
  const hours = [];
  if (a.weekday_hours) hours.push(a.weekday_hours);
  if (a.weekends) hours.push(a.weekends);

  const clientJson = {
    schemaVersion: 1,
    slug: slugify(a.business_name || 'client') + '-' + slugify(primaryCity || 'site'),
    domain: a.domain_own || a.domain_choice || '',
    style: a.style || 'classic',
    mode: 'auto',

    business: {
      name: a.business_name || '',
      legalName: a.a2p_legal_name || a.business_name || '',
      trade: trade,
      owner: a.preferred_name || '',
      phone: digits(a.business_phone),
      textNumber: '',
      email: a.email || '',
      address: addr,
      showAddress: a.show_address !== false,
      city: primaryCity,
      serviceArea,
      hours,
      license: facts.license,
      insured: facts.insured,
      yearsInBusiness: facts.yearsInBusiness,
      yearsExperience: facts.yearsExperience,
    },

    brand: {
      logo: '',
      main: a.brand_color || '',
      accent: '',
    },

    content: {
      headline: '',
      heroSub: '',
      metaDescription: '',
      formTitle: '',
      about: [],
      services,
      reviews: [],
      badges: facts.cleanBadges,
      trustPoints: [],
      process: [],
      faq: [],
    },

    photos: {
      hero: '',
      about: '',
      work: [],
      gallery: [],
    },

    legal: {
      effectiveDate: new Date().toISOString().slice(0, 10),
    },

    integrations: {
      ghl: {
        formWebhook: '',
        chatWidgetId: '',
        reviewWidgetId: '',
      },
      google: {
        reviewLink: '',
      },
    },
  };

  // Extra fields the automator uses but that are not part of the site template.
  const meta = {
    code,
    tier: row.tier || '',
    billing_cycle: row.billing_cycle || '',
    domain_choice: a.domain_choice || '',
    domain_own: a.domain_own || '',
    site_notes: a.site_notes || '',
    vibes: Array.isArray(a.vibes) ? a.vibes : [],
    job_software: a.job_software || '',
  };

  return { client_json: clientJson, meta };
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const code = String((req.query && req.query.code) || '');
    if (!CODE.test(code)) return res.status(404).json({ error: 'not_found' });

    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });

    const result = buildClientJson(row);

    if ('download' in (req.query || {})) {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${result.client_json.slug || 'client'}.json"`);
      return res.status(200).end(JSON.stringify(result.client_json, null, 2) + '\n');
    }

    return res.status(200).json({ ok: true, ...result });
  } catch (e) {
    console.error('client-json', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

// Exported for testing.
module.exports.buildClientJson = buildClientJson;
