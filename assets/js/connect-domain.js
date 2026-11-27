/* /connect-domain/<code>: steps for a client to point a domain they already own at their new site. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  if (!$('cd')) return;
  var m = location.pathname.match(/^\/connect-domain\/([A-Za-z0-9_-]{12,64})\/?$/);
  var code = m ? m[1] : '';
  var el = function (tag, text) { var e = document.createElement(tag); if (text != null) e.textContent = text; return e; };

  function show(d) {
    $('cd-loading').hidden = true;
    if (!d || !d.ok) { $('cd-error').hidden = false; return; }
    $('cd-main').hidden = false;
    if (!d.domain) {
      $('cd-h').textContent = 'There is no domain on file for you yet.';
      $('cd-intro').textContent = 'Text me the domain you own at (786) 933-8832 and I will set this page up for it.';
      return;
    }
    $('cd-h').textContent = 'Put your new website on ' + d.domain;
    $('cd-intro').textContent = (d.first_name ? d.first_name + ', this' : 'This') + ' takes about five minutes. You are changing two settings' +
      (d.managed_at ? ' in your ' + d.managed_at + ' account' : d.registrar ? ' at ' + d.registrar : '') + ', and your email is not touched.';
    if (d.note) { $('cd-note').textContent = d.note; $('cd-note').hidden = false; }
    if (!d.registered) { $('cd-note').textContent = 'I could not find ' + d.domain + ' registered anywhere. Check the spelling and text me if it is off.'; $('cd-note').hidden = false; }
    if (d.sign_in_url) { var a = $('cd-signin'); a.href = d.sign_in_url; a.textContent = 'Open my ' + d.managed_at + ' account'; a.hidden = false; }
    var ol = $('cd-steps'); ol.textContent = '';
    (d.steps || []).forEach(function (s) { ol.appendChild(el('li', s)); });
    var tb = $('cd-records'); tb.textContent = '';
    (d.records || []).forEach(function (r) {
      var tr = el('tr'); tr.appendChild(el('td', r.type)); tr.appendChild(el('td', r.name));
      var td = el('td'); td.appendChild(el('code', r.value)); tr.appendChild(td); tb.appendChild(tr);
    });
    var st = $('cd-status'), s = d.status || {};
    st.className = s.connected ? 'cd-ok' : 'cd-wait';
    st.textContent = s.connected ? 'Yes. ' + d.domain + ' is pointing at your new website. I will take it from here.'
      : s.root ? 'Halfway there. The first record is right, and the www record is not showing yet.'
      : s.www ? 'Halfway there. The www record is right, and the first record (Type A) is not showing yet.'
      : 'Not yet. If you just saved the changes, give it a few minutes and check again.';
  }

  function load() {
    if (!code) { show(null); return; }
    $('cd-check').disabled = true;
    fetch('/api/domain-connect?code=' + encodeURIComponent(code))
      .then(function (r) { return r.json(); }).then(show).catch(function () { show(null); })
      .then(function () { $('cd-check').disabled = false; });
  }
  $('cd-check').addEventListener('click', load);
  load();
})();
