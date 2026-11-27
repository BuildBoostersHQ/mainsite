// Quick test for the client-json converter mapping.
const { buildClientJson } = require('../api/client-json.js');

const FAKE_ROW = {
  id: '11111111-1111-1111-1111-111111111111',
  code: 'abcdef1234567890',
  tier: 'all_in_one',
  billing_cycle: 'monthly',
  owner_first_name: 'Dave',
  prefill: {
    business_name: 'Smith Plumbing',
    business_phone: '(813) 555-0142',
    address: '100 Main St, Tampa, FL 33602',
  },
  answers: {
    preferred_name: 'Dave',
    trade: 'plumbing',
    email: 'dave@smithplumbing.com',
    weekday_hours: 'Mon to Fri, 7 AM to 5 PM',
    weekends: 'Sat, 8 AM to 1 PM',
    services: ['Drain Cleaning', 'Water Heater Repair', 'Leak Detection', 'Toilet Repair'],
    areas: ['Tampa', 'Brandon', 'Riverview'],
    badges: ['Licensed and insured', 'Veteran owned', '15+ years in business'],
    vibes: ['reliable', 'affordable'],
    style: 'fresh',
    brand_color: '#1a6b4a',
    show_address: true,
    domain_choice: 'smithplumbingtampa.com',
    site_notes: 'Dave wants the green to match his truck.',
    years_experience: '20',
    job_software: 'Jobber',
  },
};

function test(label, fn) {
  try { fn(); console.log(`  PASS  ${label}`); }
  catch (e) { console.error(`  FAIL  ${label}: ${e.message}`); process.exitCode = 1; }
}

function eq(a, b, msg) {
  const sa = JSON.stringify(a), sb = JSON.stringify(b);
  if (sa !== sb) throw new Error(`${msg || 'mismatch'}: got ${sa}, want ${sb}`);
}

const { client_json: c, meta } = buildClientJson(FAKE_ROW);

console.log('client-json converter tests\n');

test('slug is built from name and city', () => {
  eq(c.slug, 'smith-plumbing-tampa');
});

test('mode defaults to auto', () => {
  eq(c.mode, 'auto');
});

test('style from answers', () => {
  eq(c.style, 'fresh');
});

test('business name from prefill (answers wins but prefill used when no override)', () => {
  eq(c.business.name, 'Smith Plumbing');
});

test('phone is digits only', () => {
  eq(c.business.phone, '8135550142');
});

test('owner from preferred_name', () => {
  eq(c.business.owner, 'Dave');
});

test('trade preserved', () => {
  eq(c.business.trade, 'plumbing');
});

test('email from answers', () => {
  eq(c.business.email, 'dave@smithplumbing.com');
});

test('address parsed from string', () => {
  eq(c.business.address.street, '100 Main St');
  eq(c.business.address.city, 'Tampa');
  eq(c.business.address.state, 'FL');
  eq(c.business.address.zip, '33602');
});

test('showAddress true', () => {
  eq(c.business.showAddress, true);
});

test('city is first area', () => {
  eq(c.business.city, 'Tampa');
});

test('hours built from weekday and weekend', () => {
  eq(c.business.hours.length, 2);
  eq(c.business.hours[0], 'Mon to Fri, 7 AM to 5 PM');
  eq(c.business.hours[1], 'Sat, 8 AM to 1 PM');
});

test('insured extracted from badges', () => {
  eq(c.business.insured, true);
});

test('yearsInBusiness extracted from badges', () => {
  eq(c.business.yearsInBusiness, '15');
});

test('yearsExperience from dedicated field', () => {
  eq(c.business.yearsExperience, '20');
});

test('brand color from answers', () => {
  eq(c.brand.main, '#1a6b4a');
});

test('services mapped with empty page blocks', () => {
  eq(c.content.services.length, 4);
  eq(c.content.services[0].name, 'Drain Cleaning');
  eq(c.content.services[0].blurb, '');
  eq(JSON.stringify(c.content.services[0].page), '{}');
});

test('areas mapped as objects with empty pages', () => {
  eq(c.business.serviceArea.length, 3);
  eq(c.business.serviceArea[0].city, 'Tampa');
  eq(JSON.stringify(c.business.serviceArea[0].page), '{}');
});

test('badges cleaned: licensed/insured and years stripped, veteran kept', () => {
  eq(c.content.badges.length, 1);
  eq(c.content.badges[0], 'Veteran owned');
});

test('content fields left empty for copy writer', () => {
  eq(c.content.about.length, 0);
  eq(c.content.faq.length, 0);
});

test('photos all empty', () => {
  eq(c.photos.hero, '');
  eq(c.photos.work.length, 0);
});

test('integrations all empty', () => {
  eq(c.integrations.ghl.formWebhook, '');
  eq(c.integrations.google.reviewLink, '');
});

test('domain in client_json', () => {
  eq(c.domain, 'smithplumbingtampa.com');
});

test('meta has vibes and site_notes', () => {
  eq(meta.vibes.length, 2);
  eq(meta.site_notes, 'Dave wants the green to match his truck.');
  eq(meta.domain_choice, 'smithplumbingtampa.com');
});

test('legalName falls back to business name', () => {
  eq(c.business.legalName, 'Smith Plumbing');
});

// Test with trade defaults when no services picked.
const noServices = buildClientJson({
  ...FAKE_ROW,
  answers: { ...FAKE_ROW.answers, services: [], trade: 'painting' },
});
test('trade defaults used when no services picked', () => {
  eq(noServices.client_json.content.services.length, 3);
  eq(noServices.client_json.content.services[0].name, 'Interior Painting');
  if (!noServices.client_json.content.services[0].blurb) throw new Error('blurb should come from defaults');
});

// Test with a2p_legal_name override.
const withLegal = buildClientJson({
  ...FAKE_ROW,
  answers: { ...FAKE_ROW.answers, a2p_legal_name: 'Smith Plumbing LLC' },
});
test('legalName from a2p_legal_name when provided', () => {
  eq(withLegal.client_json.business.legalName, 'Smith Plumbing LLC');
});

console.log('\nDone.');
