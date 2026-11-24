/* Build Boosters site script: menu, Trades dropdown, form handling and the thank-you redirect. */
(function () {
  var nav = document.getElementById('nav');
  if (nav) {
    var onScroll = function () { nav.classList.toggle('solid', scrollY > 120); };
    addEventListener('scroll', onScroll, { passive: true }); onScroll();
    var mb = document.getElementById('menuBtn');
    if (mb) mb.addEventListener('click', function () { var o = nav.classList.toggle('open'); mb.setAttribute('aria-expanded', o); });
    var dd = nav.querySelector('.bb-dd'), tr = dd && dd.querySelector('.bb-tr');
    if (tr) {
      tr.addEventListener('click', function () { var o = dd.classList.toggle('open'); tr.setAttribute('aria-expanded', o); });
      document.addEventListener('click', function (e) { if (!dd.contains(e.target)) { dd.classList.remove('open'); tr.setAttribute('aria-expanded', 'false'); } });
    }
  }

  /* On the homepage, "Make My Demo" buttons scroll to the demo builder and focus the first field. */
  var build = document.getElementById('build');
  if (build) {
    var RM = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.querySelectorAll('a[href="#build"],a[href="/#build"]').forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        build.scrollIntoView({ behavior: RM ? 'auto' : 'smooth', block: 'center' });
        var f = document.getElementById('b-biz');
        if (f) setTimeout(function () { f.focus({ preventScroll: true }); }, RM ? 0 : 450);
      });
    });
    if (location.hash === '#build') setTimeout(function () { build.scrollIntoView({ block: 'center' }); }, 60);
  }

  /* Call-request forms (form.quote, not the demo builder). GHL's external tracking script reads the
     submission; we show the confirmation and send the visitor to /thank-you to book a call. */
  document.querySelectorAll('form.quote').forEach(function (f) {
    if (f.id === 'build') return;
    f.addEventListener('submit', function (e) {
      e.preventDefault();
      var n = f.querySelector('.note');
      if (n) { n.hidden = false; n.textContent = "Got it! We'll text you shortly."; }
      try {
        var v = function (k) { var el = f.querySelector('[name=' + k + ']'); return el ? el.value : ''; };
        sessionStorage.setItem('bbTY', JSON.stringify({ n: v('full_name'), p: v('phone'), e: v('email') }));
      } catch (x) {}
      setTimeout(function () { f.reset(); location.href = '/thank-you'; }, 1600);
    });
  });

  /* Keep GHL booking calendars sized to their content. */
  addEventListener('message', function (e) {
    try {
      if (!/buildboosters\.com|msgsndr\.com|leadconnectorhq\.com/.test(e.origin)) return;
      var d = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
      if (Array.isArray(d) && d[0] === 'highlevel.setHeight' && d[1] && d[1].height) {
        document.querySelectorAll('iframe[data-autoheight]').forEach(function (f) {
          if (e.source === f.contentWindow) f.style.height = (Math.ceil(d[1].height) + 8) + 'px';
        });
      }
    } catch (x) {}
  });
})();
