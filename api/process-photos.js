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
const HAIKU_MODEL = 'claude-haiku-4-20250514';

const baseUrl = () => String(process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/rest\/v1$/, '');
const secret = () => String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const anthropicKey = () => String(process.env.ANTHROPIC_API_KEY || '').trim();

function storageHeaders() {
  const key = secret();
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function listPhotos(clientId) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: { ...storageHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: `${clientId}/`, limit: 100 }),
  });
  if (!res.ok) return [];
  const files = await res.json();
  // Filter to only jpg files in the root (not in processed/)
  return (files || []).filter(f => f.name && /\.jpe?g$/i.test(f.name) && !f.name.startsWith('processed/'));
}

async function downloadPhoto(path) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/${BUCKET}/${encodeURIComponent(path)}`, {
    headers: storageHeaders(),
  });
  if (!res.ok) return null;
  return Buffer.from(await res.arrayBuffer());
}

async function uploadProcessed(path, buffer) {
  const res = await fetch(`${baseUrl()}/storage/v1/object/${BUCKET}/${path}`, {
    method: 'POST',
    headers: { ...storageHeaders(), 'Content-Type': 'image/jpeg', 'x-upsert': 'true' },
    body: buffer,
  });
  return res.ok;
}

async function resizeIfPossible(buffer) {
  try {
    const sharp = require('sharp');
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.width > 1600) {
      return { buffer: await sharp(buffer).resize(1600, null, { withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer(), resized: true };
    }
    return { buffer: await sharp(buffer).jpeg({ quality: 80 }).toBuffer(), resized: true };
  } catch {
    // sharp not available on this runtime
    return { buffer, resized: false };
  }
}

async function analyzePhoto(imageBase64, services) {
  const key = anthropicKey();
  if (!key) return { alt: '', service_tag: '', suitable: true, reason: '', error: 'no_api_key' };

  const serviceList = services.length ? services.join(', ') : 'general contractor work';
  const prompt = `You are looking at a photo uploaded by a contractor for their business website gallery.

Do two things:

1. Write a one-sentence alt text describing what the photo shows. Mention the type of work if visible. Keep it under 120 characters. No quotes around it.

2. Decide if this photo is suitable for a contractor's website gallery. Flag it as unsuitable if it shows:
   - Recognizable faces (close enough to identify someone)
   - License plates
   - House numbers or street addresses
   - Is very blurry or too dark to see the work
   - Is not related to contractor work at all (selfies, screenshots, memes)

3. Tag it with the most relevant service from this list: ${serviceList}. If none fit, use "general".

Reply with ONLY this JSON, no other text:
{"alt": "...", "suitable": true or false, "reason": "why it was flagged, or empty string", "service_tag": "..."}`;

  try {
    const res = await fetch(ANTHROPIC_API, {
      method: 'POST',
      headers: {
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: HAIKU_MODEL,
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageBase64 } },
            { type: 'text', text: prompt },
          ],
        }],
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      return { alt: '', service_tag: '', suitable: true, reason: '', error: `haiku_${res.status}` };
    }
    const data = await res.json();
    const text = (data.content && data.content[0] && data.content[0].text) || '';
    // Parse JSON from the response, handling possible markdown fencing
    const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned);
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

  const code = String((req.body && req.body.code) || '').trim();
  if (!code) return res.status(400).json({ error: 'code_required' });

  try {
    // Look up the client
    const rows = await sb(`client_onboarding?code=eq.${encodeURIComponent(code)}&select=id,prefill,answers,processed_photos&limit=1`);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const client = rows[0];
    const answers = { ...(client.prefill || {}), ...(client.answers || {}) };
    const services = Array.isArray(answers.services) ? answers.services : [];
    const alreadyProcessed = new Set((client.processed_photos || []).map(p => p.name));

    // List photos in storage
    const files = await listPhotos(client.id);
    const toProcess = files.filter(f => !alreadyProcessed.has(f.name));

    if (!toProcess.length) {
      return res.status(200).json({ ok: true, processed: 0, flagged: 0, skipped: files.length, photos: client.processed_photos || [], message: 'All photos are already processed.' });
    }

    const results = [];
    let flagged = 0;
    let resizeAvailable = true;

    for (const file of toProcess) {
      const path = `${client.id}/${file.name}`;
      const raw = await downloadPhoto(path);
      if (!raw) { results.push({ name: file.name, error: 'download_failed' }); continue; }

      // Resize
      const { buffer: processed, resized } = await resizeIfPossible(raw);
      if (!resized) resizeAvailable = false;

      // Analyze with Haiku
      const base64 = processed.toString('base64');
      const analysis = await analyzePhoto(base64, services);

      // Upload processed version
      const processedPath = `${client.id}/processed/${file.name}`;
      const uploaded = await uploadProcessed(processedPath, processed);

      const publicUrl = `${baseUrl()}/storage/v1/object/public/${BUCKET}/${processedPath}`;

      const result = {
        name: file.name,
        alt: analysis.alt,
        service_tag: analysis.service_tag,
        suitable: analysis.suitable,
        reason: analysis.reason,
        url: uploaded ? publicUrl : '',
        processed_at: new Date().toISOString(),
      };
      if (analysis.error) result.analysis_error = analysis.error;
      if (!analysis.suitable) flagged++;
      results.push(result);
    }

    // Merge with existing processed photos and save
    const allPhotos = [...(client.processed_photos || []), ...results.filter(r => !r.error)];
    await sb(`client_onboarding?id=eq.${client.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ processed_photos: allPhotos }),
    });

    // Alert on flagged photos
    if (flagged > 0) {
      const bizName = answers.business_name || code;
      const reasons = results.filter(r => !r.suitable).map(r => r.reason).filter(Boolean).join('; ');
      sendAlert('Photos flagged', `${flagged} photo${flagged === 1 ? '' : 's'} from ${bizName} ${flagged === 1 ? 'was' : 'were'} flagged: ${reasons || 'see the processed photos list'}`).catch(() => {});
    }

    return res.status(200).json({
      ok: true,
      processed: results.filter(r => !r.error).length,
      flagged,
      resize_available: resizeAvailable,
      photos: results,
    });
  } catch (e) {
    console.error('process-photos', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || 'unknown' });
  }
};
