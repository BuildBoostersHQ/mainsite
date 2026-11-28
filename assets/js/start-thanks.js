/* Thank-you page after the onboarding form (/start-thank-you/<code>). Shows what is left for the setup credit,
   the launch call with add-to-calendar buttons, and what happens next. No code shows a sample client. */
(function () {
  var root = document.getElementById('ob-ty');
  if (!root) return;
  var $ = function (id) { return document.getElementById(id); };
  var m = location.pathname.match(/^\/start-thank-you\/([A-Za-z0-9_-]{12,64})\/?$/);
  var code = m ? m[1] : '';
  var CALL_MINUTES = 30;

  function sample() {
    var start = new Date(); start.setDate(start.getDate() + 3); start.setHours(14, 0, 0, 0);
    return { first_name: 'Dave', launch_call_at: '', launch_call_start: start.toISOString(), photo_folder_url: '',
      google_requested: true, google_approved: false, submitted: true,
      ein_on_file: true, billing_cycle: 'monthly',
      credit: { earned: 0, same_day_until: new Date(Date.now() + 6 * 3600 * 1000).toISOString(), next_day_until: new Date(Date.now() + 30 * 3600 * 1000).toISOString() } };
  }
  var stamp = function (d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
  var nice = function (d) {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  };

  function credit(d) {
    var a = d.answers || {};
    var noEin = /^website/i.test(String(d.tier || '').trim()) || /no EIN/i.test(a.a2p_entity_type || '');
    var missing = [];
    if (!d.submitted) missing.push('Finish your setup page and tap the button at the bottom.');
    if (!noEin && !d.ein_on_file) missing.push('Go back to your setup page and add your EIN for your texting number.');
    if (!d.google_requested) missing.push('Go back to your setup page and add me as a manager on your Google profile.');
    var c = window.bbCredit ? window.bbCredit(d) : null;
    if (!c) return;
    if (c.earned || !missing.length) {
      var n = c.earned || c.amount;
      var monthly = !d.billing_cycle || /^monthly$/i.test(String(d.billing_cycle).trim());
      $('ty-credit-eyebrow').textContent = 'A little thank you';
      $('ty-credit-title').textContent = monthly ? 'You earned $' + n + ' off your next bill' : 'You earned a $' + n + ' credit';
      $('ty-credit-text').textContent = monthly ? 'Everything is in, so it comes off automatically.' : 'Everything is in, so I will add it to your account.';
    } else {
      $('ty-credit-eyebrow').textContent = missing.length === 1 ? 'One thing left' : 'A couple of things left';
      $('ty-credit-title').textContent = "Let's get you that $" + c.amount + ' off';
      $('ty-credit-text').textContent = c.text;
      missing.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; $('ty-credit-list').appendChild(li); });
    }
    $('ty-credit').hidden = false;
  }

  function call(d) {
    var start = d.launch_call_start ? new Date(d.launch_call_start) : null;
    var ok = start && !isNaN(start);
    var label = d.launch_call_at || (ok ? nice(start) : '');
    if (!label) return;
    $('ty-when').textContent = label;
    $('ty-call').hidden = false;
    if (!ok) return;
    var end = new Date(start.getTime() + CALL_MINUTES * 60000);
    var title = 'Build Boosters launch call with Maddie';
    var details = 'We will go through your new website together and put it live. If you need to move this, text Maddie at (786) 933-8832.';
    $('ty-gcal').href = 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + encodeURIComponent(title) +
      '&dates=' + stamp(start) + '/' + stamp(end) + '&details=' + encodeURIComponent(details);
    var ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Build Boosters//Launch call//EN', 'BEGIN:VEVENT',
      'UID:launch-' + stamp(start) + '@buildboosters.com', 'DTSTAMP:' + stamp(new Date()), 'DTSTART:' + stamp(start), 'DTEND:' + stamp(end),
      'SUMMARY:' + title, 'DESCRIPTION:' + details.replace(/,/g, '\\,'), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
    $('ty-ics').href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
    $('ty-cal').hidden = false;
  }

  function render(d) {
    if (d.first_name) { $('ty-name').textContent = d.first_name; document.title = 'Thank you, ' + d.first_name + ' | Build Boosters'; }
    credit(d); call(d);
    if (d.photo_folder_url && /^https:\/\//.test(d.photo_folder_url)) { $('ty-folder').href = d.photo_folder_url; $('ty-folder').hidden = false; }
    $('ty-back').href = '/start' + (code ? '/' + code : '');
    $('ty-loading').hidden = true; $('ty-main').hidden = false;
  }

  if (!code) { render(sample()); return; }
  fetch('/api/onboarding?code=' + encodeURIComponent(code))
    .then(function (r) { if (!r.ok) throw new Error('not found'); return r.json(); })
    .then(render)
    .catch(function () { $('ty-loading').hidden = true; $('ty-error').hidden = false; });
})();
