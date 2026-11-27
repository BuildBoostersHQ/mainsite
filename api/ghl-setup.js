// /api/ghl-setup — automates GHL sub-account creation and configuration for a new client.
//
// POST /api/ghl-setup  { code: "client-code" }
//
// Steps it automates:
//   1. Create a sub-account from the BB Template snapshot
//   2. List and fill all 16 custom values from the client's onboarding answers
//   3. Search for and buy a local phone number matching the client's area code
//   4. Add the contractor as a restricted user
//   5. Set chat widget colors to match the client's brand color
//   6. Save the ghl_location_id back to Supabase
//   7. Alert Maddie with the remaining manual steps
//
// What still needs manual work after this runs (~3 minutes):
//   - Configure call forwarding on the phone number (no API for this)
//   - Connect GMB through Settings > Integrations (OAuth flow, no API)
//   - Update GMB phone to the toll-free number (through GHL's GBP tab)
//   Reputation management auto-responses come pre-set in the snapshot.
//
// Needs: GHL_AGENCY_API_KEY, GHL_COMPANY_ID, GHL_SNAPSHOT_ID,
//        BB_INTERNAL_SECRET, plus the two Supabase variables.
const crypto = require('crypto');
const { sb, allowed, configured } = require('./_sb');
const { sendAlert } = require('./alert');

const GHL = 'https://services.leadconnectorhq.com';
const TABLE = 'client_onboarding';
const CODE = /^[a-f0-9]{16,64}$/i;

