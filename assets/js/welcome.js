/* /welcome, the page a buyer lands on after paying.
   Stripe adds ?session_id=<checkout id> to the address. The page trades that for the client's setup
   code, then asks for the texting registration details first, because the carriers take days to
   approve them. With no session id, or a plan without texting, it shows the plain "check your phone"
   message instead. /welcome?sample=1 shows the registration form and saves nothing. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var q = new URLSearchParams(location.search);
  var session = q.get('session_id') || '';
  var sample = q.get('sample') === '1';
  var code = '', hasEin = null, address = null;

  function view(name) {
    ['wl-loading', 'wl-reg', 'wl-done', 'wl-plain'].forEach(function (id) { $(id).hidden = id !== name; });
  }
  function api(method, body) {
    var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
    if (body) { body.code = code; opts.body = JSON.stringify(body); }
    return fetch('/api/onboarding' + (method === 'GET' ? '?code=' + encodeURIComponent(code) : ''), opts)
      .then(function (r) { if (!r.ok) throw new Error('Request failed: ' + r.status); return r.json(); });
  }
  /* The payment webhook creates the client a moment after Stripe sends the buyer here, so keep asking for a bit. */
  function findCode(tries) {
    return fetch('/api/onboarding?session=' + encodeURIComponent(session)).then(function (r) {
      if (r.ok) return r.json().then(function (d) { return d.code; });
      if (r.status === 404 && tries > 1) return new Promise(function (res) { setTimeout(res, 2000); }).then(function () { return findCode(tries - 1); });
      throw new Error('not found');
    });
  }

  function status(text) { $('wl-status').textContent = text || ''; $('wl-status').hidden = !text; }

  /* The carriers send a code to the email, and they only take a personal address. */
  var PUBLIC_MAIL = /@(gmail|googlemail|yahoo|ymail|outlook|hotmail|live|msn|icloud|me|mac|aol|proton|protonmail|comcast|att|verizon|bellsouth|sbcglobal|cox)\.(com|net|me)$/i;
  /* "03/02/1985" becomes "1985-03-02". Returns '' unless it is a real date for someone 18 to 100. */
  function dobValue(text) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
    if (!m) return '';
    var d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    if (d.getUTCMonth() !== +m[1] - 1 || d.getUTCDate() !== +m[2]) return '';
    var age = (Date.now() - d.getTime()) / (365.25 * 24 * 3600 * 1000);
    return age >= 18 && age <= 100 ? m[3] + '-' + m[1] + '-' + m[2] : '';
  }

  function mode(yes) {
    hasEin = yes;
    $('wl-yes').setAttribute('aria-pressed', yes ? 'true' : 'false');
    $('wl-no').setAttribute('aria-pressed', yes ? 'false' : 'true');
    $('wl-form').hidden = false;
    $('wl-no-note').hidden = yes;
    $('wl-legal-wrap').hidden = !yes;
    $('wl-type-wrap').hidden = !yes;
    $('wl-ein-wrap').hidden = !yes;
    $('wl-later').hidden = !yes;
    document.querySelector('.reg-about').hidden = !yes;
    $('wl-address-label').textContent = yes ? 'Street address on your IRS letter' : 'Your street address';
    status('');
  }

  function start(d) {
    var first = d.first_name || '';
    if (first) $('wl-name').textContent = ', ' + first;
    var setup = '/start/' + code;
    $('wl-next').href = setup; $('wl-later-link').href = setup;
    var a = d.answers || {};
    if (a.a2p_legal_name) $('wl-legal').value = a.a2p_legal_name;
    $('wl-first').value = a.a2p_first_name || first;
    if (a.a2p_last_name) $('wl-last').value = a.a2p_last_name;
    if (a.cell) $('wl-cell').value = a.cell;
    var mail = a.a2p_email || a.email || '';
    if (PUBLIC_MAIL.test(mail)) $('wl-email').value = mail;
    var dob = $('wl-dob');
    dob.addEventListener('input', function () {
      var n = dob.value.replace(/\D/g, '').slice(0, 8);
      dob.value = n.length > 4 ? n.slice(0, 2) + '/' + n.slice(2, 4) + '/' + n.slice(4) : n.length > 2 ? n.slice(0, 2) + '/' + n.slice(2) : n;
    });

    var picker = window.BBAddress($('wl-address'), {
      list: $('wl-address-list'), note: $('wl-address-note'),
      onPick: function (found) { address = found; status(''); },
      onClear: function () { address = null; }
    });
    $('wl-address-typed').addEventListener('click', function () {
      if (!picker.acceptTyped()) { $('wl-address-note').hidden = false; $('wl-address-note').textContent = 'Please type the full street address first, starting with the number.'; }
    });

    $('wl-yes').addEventListener('click', function () { mode(true); });
    $('wl-no').addEventListener('click', function () { mode(false); });
    $('wl-later-btn').addEventListener('click', function () { $('wl-later-note').hidden = false; });

    var ein = $('wl-ein');
    ein.addEventListener('input', function () {
      var digits = ein.value.replace(/\D/g, '').slice(0, 9);
      ein.value = digits.length > 2 ? digits.slice(0, 2) + '-' + digits.slice(2) : digits;
    });

    $('wl-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var legal = $('wl-legal').value.trim(), type = $('wl-type').value, digits = ein.value.replace(/\D/g, '');
      var firstName = $('wl-first').value.trim(), lastName = $('wl-last').value.trim(), born = dobValue(dob.value);
      var cell = $('wl-cell').value.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''), email = $('wl-email').value.trim();
      if (hasEin && legal.length < 3) return status('Please type your legal business name the way it appears on your IRS letter.');
      if (hasEin && !type) return status('Please choose your business type.');
      if (hasEin && digits.length !== 9) return status('An EIN has 9 digits. Please check it and try again.');
      if (firstName.length < 2 || lastName.length < 2) return status('Please type your legal first and last name.');
      if (!born) return status('Please type your date of birth as month, day and year, like 03/02/1985.');
      if (cell.length !== 10) return status('Please type your 10 digit cell number.');
      if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) return status('Please type your email address.');
      if (!PUBLIC_MAIL.test(email)) return status('The carriers will not accept a work email for this step. Please use a personal one such as Gmail, Yahoo, Outlook or iCloud.');
      if (!address) return status('Please pick your street address from the list that shows as you type.');
      var answers = {
        a2p_legal_name: hasEin ? legal : firstName + ' ' + lastName,
        a2p_entity_type: hasEin ? type : 'Sole proprietor with no EIN',
        a2p_first_name: firstName, a2p_last_name: lastName, a2p_dob: born, a2p_email: email, cell: cell,
        a2p_ein_recent: hasEin ? $('wl-ein-recent').checked : false,
        a2p_address: address.formatted, a2p_street: address.street || '', a2p_unit: $('wl-unit').value.trim(),
        a2p_city: address.city || '', a2p_state: address.state || '', a2p_zip: address.zip || '',
        a2p_address_check: address.check || ''
      };
      if (sample) { status('Sample page, nothing is saved.'); return; }
      var body = { answers: answers };
      if (hasEin) body.ein = digits;
      var btn = $('wl-send'); btn.disabled = true; status('Saving.');
      api('POST', body).then(function () { ein.value = ''; dob.value = ''; view('wl-done'); window.scrollTo(0, 0); })
        .catch(function () { btn.disabled = false; status('That did not save. Please check your connection and try again, or text me at (786) 933-8832.'); });
    });
    view('wl-reg');
  }

  if (sample) { code = ''; start({ first_name: 'Dave', answers: {} }); return; }
  if (!session) return;            /* the plain message is already showing */
  view('wl-loading');
  findCode(10).then(function (c) { code = c; return api('GET'); }).then(function (d) {
    /* Plans without a texting number are not asked for registration details. */
    if (/^website/i.test(String(d.tier || '').trim())) return view('wl-plain');
    start(d);
  }).catch(function () { view('wl-plain'); });
})();
