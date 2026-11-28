/* /key/<token>: a one-time page where a client pastes a key (Housecall Pro, Jobber or other) instead of texting it. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  if (!$('key')) return;
  var m = location.pathname.match(/^\/key\/([A-Za-z0-9_-]{32,64})\/?$/);
  var token = m ? m[1] : '';
  var api = '/api/client-secret?token=' + encodeURIComponent(token);
  var label = '', first = '';
  var panels = ['key-loading', 'key-error', 'key-used', 'key-expired', 'key-sent', 'key-main'];
  function only(id) { panels.forEach(function (p) { $(p).hidden = p !== id; }); }
  // "your Housecall Pro key", or "your key" when no name was given.
  function yourKey() { return 'your ' + (label ? label + ' ' : '') + 'key'; }

  function show(d) {
    if (!d || !d.state) { only('key-error'); return; }
    label = String(d.label || ''); first = String(d.first_name || '');
    if (d.state === 'used') { only('key-used'); return; }
    if (d.state === 'expired') { only('key-expired'); return; }
    $('key-h').textContent = (first ? 'Hey ' + first + ', I' : 'I') + ' need ' + yourKey() + '.';
    $('key-lead').textContent = 'A key is a long code' + (label ? ' from your ' + label + ' account' : '') +
      ' that lets me connect it to your new system. Paste it below and I will take it from here. Please do not text it or email it.';
    if (d.note) { $('key-note').textContent = d.note; $('key-note').hidden = false; }
    $('key-label').textContent = 'Paste ' + yourKey() + ' here';
    only('key-main');
  }

  function fail(text) { var e = $('key-err'); e.textContent = text; e.hidden = false; }

  $('key-toggle').addEventListener('click', function () {
    var input = $('key-value'), showing = input.type === 'text';
    input.type = showing ? 'password' : 'text';
    this.textContent = showing ? 'Show what I pasted' : 'Hide what I pasted';
    this.setAttribute('aria-pressed', showing ? 'false' : 'true');
  });

  $('key-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = $('key-value'), value = input.value.trim(), btn = $('key-send');
    $('key-err').hidden = true;
    if (!value) { fail('Paste your key in the box first.'); input.focus(); return; }
    if (value.length > 4000) { fail('That is too long to be a key. Check that you copied only the key.'); return; }
    btn.disabled = true; btn.textContent = 'Sending your key';
    fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: value }) })
      .then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); })
      .then(function (r) {
        input.value = ''; input.type = 'password';
        if (r.body && r.body.ok) {
          $('key-sent-h').textContent = 'I have ' + yourKey() + (first ? ', ' + first : '') + '. Thank you for sending it.';
          only('key-sent'); return;
        }
        if (r.body && r.body.error === 'already_used') { only('key-used'); return; }
        if (r.body && r.body.error === 'expired') { only('key-expired'); return; }
        throw new Error('not saved');
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Send my key';
        fail('That did not save. Try again, or text me at (786) 933-8832.');
      });
  });

  if (!token) { only('key-error'); return; }
  fetch(api).then(function (r) { return r.json(); }).then(show).catch(function () { show(null); });
})();
