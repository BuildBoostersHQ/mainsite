// Tests for the site automator: step sequence, error handling, resume on retry.
const { slugify, repoName } = require('../api/build-site.js');

// ---- Unit tests for helpers ----

console.log('--- slugify ---');
console.assert(slugify('Smith Plumbing') === 'smith-plumbing');
console.assert(slugify('Dave & Sons HVAC') === 'dave-and-sons-hvac');
console.assert(slugify('  Lots---of---dashes  ') === 'lots-of-dashes');
console.assert(slugify('Über Painting') === 'uber-painting');
console.log('slugify: OK');

console.log('--- repoName ---');
const row1 = { code: 'abcdef1234567890', prefill: { business_name: 'Smith Plumbing' }, answers: { address: '100 Main St, Tampa, FL 33602' } };
console.assert(repoName(row1) === 'smith-plumbing-tampa', `got: ${repoName(row1)}`);

const row2 = { code: 'abcdef1234567890', prefill: {}, answers: { business_name: 'Ace Roofing', address: '5 Elm, Coral Gables, FL 33134' } };
console.assert(repoName(row2) === 'ace-roofing-coral-gables', `got: ${repoName(row2)}`);

const row3 = { code: 'abcdef1234567890', prefill: {}, answers: {} };
console.assert(repoName(row3) === 'client-abcdef12', `got: ${repoName(row3)}`);

const longName = { code: 'abcdef1234567890', prefill: { business_name: 'A'.repeat(80) + ' Plumbing' }, answers: { address: '1 Main, Tampa, FL' } };
console.assert(repoName(longName).length <= 60, `long name: ${repoName(longName).length}`);
console.log('repoName: OK');

// ---- Integration test with mocked fetch ----

console.log('--- handler step sequence ---');

const calls = [];
const originalFetch = global.fetch;

function mockFetch(url, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : undefined });

  // Supabase: look up client
  if (url.includes('/rest/v1/client_onboarding') && method === 'GET') {
    return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify([{
      id: 'test-id-1234', code: 'abcdef1234567890', prefill: { business_name: 'Test Plumbing' },
      answers: { address: '1 Main, Tampa, FL 33601', trade: 'plumbing', services: ['Drain Cleaning', 'Pipe Repair'], areas: ['Tampa', 'Brandon'], style: 'classic' },
      options: {}, tier: 'allinone', billing_cycle: 'monthly',
    }]), json: async function() { return JSON.parse(await this.text()); } });
  }

  // Supabase: PATCH
  if (url.includes('/rest/v1/client_onboarding') && method === 'PATCH') {
    return Promise.resolve({ ok: true, status: 200, text: async () => '[]', json: async () => [] });
  }

  // GitHub: generate from template
  if (url.includes('/generate') && method === 'POST') {
    return Promise.resolve({ ok: true, status: 201, text: async () => '{}', json: async () => ({ id: 1, full_name: 'BuildBoostersHQ/test-plumbing-tampa' }) });
  }

  // GitHub: check if repo exists / is ready
  if (url.includes('api.github.com/repos/BuildBoostersHQ/test-plumbing-tampa') && method === 'GET' && !url.includes('/contents/')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ size: 100, is_template: false }), text: async () => '{}' });
  }

  // GitHub: get existing client.json (template ships one)
  if (url.includes('/contents/client.json') && method === 'GET') {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ sha: 'abc123' }), text: async () => '{}' });
  }

  // GitHub: write client.json
  if (url.includes('/contents/client.json') && method === 'PUT') {
    return Promise.resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });
  }

  // Vercel: create project
  if (url.includes('api.vercel.com') && url.includes('/projects') && method === 'POST' && !url.includes('/env') && !url.includes('/deploy-hooks')) {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'prj_test123' }), text: async () => '{}' });
  }

  // Vercel: set env vars
  if (url.includes('/env') && method === 'POST') {
    return Promise.resolve({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });
  }

  // Vercel: create deploy hook
  if (url.includes('/deploy-hooks') && method === 'POST') {
    return Promise.resolve({ ok: true, status: 200, json: async () => ({ id: 'hook_test', url: 'https://api.vercel.com/v1/integrations/deploy/hook_test' }), text: async () => '{}' });
  }

  // Deploy hook call
  if (url.includes('integrations/deploy') && method === 'POST') {
    return Promise.resolve({ ok: true, status: 200, text: async () => '{}' });
  }

  return Promise.resolve({ ok: true, status: 200, text: async () => '[]', json: async () => [] });
}

