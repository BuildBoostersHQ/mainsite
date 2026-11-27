// /api/write-copy — generates all page copy for a client's site using Claude.
//
// POST with { "code": "..." } and x-bb-secret header. Looks up the client's onboarding answers,
// builds the Business Brief, calls the Anthropic API for each section, and returns the copy ready
// to drop into client.json.
//
// Needs ANTHROPIC_API_KEY and BB_INTERNAL_SECRET in Vercel, plus the two Supabase variables.
// This is a slow endpoint (several LLM calls). Vercel Pro functions can run up to 5 minutes.
const { sb, allowed, configured } = require('./_sb');

const TABLE = 'client_onboarding';
const CODE = /^[A-Za-z0-9_-]{12,64}$/;
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

const apiKey = () => String(process.env.ANTHROPIC_API_KEY || '').trim();

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Default FAQ questions per trade. When we don't have trade-specific ones, use these.
const TRADE_FAQS = {
  handyman: [
    'How soon can you start?',
    'Do you give free estimates?',
    'What if I only have a small job?',
    'Are you licensed and insured?',
    'Do I need to be home while you work?',
  ],
  painting: [
    'How soon can you start?',
    'Do you give free estimates?',
    'Do I need to move my furniture?',
    'How long does a paint job take?',
    'What kind of paint do you use?',
  ],
  'junk-removal': [
    'How soon can you pick up?',
    'Do you give free estimates?',
    'What can you not haul away?',
    'Do I need to carry things to the curb?',
    'Do you recycle or donate anything?',
  ],
  'pressure-washing': [
    'How soon can you come out?',
    'Do you give free estimates?',
    'Will pressure washing damage my surface?',
    'How long does a driveway take?',
    'Do I need to be home?',
  ],
  landscaping: [
    'How soon can you start?',
    'Do you give free estimates?',
    'Do you haul away the debris?',
    'How often should I have the lawn mowed?',
    'Can you work around my sprinkler system?',
  ],
};
const DEFAULT_FAQS = [
  'How soon can you start?',
  'Do you give free estimates?',
  'Are you licensed and insured?',
  'What areas do you serve?',
  'What if something goes wrong with the work?',
];

function getFaqs(trade) {
  const k = String(trade || '').toLowerCase().trim().replace(/\s+/g, '-');
  return TRADE_FAQS[k] || DEFAULT_FAQS;
}

// Build the Business Brief that goes above every prompt.
function buildBrief(a, state) {
  const services = (a.services || []).map((s, i) => `${i + 1}. ${s} | /services/${slugify(s)}`).join('\n');
  const areas = (a.areas || []).map((c, i) => `${i + 1}. ${c} | /areas/${slugify(c)}`).join('\n');
  const backstory = a.site_notes || a.backstory || `${a.preferred_name || 'The owner'} started ${a.business_name || 'the business'} to serve ${a.areas && a.areas[0] ? a.areas[0] : 'the local area'}.`;

  return `You are a local SEO copywriter for home-service contractors. Write in plain, friendly, conversational English, the way the owner would talk to a neighbor. Output only the headings and copy asked for. No commentary, no notes, no explanations.

BUSINESS
Name: ${a.business_name || 'the business'}
Trade category: ${a.trade || 'Home Services'}
Primary city: ${a.areas && a.areas[0] ? a.areas[0] + ', ' + state : 'the local area'}
Phone: ${a.business_phone || '(000) 000-0000'}
Services and their page paths:
${services || '(none listed)'}
Service areas and their page paths:
${areas || '(none listed)'}
Backstory of the business and owner: ${backstory}

RULES
- Use the real business name, service names, city names and phone number exactly as written above.
- Use only the facts above. Do not invent years in business, licenses, insurance, awards, guarantees, prices, reviews or statistics.
- Write for a homeowner first. Use each keyword where it reads naturally, never forced or repeated back to back.
- Never list every service area in one block.
- No filler openers such as "Looking for...?", "Look no further" or "In today's world".
- Stay inside the length given for each section.
- No sentence fragments. Never start a sentence with "And" or "Most". Prefer longer sentences kept in short paragraphs.`;
}

async function callClaude(prompt) {
  const key = apiKey();
  if (!key) throw Object.assign(new Error('no key'), { hint: 'anthropic_key_missing' });
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 400);
    const err = new Error(`Anthropic ${res.status}: ${text}`);
    err.hint = res.status === 401 ? 'anthropic_key_rejected' : 'anthropic_error';
    throw err;
  }
  const data = await res.json();
  return (data.content && data.content[0] && data.content[0].text) || '';
}

