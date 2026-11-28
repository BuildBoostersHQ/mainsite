/* The setup credit, worded the same way on the welcome page, the setup form and the thank-you page.
   $50 for finishing setup on the day of payment and $20 for the next day. /api/onboarding sends the
   two deadlines, which are the end of a day in Eastern time. */
window.bbCredit = function (d) {
  var c = (d && d.credit) || {};
  var monthly = !d.billing_cycle || /^monthly$/i.test(String(d.billing_cycle).trim());
  var how = function (n) { return monthly ? '$' + n + ' comes off your next bill automatically' : 'I will add a $' + n + ' credit to your account'; };
  var head = function (n) { return monthly ? '$' + n + ' off your next bill' : 'A $' + n + ' credit on your account'; };
  var day = function (iso) {
    /* The deadline is midnight, so the day it names is the one that ends there. */
    return new Date(new Date(iso).getTime() - 60000).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
  };
  if (c.earned) return { earned: c.earned, title: monthly ? 'You earned $' + c.earned + ' off your next bill' : 'You earned a $' + c.earned + ' credit', text: monthly ? 'Everything is in, so it comes off automatically.' : 'Everything is in, so I will add it to your account.' };
  var now = Date.now();
  var first = c.same_day_until ? new Date(c.same_day_until).getTime() : 0;
  var second = c.next_day_until ? new Date(c.next_day_until).getTime() : 0;
  if (first && now < first) {
    return { amount: 50, title: head(50), text: 'Finish your setup and add me to your Google profile by the end of ' + day(c.same_day_until) + ', and ' + how(50) + '. If it takes you until ' + day(c.next_day_until) + ', it is $20.' };
  }
  if (second && now < second) {
    return { amount: 20, title: head(20), text: 'Finish your setup and add me to your Google profile by the end of ' + day(c.next_day_until) + ', and ' + how(20) + '.' };
  }
  return null;
};