function ghlAgencyHeaders() {
  return {
    Authorization: `Bearer ${(process.env.GHL_AGENCY_API_KEY || '').trim()}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

function ghlHeaders() {
  return {
    Authorization: `Bearer ${(process.env.GHL_API_KEY || '').trim()}`,
    Version: '2021-07-28',
    'Content-Type': 'application/json',
  };
}

function companyId() {
  return (process.env.GHL_COMPANY_ID || '').trim();
}

function snapshotId() {
  return (process.env.GHL_SNAPSHOT_ID || '').trim();
}

// Trade to trade noun mapping
const TRADE_NOUNS = {
  plumbing: 'plumber', painting: 'painter', landscaping: 'landscaper',
  roofing: 'roofer', electrical: 'electrician', hvac: 'HVAC technician',
  handyman: 'handyman', 'junk removal': 'junk removal pro',
  'pressure washing': 'pressure washer', remodeling: 'remodeler',
  cleaning: 'cleaner', 'pest control': 'pest control pro',
  flooring: 'flooring installer', fencing: 'fencing contractor',
  concrete: 'concrete contractor', demolition: 'demolition contractor',
  'tree service': 'arborist', 'garage door': 'garage door technician',
};

function tradeNoun(trade) {
  if (!trade) return '';
  const lower = trade.toLowerCase();
  return TRADE_NOUNS[lower] || `${lower} contractor`;
}

// Extract area code from a US phone number
function areaCode(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  return ten.length === 10 ? ten.slice(0, 3) : '';
}

// ---- Step 1: Create the sub-account from the snapshot ----
async function createSubAccount(clientData) {
  const a = { ...(clientData.prefill || {}), ...(clientData.answers || {}) };
  const name = a.business_name || `Client ${clientData.code.slice(0, 8)}`;
  const phone = a.business_phone ? `+1${a.business_phone.replace(/\D/g, '')}` : '';
  const address = a.address || '';

  // Parse address into components (best effort)
  let city = a.city || a.primary_city || '';
  let state = a.state || '';
  let postalCode = '';
  if (address && !city) {
    const parts = address.split(',').map(s => s.trim());
    if (parts.length >= 2) city = parts[parts.length - 2];
  }

  const body = {
    name,
    companyId: companyId(),
    snapshotId: snapshotId(),
    phone: phone || undefined,
    address: address || undefined,
    city: city || undefined,
    state: state || undefined,
    postalCode: postalCode || undefined,
    country: 'US',
    website: a.domain_choice ? `https://${a.domain_choice}` : undefined,
    prospectInfo: {
      firstName: clientData.owner_first_name || a.preferred_name || 'Owner',
      lastName: a.business_name || 'Client',
      email: a.email || `client-${clientData.code.slice(0, 8)}@buildboosters.com`,
    },
    settings: {
      allowDuplicateContact: false,
      allowDuplicateOpportunity: false,
      allowFacebookNameMerge: false,
      disableContactTimezone: false,
    },
  };

  // Remove undefined fields
  Object.keys(body).forEach(k => body[k] === undefined && delete body[k]);

  const res = await fetch(`${GHL}/locations/`, {
    method: 'POST',
    headers: ghlAgencyHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GHL create sub-account ${res.status}: ${text.slice(0, 300)}`);
  }

  return await res.json();
}

// ---- Step 2: Fill custom values ----
async function fillCustomValues(locationId, clientData) {
  const a = { ...(clientData.prefill || {}), ...(clientData.answers || {}) };
  const trade = a.trade || '';

  // The values to set, keyed by the custom value name as defined in the template
  const values = {
    business_name: a.business_name || '',
    owner_first_name: clientData.owner_first_name || a.preferred_name || '',
    owner_full_name: `${clientData.owner_first_name || a.preferred_name || ''} ${a.last_name || ''}`.trim(),
    business_phone: a.business_phone || '',
    business_email: a.email || '',
    business_address: a.address || '',
    business_state: a.state || '',
    trade: trade,
    trade_noun: tradeNoun(trade),
    primary_city: a.city || a.primary_city || '',
    website_url: a.domain_choice ? `https://${a.domain_choice}` : '',
    review_link: '', // Set manually after GMB is connected
    booking_link: '', // Set manually
    business_hours: a.weekday_hours || '',
    job_software: a.job_software || 'none',
    photo_requests_on: 'yes',
  };

  // First, list existing custom values to get their IDs
  const listRes = await fetch(`${GHL}/locations/${locationId}/customValues`, {
    headers: ghlHeaders(),
  });

  if (!listRes.ok) {
    const text = await listRes.text();
    console.error(`ghl-setup: list custom values failed ${listRes.status}: ${text.slice(0, 200)}`);
    return { filled: 0, failed: 0 };
  }

  const listData = await listRes.json();
  const existing = listData.customValues || [];

  let filled = 0;
  let failed = 0;

  for (const [name, value] of Object.entries(values)) {
    if (!value) continue;

    // Find the matching custom value by name (case-insensitive)
    const cv = existing.find(v =>
      v.name.toLowerCase().replace(/\s+/g, '_') === name.toLowerCase() ||
      v.name.toLowerCase() === name.toLowerCase().replace(/_/g, ' ') ||
      v.fieldKey === `{{custom_values.${name}}}`
    );

    if (cv) {
      // Update existing custom value
      try {
        const updateRes = await fetch(`${GHL}/locations/${locationId}/customValues/${cv.id}`, {
          method: 'PUT',
          headers: ghlHeaders(),
          body: JSON.stringify({ name: cv.name, value }),
        });
        if (updateRes.ok) filled++;
        else {
          failed++;
          console.error(`ghl-setup: update custom value ${name} failed: ${updateRes.status}`);
        }
      } catch (e) {
        failed++;
        console.error(`ghl-setup: update custom value ${name} error: ${e.message}`);
      }
    } else {
      // Create new custom value
      try {
        const createRes = await fetch(`${GHL}/locations/${locationId}/customValues`, {
          method: 'POST',
          headers: ghlHeaders(),
          body: JSON.stringify({ name: name.replace(/_/g, ' '), value }),
        });
        if (createRes.ok) filled++;
        else {
          failed++;
          console.error(`ghl-setup: create custom value ${name} failed: ${createRes.status}`);
        }
      } catch (e) {
        failed++;
        console.error(`ghl-setup: create custom value ${name} error: ${e.message}`);
      }
    }
  }

  return { filled, failed };
}

// ---- Step 3: Search for and buy a local phone number ----
// Local numbers look more legit for contractors than toll-free. A 305 number for a Miami plumber
// reads as "this is a real local guy" which is exactly the brand.
async function buyPhoneNumber(locationId, clientPhone) {
  const ac = areaCode(clientPhone);

  // Search for available local numbers matching the client's area code
  const searchParams = new URLSearchParams({
    numberTypes: 'local',
    smsEnabled: 'true',
    mmsEnabled: 'true',
    voiceEnabled: 'true',
    countryCode: 'US',
    areaCode: ac || '',
  });

  const searchRes = await fetch(
    `${GHL}/phone-system/numbers/location/${locationId}/available?${searchParams}`,
    { headers: ghlHeaders() }
  );

  if (!searchRes.ok) {
    const text = await searchRes.text();
    return { bought: false, reason: `search failed ${searchRes.status}: ${text.slice(0, 200)}` };
  }

  const searchData = await searchRes.json();
  const numbers = searchData.data || searchData.numbers || searchData.result || [];
  if (!Array.isArray(numbers) || numbers.length === 0) {
    return { bought: false, reason: `no local numbers available for area code ${ac || 'any'}` };
  }

  // Pick the first available number
  const chosen = numbers[0];
  const phoneNumber = chosen.phoneNumber || chosen.phone_number || chosen.number || '';
  if (!phoneNumber) {
    return { bought: false, reason: 'no phone number in search results' };
  }

  // Purchase the number
  const fingerprintId = crypto.randomBytes(16).toString('hex');
  const purchaseRes = await fetch(
    `${GHL}/phone-system/numbers/location/${locationId}/purchase`,
    {
      method: 'POST',
      headers: ghlHeaders(),
      body: JSON.stringify({
        phoneNumber,
        countryCode: 'US',
        numberType: 'local',
        fingerprintId,
        skipLocationKYC: true,
        addressSid: '',
        bundleSid: '',
        paymentIntentId: '',
        stripeAccountId: '',
        paymentMethodId: '',
        locality: '',
        region: '',
      }),
    }
  );

  if (!purchaseRes.ok) {
    const text = await purchaseRes.text();
    return { bought: false, reason: `purchase failed ${purchaseRes.status}: ${text.slice(0, 200)}`, number: phoneNumber };
  }

  return { bought: true, number: phoneNumber };
}

// ---- Step 4: Add the contractor as a restricted user ----
async function addContractorUser(locationId, clientData) {
  const a = { ...(clientData.prefill || {}), ...(clientData.answers || {}) };
  const email = a.email || '';
  const firstName = clientData.owner_first_name || a.preferred_name || '';
  const lastName = a.last_name || a.business_name || '';
  const phone = a.cell || a.business_phone || '';
  const fullPhone = phone ? `+1${phone.replace(/\D/g, '')}` : '';

  if (!email) return { added: false, reason: 'no email for the contractor' };

  // Generate a random password they will reset on first login
  const pwd = crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '') + 'Bb1!';

  const body = {
    companyId: companyId(),
    email,
    password: pwd,
    type: 'account',
    role: 'user',
    locationIds: [locationId],
    firstName: firstName || 'Owner',
    lastName: lastName || 'Client',
    phone: fullPhone || undefined,
    platformLanguage: 'en_US',
    permissions: {
      // ON: what they need
      contactsEnabled: true,
      conversationsEnabled: true,
      appointmentsEnabled: true,
      reviewsEnabled: true,
      dashboardStatsEnabled: true,
      phoneCallEnabled: true,
      tagsEnabled: true,
      leadValueEnabled: true,
      // OFF: everything they don't need
      campaignsEnabled: false,
      campaignsReadOnly: false,
      workflowsEnabled: false,
      workflowsReadOnly: false,
      triggersEnabled: false,
      funnelsEnabled: false,
      websitesEnabled: false,
      opportunitiesEnabled: false,
      bulkRequestsEnabled: false,
      onlineListingsEnabled: false,
      settingsEnabled: false,
      marketingEnabled: false,
      agentReportingEnabled: false,
      socialPlanner: false,
      bloggingEnabled: false,
      invoiceEnabled: false,
      affiliateManagerEnabled: false,
      contentAiEnabled: false,
      refundsEnabled: false,
      recordPaymentEnabled: false,
      cancelSubscriptionEnabled: false,
      paymentsEnabled: false,
      communitiesEnabled: false,
      exportPaymentsEnabled: false,
      membershipEnabled: false,
      assignedDataOnly: false,
      adwordsReportingEnabled: false,
      facebookAdsReportingEnabled: false,
      attributionsReportingEnabled: false,
      botService: false,
    },
  };

  // Remove undefined fields
  if (!body.phone) delete body.phone;

  const res = await fetch(`${GHL}/users/`, {
    method: 'POST',
    headers: ghlAgencyHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    return { added: false, reason: `${res.status}: ${text.slice(0, 200)}` };
  }

  const data = await res.json();
  return { added: true, userId: data.id || data.userId };
}

// ---- Main handler ----
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  if (!configured() || !process.env.BB_INTERNAL_SECRET)
    return res.status(500).json({ error: 'not_configured', reason: 'Supabase or BB_INTERNAL_SECRET not set' });
  if (!allowed(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!process.env.GHL_AGENCY_API_KEY)
    return res.status(500).json({ error: 'not_configured', reason: 'GHL_AGENCY_API_KEY not set' });
  if (!companyId())
    return res.status(500).json({ error: 'not_configured', reason: 'GHL_COMPANY_ID not set' });

  try {
    const code = String((req.body && req.body.code) || '');
    if (!CODE.test(code)) return res.status(400).json({ error: 'bad_request', reason: 'missing or invalid code' });

    // Look up the client
    const rows = await sb(`${TABLE}?code=eq.${encodeURIComponent(code)}&select=*&limit=1`);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: 'not_found' });
    if (row.ghl_location_id) return res.status(409).json({ error: 'already_setup', location_id: row.ghl_location_id });

    const a = { ...(row.prefill || {}), ...(row.answers || {}) };
    const bizName = a.business_name || row.owner_first_name || code.slice(0, 8);
    const results = { steps: {} };

    // Step 1: Create sub-account
    let locationId;
    try {
      const location = await createSubAccount(row);
      locationId = location.id || location.locationId;
      results.steps.create_subaccount = { ok: true, location_id: locationId };
    } catch (e) {
      results.steps.create_subaccount = { ok: false, error: e.message };
      await sendAlert('GHL setup failed', `Could not create sub-account for ${bizName}: ${e.message}`).catch(() => {});
      return res.status(500).json({ error: 'ghl_setup_failed', step: 'create_subaccount', reason: e.message, results });
    }

    // Save location ID immediately
    await sb(`${TABLE}?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ghl_location_id: locationId }),
    });

    // Step 2: Fill custom values
    try {
      const cv = await fillCustomValues(locationId, row);
      results.steps.custom_values = { ok: true, ...cv };
    } catch (e) {
      results.steps.custom_values = { ok: false, error: e.message };
    }

    // Step 3: Buy phone number
    let phoneResult;
    try {
      phoneResult = await buyPhoneNumber(locationId, a.business_phone || '');
      results.steps.phone_number = phoneResult;
    } catch (e) {
      results.steps.phone_number = { bought: false, error: e.message };
    }

    // Step 4: Add contractor user
    try {
      const user = await addContractorUser(locationId, row);
      results.steps.add_user = user;
    } catch (e) {
      results.steps.add_user = { added: false, error: e.message };
    }

    // Step 5: Set chat widget colors if brand_color is set
    if (a.brand_color) {
      try {
        // List existing chat widgets
        const widgetListRes = await fetch(`${GHL}/locations/${locationId}/chat-widget`, {
          headers: ghlHeaders(),
        });
        if (widgetListRes.ok) {
          const widgetList = await widgetListRes.json();
          const widgets = widgetList.widgets || widgetList.data || [];
          if (widgets.length > 0) {
            const widget = widgets[0];
            const widgetId = widget.id || widget._id;
            await fetch(`${GHL}/chat-widget/data/${locationId}/${widgetId}`, {
              method: 'PUT',
              headers: ghlHeaders(),
              body: JSON.stringify({
                ...widget,
                widgetPrimaryColor: a.brand_color,
                theme: {
                  ...(widget.theme || {}),
                  colors: {
                    ...(widget.theme?.colors || {}),
                    headerColor: a.brand_color,
                    buttonColor: a.brand_color,
                    chatBubbleColor: a.brand_color,
                    avatarBackgroundColor: a.brand_color,
                    avatarBorderColor: a.brand_color,
                    senderMessageBackgroundColor: a.brand_color,
                  },
                },
              }),
            });
            results.steps.chat_widget = { ok: true, color: a.brand_color };
          } else {
            results.steps.chat_widget = { ok: false, reason: 'no widgets found in sub-account' };
          }
        }
      } catch (e) {
        results.steps.chat_widget = { ok: false, error: e.message };
      }
    }

    // Build the manual steps reminder
    const manualSteps = [];
    if (phoneResult && phoneResult.bought && phoneResult.number) {
      manualSteps.push(`Configure call forwarding on ${phoneResult.number} to ${a.business_phone || 'their business phone'}`);
    } else {
      manualSteps.push('Buy and configure a toll-free number manually');
    }
    manualSteps.push('Connect GMB (Settings > Integrations > Sign in with Google)');
    manualSteps.push('Update GMB phone to the toll-free number');

    // Alert Maddie
    const alertBody = `GHL sub-account created for ${bizName}.\n` +
      `Location ID: ${locationId}\n` +
      `Still manual:\n${manualSteps.map(s => `- ${s}`).join('\n')}`;
    await sendAlert('GHL setup done', alertBody).catch(() => {});

    return res.status(200).json({
      ok: true,
      location_id: locationId,
      results,
      manual_steps: manualSteps,
    });
  } catch (e) {
    console.error('ghl-setup', e.message);
    return res.status(500).json({ error: 'server_error', reason: e.hint || e.message || 'unknown' });
  }
};