// Ask for JSON output and try to parse it. Falls back to raw text extraction.
function parseJSON(raw) {
  const jsonMatch = raw.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  const candidate = jsonMatch ? jsonMatch[1].trim() : raw.trim();
  try { return JSON.parse(candidate); } catch (e) { /* fall through */ }
  const first = candidate.indexOf('{');
  const firstArr = candidate.indexOf('[');
  const start = first >= 0 && (firstArr < 0 || first < firstArr) ? first : firstArr;
  if (start >= 0) {
    const sub = candidate.slice(start);
    try { return JSON.parse(sub); } catch (e) { /* fall through */ }
    const isArr = sub[0] === '[';
    const close = isArr ? sub.lastIndexOf(']') : sub.lastIndexOf('}');
    if (close > 0) { try { return JSON.parse(sub.slice(0, close + 1)); } catch (e) { /* fall through */ } }
  }
  return null;
}

async function writeAbout(brief) {
  const prompt = `${brief}

Write the About Us section for the homepage.

Return the result as JSON with this exact structure (no other text):
{
  "about": ["paragraph 1", "paragraph 2"]
}

Write 120 to 250 words total in 2 or 3 short paragraphs.
- Lead with the backstory: who the owner is and why they started the business.
- Name the trade category and the primary city once within the first two sentences.
- Mention 2 or 3 of the services by name, and no more than 2 service areas besides the primary city.
- Use the business name once or twice. Otherwise write as "we".
- End with one friendly sentence inviting the reader to call, including the phone number.`;
  const raw = await callClaude(prompt);
  const parsed = parseJSON(raw);
  return parsed && Array.isArray(parsed.about) ? parsed.about : [raw];
}

async function writeFaq(brief, questions) {
  const qs = questions.map((q, i) => `${i + 1}. ${q}`).join('\n');
  const prompt = `${brief}

Write the homepage FAQ answers.

Questions:
${qs}

Return the result as JSON with this exact structure (no other text):
{
  "faq": [["question 1", "answer 1"], ["question 2", "answer 2"]]
}

- Each answer is 1 or 2 sentences, 120 to 250 characters including spaces.
- Answer the question directly in the first sentence.
- Use the backstory only where it actually answers the question.
- Name a service or a city only where the question calls for it.
- If the facts above do not answer a question, write an honest general answer and tell the reader to call for specifics. Do not make up a policy, price or timeline.
- No two answers may start with the same words.`;
  const raw = await callClaude(prompt);
  const parsed = parseJSON(raw);
  return parsed && Array.isArray(parsed.faq) ? parsed.faq : [];
}

async function writeServices(brief, services) {
  const serviceList = services.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const prompt = `${brief}

Write the service pages for all of these services:
${serviceList}

Return the result as JSON with this exact structure (no other text):
{
  "services": [
    {
      "name": "Service Name",
      "blurb": "120 to 250 character description for the homepage card",
      "metaTitle": "up to 60 chars: Service in City | Business Name",
      "metaDescription": "up to 155 chars",
      "title": "H1 headline with service and city",
      "body": ["paragraph 1 (80-120 words)", "paragraph 2 (80-120 words)", "paragraph 3 (80-120 words)"],
      "why": [{"title": "point title", "text": "one sentence"}],
      "expect": [{"title": "step title", "text": "one sentence"}],
      "cta": "one sentence call to action with business name and phone"
    }
  ]
}

For each service:
- "blurb": 120 to 250 characters. This is the short description for the homepage service card.
- "metaTitle": Up to 60 characters, in the form: [Service] in [Primary City] | [Business Name]
- "metaDescription": Up to 155 characters. Say what the service is, name the primary city and end with a reason to call.
- "title": One headline that includes the service and the primary city.
- "body": Three paragraphs of 80 to 120 words each:
  1. What the service is. Put the service name and the primary city in the first sentence.
  2. When the service is necessary. Give the real signs a homeowner would notice. Mention 2 other services from the list that often go with this one, by name, where they fit.
  3. What to expect. Cover the process, what the homeowner needs to do beforehand and how the job wraps up. Name 2 service areas as places we do this work.
- "why": 2 or 4 short points about why to choose us for this service, each with a title and one sentence of text.
- "expect": 2 or 4 short points about what to expect, each with a title and one sentence of text.
- "cta": One sentence inviting the reader to call for an estimate, with the business name and phone number.`;
  const raw = await callClaude(prompt);
  const parsed = parseJSON(raw);
  return parsed && Array.isArray(parsed.services) ? parsed.services : [];
}

