/* Client onboarding page (/start/<code>). Loads one client's record from /api/onboarding, fills the page,
   and saves each answer as it changes. Opening /start with no code shows a sample client and saves nothing. */
(function () {
  var root = document.getElementById('ob');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var m = location.pathname.match(/^\/start\/([A-Za-z0-9_-]{12,64})\/?$/);
  var code = m ? m[1] : '';
  var demo = !code;
  var thanksUrl = '/start-thank-you' + (code ? '/' + code : '');

  var VIBES = ['Friendly', 'Quiet and respectful', 'Affordable', 'High quality', 'Fast', 'Family-run', 'Straight shooter', 'Clean and careful'];
  var STYLES = [
    ['classic', 'Classic', 'Navy and gold', '#0b2440', '#f2a20c', '/demo'],
    ['fresh', 'Fresh', 'Bright and clean', '#1C77C3', '#F39237', '/demo-fresh'],
    ['bold', 'Bold', 'Dark and modern', '#16191d', '#ff6a13', '/demo-bold'],
    ['freeze', 'Freeze', 'Elegant and airy', '#1E293B', '#4A7CBA', '/demo-luxe'],
    ['edge', 'Edge', 'Sleek and minimal', '#111827', '#4A7CBA', '/demo-edge'],
    ['earthy', 'Earthy', 'Warm and natural', '#2D5F4A', '#C45D3E', '/demo-earthy']
  ];
  var BADGES = ['Women owned', 'Veteran owned', 'Family owned', 'Licensed and insured', 'Free estimates', 'Se habla español'];
  var SAMPLE = {
    first_name: 'Dave', billing_cycle: 'quarterly', ein_on_file: false, launch_call_at: 'Thursday at 2:00 PM', video_url: '', photo_folder_url: '',
    google_requested: false, text_link_requested: false, submitted: false, sms_consent: false,
    options: {
      services: ['Drain cleaning', 'Water heaters', 'Leak repair', 'Repiping', 'Toilets and faucets', 'Sewer lines', 'Garbage disposals', 'Emergency calls'],
      areas: ['Miami', 'Coral Gables', 'Hialeah', 'Kendall', 'Doral', 'Miami Beach', 'Homestead', 'Pinecrest'],
      domains: ['smithplumbingmiami.com', 'smithplumbingfl.com', 'callsmithplumbing.com']
    },
    answers: {
      business_name: 'Smith Plumbing', business_phone: '(305) 555-0199', address: '1420 SW 8th St, Miami, FL 33135',
      weekday_hours: '8:00 AM to 6:00 PM', weekends: 'Closed', services: ['Drain cleaning', 'Water heaters', 'Leak repair'],
      areas: ['Miami', 'Coral Gables'], vibes: [], badges: ['Licensed and insured'], preferred_name: 'Dave', job_software: 'Pen and paper'
    }
  };

  var answers = {};
  var pending = {};
  var timer = null;
  var saving = false;

  function show(state) {
    root.setAttribute('data-state', state);
    $('ob-loading').hidden = state !== 'loading';
    $('ob-error').hidden = state !== 'error';
    $('ob-main').hidden = state !== 'ready';
  }
  function saved(text) { $('ob-saved').textContent = text; }

  function api(method, body) {
    var url = '/api/onboarding' + (method === 'GET' ? '?code=' + encodeURIComponent(code) : '');
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) { body.code = code; opts.body = JSON.stringify(body); }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) throw new Error('Request failed: ' + r.status);
      return r.json();
    });
  }

  /* Saving: changes collect for a moment, then go up together. A failed save is kept and retried on the next change. */
  function flush() {
    if (saving || !Object.keys(pending).length) return;
    var batch = pending; pending = {};
    if (demo) { saved('Sample page, nothing is saved.'); return; }
    saving = true; saved('Saving.');
    api('POST', { answers: batch }).then(function () {
      saving = false; saved('Saved.');
      if (Object.keys(pending).length) flush();
    }).catch(function () {
      saving = false;
      for (var k in batch) if (!(k in pending)) pending[k] = batch[k];
      saved('Not saved yet. Check your connection, and I will try again when you change something.');
    });
  }
  function save(key, value, now) {
    answers[key] = value; pending[key] = value;
    clearTimeout(timer);
    timer = setTimeout(flush, now ? 0 : 700);
  }
  function action(name) {
    if (demo) return Promise.resolve();
    return api('POST', { action: name });
  }

  function chips(box, options) {
    var key = box.getAttribute('data-chips');
    var max = parseInt(box.getAttribute('data-max') || '0', 10);
    /* data-limit stops at the number and says so. data-max (vibes) swaps the oldest pick out instead. */
    var limit = parseInt(box.getAttribute('data-limit') || '0', 10);
    var cap = document.getElementById('ob-cap-' + key);
    var picked = Array.isArray(answers[key]) ? answers[key].slice() : [];
    /* Anything already picked that is not in the option list still shows, so it can be untapped. */
    var all = options.concat(picked.filter(function (p) { return options.indexOf(p) < 0; }));
    box.textContent = '';
    all.forEach(function (label) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'ob-chip'; b.textContent = label;
      b.setAttribute('aria-pressed', picked.indexOf(label) >= 0 ? 'true' : 'false');
      b.addEventListener('click', function () {
        var on = picked.indexOf(label) >= 0;
        if (on) picked = picked.filter(function (p) { return p !== label; });
        else {
          if (limit && picked.length >= limit) { if (cap) cap.hidden = false; return; }
          if (max && picked.length >= max) picked.shift();
          picked.push(label);
        }
        if (cap) cap.hidden = true;
        Array.prototype.forEach.call(box.children, function (c) {
          c.setAttribute('aria-pressed', picked.indexOf(c.textContent) >= 0 ? 'true' : 'false');
        });
        if (key === 'vibes') $('ob-vibe-count').textContent = String(picked.length);
        save(key, picked.slice(), true);
      });
      box.appendChild(b);
    });
    if (key === 'vibes') $('ob-vibe-count').textContent = String(picked.length);
  }

  function once(btn, done, name) {
    btn.addEventListener('click', function () {
      btn.disabled = true;
      action(name).then(function () { btn.hidden = true; done.hidden = false; })
        .catch(function () { btn.disabled = false; saved('That did not go through. Please try again.'); });
    });
  }

  function render(d) {
    answers = d.answers || {};
    var opts = d.options || {};
    var first = d.first_name || answers.preferred_name || '';
    root.querySelectorAll('[data-fill="first_name"]').forEach(function (el) { if (first) el.textContent = first; });
    if (!answers.preferred_name && first) answers.preferred_name = first;

    root.querySelectorAll('[data-key]').forEach(function (el) {
      var key = el.getAttribute('data-key');
      var v = answers[key];
      if (v != null && v !== '') {
        if (el.tagName === 'SELECT') {
          /* Match loosely, so "plumbing" or "junk-removal" from the prospect list still selects the right option. */
          var want = String(v).toLowerCase().replace(/[-_]+/g, ' ').trim();
          Array.prototype.forEach.call(el.options, function (o) { if (o.value.toLowerCase() === want) el.value = o.value; });
        } else el.value = String(v);
      }
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { save(key, el.tagName === 'TEXTAREA' ? el.value : el.value.trim()); });
      el.addEventListener('blur', function () { clearTimeout(timer); flush(); });
    });

    root.querySelectorAll('[data-chips]').forEach(function (box) {
      var key = box.getAttribute('data-chips');
      var list = key === 'vibes' ? VIBES : key === 'badges' ? BADGES : (Array.isArray(opts[key]) ? opts[key] : []);
      chips(box, list);
    });

    var domains = Array.isArray(opts.domains) ? opts.domains.slice(0, 6) : [];
    if (domains.length) {
      var dbox = $('ob-domains');
      domains.forEach(function (name, i) {
        var lab = document.createElement('label'); lab.className = 'ob-radio';
        var inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'ob-domain'; inp.value = name; inp.id = 'ob-domain-' + i;
        lab.htmlFor = inp.id; inp.checked = answers.domain_choice === name;
        inp.addEventListener('change', function () { if (inp.checked) save('domain_choice', name, true); });
        var txt = document.createElement('span'); txt.textContent = name;
        lab.appendChild(inp); lab.appendChild(txt); dbox.appendChild(lab);
      });
      $('ob-domain-sec').hidden = false;
    }

    /* The six site looks, each with its two colors and a link to a sample. */
    var sbox = $('ob-styles');
    STYLES.forEach(function (s) {
      var lab = document.createElement('label'); lab.className = 'ob-radio'; lab.htmlFor = 'ob-style-' + s[0];
      var inp = document.createElement('input'); inp.type = 'radio'; inp.name = 'ob-style'; inp.id = 'ob-style-' + s[0]; inp.value = s[0];
      inp.checked = answers.style === s[0];
      inp.addEventListener('change', function () { if (inp.checked) save('style', s[0], true); });
      var name = document.createElement('span'); name.className = 'ob-style-name'; name.textContent = s[1];
      var note = document.createElement('small'); note.textContent = s[2]; name.appendChild(note);
      var dots = document.createElement('span'); dots.className = 'ob-dots'; dots.setAttribute('aria-hidden', 'true');
      [s[3], s[4]].forEach(function (c) { var d = document.createElement('i'); d.style.background = c; dots.appendChild(d); });
      var see = document.createElement('a'); see.href = s[5]; see.target = '_blank'; see.rel = 'noopener'; see.textContent = 'See it';
      see.setAttribute('aria-label', 'See a sample of the ' + s[1] + ' look');
      lab.appendChild(inp); lab.appendChild(name); lab.appendChild(dots); lab.appendChild(see); sbox.appendChild(lab);
    });

    /* Own color: only saved once he actually picks one. */
    var color = $('ob-brand_color'), colorNote = $('ob-color-note'), colorClear = $('ob-color-clear');
    function colorState() {
      var v = /^#[0-9a-f]{6}$/i.test(answers.brand_color || '') ? answers.brand_color : '';
      if (v) color.value = v;
      colorNote.textContent = v ? 'Your site will use ' + v.toUpperCase() + ' as its main color.' : 'Leave this alone to use the colors of the look you picked.';
      colorClear.hidden = !v;
    }
    colorState();
    color.addEventListener('change', function () { save('brand_color', color.value, true); colorState(); });
    colorClear.addEventListener('click', function () { save('brand_color', '', true); colorState(); });

    var rem = $('ob-photo_reminders');
    rem.checked = answers.photo_reminders === true;
    rem.addEventListener('change', function () { save('photo_reminders', rem.checked, true); });
    $('ob-consent').checked = !!d.sms_consent;
    $('ob-thanks-link').href = thanksUrl;

    /* Clients who prepay (quarterly, six months or annual) also get their Google profile kept in step with the site. */
    if (/^(quarterly|six[_ -]?months?|6[_ -]?months?|annual|annually|yearly)$/i.test(String(d.billing_cycle || '').trim())) $('ob-gupd').hidden = false;

    /* One optional add-on, offered to clients on the website plan. The Stripe payment link goes in GBP_ADDON_LINK
       (or in options.gbp_addon_link for one client). It needs the tag addon = gbp_optimization, and the client's
       code rides along so the payment lands on their record. With no link set, the section stays hidden. */
    var GBP_ADDON_LINK = '';
    var addonLink = String((d.options && d.options.gbp_addon_link) || GBP_ADDON_LINK || '').trim();
    var addonPaid = (d.addons_paid || []).indexOf('gbp_optimization') > -1;
    if (addonPaid) {
      $('ob-addon').hidden = false; $('ob-addon-btn').hidden = true; $('ob-addon-note').hidden = true; $('ob-addon-done').hidden = false;
    } else if (code && /^https:\/\/buy\.stripe\.com\//.test(addonLink) && /^(website|essentials)/i.test(String(d.tier || '').trim())) {
      $('ob-addon').hidden = false;
      $('ob-addon-btn').href = addonLink + (addonLink.indexOf('?') > -1 ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(code);
    }

    /* Plain yes or no checkboxes. */
    root.querySelectorAll('[data-flag]').forEach(function (box) {
      var key = box.getAttribute('data-flag');
      box.checked = answers[key] === true;
      box.addEventListener('change', function () { save(key, box.checked, true); });
    });

    /* Website-only clients do not get a texting number, so they are not asked for registration details. */
    if (/^website/i.test(String(d.tier || '').trim())) { $('ob-a2p').hidden = true; document.querySelector('.ob-google .ob-eyebrow').textContent = 'Start here'; }

    /* EIN: sent once it is complete, kept in its own private column, and never sent back to this page. */
    var ein = $('ob-ein'), einStatus = $('ob-ein-status'), type = $('ob-a2p_entity_type');
    function einMode() {
      var none = /no EIN/i.test(type.value);
      $('ob-ein-wrap').hidden = none; $('ob-ein-none').hidden = !none;
      if (none) einStatus.hidden = true;
    }
    type.addEventListener('change', einMode); einMode();
    if (d.ein_on_file) { einStatus.textContent = 'Your EIN is on file. Type it again only if it has changed.'; einStatus.hidden = /no EIN/i.test(type.value); }
    ein.addEventListener('input', function () {
      var digits = ein.value.replace(/\D/g, '').slice(0, 9);
      ein.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    });
    ein.addEventListener('change', function () {
      var digits = ein.value.replace(/\D/g, '');
      if (!digits) return;
      einStatus.hidden = false;
      if (digits.length !== 9) { einStatus.textContent = 'An EIN has 9 digits. Please check it and try again.'; return; }
      if (demo) { einStatus.textContent = 'Sample page, nothing is saved.'; ein.value = ''; return; }
      einStatus.textContent = 'Saving.';
      api('POST', { ein: digits }).then(function () { ein.value = ''; einStatus.textContent = 'Your EIN is saved and kept private. Type it again only if it has changed.'; })
        .catch(function () { einStatus.textContent = 'That did not save. Please try again.'; });
    });

    var gDone = function () { $('ob-gsteps').hidden = true; $('ob-ghelp').hidden = true; $('ob-google-done').hidden = false; };
    if (d.google_requested) gDone();
    $('ob-google-btn').addEventListener('click', function () {
      var btn = this; btn.disabled = true;
      action('request_google').then(gDone)
        .catch(function () { btn.disabled = false; saved('That did not go through. Please try again.'); });
    });
    $('ob-gcopy').addEventListener('click', function () {
      var btn = this, email = $('ob-gmail').textContent;
      var ok = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy email'; }, 2000); };
      var fallback = function () {
        var r = document.createRange(); r.selectNodeContents($('ob-gmail'));
        var s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
        try { document.execCommand('copy'); ok(); } catch (e) { btn.textContent = 'Press and hold the email to copy'; }
      };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(email).then(ok, fallback); else fallback();
    });

    if (d.photo_folder_url && /^https:\/\//.test(d.photo_folder_url)) { $('ob-folder').href = d.photo_folder_url; $('ob-folder').hidden = false; }
    /* Photos: each one is shrunk on the phone first, then sent up one at a time. */
    var pBtn = $('ob-photo-btn'), pIn = $('ob-photo-input'), pCount = $('ob-photo-count');
    var have = d.photo_count || 0;
    function countText(extra) {
      pCount.hidden = !(have || extra);
      pCount.textContent = (have ? 'I have ' + have + (have === 1 ? ' photo' : ' photos') + ' from you so far.' : '') + (extra ? ' ' + extra : '');
    }
    function shrink(file) {
      return new Promise(function (resolve, reject) {
        var img = new Image(), url = URL.createObjectURL(file);
        img.onload = function () {
          var scale = Math.min(1, 1600 / Math.max(img.width, img.height));
          var c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          resolve(c.toDataURL('image/jpeg', 0.85).split(',')[1]);
        };
        img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('not an image')); };
        img.src = url;
      });
    }
    countText('');
    pBtn.addEventListener('click', function () { pIn.click(); });
    pIn.addEventListener('change', function () {
      var files = Array.prototype.slice.call(pIn.files || []);
      if (!files.length) return;
      pBtn.disabled = true;
      var done = 0, failed = 0;
      (function next() {
        if (!files.length) {
          pBtn.disabled = false; pIn.value = '';
          countText(failed ? failed + (failed === 1 ? ' photo' : ' photos') + ' did not go through. Please try those again.' : (demo ? 'Sample page, nothing is saved.' : 'Thank you.'));
          return;
        }
        var file = files.shift();
        countText('Sending photo ' + (done + failed + 1) + '.');
        shrink(file).then(function (data) { return demo ? null : api('POST', { photo: data }); })
          .then(function (r) { done++; if (r && r.photo_count) have = r.photo_count; else if (demo) have++; next(); })
          .catch(function () { failed++; next(); });
      })();
    });

    if (d.text_link_requested) { $('ob-textme').hidden = true; $('ob-textme-done').hidden = false; }
    once($('ob-textme'), $('ob-textme-done'), 'text_link');

    if (d.submitted) { $('ob-submit').hidden = true; $('ob-submit-done').hidden = false; }
    $('ob-submit').addEventListener('click', function () {
      var btn = $('ob-submit'), err = $('ob-submit-err');
      var cell = (answers.cell || '').replace(/\D/g, '');
      var problem = '';
      if (cell.length < 10) problem = 'Please add your cell number in the About you section first, so I know where to text you.';
      else if (!$('ob-consent').checked) problem = 'Please check the box to say I can text you about your account. I cannot run your setup without it.';
      if (problem) {
        err.textContent = problem; err.hidden = false;
        (cell.length < 10 ? $('ob-cell') : $('ob-consent')).focus();
        return;
      }
      err.hidden = true; btn.disabled = true;
      clearTimeout(timer);
      var rest = pending; pending = {};
      var send = demo ? Promise.resolve() : api('POST', { answers: rest, action: 'submit', sms_consent: true });
      send.then(function () { location.href = thanksUrl; })
        .catch(function () {
          for (var k in rest) if (!(k in pending)) pending[k] = rest[k];
          btn.disabled = false; err.textContent = 'That did not go through. Please try again.'; err.hidden = false;
        });
    });

    if (d.video_url && /^https:\/\//.test(d.video_url)) {
      $('ob-video').querySelector('video').src = d.video_url;
      $('ob-video').hidden = false; $('ob-video-note').hidden = false;
    }
    if (d.launch_call_at) {
      root.querySelector('[data-fill="launch_call_at"]').textContent = d.launch_call_at;
      $('ob-call').hidden = false;
    }
    if (first) document.title = first + ", let's get you set up | Build Boosters";
    show('ready');
  }

  window.addEventListener('pagehide', function () {
    if (demo || !Object.keys(pending).length || !navigator.sendBeacon) return;
    navigator.sendBeacon('/api/onboarding', new Blob([JSON.stringify({ code: code, answers: pending })], { type: 'application/json' }));
  });

  /* Find my business: for organic signups whose form has no prefill data. After they pick a
     business from Google Maps, the prefill fields get filled and the form renders normally. */
  function hasPrefill(d) {
    var a = d.answers || {};
    return !!(a.business_name || a.business_phone || a.address);
  }

  function setupFind(data) {
    var findBox = $('ob-find'), resultBox = $('ob-find-results'), statusEl = $('ob-find-status');
    var findBtn = $('ob-find-btn'), skipBtn = $('ob-find-skip');
    var qEl = $('ob-find-q'), cityEl = $('ob-find-city');

    function doSearch() {
      var q = (qEl.value.trim() + ' ' + cityEl.value.trim()).trim();
      if (q.length < 3) { statusEl.textContent = 'Type at least a few letters of your business name.'; statusEl.hidden = false; return; }
      findBtn.disabled = true;
      statusEl.textContent = 'Searching.'; statusEl.hidden = false;
      resultBox.hidden = true; resultBox.textContent = '';
      fetch('/api/business-lookup?q=' + encodeURIComponent(q))
        .then(function (r) { return r.json(); })
        .then(function (resp) {
          findBtn.disabled = false;
          if (!resp.found || !resp.results || !resp.results.length) {
            statusEl.textContent = 'No businesses matched that name. Try a different spelling, or tap the button below to type everything in by hand.';
            return;
          }
          statusEl.hidden = true;
          resp.results.forEach(function (biz) {
            var card = document.createElement('div');
            card.className = 'ob-biz-card';
            card.innerHTML = '<div class="ob-biz-info"><div class="ob-biz-name"></div><div class="ob-biz-addr"></div></div><div class="ob-biz-rating"></div>';
            card.querySelector('.ob-biz-name').textContent = biz.business_name;
            card.querySelector('.ob-biz-addr').textContent = biz.address;
            card.querySelector('.ob-biz-rating').textContent = biz.rating ? biz.rating + ' stars (' + biz.review_count + ' reviews)' : '';
            card.addEventListener('click', function () {
              /* Fill the data and render the form */
              data.answers = data.answers || {};
              if (biz.business_name) data.answers.business_name = biz.business_name;
              if (biz.business_phone) data.answers.business_phone = biz.business_phone;
              if (biz.address) data.answers.address = biz.address;
              if (biz.weekday_hours) data.answers.weekday_hours = biz.weekday_hours;
              if (biz.weekends) data.answers.weekends = biz.weekends;
              if (biz.city) data.answers.city = biz.city;
              /* Save the prefill to the server */
              if (!demo) api('POST', { answers: data.answers }).catch(function () {});
              findBox.hidden = true;
              $('ob-lead-prefill').hidden = false;
              $('ob-lead-manual').hidden = true;
              render(data);
            });
            resultBox.appendChild(card);
          });
          resultBox.hidden = false;
        })
        .catch(function () {
          findBtn.disabled = false;
          statusEl.textContent = 'Could not search right now. You can type everything in by hand instead.';
        });
    }

    findBtn.addEventListener('click', doSearch);
    qEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
    cityEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });

    skipBtn.addEventListener('click', function () {
      findBox.hidden = true;
      $('ob-lead-prefill').hidden = true;
      $('ob-lead-manual').hidden = false;
      render(data);
    });
  }

  function maybeFind(data) {
    if (hasPrefill(data)) {
      /* Cold SMS prospect or someone who already started filling in. Skip the find step. */
      $('ob-find').hidden = true;
      $('ob-lead-prefill').hidden = false;
      $('ob-lead-manual').hidden = true;
      render(data);
    } else {
      /* Organic signup: show the find step first. */
      $('ob-find').hidden = false;
      $('ob-greeting').hidden = true;
      $('ob-lead-prefill').hidden = true;
      $('ob-lead-manual').hidden = true;
      setupFind(data);
      show('ready');
    }
  }

  if (demo) { render(SAMPLE); saved('Sample page, nothing is saved.'); }
  else api('GET').then(maybeFind).catch(function () { show('error'); });
})();
