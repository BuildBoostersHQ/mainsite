// Tests for the secure key link: encryption, expiry and single use.
const crypto = require('crypto');
const { secretsKey, encrypt, decrypt, stateOf, cleanValue, cleanLabel, newToken, MAX_VALUE } = require('../api/client-secret.js');
let failed = 0;
const ok = (name, cond) => { console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}`); if (!cond) failed++; };
const throws = (fn) => { try { fn(); return false; } catch (e) { return true; } };

// ---- the key from the env var ----
const b64 = crypto.randomBytes(32).toString('base64');
const key = secretsKey(b64);
ok('32 random bytes in base64 is a key', Buffer.isBuffer(key) && key.length === 32);
ok('spaces around the env var are ignored', secretsKey(`  ${b64}\n`).equals(key));
ok('no env var is no key', secretsKey('') === null && secretsKey(undefined) === null);
ok('a short key is refused', secretsKey(crypto.randomBytes(16).toString('base64')) === null);
ok('a plain password is refused', secretsKey('hunter2') === null);

// ---- encryption round trip ----
const secret = 'hcp_live_9f8a7b6c5d4e3f2a1b0c ünïcode ok';
const enc = encrypt(secret, key, 'row-1');
ok('round trip gives the same value back', decrypt(enc, key, 'row-1') === secret);
ok('iv, tag and ciphertext are base64 strings', ['iv', 'tag', 'ciphertext'].every((k) => typeof enc[k] === 'string' && /^[A-Za-z0-9+/]+=*$/.test(enc[k])));
ok('iv is 12 bytes and tag is 16', Buffer.from(enc.iv, 'base64').length === 12 && Buffer.from(enc.tag, 'base64').length === 16);
ok('the plain value is not in what gets stored', !JSON.stringify(enc).includes('hcp_live') && !Buffer.from(enc.ciphertext, 'base64').toString('utf8').includes('hcp_live'));
const again = encrypt(secret, key, 'row-1');
ok('a fresh iv every time', again.iv !== enc.iv && again.ciphertext !== enc.ciphertext);
ok('the wrong key cannot read it', throws(() => decrypt(enc, crypto.randomBytes(32), 'row-1')));
ok('it cannot be read from another row', throws(() => decrypt(enc, key, 'row-2')));
const flipped = Buffer.from(enc.ciphertext, 'base64'); flipped[0] ^= 1;
ok('a changed ciphertext is refused', throws(() => decrypt({ ...enc, ciphertext: flipped.toString('base64') }, key, 'row-1')));
ok('a cut-down tag is refused', throws(() => decrypt({ ...enc, tag: Buffer.from(enc.tag, 'base64').subarray(0, 4).toString('base64') }, key, 'row-1')));

// ---- expiry and single use ----
const NOW = Date.parse('2026-11-27T15:00:00Z');
const at = (hours) => new Date(NOW + hours * 3600000).toISOString();
ok('open before it expires', stateOf({ expires_at: at(1), used_at: null }, NOW) === 'open');
ok('expired after seven days', stateOf({ expires_at: at(-1), used_at: null }, NOW) === 'expired');
ok('expired at the exact moment', stateOf({ expires_at: at(0), used_at: null }, NOW) === 'expired');
ok('used once it has a value', stateOf({ expires_at: at(1), used_at: at(-2) }, NOW) === 'used');
ok('used stays used after expiry', stateOf({ expires_at: at(-1), used_at: at(-2) }, NOW) === 'used');
ok('a missing expiry date is treated as expired', stateOf({ expires_at: null, used_at: null }, NOW) === 'expired');

// ---- what the client pasted ----
ok('input is trimmed', cleanValue('  abc123 \n').value === 'abc123');
ok('empty is refused', cleanValue('').error === 'value_required' && cleanValue('   \n').error === 'value_required');
ok('anything but text is refused', cleanValue(undefined).error === 'value_required' && cleanValue({ a: 1 }).error === 'value_required');
ok('4000 characters is kept', cleanValue('x'.repeat(MAX_VALUE)).value.length === 4000);
ok('4001 characters is refused', cleanValue('x'.repeat(MAX_VALUE + 1)).error === 'value_too_long');

// ---- label and token ----
ok('label drops "API key" so the page can say "your Housecall Pro key"', cleanLabel(' Housecall Pro API key ') === 'Housecall Pro' && cleanLabel('Jobber key') === 'Jobber' && cleanLabel('Jobber') === 'Jobber');
const t1 = newToken(), t2 = newToken();
ok('tokens are long, link-safe and different each time', /^[A-Za-z0-9_-]{32}$/.test(t1) && t1 !== t2);

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('All client-secret tests passed.');