async function writeAreas(brief, areas, state) {
  const areaList = areas.map((a, i) => `${i + 1}. ${a}, ${state}`).join('\n');
  const prompt = `${brief}

Write the service area pages for all of these cities:
${areaList}

For each city, think of 2 or 3 real local facts about it (neighborhoods, the age of homes, the weather, common jobs there) and use them so each page reads differently.

Return the result as JSON with this exact structure (no other text):
{
  "areas": [
    {
      "city": "City Name",
      "metaTitle": "up to 60 chars: Trade in City | Business Name",
      "metaDescription": "up to 155 chars",
      "title": "H1 headline with trade and city",
      "intro": "one sentence intro under the page title",
      "body": ["paragraph 1 (100-150 words)", "paragraph 2 (100-150 words)", "paragraph 3 (100-150 words)"],
      "why": [{"title": "point title", "text": "one sentence"}],
      "cta": "one sentence call to action with city, business name and phone"
    }
  ]
}

For each city:
- "metaTitle": Up to 60 characters, in the form: [Trade Category] in [City] | [Business Name]
- "metaDescription": Up to 155 characters. Name the trade and the city and end with a reason to call.
- "title": One headline that includes the trade category and the city.
- "intro": One sentence about what this business does in this city.
- "body": Three paragraphs of 100 to 150 words each:
  1. Why homeowners in this city need this trade. Build it on the local facts. Give the business backstory one sentence at most.
  2. The services we offer in this city. Name 4 to 6 services from the list and tie each to a typical job here.
  3. Why choose us in this city. Use only the facts from the brief. Mention 1 or 2 other service areas from the list as nearby places we also work.
  Name the city in the first sentence and 3 to 5 times across the page.
- "why": 2 or 4 short points about why to choose us in this city.
- "cta": One sentence inviting the reader to call, with the city, the business name and the phone number.

If you do not know real facts about a city, write only what is safely true. Do not invent landmarks, neighborhoods, weather events or past jobs.`;
  const raw = await callClaude(prompt);
  const parsed = parseJSON(raw);
  return parsed && Array.isArray(parsed.areas) ? parsed.areas : [];
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!apiKey()) return res.status(500).json({ error: 'not_configured', reason: 'ANTHROPIC_API_KEY is not set' });

  try {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = null; } }
    const code = String((body && body.code) || '');
    if (!CODE.test(code)) return res.status(400).json({ error: 'code_required' });

    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });

    const a = { ...(row.prefill || {}), ...(row.answers || {}) };
    const services = Array.isArray(a.services) ? a.services.filter(Boolean) : [];
    const areas = Array.isArray(a.areas) ? a.areas.filter(Boolean) : [];

    if (!services.length && !areas.length) {
      return res.status(400).json({ error: 'no_content', reason: 'The client has no services or areas to write about.' });
    }

    // Guess the state from the address if we can, otherwise default to FL.
    const addrState = String(a.address || '').match(/\b([A-Z]{2})\b(?:\s+\d{5})?$/);
    const state = addrState ? addrState[1] : 'FL';

    const brief = buildBrief(a, state);
    const questions = getFaqs(a.trade);

    // Run about + faq in parallel, then services, then areas.
    const [about, faq] = await Promise.all([
      writeAbout(brief),
      writeFaq(brief, questions),
    ]);

    const svcCopy = services.length ? await writeServices(brief, services) : [];
    const areaCopy = areas.length ? await writeAreas(brief, areas, state) : [];

    // Match service copy back to the service names (the LLM may reorder).
    const svcMap = {};
    for (const s of svcCopy) if (s && s.name) svcMap[s.name.toLowerCase()] = s;
    const orderedServices = services.map((name) => {
      const found = svcMap[name.toLowerCase()] || svcCopy.find((s) => s && s.name && s.name.toLowerCase().includes(name.toLowerCase().slice(0, 10)));
      if (!found) return { name, blurb: '', page: {} };
      return {
        name,
        blurb: found.blurb || '',
        page: {
          metaTitle: found.metaTitle || '',
          metaDescription: found.metaDescription || '',
          title: found.title || '',
          body: Array.isArray(found.body) ? found.body : [],
          why: Array.isArray(found.why) ? found.why : [],
          expect: Array.isArray(found.expect) ? found.expect : [],
          cta: found.cta || '',
        },
      };
    });

    // Same for areas.
    const areaMap = {};
    for (const ar of areaCopy) if (ar && ar.city) areaMap[ar.city.toLowerCase()] = ar;
    const orderedAreas = areas.map((city) => {
      const found = areaMap[city.toLowerCase()] || areaCopy.find((ar) => ar && ar.city && ar.city.toLowerCase().includes(city.toLowerCase().slice(0, 8)));
      if (!found) return { city, page: {} };
      return {
        city,
        page: {
          metaTitle: found.metaTitle || '',
          metaDescription: found.metaDescription || '',
          title: found.title || '',
          intro: found.intro || '',
          body: Array.isArray(found.body) ? found.body : [],
          why: Array.isArray(found.why) ? found.why : [],
          cta: found.cta || '',
        },
      };
    });

    return res.status(200).json({
      ok: true,
      copy: {
        about,
        faq,
        services: orderedServices,
        areas: orderedAreas,
      },
    });
  } catch (e) {
    console.error('write-copy', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};

// Exported for testing.
module.exports.slugify = slugify;
module.exports.parseJSON = parseJSON;
module.exports.buildBrief = buildBrief;
module.exports.getFaqs = getFaqs;
