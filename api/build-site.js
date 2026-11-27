// /api/build-site — creates a client's website from start to finish.
//
// POST with { "code": "..." } and x-bb-secret header.
//
// Steps:
//   1. Look up the client in Supabase
//   2. Generate client.json from their onboarding answers
//   3. Create the GitHub repo from the template
//   4. Write client.json to the new repo
//   5. Create a Vercel project for the repo
//   6. Set environment variables on the Vercel project
//   7. Create a deploy hook for the A2P approval trigger
//   8. Trigger the first deploy
//   9. Save everything back to Supabase
//
// Add ?with_copy=true to also run the copy writer (takes several minutes).
//
// Needs: BB_INTERNAL_SECRET, GITHUB_TOKEN, VERCEL_TOKEN, VERCEL_TEAM_ID,
//        LEGAL_SOURCE_TOKEN, plus the two Supabase variables.
const { sb, allowed, configured } = require('./_sb');
const { buildClientJson } = require('./client-json');
const { checkDomains, registerDomain } = require('./domain');

const cfAccount = () => (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();

const TABLE = 'client_onboarding';
const CODE = /^[a-f0-9]{16,32}$/;
const ORG = 'BuildBoostersHQ';
const TEMPLATE = 'client-templates';

function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function repoName(row) {
  const a = { ...(row.prefill || {}), ...(row.answers || {}) };
  const biz = a.business_name || '';
  const city = a.address ? (a.address.match(/,\s*([A-Za-z\s]+),?\s*[A-Z]{2}/) || [])[1] || '' : '';
  const slug = slugify(`${biz} ${city}`.trim()).slice(0, 60).replace(/-+$/, '');
  return slug || `client-${row.code.slice(0, 8)}`;
}

const ghHeaders = () => ({
  Authorization: `token ${process.env.GITHUB_TOKEN}`,
  Accept: 'application/vnd.github.v3+json',
  'Content-Type': 'application/json',
  'X-GitHub-Api-Version': '2022-11-28',
});

const vcHeaders = () => ({
  Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
  'Content-Type': 'application/json',
});

const vcQuery = () => process.env.VERCEL_TEAM_ID ? `?teamId=${process.env.VERCEL_TEAM_ID}` : '';

async function patch(id, fields) {
  await sb(`${TABLE}?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify(fields) });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  // Check config
  if (!configured() || !process.env.BB_INTERNAL_SECRET)
    return res.status(500).json({ error: 'not_configured', reason: 'Supabase or BB_INTERNAL_SECRET not set' });
  if (!allowed(req))
    return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.GITHUB_TOKEN)
    return res.status(500).json({ error: 'not_configured', reason: 'GITHUB_TOKEN is not set' });
  if (!process.env.VERCEL_TOKEN)
    return res.status(500).json({ error: 'not_configured', reason: 'VERCEL_TOKEN is not set' });

  const withCopy = 'with_copy' in (req.query || {});
  const withGhl = 'with_ghl' in (req.query || {});
  const withDns = 'with_dns' in (req.query || {});

  try {
    const code = String((req.body && req.body.code) || '');
    if (!CODE.test(code)) return res.status(400).json({ error: 'bad_request', reason: 'missing or invalid code' });

    // ---- Step 1: Look up the client ----
    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.site_repo) return res.status(409).json({ error: 'already_built', repo: row.site_repo });

    const clientId = row.id;
    const name = repoName(row);
    const fullRepo = `${ORG}/${name}`;

    // ---- Step 2: Generate client.json ----
    let clientJson;
    try {
      const result = buildClientJson(row);
      clientJson = result.client_json;
    } catch (e) {
      return res.status(500).json({ error: 'build_failed', step: 'generate_client_json', reason: e.message });
    }

    // ---- Step 3: Create the GitHub repo from the template ----
    let repoCreated = false;
    const ghRes = await fetch(`https://api.github.com/repos/${ORG}/${TEMPLATE}/generate`, {
      method: 'POST',
      headers: ghHeaders(),
      body: JSON.stringify({ owner: ORG, name, private: true, description: `Client site for ${clientJson.business?.name || name}` }),
    });

    if (ghRes.status === 201) {
      repoCreated = true;
    } else if (ghRes.status === 422) {
      // 422 means the repo name already exists. Check if it is ours.
      const checkRes = await fetch(`https://api.github.com/repos/${fullRepo}`, { headers: ghHeaders() });
      if (checkRes.ok) {
        repoCreated = true; // Already exists, proceed to write client.json
      } else {
        const text = await ghRes.text();
        return res.status(500).json({ error: 'build_failed', step: 'create_repo', reason: `GitHub 422: ${text.slice(0, 200)}` });
      }
    } else {
      const text = await ghRes.text();
      return res.status(500).json({ error: 'build_failed', step: 'create_repo', reason: `GitHub ${ghRes.status}: ${text.slice(0, 200)}` });
    }

    // Save partial progress: we have a repo
    await patch(clientId, { site_repo: fullRepo });

    // Template repos take a moment to generate. Wait for the repo to be ready.
    for (let i = 0; i < 12; i++) {
      const check = await fetch(`https://api.github.com/repos/${fullRepo}`, { headers: ghHeaders() });
      if (check.ok) {
        const data = await check.json();
        if (!data.is_template) break; // Generated repo won't be a template
        if (data.size > 0) break; // Has content
      }
      await new Promise((r) => setTimeout(r, 5000));
    }

    // ---- Step 4: Write client.json to the new repo ----
    // First check if client.json already exists (template ships a default one)
    let existingSha = null;
    const existsRes = await fetch(`https://api.github.com/repos/${fullRepo}/contents/client.json`, { headers: ghHeaders() });
    if (existsRes.ok) {
      const existing = await existsRes.json();
      existingSha = existing.sha;
    }

    const content = Buffer.from(JSON.stringify(clientJson, null, 2) + '\n').toString('base64');
    const writeBody = {
      message: 'Set up client.json from onboarding answers',
      content,
      ...(existingSha ? { sha: existingSha } : {}),
    };

    const writeRes = await fetch(`https://api.github.com/repos/${fullRepo}/contents/client.json`, {
      method: 'PUT',
      headers: ghHeaders(),
      body: JSON.stringify(writeBody),
    });

    if (!writeRes.ok) {
      const text = await writeRes.text();
      return res.status(500).json({ error: 'build_failed', step: 'write_client_json', reason: `GitHub ${writeRes.status}: ${text.slice(0, 200)}` });
    }

    // ---- Step 5: Create a Vercel project ----
    let projectId;
    const vcCreateRes = await fetch(`https://api.vercel.com/v10/projects${vcQuery()}`, {
      method: 'POST',
      headers: vcHeaders(),
      body: JSON.stringify({
        name,
        framework: 'nextjs',
        gitRepository: { type: 'github', repo: fullRepo },
      }),
    });

    if (vcCreateRes.ok) {
      const data = await vcCreateRes.json();
      projectId = data.id;
    } else if (vcCreateRes.status === 409) {
      // Project already exists. Look it up.
      const lookupRes = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(name)}${vcQuery()}`, { headers: vcHeaders() });
      if (lookupRes.ok) {
        const data = await lookupRes.json();
        projectId = data.id;
      } else {
        const text = await vcCreateRes.text();
        return res.status(500).json({ error: 'build_failed', step: 'create_vercel_project', reason: `Vercel 409 and lookup failed: ${text.slice(0, 200)}` });
      }
    } else {
      const text = await vcCreateRes.text();
      return res.status(500).json({ error: 'build_failed', step: 'create_vercel_project', reason: `Vercel ${vcCreateRes.status}: ${text.slice(0, 200)}` });
    }

    await patch(clientId, { site_project_id: projectId });

    // ---- Step 6: Set environment variables ----
    const envVars = [
      { key: 'BB_CLIENT_CODE', value: code, target: ['production', 'preview'], type: 'encrypted' },
    ];
    if (process.env.LEGAL_SOURCE_TOKEN) {
      envVars.push({ key: 'LEGAL_SOURCE_TOKEN', value: process.env.LEGAL_SOURCE_TOKEN, target: ['production', 'preview'], type: 'encrypted' });
    }

    for (const env of envVars) {
      const envRes = await fetch(`https://api.vercel.com/v10/projects/${projectId}/env${vcQuery()}`, {
        method: 'POST',
        headers: vcHeaders(),
        body: JSON.stringify(env),
      });
      // 409 means it already exists, which is fine
      if (!envRes.ok && envRes.status !== 409) {
        const text = await envRes.text();
        console.error(`build-site: env ${env.key} failed: ${envRes.status} ${text.slice(0, 200)}`);
        // Non-fatal: continue, the deploy may still work
      }
    }

    // ---- Step 7: Create a deploy hook ----
    let deployHookUrl = row.site_deploy_hook || '';
    if (!deployHookUrl) {
      // Vercel deploy hooks: POST /v1/projects/{projectId}/deploy-hooks
      const hookRes = await fetch(`https://api.vercel.com/v1/projects/${projectId}/deploy-hooks${vcQuery()}`, {
        method: 'POST',
        headers: vcHeaders(),
        body: JSON.stringify({ name: 'a2p-approval', ref: 'main' }),
      });

      if (hookRes.ok) {
        const hookData = await hookRes.json();
        // The URL is constructed from the id: https://api.vercel.com/v1/integrations/deploy/{hookId}
        deployHookUrl = hookData.url || `https://api.vercel.com/v1/integrations/deploy/${hookData.id}`;
      } else {
        const text = await hookRes.text();
        console.error(`build-site: deploy hook failed: ${hookRes.status} ${text.slice(0, 200)}`);
        // Non-fatal: the site will deploy but A2P approval won't auto-trigger a rebuild
      }
    }

    // ---- Step 8: Register domain if provided ----
    // Pass { domain: "example.com" } to register and assign it.
    // The domain gets registered through Cloudflare Registrar and added to the Vercel project.
    let registeredDomain = row.site_domain || null;
    const requestedDomain = req.body && req.body.domain;
    if (requestedDomain && !registeredDomain && cfAccount() && process.env.CLOUDFLARE_API_TOKEN) {
      try {
        // Check availability first
        const checked = await checkDomains([requestedDomain]);
        const info = checked[0];
        if (info && info.registrable) {
          const regResult = await registerDomain(requestedDomain);
          if (regResult && (regResult.state === 'succeeded' || regResult.state === 'pending' || regResult.completed)) {
            registeredDomain = requestedDomain;
            // Add the domain to the Vercel project
            try {
              await fetch(`https://api.vercel.com/v10/projects/${projectId}/domains${vcQuery()}`, {
                method: 'POST',
                headers: vcHeaders(),
                body: JSON.stringify({ name: requestedDomain }),
              });
            } catch (e) {
              console.error('build-site: Vercel domain assignment failed:', e.message);
            }
          }
        } else {
          console.error(`build-site: domain ${requestedDomain} not registrable: ${info?.reason || 'unknown'}`);
        }
      } catch (e) {
        console.error('build-site: domain registration failed:', e.message);
        // Non-fatal: the site works fine on the Vercel subdomain
      }
    }

    // ---- Step 9: Save everything to Supabase ----
    const now = new Date().toISOString();
    await patch(clientId, {
      site_repo: fullRepo,
      site_project_id: projectId,
      site_deploy_hook: deployHookUrl || null,
      site_created_at: now,
      ...(registeredDomain ? { site_domain: registeredDomain, domain_registered_at: now } : {}),
    });

    // ---- Step 9: Trigger the first deploy ----
    if (deployHookUrl) {
      await fetch(deployHookUrl, { method: 'POST', body: '{}' }).catch((e) => {
        console.error('build-site: deploy hook call failed:', e.message);
      });
    }

    // ---- Optional: Run the copy writer ----
    // The copy writer calls the Anthropic API and takes several minutes. It is a separate step
    // so the site can go live as thin immediately while the copy is being written. Once the copy
    // is ready, the site is updated and rebuilt.
    //
    // To include copy in this call, add ?with_copy=true. The site will still deploy thin first,
    // then update with the copy and redeploy.
    let copyResult = null;
    if (withCopy && process.env.ANTHROPIC_API_KEY) {
      try {
        const baseUrl = process.env.VERCEL_URL
          ? `https://${process.env.VERCEL_URL}`
          : process.env.BB_API_URL || 'https://buildboosters.com';
        const copyRes = await fetch(`${baseUrl}/api/write-copy`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-bb-secret': process.env.BB_INTERNAL_SECRET,
          },
          body: JSON.stringify({ code }),
        });
        if (copyRes.ok) {
          const copyData = await copyRes.json();
          if (copyData.ok && copyData.copy) {
            copyResult = copyData.copy;
            // Merge the copy into client.json and push an update
            if (copyResult.about) clientJson.content.about = copyResult.about;
            if (copyResult.faq) clientJson.content.faq = copyResult.faq;
            if (copyResult.services) {
              for (const sc of copyResult.services) {
                const svc = clientJson.content.services.find(
                  (s) => s.name.toLowerCase() === sc.name.toLowerCase()
                );
                if (svc) {
                  if (sc.blurb) svc.blurb = sc.blurb;
                  if (sc.page) Object.assign(svc.page, sc.page);
                }
              }
            }
            if (copyResult.areas) {
              for (const ac of copyResult.areas) {
                const area = clientJson.business.serviceArea.find(
                  (x) => (typeof x === 'string' ? x : x.city || '').toLowerCase() === (ac.city || ac.name || '').toLowerCase()
                );
                if (area && typeof area === 'object' && ac.page) {
                  Object.assign(area.page || (area.page = {}), ac.page);
                }
              }
            }

            // Push updated client.json
            const getRes = await fetch(`https://api.github.com/repos/${fullRepo}/contents/client.json`, { headers: ghHeaders() });
            if (getRes.ok) {
              const current = await getRes.json();
              const updatedContent = Buffer.from(JSON.stringify(clientJson, null, 2) + '\n').toString('base64');
              await fetch(`https://api.github.com/repos/${fullRepo}/contents/client.json`, {
                method: 'PUT',
                headers: ghHeaders(),
                body: JSON.stringify({ message: 'Add page copy from the copy writer', content: updatedContent, sha: current.sha }),
              });
              // Trigger another deploy with the full copy
              if (deployHookUrl) {
                await fetch(deployHookUrl, { method: 'POST', body: '{}' }).catch(() => {});
              }
            }
          }
        }
      } catch (e) {
        console.error('build-site: copy writer failed:', e.message);
        // Non-fatal: the site is live as thin, copy can be added later
      }
    }

    // ---- Optional: Set up GHL sub-account ----
    let ghlResult = null;
    if (withGhl && process.env.GHL_AGENCY_API_KEY && !row.ghl_location_id) {
      try {
        const host = req.headers?.host || 'buildboosters.com';
        const proto = host.includes('localhost') ? 'http' : 'https';
        const ghlRes = await fetch(`${proto}://${host}/api/ghl-setup`, {
          method: 'POST',
          headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify({ code }),
        });
        ghlResult = await ghlRes.json().catch(() => ({}));
      } catch (e) {
        console.error('build-site: ghl-setup failed:', e.message);
      }
    }

    // ---- Optional: Set up DNS ----
    let dnsResult = null;
    if ((withDns || registeredDomain) && registeredDomain && process.env.CLOUDFLARE_API_TOKEN) {
      try {
        const host = req.headers?.host || 'buildboosters.com';
        const proto = host.includes('localhost') ? 'http' : 'https';
        const dnsRes = await fetch(`${proto}://${host}/api/dns-setup`, {
          method: 'POST',
          headers: { 'x-bb-secret': process.env.BB_INTERNAL_SECRET, 'Content-Type': 'application/json' },
          body: JSON.stringify({ domain: registeredDomain, code }),
        });
        dnsResult = await dnsRes.json().catch(() => ({}));
      } catch (e) {
        console.error('build-site: dns-setup failed:', e.message);
      }
    }

    return res.status(200).json({
      ok: true,
      repo: fullRepo,
      projectId,
      deployHookUrl: deployHookUrl || null,
      domain: registeredDomain || null,
      copyWritten: !!copyResult,
      ghl: ghlResult,
      dns: dnsResult,
    });
  } catch (e) {
    console.error('build-site', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};

// Exported for testing
module.exports.slugify = slugify;
module.exports.repoName = repoName;
