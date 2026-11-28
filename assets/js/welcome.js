/* The page a buyer lands on right after paying (/welcome?session_id=... from Stripe, or /welcome/<code>).
   It collects the texting registration details, which are needed first, and has them pick their Google
   profile so the setup form opens half filled in. Then it sends them on to /start/<code>.
   With no account to load it tells them to check their phone. /welcome?sample=1 shows a sample and saves nothing. */
(function () {
  var root = document.getElementById('wl');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var m = location.pathname.match(/^\/welcome\/([A-Za-z0-9_-]{12,64})\/?$/);
  var code = m ? m[1] : '';
  var session = params.get('session_id') || '';
  var demo = params.get('sample') === '1';

  var SAMPLE = {
    first_name: 'Dave', billing_cycle: 'monthly', tier: 'all_in_one', ein_on_file: false, birthday_on_file: false,
    credit: { earned: 0, same_day_until: new Date(Date.now() + 6 * 3600000).toISOString(), next_day_until: new Date(Date.now() + 30 * 3600000).toISOString() },
    answers: { business_name: 'Smith Plumbing', address: '1420 SW 8th St, Miami, FL 33135', place_id: 'sample' }
  };

  /* The carriers send a code to the email, and they only take a personal address. */
  var MAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
  var PUBLIC_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|comcast|att|verizon|bellsouth|sbcglobal|cox)\.(com|net|me)$/i;

  var answers = {};
  var state = { ein: false, birthday: false, address: false, google: false };

  function show(which) {
    $('wl-loading').hidden = which !== 'loading';
    $('wl-phone').hidden = which !== 'phone';
    $('wl-main').hidden = which !== 'ready';
  }
  function saved(text) { $('ob-saved').textContent = text; }
  function note(id, text) { $(id).textContent = text; $(id).hidden = !text; }

  function post(body) {
    if (demo) { saved('Sample page, nothing is saved.'); return Promise.resolve({}); }
    body.code = code;
    return fetch('/api/onboarding', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('Request failed: ' + r.status); return r.json(); });
  }
  function save(changes) {
    for (var k in changes) answers[k] = changes[k];
    saved('Saving.');
    return post({ answers: changes }).then(function () { if (!demo) saved('Saved.'); })
      .catch(function () { saved('Not saved yet. Check your connection and change it again.'); });
  }

  function registration(d) {
    var type = $('wl-a2p_entity_type'), ein = $('wl-ein');
    root.querySelectorAll('[data-key]').forEach(function (el) {
      var key = el.getAttribute('data-key');
      if (answers[key]) el.value = String(answers[key]);
      el.addEventListener('change', function () { var c = {}; c[key] = el.value.trim(); el.classList.remove('wl-bad'); save(c); });
    });
    function mode() {
      var none = /no EIN/i.test(type.value), sole = /^sole proprietor/i.test(type.value);
      $('wl-ein-wrap').hidden = none; $('wl-ein-none').hidden = !none;
      $('wl-sole-note').hidden = !/^sole proprietor$/i.test(type.value);
      $('wl-legal-hint').textContent = none ? '(your own full legal name)' : sole ? '(the name on your IRS letter)' : '(exactly as it appears on your IRS letter)';
      if (none) note('wl-ein-status', '');
    }
    type.addEventListener('change', mode); mode();

    /* EIN: sent once it is complete, kept in its own private column, and never sent back to this page. */
    state.ein = !!d.ein_on_file;
    if (d.ein_on_file) note('wl-ein-status', 'Your EIN is on file. Type it again only if it has changed.');
    ein.addEventListener('input', function () {
      var digits = ein.value.replace(/\D/g, '').slice(0, 9);
      ein.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    });
    ein.addEventListener('change', function () {
      var digits = ein.value.replace(/\D/g, '');
      if (!digits) return;
      if (digits.length !== 9) { note('wl-ein-status', 'An EIN has 9 digits. Please check it and try again.'); return; }
      note('wl-ein-status', 'Saving your EIN.');
      post({ ein: digits }).then(function () { state.ein = true; ein.value = ''; ein.classList.remove('wl-bad'); note('wl-ein-status', 'Your EIN is saved and kept private. Type it again only if it has changed.'); })
        .catch(function () { note('wl-ein-status', 'Your EIN did not save. Please try again.'); });
    });

    /* Date of birth: saved on its own like the EIN. */
    var bday = $('wl-birthday');
    state.birthday = !!d.birthday_on_file;
    if (d.birthday_on_file) note('wl-birthday-status', 'Your date of birth is on file. Enter it again only if it was wrong.');
    bday.addEventListener('change', function () {
      if (!bday.value) return;
      note('wl-birthday-status', 'Saving your date of birth.');
      post({ birthday: bday.value }).then(function () { state.birthday = true; bday.classList.remove('wl-bad'); note('wl-birthday-status', 'Your date of birth is saved and kept private.'); })
        .catch(function () { state.birthday = false; note('wl-birthday-status', 'That date did not save. Please check it and try again.'); });
    });

    /* Address: picked from Google's list, so it is a real street address and not a P.O. box. */
    var addr = $('wl-a2p_address');
    function addrLabel() { $('wl-address-label').textContent = /no EIN/i.test(type.value) ? 'Your street address' : 'Street address on your IRS letter'; }
    type.addEventListener('change', addrLabel); addrLabel();
    if (answers.a2p_address) { addr.value = answers.a2p_address; state.address = true; }
    var picker = window.BBAddress(addr, {
      list: $('wl-address-list'), note: $('wl-address-status'),
      onPick: function (a) {
        state.address = true; addr.classList.remove('wl-bad');
        save({ a2p_address: a.formatted, a2p_street: a.street || '', a2p_city: a.city || '', a2p_state: a.state || '', a2p_zip: a.zip || '', a2p_address_check: a.check || '' });
      },
      onClear: function () { state.address = false; save({ a2p_address: '', a2p_address_check: '' }); }
    });
    if (answers.a2p_address) picker.markPicked();
    $('wl-address-typed').addEventListener('click', function () {
      if (!picker.acceptTyped()) note('wl-address-status', 'Please type the full street address first, starting with the number.');
    });

    /* Cell and personal email: the carriers send a code to each one, and they only take a personal email. */
    var cell = $('wl-cell'), mail = $('wl-a2p_email');
    if (answers.cell) cell.value = answers.cell;
    var known = answers.a2p_email || answers.email || '';
    if (PUBLIC_MAIL.test(known)) mail.value = known;
    cell.addEventListener('change', function () {
      var n = cell.value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
      if (!n) return;
      if (n.length !== 10) { cell.classList.add('wl-bad'); note('wl-contact-status', 'Please type your 10 digit cell number.'); return; }
      cell.classList.remove('wl-bad'); note('wl-contact-status', ''); save({ cell: n });
    });
    mail.addEventListener('change', function () {
      var v = mail.value.trim();
      if (!v) return;
      if (!MAIL.test(v)) { mail.classList.add('wl-bad'); note('wl-contact-status', 'Please type your email address.'); return; }
      if (!PUBLIC_MAIL.test(v)) { mail.classList.add('wl-bad'); note('wl-contact-status', 'The carriers will not accept a work email for this step. Please use a personal one such as Gmail, Yahoo, Outlook or iCloud.'); return; }
      mail.classList.remove('wl-bad'); note('wl-contact-status', ''); save({ a2p_email: v });
    });

    /* An EIN issued in the last two months can take the carriers longer to match. */
    var recent = $('wl-ein-recent');
    recent.checked = !!answers.a2p_ein_recent;
    recent.addEventListener('change', function () { save({ a2p_ein_recent: recent.checked }); });
  }

  function google() {
    var found = $('wl-found'), find = $('wl-find'), results = $('ob-find-results');
    function picked(biz, text) {
      $('wl-found-name').textContent = biz.business_name || '';
      $('wl-found-addr').textContent = biz.address || '';
      $('wl-found-note').textContent = text;
      $('wl-found-row').hidden = true; found.hidden = false; find.hidden = true;
      state.google = true;
    }
    function search() { found.hidden = true; find.hidden = false; state.google = false; }

    if (answers.place_id || (answers.business_name && answers.address)) {
      $('wl-found-name').textContent = answers.business_name || '';
      $('wl-found-addr').textContent = answers.address || '';
      found.hidden = false;
      /* A name with no Google match behind it came from the checkout page, so the search stays one tap away. */
    } else search();
    if (answers.business_name) $('wl-find-q').value = answers.business_name;

    $('wl-found-yes').addEventListener('click', function () { picked(answers, 'Great, your setup page will open with this filled in.'); });
    $('wl-found-no').addEventListener('click', search);
    $('wl-find-skip').addEventListener('click', function () {
      state.google = true;
      note('wl-find-status', 'No problem. You will type your business details in on your setup page, and I will help you set up a Google profile on our launch call.');
    });

    function run() {
      var q = ($('wl-find-q').value.trim() + ' ' + $('wl-find-city').value.trim()).trim();
      if (q.length < 3) { note('wl-find-status', 'Type at least a few letters of your business name.'); return; }
      var btn = $('wl-find-btn'); btn.disabled = true;
      note('wl-find-status', 'Searching Google.');
      results.hidden = true; results.textContent = '';
      fetch('/api/business-lookup?q=' + encodeURIComponent(q)).then(function (r) { return r.json(); })
        .then(function (resp) {
          btn.disabled = false;
          if (!resp.found || !resp.results || !resp.results.length) { note('wl-find-status', 'Nothing matched that name, so please try a different spelling or add your city.'); return; }
          note('wl-find-status', 'Tap your business.');
          resp.results.forEach(function (biz) {
            var card = document.createElement('button');
            card.type = 'button'; card.className = 'ob-biz-card'; card.style.width = '100%'; card.style.textAlign = 'left'; card.style.font = 'inherit';
            card.innerHTML = '<div class="ob-biz-info"><div class="ob-biz-name"></div><div class="ob-biz-addr"></div></div><div class="ob-biz-rating"></div>';
            card.querySelector('.ob-biz-name').textContent = biz.business_name;
            card.querySelector('.ob-biz-addr').textContent = biz.address;
            card.querySelector('.ob-biz-rating').textContent = biz.rating ? biz.rating + ' stars (' + biz.review_count + ' reviews)' : '';
            card.addEventListener('click', function () {
              var c = {};
              ['business_name', 'business_phone', 'address', 'weekday_hours', 'weekends', 'city', 'place_id', 'website'].forEach(function (k) { if (biz[k]) c[k] = biz[k]; });
              save(c);
              note('wl-find-status', '');
              picked(biz, 'Great, your setup page will open with this filled in.');
            });
            results.appendChild(card);
          });
          results.hidden = false;
        })
        .catch(function () { btn.disabled = false; note('wl-find-status', 'Google could not be searched right now, so tap "I am not on Google yet" and type your details in on your setup page.'); });
    }
    $('wl-find-btn').addEventListener('click', run);
    ['wl-find-q', 'wl-find-city'].forEach(function (id) { $(id).addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); run(); } }); });
  }

  function finish() {
    var err = $('wl-err'), type = $('wl-a2p_entity_type').value;
    var none = /no EIN/i.test(type);
    var checks = [
      [!!type, 'wl-a2p_entity_type', 'Please choose your business type.'],
      [none || state.ein, 'wl-ein', 'Please add your 9 digit EIN, or choose "Sole proprietor with no EIN" if you do not have one.'],
      [!!$('wl-a2p_legal_name').value.trim(), 'wl-a2p_legal_name', 'Please add your legal business name.'],
      [!!$('wl-a2p_first_name').value.trim(), 'wl-a2p_first_name', 'Please add your legal first name.'],
      [!!$('wl-a2p_last_name').value.trim(), 'wl-a2p_last_name', 'Please add your legal last name.'],
      [state.birthday, 'wl-birthday', 'Please add your date of birth.'],
      [$('wl-cell').value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '').length === 10, 'wl-cell', 'Please add your 10 digit cell number.'],
      [PUBLIC_MAIL.test($('wl-a2p_email').value.trim()), 'wl-a2p_email', 'Please add a personal email such as Gmail, Yahoo, Outlook or iCloud.'],
      [state.address, 'wl-a2p_address', 'Please pick a street address for the business that is not a P.O. box.'],
      [state.google, 'wl-find-q', 'Please pick your business on Google, or tap "I am not on Google yet".']
    ];
    for (var i = 0; i < checks.length; i++) {
      if (checks[i][0]) continue;
      var el = $(checks[i][1]);
      err.textContent = checks[i][2]; err.hidden = false;
      if (el) { el.classList.add('wl-bad'); if (!el.offsetParent) $('wl-google').scrollIntoView(); else el.focus(); }
      return;
    }
    err.hidden = true;
    var btn = $('wl-next'); btn.disabled = true;
    post({ action: 'welcome_done' }).then(function () { location.href = demo ? '/start' : '/start/' + code; })
      .catch(function () { btn.disabled = false; err.textContent = 'That did not go through. Please try again.'; err.hidden = false; });
  }

  function render(d) {
    answers = d.answers || {};
    var first = d.first_name || answers.preferred_name || '';
    if (first) root.querySelectorAll('[data-fill="first_name"]').forEach(function (el) { el.textContent = first; });
    var credit = window.bbCredit ? window.bbCredit(d) : null;
    if (credit && !credit.earned) { $('wl-credit-title').textContent = credit.title; $('wl-credit-text').textContent = credit.text; $('wl-credit').hidden = false; }
    registration(d); google();
    $('wl-next').addEventListener('click', finish);
    $('wl-later-link').href = demo ? '/start' : '/start/' + code;
    $('wl-later-btn').addEventListener('click', function () { $('wl-later-note').hidden = false; });
    show('ready');
  }

  function load() {
    return fetch('/api/onboarding?code=' + encodeURIComponent(code))
      .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
      .then(render);
  }

  /* Stripe sends the buyer here a moment before its own message creates their account, so keep asking for a little while. */
  function fromSession(triesLeft) {
    fetch('/api/onboarding?session=' + encodeURIComponent(session))
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (r) {
        if (r && r.code) {
          code = r.code;
          try { history.replaceState(null, '', '/welcome/' + code); } catch (e) {}
          return load().catch(function () { show('phone'); });
        }
        if (triesLeft > 0) setTimeout(function () { fromSession(triesLeft - 1); }, 2000);
        else show('phone');
      });
  }

  if (demo) { render(SAMPLE); saved('Sample page, nothing is saved.'); }
  else if (code) load().catch(function () { show('phone'); });
  else if (/^cs_[A-Za-z0-9_]{10,200}$/.test(session)) fromSession(10);
  else show('phone');
})();
