/**
 * SkyDeck Live Map: Gmail to map relay (runs free in YOUR Google account, no Grok Bot compute).
 * Setup (one time, about 3 minutes):
 *  1. Open https://script.google.com, click New project, paste this file, and save.
 *  2. Set KEY below to the plan key (same as INBOUND_KEY on Render).
 *  3. Run "setup" once and approve the Gmail + external-request permissions.
 * Then email or forward any flight plan to  quin.colson+livemapskydeck@gmail.com
 * Every 5 minutes this checks for new mail to that address, posts it to the map, and labels it.
 */
const URL_ = 'https://skydeck-livemap.onrender.com/api/inbound';
const KEY = 'PASTE_PLAN_KEY_HERE';
const QUERY = 'to:quin.colson+livemapskydeck@gmail.com -label:livemapskydeck-done newer_than:2d';
function setup() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('relay').timeBased().everyMinutes(5).create();
  GmailApp.getUserLabelByName('livemapskydeck-done') || GmailApp.createLabel('livemapskydeck-done');
  relay();
}
function relay() {
  const done = GmailApp.getUserLabelByName('livemapskydeck-done') || GmailApp.createLabel('livemapskydeck-done');
  GmailApp.search(QUERY, 0, 10).reverse().forEach(th => {
    const m = th.getMessages().pop();
    const r = UrlFetchApp.fetch(URL_ + '?key=' + encodeURIComponent(KEY), { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ subject: m.getSubject(), plain: m.getPlainBody(), from: m.getFrom(), date: m.getDate() }) });
    console.log(m.getSubject(), r.getResponseCode(), r.getContentText().slice(0, 300));
    th.addLabel(done);
  });
}
