/* Street address lookup for texting registration, shared by /welcome and /start.
   The client types, picks a real address from Google's list, and the page gets it back split into
   street, city, state and zip. A P.O. box is turned away, because the carriers reject it.

   BBAddress(input, { list, note, onPick, onClear })
     input    the text box
     list     an empty element under it, for the suggestions
     note     an element for the short message under the box
     onPick   called with { formatted, street, city, state, zip, check } once an address is chosen
     onClear  called when he edits the box again after choosing

   When Google cannot be reached, a typed address is accepted as it is and marked check: 'typed'. */
(function () {
  var PO_BOX = /\b(p\.?\s*o\.?\s*b(ox)?\.?|post\s+office\s+box|pob)\s*#?\s*\d+/i;
  var MSG = {
    po_box: 'A P.O. box will not work for this, even when the IRS has one on file. Please use the street address where your business is located.',
    no_street_number: 'That one is missing a street number. Please pick the full address, starting with the number.',
    mailbox_store: 'This looks like a rented mailbox. I saved it, and I will text you if the carriers want a different address.',
    none: 'I could not find that address. Keep typing, starting with the street number.',
    typed: 'I could not check this one against Google, so I saved it the way you typed it.'
  };
  function token() { return 'bb' + Math.random().toString(36).slice(2) + Date.now().toString(36); }
  function get(url) { return fetch(url).then(function (r) { if (!r.ok) throw new Error('bad'); return r.json(); }); }

  window.BBAddress = function (input, opt) {
    var list = opt.list, note = opt.note, session = token(), timer = null, picked = false, last = 0;
    function say(text) { note.textContent = text || ''; note.hidden = !text; }
    function close() { list.textContent = ''; list.hidden = true; }
    function typed() {
      var v = input.value.trim();
      if (v.length < 8 || PO_BOX.test(v)) return;
      picked = true; say(MSG.typed);
      opt.onPick({ formatted: v, street: '', city: '', state: '', zip: '', check: 'typed' });
    }
    function choose(item) {
      close(); input.value = item.text; say('Checking that address.');
      get('/api/address?id=' + encodeURIComponent(item.id) + '&s=' + session).then(function (d) {
        session = token();
        if (!d.available || !d.address) return typed();
        var a = d.address;
        if (a.check === 'po_box' || a.check === 'no_street_number') { say(MSG[a.check]); return; }
        picked = true; input.value = a.formatted;
        say(a.check === 'mailbox_store' ? MSG.mailbox_store : '');
        opt.onPick(a);
      }).catch(typed);
    }
    function search() {
      var q = input.value.trim(), mine = ++last;
      if (PO_BOX.test(q)) { close(); say(MSG.po_box); return; }
      if (q.length < 4) { close(); say(''); return; }
      get('/api/address?q=' + encodeURIComponent(q) + '&s=' + session).then(function (d) {
        if (mine !== last) return;
        if (!d.available) { close(); return; }
        list.textContent = '';
        (d.results || []).forEach(function (item) {
          var b = document.createElement('button');
          b.type = 'button'; b.textContent = item.text;
          /* mousedown fires before the box loses focus, so the tap is not lost. */
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { choose(item); });
          list.appendChild(b);
        });
        list.hidden = !list.children.length;
        say(list.children.length ? '' : MSG.none);
      }).catch(close);
    }
    input.setAttribute('autocomplete', 'off');
    input.addEventListener('input', function () {
      if (picked) { picked = false; if (opt.onClear) opt.onClear(); }
      clearTimeout(timer); timer = setTimeout(search, 250);
    });
    /* Leaving the box without choosing: if Google gave nothing to choose from, keep what he typed. */
    input.addEventListener('blur', function () {
      setTimeout(function () { if (!picked && list.hidden && !note.textContent) typed(); close(); }, 200);
    });
    return { isPicked: function () { return picked; }, markPicked: function () { picked = true; }, acceptTyped: function () { close(); typed(); return picked; } };
  };
})();
