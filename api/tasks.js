// /api/tasks — generates a per-client task list based on what's missing in their setup.
//
// GET  /api/tasks  → { clients: [...] } with stage and task list for each client
//
// Each client gets tasks based on which columns are null or incomplete. The dashboard
// tracks "done" state in localStorage since these are one-time setup tasks.
//
// Internal only (BB_INTERNAL_SECRET).
const { sb, allowed, configured } = require('./_sb');

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

function stage(r) {
  if (r.a2p_registered_at && r.site_repo && r.ghl_location_id) return 'launched';
  if (r.a2p_registered_at) return 'a2p_approved';
  if (r.ghl_location_id && r.a2p_status) return 'a2p_pending';
  if (r.site_repo) return 'site_live';
  if (r.submitted_at && (r.site_repo === null)) return 'form_done';
  if (r.submitted_at) return 'building';
  if (r.created_at) return 'paid';
  return 'unknown';
}

function buildTasks(r) {
  const a = { ...(r.prefill || {}), ...(r.answers || {}) };
  const tasks = [];
  const code = r.code;
  const bizPhone = a.business_phone || a.cell || '';
  const cell = a.cell || a.business_phone || '';

  // High priority tasks
  if (!r.submitted_at) {
    const days = Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000);
    tasks.push({
      id: `${code}:form_not_submitted`,
      title: "Client hasn't filled in their form",
      instructions: `Check if they got the setup link text. Their link is https://buildboosters.com/start/${code}. It has been ${days} day${days === 1 ? '' : 's'} since they paid.${days >= 4 ? ' Call them.' : ''}`,
      priority: 'high',
    });
  }

  if (r.submitted_at && !r.site_repo) {
    tasks.push({
      id: `${code}:site_not_built`,
      title: 'Site not built yet',
      instructions: 'Should have triggered automatically on form submission. Check the Vercel function logs for errors. If needed, trigger manually from the Launch page.',
      priority: 'high',
    });
  }

  if (r.submitted_at && !r.ghl_location_id) {
    tasks.push({
      id: `${code}:no_ghl`,
      title: 'GHL sub-account not created',
      instructions: 'Should have triggered with the site build. Check if GHL_AGENCY_API_KEY, GHL_COMPANY_ID and GHL_SNAPSHOT_ID are set in Vercel. If they are, check the function logs.',
      priority: 'high',
    });
  }

  if (r.ghl_location_id && !r.ghl_phone_number) {
    tasks.push({
      id: `${code}:no_phone`,
      title: 'No phone number bought',
      instructions: `Go to the sub-account in GHL, Settings, Phone Numbers, buy a local number matching their area code (${bizPhone ? bizPhone.replace(/\D/g, '').slice(0, 3) : 'unknown'}).`,
      priority: 'high',
    });
  }

  if (r.ghl_phone_number) {
    tasks.push({
      id: `${code}:call_forwarding`,
      title: 'Configure call forwarding',
      instructions: `Go to the sub-account, Settings, Phone Numbers, click the three dots on ${r.ghl_phone_number}, Edit Configuration. Set "Forward Calls To" to ${bizPhone || 'their business phone'}. Check "Ring Incoming Call To All Users". Click Save.`,
      priority: 'high',
    });
  }

  if (r.ghl_location_id && !r.google_approved_at) {
    tasks.push({
      id: `${code}:no_gmb`,
      title: 'Connect their Google Business Profile',
      instructions: 'Go to the sub-account, Settings, Integrations, click "Sign in with Google" using buildboostersgmb@gmail.com. Connect their business profile. Then come back here and mark this done.',
      priority: 'high',
    });
  }

  // Medium priority
  if (r.google_approved_at && !r.ghl_review_widget_id) {
    tasks.push({
      id: `${code}:no_review_widget`,
      title: 'Get review widget ID',
      instructions: 'Go to the sub-account, Reputation, Widgets. Copy the widget ID from the embed code. Save it to their ghl_review_widget_id column in Supabase.',
      priority: 'medium',
    });
  }

  if (r.site_repo && !r.site_domain && a.domain_own) {
    tasks.push({
      id: `${code}:own_domain`,
      title: 'Waiting on them to point their own domain',
      instructions: `They want to use ${a.domain_own}. Their steps are at https://buildboosters.com/connect-domain/${code}. This task clears on its own once the domain points at the site.`,
      priority: 'medium',
    });
  } else if (r.site_repo && !r.site_domain) {
    tasks.push({
      id: `${code}:no_domain`,
      title: 'No domain registered',
      instructions: `Search for domains at /api/domain?action=search&q=${encodeURIComponent(a.business_name || '')} or use action "suggest" with their code to see options, then register one.`,
      priority: 'medium',
    });
  }

  // Low priority
  if (!r.a2p_registered_at && r.ghl_location_id) {
    const statusNote = r.a2p_status ? ` Current status: ${r.a2p_status.replace(/_/g, ' ')}.` : '';
    tasks.push({
      id: `${code}:a2p_pending`,
      title: 'A2P not approved yet',
      instructions: `Check the Launch page for their status.${statusNote} If rejected, look at the reason and resubmit.`,
      priority: 'low',
    });
  }

  if (r.site_repo && (r.photo_count || 0) < 3) {
    tasks.push({
      id: `${code}:needs_photos`,
      title: 'Needs more photos',
      instructions: `They have ${r.photo_count || 0} photo${(r.photo_count || 0) === 1 ? '' : 's'}. Text them asking for job photos.${cell ? ` Their cell: ${cell}` : ''}`,
      priority: 'low',
    });
  }

  if (!r.video_url) {
    tasks.push({
      id: `${code}:no_video`,
      title: 'No personalized video',
      instructions: 'Film a 30-second video for this client welcoming them and add the URL to their video_url column in Supabase.',
      priority: 'low',
    });
  }

  return tasks;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET) return res.status(500).json({ error: 'not_configured' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });

  try {
    const rows = await sb('client_onboarding?select=*&order=created_at.desc&limit=500');

    const clients = rows.map(r => {
      const a = { ...(r.prefill || {}), ...(r.answers || {}) };
      const tasks = buildTasks(r);
      const openTasks = tasks.length;
      const highCount = tasks.filter(t => t.priority === 'high').length;

      return {
        code: r.code,
        business_name: a.business_name || r.owner_first_name || r.code.slice(0, 8),
        owner_first_name: r.owner_first_name || '',
        tier: r.tier || 'unknown',
        created_at: r.created_at,
        stage: stage(r),
        tasks,
        open_tasks: openTasks,
        high_priority: highCount,
        sort_score: highCount * 100 + openTasks,
      };
    });

    // Sort by most urgent first
    clients.sort((a, b) => b.sort_score - a.sort_score);

    const totalTasks = clients.reduce((n, c) => n + c.open_tasks, 0);
    const totalHigh = clients.reduce((n, c) => n + c.high_priority, 0);

    return res.status(200).json({
      ok: true,
      summary: {
        clients: clients.length,
        total_tasks: totalTasks,
        high_priority: totalHigh,
      },
      clients,
    });
  } catch (e) {
    console.error('tasks', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};