async function runTest() {
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'sb_secret_test';
  process.env.BB_INTERNAL_SECRET = 'abcdefghijklmnopqrstuvwxyz123456';
  process.env.GITHUB_TOKEN = 'ghp_test';
  process.env.VERCEL_TOKEN = 'test_token';
  process.env.VERCEL_TEAM_ID = 'team_test';
  process.env.LEGAL_SOURCE_TOKEN = 'ghp_legal_test';

  global.fetch = mockFetch;

  // Clear module cache to pick up env
  delete require.cache[require.resolve('../api/build-site.js')];
  delete require.cache[require.resolve('../api/_sb.js')];
  const handler = require('../api/build-site.js');

  let result = {};
  const res = {
    setHeader() {},
    status(c) { this.c = c; return this; },
    json(d) { result = { status: this.c, ...d }; return this; },
  };

  // Test: missing code
  await handler({ method: 'POST', body: {}, query: {}, headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET } }, { ...res });
  console.assert(result.status === 400, `missing code: ${result.status}`);
  console.log('  missing code: OK');

  // Test: wrong method
  await handler({ method: 'GET', body: {}, query: {}, headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET } }, { ...res });
  console.assert(result.status === 405, `wrong method: ${result.status}`);
  console.log('  wrong method: OK');

  // Test: unauthorized
  await handler({ method: 'POST', body: { code: 'abcdef1234567890' }, query: {}, headers: {} }, { ...res });
  console.assert(result.status === 401, `unauthorized: ${result.status}`);
  console.log('  unauthorized: OK');

  // Test: full happy path
  calls.length = 0;
  await handler({ method: 'POST', body: { code: 'abcdef1234567890' }, query: {}, headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET } }, { ...res });
  console.assert(result.status === 200, `happy path status: ${result.status} ${JSON.stringify(result)}`);
  console.assert(result.ok === true, 'happy path ok');
  console.assert(result.repo === 'BuildBoostersHQ/test-plumbing-tampa', `repo: ${result.repo}`);
  console.assert(result.projectId === 'prj_test123', `projectId: ${result.projectId}`);
  console.assert(result.deployHookUrl, 'deployHookUrl set');
  console.log('  happy path: OK');

  // Check the step sequence
  const steps = calls.map(c => {
    if (c.url.includes('/generate')) return 'generate_repo';
    if (c.url.includes('/contents/client.json') && c.method === 'GET') return 'get_client_json';
    if (c.url.includes('/contents/client.json') && c.method === 'PUT') return 'write_client_json';
    if (c.url.includes('/projects') && c.method === 'POST' && !c.url.includes('/env') && !c.url.includes('/deploy-hooks')) return 'create_project';
    if (c.url.includes('/env')) return 'set_env';
    if (c.url.includes('/deploy-hooks')) return 'create_hook';
    if (c.url.includes('integrations/deploy') && c.method === 'POST') return 'trigger_deploy';
    if (c.url.includes('client_onboarding') && c.method === 'PATCH') return 'save_supabase';
    if (c.url.includes('client_onboarding') && c.method === 'GET') return 'lookup_client';
    if (c.url.includes('github.com/repos/BuildBoostersHQ/test') && c.method === 'GET' && !c.url.includes('contents')) return 'check_repo';
    return `other:${c.method}:${c.url.slice(0, 60)}`;
  });

  // Verify key steps happened in order
  const keySteps = steps.filter(s => ['lookup_client', 'generate_repo', 'write_client_json', 'create_project', 'create_hook', 'trigger_deploy'].includes(s));
  const expected = ['lookup_client', 'generate_repo', 'write_client_json', 'create_project', 'create_hook', 'trigger_deploy'];
  for (let i = 0; i < expected.length; i++) {
    console.assert(keySteps[i] === expected[i], `step ${i}: expected ${expected[i]}, got ${keySteps[i]}`);
  }
  console.log('  step order: OK');

  // Verify Supabase patches happened (partial progress)
  const patches = calls.filter(c => c.url.includes('client_onboarding') && c.method === 'PATCH');
  console.assert(patches.length >= 2, `patches: ${patches.length}`);
  console.log('  partial progress saves: OK');

  // Verify env vars were set
  const envCalls = calls.filter(c => c.url.includes('/env') && c.method === 'POST');
  const envKeys = envCalls.map(c => c.body.key);
  console.assert(envKeys.includes('BB_CLIENT_CODE'), 'BB_CLIENT_CODE env set');
  console.assert(envKeys.includes('LEGAL_SOURCE_TOKEN'), 'LEGAL_SOURCE_TOKEN env set');
  console.log('  env vars: OK');

  global.fetch = originalFetch;
  console.log('All build-site tests passed.');
}

runTest().catch(e => { console.error('TEST FAILED:', e); process.exit(1); });
