/**
 * Project Chronos - Transition Round password service (Google Apps Script web app).
 *
 * Bound to the "Project Chronos - Password List" sheet. The Chronos backend calls it with
 *   POST { secret, action: "consume", zone: "past" | "present" | "future", password,
 *          team_id?, team_name? }
 * and gets back JSON:
 *   { ok: true,  valid: true,  success: true }    password found in that zone's tab and not used
 *                                                  yet -> Status ticked, "Used By" / "Used At" filled
 *   { ok: false, valid: false, success: false }   wrong password, wrong zone, or already used
 *   { error: "...", ok: false, ... }              bad secret / bad request / busy / not configured
 *                                                  (the backend does NOT count the attempt)
 *
 * Also: { secret, action: "add_passwords", zone, passwords: [...] } appends new passwords.
 * GET answers a small health check (no data, no secret needed).
 *
 * THIS MUST BE THE ONLY FILE in the Apps Script project that defines doGet / doPost. A second
 * file with the same function names silently overrides this one (which is what broke the
 * password check before).
 *
 * SETUP (once):
 *  1. In the sheet: Extensions > Apps Script. Replace Code.gs with this file; delete other files.
 *  2. Project Settings (gear) > Script Properties > add  CHRONOS_SECRET = <a long random string>
 *     (the same value goes into the backend's TRANSITION_SHEET_SECRET).
 *  3. Deploy > New deployment > type "Web app": Execute as "Me", Who has access "Anyone".
 *     Copy the Web app URL (ends in /exec) into TRANSITION_SHEET_URL.
 *  4. After changing this code: Deploy > Manage deployments > Edit > Version: New version.
 *     (The URL stays the same.)
 *
 * Tabs are matched by name prefix, case-insensitive: "PAST - PASSWORDS" matches zone "past".
 * Layout per tab: row 1 title, row 2 headers, rows 3+ = SN | Password | Status (checkbox)
 *                 | Used By | Used At        (the last two are filled in by this script)
 */

var FIRST_DATA_ROW = 3;
var PASSWORD_COL = 2; // B
var STATUS_COL = 3;   // C
var USED_BY_COL = 4;  // D
var USED_AT_COL = 5;  // E
var ZONES = ['past', 'present', 'future'];

function doGet() {
  return out_({ status: 'online', service: 'Project Chronos password service' });
}

function doPost(e) {
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    var req;
    try {
      req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    } catch (parseErr) {
      return fail_('bad request');
    }

    var secret = PropertiesService.getScriptProperties().getProperty('CHRONOS_SECRET');
    if (!secret) return fail_('CHRONOS_SECRET is not set in Script Properties');
    if (!req.secret || String(req.secret) !== secret) return fail_('unauthorized');

    var action = String(req.action || 'consume');
    var zone = String(req.zone || '').toLowerCase();
    if (ZONES.indexOf(zone) < 0) return fail_('bad request');

    var sheet = findTab_(zone);
    if (!sheet) return fail_('no tab for zone ' + zone);

    // One request at a time: a password can be used only once. If the lock cannot be had the
    // answer is an error (not "wrong password"), so the backend does not count the attempt.
    locked = lock.tryLock(25000);
    if (!locked) return fail_('busy, try again');

    if (action === 'add_passwords') return addPasswords_(sheet, req.passwords);
    if (action !== 'consume') return fail_('unknown action');

    var password = String(req.password || '').trim().toUpperCase();
    if (!password) return fail_('bad request');
    return consume_(sheet, password, req.team_id, req.team_name);
  } catch (err) {
    return fail_(String(err));
  } finally {
    if (locked) {
      try { lock.releaseLock(); } catch (ignore) {}
    }
  }
}

function consume_(sheet, password, teamId, teamName) {
  var lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return answer_(false);

  var rows = lastRow - FIRST_DATA_ROW + 1;
  var values = sheet.getRange(FIRST_DATA_ROW, PASSWORD_COL, rows, USED_BY_COL - PASSWORD_COL + 1).getValues();
  var tag = (teamId !== undefined && teamId !== null && teamId !== '') ? '(ID: ' + teamId + ')' : '';

  for (var i = 0; i < values.length; i++) {
    if (String(values[i][0]).trim().toUpperCase() !== password) continue;

    var used = isUsed_(values[i][1]);
    if (used) {
      // A retried request (the first answer got lost on the way) must not turn a success into
      // a failure: the same team asking again for the password it already used gets "ok".
      var by = String(values[i][2] || '');
      if (tag && by.indexOf(tag) >= 0) return answer_(true, { replay: true });
      return answer_(false, { is_used: true });
    }

    var rowNum = FIRST_DATA_ROW + i;
    var label = teamName ? String(teamName) + (tag ? ' ' + tag : '') : tag;
    ensureHeaders_(sheet);
    sheet.getRange(rowNum, STATUS_COL).setValue(true);
    if (label) sheet.getRange(rowNum, USED_BY_COL).setValue(label);
    sheet.getRange(rowNum, USED_AT_COL).setValue(
      Utilities.formatDate(new Date(), 'GMT', "yyyy-MM-dd HH:mm:ss 'UTC'")
    );
    SpreadsheetApp.flush();
    return answer_(true);
  }
  return answer_(false);
}

function addPasswords_(sheet, list) {
  if (!Array.isArray(list)) return fail_('bad request');
  var lastRow = sheet.getLastRow();
  var existing = {};
  var maxSn = 0;
  if (lastRow >= FIRST_DATA_ROW) {
    var data = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getValues();
    for (var r = 0; r < data.length; r++) {
      var sn = parseInt(data[r][0], 10);
      if (!isNaN(sn) && sn > maxSn) maxSn = sn;
      if (data[r][1]) existing[String(data[r][1]).trim().toUpperCase()] = true;
    }
  }
  var added = [];
  var skipped = [];
  for (var p = 0; p < list.length; p++) {
    var pw = String(list[p] || '').trim();
    if (!pw) continue;
    if (existing[pw.toUpperCase()]) {
      skipped.push(pw);
      continue;
    }
    maxSn += 1;
    sheet.appendRow([maxSn, pw, false]);
    existing[pw.toUpperCase()] = true;
    added.push(pw);
  }
  return out_({ ok: true, success: true, added: added, skipped: skipped, total_added: added.length });
}

function isUsed_(cell) {
  if (cell === true) return true;
  var s = String(cell).trim().toUpperCase();
  return s === 'TRUE' || s === 'USED' || s === 'REDEEMED';
}

function ensureHeaders_(sheet) {
  var header = sheet.getRange(FIRST_DATA_ROW - 1, USED_BY_COL, 1, 2).getValues()[0];
  if (!header[0]) sheet.getRange(FIRST_DATA_ROW - 1, USED_BY_COL).setValue('Used By');
  if (!header[1]) sheet.getRange(FIRST_DATA_ROW - 1, USED_AT_COL).setValue('Used At');
}

function findTab_(zone) {
  var sheets = SpreadsheetApp.getActiveSpreadsheet().getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (sheets[i].getName().toLowerCase().indexOf(zone) === 0) return sheets[i];
  }
  return null;
}

// ok / valid / success all carry the same answer so any client version understands it.
function answer_(accepted, extra) {
  var body = { ok: accepted, valid: accepted, success: accepted };
  for (var k in (extra || {})) body[k] = extra[k];
  return out_(body);
}

function fail_(message) {
  return out_({ error: message, ok: false, valid: false, success: false });
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
