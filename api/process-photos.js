// /api/process-photos — processes a client's uploaded photos: resize, alt text, service tagging, screening.
//
// POST with { "code": "..." } and x-bb-secret header.
//
// For each unprocessed photo in the client's storage folder:
//   1. Download it from Supabase Storage
//   2. Resize to max 1600px wide (when sharp is available, otherwise skipped)
//   3. Call Claude Haiku to generate alt text, tag by service, and screen for unsuitable content
//   4. Upload the processed version back to storage under {id}/processed/
//   5. Save the metadata to the client's row
//
// Needs: BB_INTERNAL_SECRET, ANTHROPIC_API_KEY, plus the two Supabase variables.
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const BUCKET = 'client-photos';
const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';
const HAIKU_MODEL = 'claude-haiku-5-5';

const baseUrl = () => String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const secret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const anthropicKey = () => String(process.env.ANTHROPIC_API_KEY || '').trim();

function storageHeaders() {
  const key = secret();
  return { apikey: key, Authorization: 'Bearer ' + key };
}

async function listPhotos(clientId) {
  const res = await fetch(baseUrl() + '/storage/v1/object/list/' + BUCKET, {
    method: 'POST',
    headers: { ...storageHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: clientId + '/', limit: 100 }),
  });
  if (!res.ok) return [];
  const files = await res.json();
  return (files || []).filter(function (f) { return f.name && /\.jpe?g$/i.test(f.name) && !f.name.startsWith('processed/'); });
}

async function downloadPhoto(path) {
  const res = await fetch(baseUrl() + '/storage/v1/object/' + BUCKET + '/' + encodeURIComponent(path), {
    headers: storageHeaders(),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function uploadProcessed(path, buffer) {
  const res = await fetch(baseUrl() + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { ...storageHeaders(), 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: buffer,
  });
  return res.ok;
}

async function resizeIfPossible(buffer) {
  try {
    var sharp = require('sharp');
    var meta = await sharp(buffer).metadata();
    if (meta.width && meta.width > 1600) {
      return { buffer: await sharp(buffer).resize(1600, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(), resized: true };
    }
    return { buffer: await sharp(buffer).jpeg({ quality: 80 }).toBuffer(), resized: true };
  } catch (e) {
    return { buffer: buffer, resized: false };
  }
}

async function analyzePhoto(imageBase64, services) {
  var key = anthropicKey();
  if (!key) return { alt: '', service_tag: '', suitable: true, reason: '', error: 'no_api_key' };

  var serviceList = services.length ? services.join(', ') : 'general contractor work';
  var prompt = 'You are looking at a photo uploaded by a contractor for their business website gallery.\n\n'
    + 'Do three things:\n\n'
    + '1. Write a one-sentence alt text describing what the photo shows. Mention the type of work if visible. Keep it under 120 characters. No quotes.\n\n'
    + '2. Decide if the photo is suitable for a contractor website gallery. Flag as unsuitable if it shows recognizable faces, license plates, house numbers, is very blurry or too dark, or is unrelated to contractor work.\n\n'
    + '3. Tag it with the most relevant service from this list: ' + serviceList + '. If none fit, use "general".\n\n'
    + 'Reply with ONLY this JSON:\n{"alt": "...", "suitable": true, "reason": "", "service_tag": "..."}';

  try {
    var res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 256,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
          { type: 'text', text: prompt },
        ]}],
      }),
    });
    if (!res.ok) return { alt: '', service_tag: '', suitable: true, reason: '', error: 'haiku_' + res.status };
    var data = await res.json();
    var text = (data.content && data.content[0] && data.content[0].text) || '';
    var cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    var parsed = JSON.parse(cleaned);
    return {
      alt: String(parsed.alt || '').slice(0, 120),
      service_tag: String(parsed.service_tag || 'general').toLowerCase(),
      suitable: parsed.suitable !== false,
      reason: String(parsed.reason || ''),
    };
  } catch (e) {
    return { alt: '', service_tag: '', suitable: true, reason: '', error: e.message };
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  var code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: 'code_required' });

  try {
    var rows = await sb('client_onboarding?code=eq.' + encodeURIComponent(code) + '&select=id,prefill,answers,processed_photos&limit=1');
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    var client = rows[0];
    var answers = Object.assign({}, client.prefill || {}, client.answers || {});
    var services = Array.isArray(answers.services) ? answers.services : [];
    var alreadyProcessed = new Set((client.processed_photos || []).map(function (p) { return p.name; }));

    var files = await listPhotos(client.id);
    var toProcess = files.filter(function (f) { return !alreadyProcessed.has(f.name); });

    if (!toProcess.length) {
      return res.status(200).json({ ok: true, processed: 0, flagged: 0, skipped: files.length, photos: client.processed_photos || [], message: 'All photos are already processed.' });
    }

    var results = [];
    var flagged = 0;
    var resizeAvailable = true;

    for (var i = 0; i < toProcess.length; i++) {
      var file = toProcess[i];
      var path = client.id + '/' + file.name;
      var raw = await downloadPhoto(path);
      if (!raw) { results.push({ name: file.name, error: 'download_failed' }); continue; }

      var r = await resizeIfPossible(raw);
      if (!r.resized) resizeAvailable = false;

      var base64 = r.buffer.toString('base64');
      var analysis = await analyzePhoto(base64, services);

      var processedPath = client.id + '/processed/' + file.name;
      var uploaded = await uploadProcessed(processedPath, r.buffer);

      var result = {
        name: file.name,
        alt: analysis.alt,
        service_tag: analysis.service_tag,
        suitable: analysis.suitable,
        reason: analysis.reason,
        url: uploaded ? (baseUrl() + '/storage/v1/object/public/' + BUCKET + '/' + processedPath) : '',
        processed_at: new Date().toISOString(),
      };
      if (analysis.error) result.analysis_error = analysis.error;
      if (!analysis.suitable) flagged++;
      results.push(result);
    }

    var allPhotos = (client.processed_photos || []).concat(results.filter(function (r) { return !r.error; }));
    await sb('client_onboarding?id=eq.' + client.id, {
      method: 'PATCH',
      body: JSON.stringify({ processed_photos: allPhotos }),
    });

    if (flagged > 0) {
      var bizName = answers.business_name || code;
      var reasons = results.filter(function (r) { return !r.suitable; }).map(function (r) { return r.reason; }).filter(Boolean).join('; ');
      sendAlert('Photos flagged', flagged + ' photo' + (flagged === 1 ? '' : 's') + ' from ' + bizName + (flagged === 1 ? ' was' : ' were') + ' flagged: ' + (reasons || 'see the processed photos list')).catch(function () {});
    }

    return res.status(200).json({ ok: true, processed: results.filter(function (r) { return !r.error; }).length, flagged: flagged, resize_available: resizeAvailable, photos: results });
  } catch (e) {
    console.error('process-photos', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
