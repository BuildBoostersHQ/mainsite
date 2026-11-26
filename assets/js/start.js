/* Client onboarding page (/start/<code>). Loads one client's record from /api/onboarding, fills the page,
   and saves each answer as it changes. Opening /start with no code shows a sample client and saves nothing. */
(function () {
  var root = document.getElementById('ob');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var m = location.pathname.match(/^\/start\/([A-Za-z0-9_-]{12,64})\/?$/);
  var code = m ? m[1] : '';
  var demo = !code;

  var VIBES = ['Friendly', 'Quiet and respectful', 'Affordable', 'High quality', 'Fast', 'Family-run', 'Straight shooter', 'Clean and careful'];
  var BADGES = ['Women owned', 'Veteran owned', 'Family owned', 'Licensed and insured', 'Free estimates', 'Se habla español'];
  var SAMPLE = {
    first_name: 'Dave', launch_call_at: 'Thursday at 2:00 PM', video_url: '', photo_folder_url: '',
    google_requested: false, text_link_requested: false, submitted: false,
    options: {
      services: ['Drain cleaning', 'Water heaters', 'Leak repair', 'Repiping', 'Toilets and faucets', 'Sewer lines', 'Garbage disposals', 'Emergency calls'],
      areas: ['Miami', 'Coral Gables', 'Hialeah', 'Kendall', 'Doral', 'Miami Beach', 'Homestead', 'Pinecrest']
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
        else { if (max && picked.length >= max) picked.shift(); picked.push(label); }
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
          var has = Array.prototype.some.call(el.options, function (o) { return o.value === String(v); });
          if (has) el.value = String(v);
        } else el.value = String(v);
      }
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', function () { save(key, el.value.trim()); });
      el.addEventListener('blur', function () { clearTimeout(timer); flush(); });
    });

    root.querySelectorAll('[data-chips]').forEach(function (box) {
      var key = box.getAttribute('data-chips');
      var list = key === 'vibes' ? VIBES : key === 'badges' ? BADGES : (Array.isArray(opts[key]) ? opts[key] : []);
      chips(box, list);
    });

    if (d.google_requested) { $('ob-google-btn').hidden = true; $('ob-google-done').hidden = false; }
    once($('ob-google-btn'), $('ob-google-done'), 'request_google');

    if (d.photo_folder_url && /^https:\/\//.test(d.photo_folder_url)) { $('ob-folder').href = d.photo_folder_url; $('ob-folder').hidden = false; }
    if (d.text_link_requested) { $('ob-textme').hidden = true; $('ob-textme-done').hidden = false; }
    once($('ob-textme'), $('ob-textme-done'), 'text_link');

    if (d.submitted) { $('ob-submit').hidden = true; $('ob-submit-done').hidden = false; }
    $('ob-submit').addEventListener('click', function () {
      var btn = $('ob-submit'); btn.disabled = true;
      clearTimeout(timer);
      var rest = pending; pending = {};
      var send = demo ? Promise.resolve() : api('POST', { answers: rest, action: 'submit' });
      send.then(function () { btn.hidden = true; $('ob-submit-done').hidden = false; saved(demo ? '' : 'Saved.'); })
        .catch(function () {
          for (var k in rest) if (!(k in pending)) pending[k] = rest[k];
          btn.disabled = false; saved('That did not go through. Please try again.');
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

  if (demo) { render(SAMPLE); saved('Sample page, nothing is saved.'); }
  else api('GET').then(render).catch(function () { show('error'); });
})();
