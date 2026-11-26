/**
 * Build Boosters: sends HighLevel's A2P registration emails to the launch tracker.
 *
 * Lives in the Gmail account that receives the A2P emails (script.google.com, signed in as that account).
 * Twice a day it finds A2P emails from HighLevel it has not sent yet, posts them to
 * buildboosters.com/api/a2p-inbox, and labels them "a2p-sent" so each one goes once.
 *
 * Setup, one time:
 *   1. Project Settings > Script Properties > add BB_INTERNAL_SECRET with the same value as in Vercel.
 *   2. Run "setup" once and approve the Gmail permission. It creates the label and the twice-a-day timer.
 *   3. Run "checkA2pEmails" once by hand and read the log to see what it found.
 */
var ENDPOINT = 'https://buildboosters.com/api/a2p-inbox';
var SENT_LABEL = 'a2p-sent';
var QUERY = 'from:(gohighlevel.com OR leadconnectorhq.com OR msgsndr.com) ' +
  '(a2p OR 10dlc OR "brand registration" OR "campaign registration" OR "trust center") ' +
  '-label:' + SENT_LABEL + ' newer_than:30d';

function setup() {
  if (!GmailApp.getUserLabelByName(SENT_LABEL)) GmailApp.createLabel(SENT_LABEL);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'checkA2pEmails') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('checkA2pEmails').timeBased().everyHours(12).create();
  Logger.log('Ready. checkA2pEmails will run every 12 hours.');
}

function checkA2pEmails() {
  var secret = PropertiesService.getScriptProperties().getProperty('BB_INTERNAL_SECRET');
  if (!secret) throw new Error('Add BB_INTERNAL_SECRET under Project Settings > Script Properties.');
  var label = GmailApp.getUserLabelByName(SENT_LABEL) || GmailApp.createLabel(SENT_LABEL);
  var threads = GmailApp.search(QUERY, 0, 25);
  if (!threads.length) { Logger.log('No new A2P emails.'); return; }

  var messages = [];
  threads.forEach(function (thread) {
    thread.getMessages().forEach(function (m) {
      messages.push({
        id: m.getId(),
        from: m.getFrom(),
        subject: m.getSubject(),
        date: m.getDate().toISOString(),
        body: m.getPlainBody().slice(0, 8000)
      });
    });
  });

  var res = UrlFetchApp.fetch(ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-bb-secret': secret },
    payload: JSON.stringify({ messages: messages.slice(0, 50) }),
    muteHttpExceptions: true
  });
  Logger.log(res.getResponseCode() + ' ' + res.getContentText());
  // Only label them as sent when the tracker took them, so a failed run tries again next time.
  if (res.getResponseCode() === 200) threads.forEach(function (t) { t.addLabel(label); });
  else throw new Error('The tracker answered ' + res.getResponseCode() + '. Nothing was labeled, so it will retry.');
}
