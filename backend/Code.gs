// ===== Budget app backend (Google Apps Script) =====
// Works in any copy of the budget workbook without editing this file:
//  - it uses the spreadsheet it is attached to (no sheet ID to change)
//  - the passphrase is set from the sheet's menu: Budget app → Set up / change passphrase
const BUDGET_TAB = 'Am I over Budget??';
const SHEET_GID = 848641762;   // fallback if the budget tab was renamed
const FIRST_CAT_ROW = 6;       // categories: Name B, Budget C, Spending D (Total row right after them)
const LOG_FIRST_ROW = 16;      // log: Date B, Category C, Spent D, Note E
const SPEND_LAST_ROW = 86;     // your Spending formulas only sum rows 16-86
const API_VERSION = 13;         // shown in the app's error messages so you can tell which version is live
const OWED_TAB = 'Savings Owed';
const TRIP_TAB = 'Bolivia Trip';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const ARCH_HEADER_ROW = 3, ARCH_FIRST_ROW = 4;

// ---------- setup menu (in the spreadsheet: Budget app → ...) ----------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Budget app')
    .addItem('Set up / change passphrase', 'setupBudgetApp')
    .addItem('Show app link', 'showAppLink')
    .addSeparator()
    .addItem('Turn on Chase email import', 'turnOnChaseImport')
    .addItem('Turn off Chase email import', 'turnOffChaseImport')
    .addToUi();
}
function props_() { return PropertiesService.getScriptProperties(); }
function secret_() { return props_().getProperty('SECRET') || ''; }
function checkKey_(key) {
  const s = secret_();
  if (!s) throw new Error('This budget sheet is not set up yet. In the sheet, choose Budget app → Set up / change passphrase.');
  if (!key || key !== s) throw new Error('Wrong passphrase');
}
function setupBudgetApp() {
  const ui = SpreadsheetApp.getUi();
  const p = props_();
  const had = !!p.getProperty('SECRET');
  const r = ui.prompt('Budget app passphrase',
    (had ? 'A passphrase is already set. Type a new one to change it (then re-enter it in the app).'
         : 'Choose a passphrase. You will type it into the app once.') + '\nAt least 6 characters.',
    ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const s = r.getResponseText().trim();
  if (s.length < 6) { ui.alert('Use at least 6 characters.'); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  p.setProperty('SECRET', s);
  p.setProperty('SHEET_ID', ss.getId());
  // a fresh copy (no payments, no archive yet): the app will ask for categories and budgets
  const fresh = !ss.getSheets().some(x => /^Archive \d{4}$/.test(x.getName())) && readLog_(getSheet_()).rows.length === 0;
  if (!had && fresh) p.setProperty('NEEDS_BUDGET', '1');
  ensureMonthlyTrigger_();
  ui.alert('Passphrase saved',
    had ? 'Enter the new passphrase in the app (Re-enter setup) on each phone.'
        : 'Next: Extensions → Apps Script → Deploy → New deployment → Web app.\n' +
          'Execute as: Me. Who has access: Anyone. Then copy the Web app URL (ends in /exec)\n' +
          'and enter it in the app with this passphrase.',
    ui.ButtonSet.OK);
}
function showAppLink() {
  let u = '';
  try { u = ScriptApp.getService().getUrl() || ''; } catch (e) {}
  SpreadsheetApp.getUi().alert(u
    ? 'Your app link (paste it into the Budget app setup):\n\n' + u
    : 'Not deployed yet. Extensions → Apps Script → Deploy → New deployment → Web app.');
}
// Chase purchase alerts in this account's Gmail become payments automatically (checked every 10 minutes, from now on)
function turnOnChaseImport() {
  setupChaseTrigger();
  SpreadsheetApp.getUi().alert('Chase email import is on',
    'Purchase alerts from no.reply.alerts@chase.com in this Google account\'s Gmail are checked every 10 minutes ' +
    '(only emails from now on). Turn on purchase alerts in the Chase app or website, sent to this Gmail address.\n\n' +
    'Charges that no Merchant Rule knows wait in the app (Chase charges card) for you to pick a category.',
    SpreadsheetApp.getUi().ButtonSet.OK);
}
function turnOffChaseImport() {
  stopChaseTrigger();
  SpreadsheetApp.getUi().alert('Chase email import is off.');
}
// the monthly save-and-clear job, created once
function ensureMonthlyTrigger_() {
  if (ScriptApp.getProjectTriggers().some(t => t.getHandlerFunction() === 'monthlyJob')) return;
  ScriptApp.newTrigger('monthlyJob').timeBased().onMonthDay(1).atHour(1).nearMinute(30).create();
  if (!props_().getProperty('lastArchived')) {
    const tz = ss_().getSpreadsheetTimeZone();
    const cur = Utilities.formatDate(new Date(), tz, 'yyyy-MM').split('-');
    let y = Number(cur[0]), pm = Number(cur[1]) - 1;   // last month, 1-based
    if (pm < 1) { pm = 12; y -= 1; }
    props_().setProperty('lastArchived', y + '-' + String(pm).padStart(2, '0'));
  }
}

// ---------- web app entry points ----------
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function doGet(e) {
  try {
    checkKey_(e.parameter.key);
    if (e.parameter.action === 'payments') return out_(getPayments());
    if (e.parameter.action === 'summary') return out_(getSummary());
    if (e.parameter.action === 'owed') return out_(getOwed());
    if (e.parameter.action === 'trip') return out_(tripGet_());
    if (e.parameter.action === 'rules') return out_(getRules_());
    if (e.parameter.action === 'imports') return out_(getImports_());
    if (e.parameter.action === 'ping') return out_({ version: API_VERSION });
    return out_(getData());
  } catch (err) { return out_({ error: String(err.message || err) }); }
}
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    checkKey_(body.key);
    const action = body.action || 'add';
    if (action === 'update') return out_(withLock_(() => updatePayment_(body)));
    if (action === 'delete') return out_(withLock_(() => deletePayment_(body)));
    if (action === 'budgetSave') return out_(withLock_(() => saveBudget_(body)));
    if (action === 'ruleSave') return out_(withLock_(() => saveRule_(body)));
    if (action === 'ruleDelete') return out_(withLock_(() => deleteRule_(body)));
    if (action === 'importSet') return out_(withLock_(() => importSet_(body)));
    if (action === 'importSkip') return out_(withLock_(() => importSkip_(body)));
    if (action === 'owedAdd') return out_(withLock_(() => addOwed_(body)));
    if (action === 'owedDelete') return out_(withLock_(() => deleteOwed_(body)));
    if (action === 'tripSave') return out_(withLock_(() => tripSave_(body.trip || {})));
    return out_(withLock_(() => addExpenses_(body.items || [])));
  } catch (err) { return out_({ error: String(err.message || err) }); }
}

// ---------- helpers ----------
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
let SS_ = null;
// the workbook this script is attached to (falls back to the ID saved by Set up)
function ss_() {
  if (SS_) return SS_;
  SS_ = SpreadsheetApp.getActiveSpreadsheet();
  if (!SS_) {
    const id = props_().getProperty('SHEET_ID');
    if (!id) throw new Error('In the sheet, choose Budget app → Set up / change passphrase first.');
    SS_ = SpreadsheetApp.openById(id);
  }
  return SS_;
}
function getSheet_() {
  const ss = ss_();
  const sh = ss.getSheetByName(BUDGET_TAB) || ss.getSheets().find(s => s.getSheetId() === SHEET_GID);
  if (!sh) throw new Error('Budget tab "' + BUDGET_TAB + '" not found');
  return sh;
}
function fmt_(d, tz) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd'); }
function num_(v) { const n = Number(String(v).replace(/[$,]/g, '')); return isNaN(n) ? 0 : n; }
// midnight of a 'yyyy-MM-dd' day in the spreadsheet's timezone (correct even if the script's own timezone differs)
function dateAt_(str) { return Utilities.parseDate(String(str), ss_().getSpreadsheetTimeZone(), 'yyyy-MM-dd'); }
function writeDate_(sh, row, str) { writeDateOn_(sh, row, 2, str); }
// your category's exact spelling from the sheet, whatever capitalization was sent
function canonCat_(name, canon) { return canon[String(name || '').trim().toLowerCase()] || String(name || '').trim(); }

// ---------- reading ----------
// The category block: rows from FIRST_CAT_ROW down to the "Total" row (blank rows in between are unused slots).
function catBlock_(sh) {
  const n = LOG_FIRST_ROW - 1 - FIRST_CAT_ROW;           // rows 6..14
  const rows = sh.getRange(FIRST_CAT_ROW, 2, n, 3).getValues();
  let totalAt = -1;
  for (let i = 0; i < rows.length; i++) if (String(rows[i][0]).trim().toLowerCase() === 'total') { totalAt = i; break; }
  return { rows: totalAt >= 0 ? rows.slice(0, totalAt) : rows, total: totalAt >= 0 ? rows[totalAt] : null };
}
// Categories + the sheet's own Total row (budget total includes Monthly Spendable)
function getData() {
  SpreadsheetApp.flush();
  const b = catBlock_(getSheet_());
  const categories = [];
  b.rows.forEach(([name, budget, spent]) => {
    const n = String(name).trim();
    if (n) categories.push({ name: n, budget: num_(budget), spent: num_(spent) });
  });
  const total = b.total ? { budget: num_(b.total[1]), spent: num_(b.total[2]) }
    : { budget: categories.reduce((a, c) => a + c.budget, 0), spent: categories.reduce((a, c) => a + c.spent, 0) };
  const ic = importCounts_();
  return { version: API_VERSION, categories: categories, total: total, owed: owedBalance_(), pendingCount: ic.pending, recentImports: ic.recent, aiRecent: ic.ai,
    maxCategories: b.total ? b.rows.length : 0, needsBudget: props_().getProperty('NEEDS_BUDGET') === '1' };
}

// Reads the log. A blank date means "same day as the nearest date above".
function readLog_(sh) {
  const tz = ss_().getSpreadsheetTimeZone();
  const n = sh.getMaxRows() - LOG_FIRST_ROW + 1;
  const vals = sh.getRange(LOG_FIRST_ROW, 2, n, 4).getValues();
  const rows = [];
  let eff = '', last = LOG_FIRST_ROW - 1;
  vals.forEach((v, i) => {
    const r = LOG_FIRST_ROW + i;
    let own = '';
    if (v[0] instanceof Date) own = fmt_(v[0], tz);
    else if (String(v[0]).trim() !== '') { const p = new Date(v[0]); if (!isNaN(p)) own = fmt_(p, tz); }
    if (own) eff = own;
    const used = String(v[1]).trim() !== '' || String(v[2]).trim() !== '';
    if (used) {
      rows.push({ row: r, date: own, effectiveDate: eff, category: String(v[1]).trim(), amount: num_(v[2]), note: String(v[3] || '') });
      last = r;
    }
  });
  return { rows: rows, last: last, tz: tz };
}
function getPayments() {
  const L = readLog_(getSheet_());
  return { version: API_VERSION, payments: L.rows, lastRow: L.last, limitWarning: L.last > SPEND_LAST_ROW - 6 };
}
function matches_(cur, exp) {
  if (!exp) return false;
  return String(cur.category).trim().toLowerCase() === String(exp.category).trim().toLowerCase() &&
    Math.abs(cur.amount - Number(exp.amount)) < 0.005;
}

// ---------- categories & budgets (set from the app) ----------
// Writes names (B) and monthly budgets (C) into the category rows, with the same Spending formula (D) as the sheet's own.
// A category can be renamed or removed only while it has no payments this month (so the totals never lose a payment).
function saveBudget_(b) {
  const sh = getSheet_();
  const block = catBlock_(sh);
  if (!block.total) throw new Error('Could not find the "Total" row under your categories.');
  const slots = block.rows.length;
  const list = (Array.isArray(b.categories) ? b.categories : []).map(c => ({ name: String(c.name || '').trim(), budget: Number(c.budget) }))
    .filter(c => c.name || c.budget);
  if (!list.length) throw new Error('Add at least one category.');
  if (list.length > slots) throw new Error('Your sheet has room for ' + slots + ' categories.');
  const seen = {};
  list.forEach(c => {
    if (!c.name) throw new Error('Every category needs a name.');
    if (/[*?~]/.test(c.name)) throw new Error('Category names can\'t contain * ? or ~');
    if (!isFinite(c.budget) || c.budget < 0) throw new Error('Enter a budget of 0 or more for "' + c.name + '".');
    const k = c.name.toLowerCase();
    if (seen[k]) throw new Error('"' + c.name + '" is listed twice.');
    seen[k] = true;
  });
  // the Spending formula matches any category name containing this one, so one name can't sit inside another
  list.forEach(a => list.forEach(o => {
    if (a !== o && o.name.toLowerCase().indexOf(a.name.toLowerCase()) >= 0)
      throw new Error('"' + a.name + '" is part of "' + o.name + '", so their spending would be mixed up. Rename one of them.');
  }));
  const used = {};
  readLog_(sh).rows.forEach(r => { if (r.category) used[r.category.toLowerCase()] = true; });
  block.rows.forEach(r => {
    const n = String(r[0]).trim();
    if (n && !seen[n.toLowerCase()] && used[n.toLowerCase()])
      throw new Error('"' + n + '" has payments this month, so it can\'t be renamed or removed until next month. You can still change its budget.');
  });
  const vals = [], f = [];
  for (let i = 0; i < slots; i++) {
    const r = FIRST_CAT_ROW + i;
    vals.push(i < list.length ? [list[i].name, list[i].budget] : ['', '']);
    f.push(['=IF(B' + r + ' = "", "",(SUMIF($C$' + LOG_FIRST_ROW + ':$C$' + SPEND_LAST_ROW + ',"*"& B' + r + ' & "*",$D$' + LOG_FIRST_ROW + ':$D$' + SPEND_LAST_ROW + ')))']);
  }
  sh.getRange(FIRST_CAT_ROW, 2, slots, 2).setValues(vals);
  sh.getRange(FIRST_CAT_ROW, 3, slots, 1).setNumberFormat('$#,##0.00');
  sh.getRange(FIRST_CAT_ROW, 4, slots, 1).setFormulas(f);
  props_().deleteProperty('NEEDS_BUDGET');
  SpreadsheetApp.flush();
  return getData();
}

// ---------- writing ----------
// A date may be supplied. It is written only when it differs from the date already in effect above
// (same result, and it keeps the log looking like your manual entries). With no date, today's is used.
function addExpenses_(items) {
  const sh = getSheet_();
  const L = readLog_(sh);
  const canon = canonCats_();
  const todayStr = fmt_(new Date(), L.tz);
  let lastDate = L.rows.length ? L.rows[L.rows.length - 1].effectiveDate : '';
  let last = L.last;
  const savingsRows = [];
  items.forEach(it => {
    last++;
    if (last > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), 20);
    const want = it.date ? String(it.date) : todayStr;
    if (want !== lastDate) { writeDate_(sh, last, want); lastDate = want; }
    const cat = canonCat_(it.category, canon);
    if (it.fromSavings) savingsRows.push([Number(it.amount), 'Paid: ' + cat + (it.note ? ' - ' + it.note : ''), want]);
    sh.getRange(last, 3).setValue(cat);
    sh.getRange(last, 4).setValue(Number(it.amount)).setNumberFormat('$#,##0.00');
    sh.getRange(last, 5).setValue(it.note || '');
  });
  savingsRows.forEach(r => addOwedRow_(r[0], r[1], r[2]));
  SpreadsheetApp.flush();
  return getData();
}

function updatePayment_(b) {
  const sh = getSheet_();
  const L = readLog_(sh);
  const cur = L.rows.find(x => x.row === Number(b.row));
  if (!cur || !matches_(cur, b.expected)) throw new Error('That payment changed. Refresh and try again.');
  if (b.date && b.date !== cur.effectiveDate) {
    // keep the next payment on its current day if it was relying on this row's date
    const next = L.rows.find(x => x.row === cur.row + 1);
    if (next && !next.date && cur.effectiveDate) writeDate_(sh, next.row, cur.effectiveDate);
    writeDate_(sh, cur.row, b.date);
  }
  sh.getRange(cur.row, 3).setValue(canonCat_(b.category, canonCats_()));
  sh.getRange(cur.row, 4).setValue(Number(b.amount)).setNumberFormat('$#,##0.00');
  sh.getRange(cur.row, 5).setValue(b.note || '');
  SpreadsheetApp.flush();
  return getData();
}

// Delete without deleteRow (that would shrink your Spending formula ranges):
// shift later rows up, and hand the removed row's date to the next row if it needed it.
function deletePayment_(b) {
  const sh = getSheet_();
  const L = readLog_(sh);
  const cur = L.rows.find(x => x.row === Number(b.row));
  if (!cur || !matches_(cur, b.expected)) throw new Error('That payment changed. Refresh and try again.');
  const count = L.last - cur.row + 1;
  const raw = sh.getRange(cur.row, 2, count, 4).getValues();
  const removedDate = raw[0][0];
  const rest = raw.slice(1);
  if (String(removedDate).trim() !== '' && rest.length && String(rest[0][0]).trim() === '') rest[0][0] = removedDate;
  if (rest.length) {
    sh.getRange(cur.row, 2, rest.length, 1).setNumberFormat('yyyy-mm-dd');
    sh.getRange(cur.row, 4, rest.length, 1).setNumberFormat('$#,##0.00');
    sh.getRange(cur.row, 2, rest.length, 4).setValues(rest);
  }
  sh.getRange(L.last, 2, 1, 4).clearContent();
  SpreadsheetApp.flush();
  return getData();
}

// ---------- monthly archive + clear ----------
function clearLog_(sh) {
  const n = sh.getMaxRows() - LOG_FIRST_ROW + 1;
  sh.getRange(LOG_FIRST_ROW, 2, n, 4).clearContent(); // values only: dropdowns, formats, formulas stay
}
function clearLogNow() { withLock_(() => clearLog_(getSheet_())); }

function monthlyJob() { archiveAndClear(false); }

// Archives the month that just ended, then clears the log.
function archiveAndClear(force) {
  withLock_(() => {
    const tz = ss_().getSpreadsheetTimeZone();
    const cur = Utilities.formatDate(new Date(), tz, 'yyyy-MM').split('-');
    let y = Number(cur[0]);
    let pm = Number(cur[1]) - 2;                 // previous month, 0-based
    if (pm < 0) { pm = 11; y -= 1; }
    const monthKey = y + '-' + String(pm + 1).padStart(2, '0');
    const props = PropertiesService.getScriptProperties();
    if (!force && props.getProperty('lastArchived') === monthKey) return;
    const cats = getData().categories;
    writeArchive_(ss_(), y, pm, cats);           // throws on failure, so the log is never cleared without an archive
    clearLog_(getSheet_());
    props.setProperty('lastArchived', monthKey);
  });
}

// (older one-time setup for the original sheet; new copies use Budget app → Set up instead)
function setupMonthlyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'monthlyJob') ScriptApp.deleteTrigger(t);
  });
  // 1:30 AM, so the 1st has started in Central time even if the script's timezone is set to Eastern
  ScriptApp.newTrigger('monthlyJob').timeBased().onMonthDay(1).atHour(1).nearMinute(30).create();
  PropertiesService.getScriptProperties().setProperty('lastArchived', '2026-10'); // October already archived
}

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
function findTotalRow_(sh) {
  const vals = sh.getRange(ARCH_FIRST_ROW, 1, Math.max(1, sh.getLastRow() - ARCH_FIRST_ROW + 1), 1).getValues();
  for (let i = 0; i < vals.length; i++) if (String(vals[i][0]).trim().toLowerCase() === 'total') return ARCH_FIRST_ROW + i;
  throw new Error('Total row not found in ' + sh.getName());
}
function findCatRow_(sh, name, totalRow) {
  const vals = sh.getRange(ARCH_FIRST_ROW, 1, totalRow - ARCH_FIRST_ROW, 1).getValues();
  for (let i = 0; i < vals.length; i++)
    if (String(vals[i][0]).trim().toLowerCase() === name.trim().toLowerCase()) return ARCH_FIRST_ROW + i;
  return 0;
}
function createArchive_(ss, year, cats) {
  const sh = ss.insertSheet('Archive ' + year);
  const header = ['Category', 'Starting total'].concat(MONTHS, ['Year total']);
  const yc = header.length;                      // Year total column
  sh.getRange(1, 1).setValue('Archive ' + year + ': monthly totals per category').setFontWeight('bold').setFontSize(14);
  sh.getRange(ARCH_HEADER_ROW, 1, 1, yc).setValues([header]).setFontWeight('bold').setHorizontalAlignment('center');
  cats.forEach((c, i) => {
    const r = ARCH_FIRST_ROW + i;
    sh.getRange(r, 1).setValue(c.name);
    sh.getRange(r, yc).setFormula('=SUM(B' + r + ':' + colLetter_(yc - 1) + r + ')');
  });
  const totalRow = ARCH_FIRST_ROW + cats.length;
  sh.getRange(totalRow, 1).setValue('Total');
  rebuildTotals_(sh, totalRow, header);
  sh.getRange(ARCH_FIRST_ROW, 2, cats.length + 1, yc - 1).setNumberFormat('$#,##0.00');
  sh.getRange(totalRow, 1, 1, yc).setFontWeight('bold');
  sh.setColumnWidth(1, 240); sh.setColumnWidth(2, 130);
  return sh;
}
function rebuildTotals_(sh, totalRow, headers) {
  const yc = headers.indexOf('Year total') + 1;
  for (let c = 3; c <= yc; c++) {
    const L = colLetter_(c);
    sh.getRange(totalRow, c).setFormula('=SUM(' + L + ARCH_FIRST_ROW + ':' + L + (totalRow - 1) + ')');
  }
}
function writeArchive_(ss, year, mi, cats) {
  const sh = ss.getSheetByName('Archive ' + year) || createArchive_(ss, year, cats);
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(ARCH_HEADER_ROW, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
  const mc = headers.indexOf(MONTHS[mi]) + 1;
  if (!mc) throw new Error('Column "' + MONTHS[mi] + '" not found in ' + sh.getName());
  let totalRow = findTotalRow_(sh);
  cats.forEach(c => {
    let r = findCatRow_(sh, c.name, totalRow);
    if (!r) {                                    // new category: add a row above Total
      sh.insertRowBefore(totalRow);
      r = totalRow; totalRow++;
      sh.getRange(r - 1, 1, 1, lastCol).copyTo(sh.getRange(r, 1, 1, lastCol), SpreadsheetApp.CopyPasteType.PASTE_NORMAL, false);
      sh.getRange(r, 1).setValue(c.name);
      sh.getRange(r, 2, 1, lastCol - 2).clearContent();
    }
    sh.getRange(r, mc).setValue(c.spent);
  });
  rebuildTotals_(sh, totalRow, headers);
}

// ---------- year-to-date summary (reads the Archive tab + this month's live numbers) ----------
function getSummary() {
  const ss = ss_();
  const tz = ss.getSpreadsheetTimeZone();
  const now = Utilities.formatDate(new Date(), tz, 'yyyy-MM').split('-');
  const year = Number(now[0]);
  const cur = MONTHS[Number(now[1]) - 1];
  const live = getData().categories;
  const rows = [];
  const seen = {};
  const sh = ss.getSheetByName('Archive ' + year);
  if (sh) {
    const lastCol = sh.getLastColumn();
    const headers = sh.getRange(ARCH_HEADER_ROW, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
    const startCol = headers.indexOf('Starting total');
    const yearCol = headers.indexOf('Year total');
    const totalRow = findTotalRow_(sh);
    const vals = sh.getRange(ARCH_FIRST_ROW, 1, totalRow - ARCH_FIRST_ROW, lastCol).getValues();
    vals.forEach(v => {
      const name = String(v[0]).trim();
      if (!name) return;
      const values = {};
      MONTHS.forEach(m => {
        const c = headers.indexOf(m);
        if (c >= 0 && String(v[c]).trim() !== '') { values[m] = num_(v[c]); seen[m] = true; }
      });
      rows.push({
        name: name,
        startingTotal: startCol >= 0 && String(v[startCol]).trim() !== '' ? num_(v[startCol]) : null,
        values: values,
        yearTotal: yearCol >= 0 ? num_(v[yearCol]) : 0
      });
    });
  }
  // this month so far (live), added on top unless the archive already holds it
  live.forEach(c => {
    let r = rows.find(x => x.name.toLowerCase() === c.name.toLowerCase());
    if (!r) { r = { name: c.name, startingTotal: null, values: {}, yearTotal: 0 }; rows.push(r); }
    if (r.values[cur] === undefined) { r.values[cur] = c.spent; r.yearTotal += c.spent; }
  });
  seen[cur] = true;
  const months = MONTHS.filter(m => seen[m]);
  const totals = { values: {}, yearTotal: 0 };
  months.forEach(m => { totals.values[m] = rows.reduce((a, r) => a + (r.values[m] || 0), 0); });
  totals.yearTotal = rows.reduce((a, r) => a + r.yearTotal, 0);
  return { version: API_VERSION, year: year, current: cur, months: months, rows: rows, totals: totals };
}

// ---------- owed to savings (money moved from savings to checking) ----------
// Positive amount = moved from savings (you owe it back). Negative = paid back into savings.
function owedSheet_(create) {
  const ss = ss_();
  let sh = ss.getSheetByName(OWED_TAB);
  if (!sh && create) {
    sh = ss.insertSheet(OWED_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['Date', 'Amount', 'Note']]).setFontWeight('bold');
    sh.getRange(1, 5).setValue('Balance owed').setFontWeight('bold');
    sh.getRange(1, 6).setFormula('=SUM(B2:B)');
  }
  return sh;
}
function owedBalance_() {
  const sh = ss_().getSheetByName(OWED_TAB);
  if (!sh) return 0;
  const n = sh.getLastRow() - 1;
  if (n < 1) return 0;
  return sh.getRange(2, 2, n, 1).getValues().reduce((a, r) => a + num_(r[0]), 0);
}
function cellDate_(v, tz) {
  if (v instanceof Date) return fmt_(v, tz);
  const s = String(v).trim();
  if (!s) return '';
  const p = new Date(s);
  return isNaN(p) ? s : fmt_(p, tz);
}
function getOwed() {
  const tz = ss_().getSpreadsheetTimeZone();
  const sh = ss_().getSheetByName(OWED_TAB);
  const entries = [];
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach((v, i) => {
      if (String(v[1]).trim() === '') return;
      entries.push({ row: i + 2, date: cellDate_(v[0], tz), amount: num_(v[1]), note: String(v[2] || '') });
    });
  }
  return { version: API_VERSION, entries: entries, balance: entries.reduce((a, e) => a + e.amount, 0) };
}
function addOwedRow_(amount, note, dateStr) {
  const sh = owedSheet_(true);
  const r = Math.max(2, sh.getLastRow() + 1);
  writeDateOn_(sh, r, 1, dateStr);
  sh.getRange(r, 2).setValue(Number(amount)).setNumberFormat('$#,##0.00');
  sh.getRange(r, 3).setValue(note || '');
}
function writeDateOn_(sh, row, col, str) {
  sh.getRange(row, col).setValue(dateAt_(str)).setNumberFormat('yyyy-mm-dd');
}
function addOwed_(b) {
  const amt = Number(b.amount);
  if (!amt) throw new Error('Enter an amount.');
  const tz = ss_().getSpreadsheetTimeZone();
  addOwedRow_(amt, b.note, b.date || fmt_(new Date(), tz));
  SpreadsheetApp.flush();
  return getOwed();
}
function deleteOwed_(b) {
  const sh = owedSheet_(false);
  if (!sh) throw new Error('Nothing to delete.');
  const row = Number(b.row);
  const cur = getOwed().entries.find(e => e.row === row);
  if (!cur || Math.abs(cur.amount - Number(b.expected && b.expected.amount)) > 0.005) throw new Error('That entry changed. Reopen and try again.');
  sh.deleteRow(row);
  SpreadsheetApp.flush();
  return getOwed();
}

// ---------- Bolivia trip fund (kept completely separate from the monthly budget) ----------
// The app keeps the master copy on the phone (works offline) and saves a snapshot here when online.
function tripSheet_(create) {
  const ss = ss_();
  let sh = ss.getSheetByName(TRIP_TAB);
  if (!sh && create) {
    sh = ss.insertSheet(TRIP_TAB);
    sh.getRange(1, 1).setValue('Bolivia Trip: synced from the app (edit payments in the app)').setFontWeight('bold');
    sh.getRange(2, 1).setValue('Fund (USD)');
    sh.getRange(3, 1).setValue('Rate (BOB per USD)');
    sh.getRange(2, 4).setValue('Spent (USD)'); sh.getRange(2, 5).setFormula('=SUM(E6:E1000)');
    sh.getRange(3, 4).setValue('Left (USD)'); sh.getRange(3, 5).setFormula('=B2-E2');
    sh.getRange(5, 1, 1, 8).setValues([['Date', 'Amount', 'Currency', 'Rate', 'USD', 'BOB', 'Note', 'ID']]).setFontWeight('bold');
  }
  return sh;
}
function tripSave_(t) {
  const sh = tripSheet_(true);
  const items = Array.isArray(t.items) ? t.items : [];
  sh.getRange(2, 2).setValue(Number(t.fund) || 0);
  sh.getRange(3, 2).setValue(Number(t.rate) || 0);
  const n = Math.max(sh.getMaxRows() - 5, 1);
  sh.getRange(6, 1, n, 8).clearContent();
  if (items.length) {
    if (sh.getMaxRows() < 5 + items.length) sh.insertRowsAfter(sh.getMaxRows(), items.length + 20);
    const vals = items.map(it => {
      return [dateAt_(it.date), Number(it.amount), it.currency, Number(it.rate), Number(it.usd), Number(it.bob), it.note || '', it.id || ''];
    });
    sh.getRange(6, 1, vals.length, 8).setValues(vals);
    sh.getRange(6, 1, vals.length, 1).setNumberFormat('yyyy-mm-dd');
  }
  SpreadsheetApp.flush();
  return { version: API_VERSION, ok: true, saved: items.length };
}
function tripGet_() {
  const sh = tripSheet_(false);
  if (!sh) return { version: API_VERSION, exists: false };
  const tz = ss_().getSpreadsheetTimeZone();
  const items = [];
  const n = sh.getLastRow() - 5;
  if (n > 0) {
    sh.getRange(6, 1, n, 8).getValues().forEach((v, i) => {
      if (String(v[1]).trim() === '') return;
      items.push({ id: String(v[7] || ('r' + i)), date: cellDate_(v[0], tz), amount: num_(v[1]), currency: String(v[2]), rate: num_(v[3]), usd: num_(v[4]), bob: num_(v[5]), note: String(v[6] || '') });
    });
  }
  return { version: API_VERSION, exists: true, fund: num_(sh.getRange(2, 2).getValue()), rate: num_(sh.getRange(3, 2).getValue()), items: items };
}

// ---------- Chase alert importer (reads Gmail, never changes or deletes any mail) ----------
// Flow: Chase alert email -> parse amount/merchant/date -> Merchant Rules -> (no rule: ask Claude) -> payment in your log.
// If no rule matches and the AI is off or fails, the charge waits in the "Chase Imports" tab as 'pending' until you give it a category.
// Only runs after Budget app → Turn on Chase email import (or setupChaseTrigger) in that copy.
const CHASE_SENDER = 'no.reply.alerts@chase.com';
const RULES_TAB = 'Merchant Rules';
const IMPORT_TAB = 'Chase Imports';
const IMPORT_HEADERS = ['Imported at', 'Date', 'Merchant', 'Amount', 'Card', 'Category', 'Status', 'Message ID', 'Source'];
// Card charges on these days are left out completely (not added, not listed): trip money goes on the Trip tab by hand.
// Set in Project Settings → Script Properties: TRIP_SKIP = 2026-11-25..2026-12-09 (leave it out to skip nothing).
function inTripWindow_(ymd) {
  const m = /^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})$/.exec(String(props_().getProperty('TRIP_SKIP') || '').trim());
  return !!(m && ymd && ymd >= m[1] && ymd <= m[2]);
}

// ---------- AI categorization (Claude) for merchants no rule knows ----------
// Runs only when Script Properties has ANTHROPIC_API_KEY. Sends the merchant name, the amount and your category
// names to Anthropic, nothing else. Any failure (no key, error, timeout, odd answer) leaves the charge 'pending'.
const AI_MODEL = 'claude-haiku-5-5';
const AI_URL = 'https://api.anthropic.com/v1/messages';
// What each category means, so the AI can choose well. These are EXAMPLES; categories not listed are offered by name only.
// To describe your own categories without editing this file, add a Script Property AI_HINTS holding JSON, e.g.
//   {"groceries": "supermarkets, warehouse clubs", "eating out": "restaurants, coffee, delivery"}
// Keys are category names in lower case. Your entries are used on top of (and instead of) the examples below.
const AI_HINTS_EXAMPLES = {
  'groceries': 'grocery stores, supermarkets, warehouse clubs, household supplies',
  'gas': 'fuel for the car at a gas station',
  'eating out': 'restaurants, fast food, coffee shops, bars, food delivery',
  'fun': 'entertainment, hobbies, online shopping, apps, subscriptions, games, movies',
  'bills': 'utilities, phone, internet, insurance',
  'unexpected': 'unexpected necessary costs: car repair, medical, fees, fines'
};
function aiHints_() {
  let own = {};
  try { own = JSON.parse(props_().getProperty('AI_HINTS') || '{}') || {}; } catch (e) { console.warn('AI_HINTS is not valid JSON'); }
  const out = Object.assign({}, AI_HINTS_EXAMPLES);
  Object.keys(own).forEach(k => { out[String(k).trim().toLowerCase()] = String(own[k]); });
  return out;
}
function aiKey_() { return PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY') || ''; }
// "SAMS CLUB #6338" -> "SAMS CLUB" (same as the app's suggested rule keyword)
function deriveKeyword_(m) {
  return String(m).toUpperCase().replace(/#.*$/, '').replace(/\s+[\d][\d\s-]*$/, '').replace(/\s+/g, ' ').trim();
}
// Returns one of your categories (exact spelling), or '' if anything goes wrong.
// Answers are remembered per merchant keyword, so the same unknown merchant is only asked about once.
function aiCategory_(merchant, amount, canon, noCache) {
  const key = aiKey_();
  const names = Object.keys(canon).map(k => canon[k]);
  if (!key || !names.length || !merchant) return '';
  const props = PropertiesService.getScriptProperties();
  const cacheKey = 'ai|' + deriveKeyword_(merchant);
  const cached = noCache ? '' : props.getProperty(cacheKey);
  if (cached && canon[cached.toLowerCase()]) return canon[cached.toLowerCase()];
  const hints = aiHints_();
  const body = {
    model: AI_MODEL,
    max_tokens: 1024,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: {
      type: 'object', properties: { category: { type: 'string', enum: names } }, required: ['category'], additionalProperties: false } } },
    system: 'You sort one person\'s credit card charges into their monthly budget categories. ' +
      'Choose the single most likely category for the charge. The categories are:\n' +
      names.map(n => '- ' + n + (hints[n.toLowerCase()] ? ': ' + hints[n.toLowerCase()] : '')).join('\n') +
      '\nThe merchant name is printed by the bank and may be shortened or include store numbers.',
    messages: [{ role: 'user', content: 'Merchant: ' + merchant + '\nAmount: $' + Number(amount).toFixed(2) }]
  };
  try {
    const res = UrlFetchApp.fetch(AI_URL, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      headers: { 'x-api-key': key, 'anthropic-version': '2026-10-21' }, payload: JSON.stringify(body) });
    if (res.getResponseCode() !== 200) { console.warn('AI error ' + res.getResponseCode() + ': ' + String(res.getContentText()).slice(0, 300)); return ''; }
    const d = JSON.parse(res.getContentText());
    if (d.stop_reason !== 'end_turn') { console.warn('AI stopped: ' + d.stop_reason); return ''; }
    const text = (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const pick = canon[String(JSON.parse(text).category || '').trim().toLowerCase()] || '';
    if (pick && !noCache) props.setProperty(cacheKey, pick);
    return pick;
  } catch (err) {
    console.warn('AI failed: ' + (err && err.message || err));
    return '';
  }
}
// Run this from the editor after adding the key: logs what the AI picks for a few merchants. Writes nothing to the sheet.
function testAI() {
  if (!aiKey_()) { Logger.log('No ANTHROPIC_API_KEY in Script Properties yet.'); return; }
  const canon = canonCats_();
  ['ANTHROPIC* CLAUDE SU', 'SHELL OIL 57444', 'HOME DEPOT #6512'].forEach(m => Logger.log(m + ' -> ' + (aiCategory_(m, 20, canon, true) || '(no answer, would stay pending)')));
}
const ZONES = { ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles' };

function decodeEntities_(s) {
  return String(s)
    .replace(/&nbsp;/gi, ' ').replace(/&zwnj;|&reg;|&copy;/gi, '')
    .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(Number(n)));
}
function htmlToLines_(html) {
  const t = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(td|tr|p|div|h\d|li)>/gi, '\n').replace(/<[^>]+>/g, ' ');
  return decodeEntities_(t).split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function fieldAfter_(lines, label) {
  const i = lines.findIndex(l => l.toLowerCase() === label);
  return i >= 0 && i + 1 < lines.length ? lines[i + 1] : '';
}
function senderAddress_(from) {
  const m = /<([^<>\s]+@[^<>\s]+)>/.exec(String(from)) || /([^\s<>]+@[^\s<>]+)/.exec(String(from));
  return m ? m[1].toLowerCase() : '';
}
function isSpendAlert_(subject) { return /you made an? .*transaction/i.test(String(subject)); }

// Returns { amount, merchant, card, date } ; date is yyyy-MM-dd in the spreadsheet's timezone ('' if not found)
function parseChaseAlert_(subject, html, plain, tz) {
  const lines = htmlToLines_(html).concat(String(plain || '').split('\n').map(s => s.trim()).filter(Boolean));
  const out = { amount: null, merchant: '', card: '', date: '' };
  let merchant = fieldAfter_(lines, 'merchant');
  if (/^(amount|date|account)$/i.test(merchant)) merchant = '';
  const am = /\$?\s*([\d,]+\.\d{2})/.exec(fieldAfter_(lines, 'amount'));
  out.card = fieldAfter_(lines, 'account');
  const sub = /you made an? \$([\d,]+(?:\.\d{2})?) transaction with (.+)$/i.exec(String(subject));
  out.amount = am ? Number(am[1].replace(/,/g, '')) : (sub ? Number(sub[1].replace(/,/g, '')) : null);
  out.merchant = merchant || (sub ? sub[2].trim() : '');
  const dm = /([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) at (\d{1,2}:\d{2} [AP]M) ([A-Z]{2})/.exec(fieldAfter_(lines, 'date'));
  if (dm && ZONES[dm[5]]) {
    const when = Utilities.parseDate(dm[1] + ' ' + dm[2] + ', ' + dm[3] + ' ' + dm[4], ZONES[dm[5]], 'MMM d, yyyy h:mm a');
    out.date = Utilities.formatDate(when, tz, 'yyyy-MM-dd');
  }
  return out;
}

function ensureTab_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  }
  return sh;
}
function isOff_(v) { const s = String(v).trim().toLowerCase(); return s === 'false' || s === 'no' || s === 'off'; }
// Merchant Rules tab columns: A Keyword | B Category | C Active | D Label | E Auto
// Several rules may share a keyword (e.g. "Sam's Club Groceries" and "Sam's Club Gas"). Only an "Auto" rule is
// applied by itself, the first one listed wins; the others show up as one-tap choices in the app.
const RULE_HEADERS = ['Keyword', 'Category', 'Active', 'Label', 'Auto'];
function readRules_() {
  const sh = ss_().getSheetByName(RULES_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().map((v, i) => ({
    row: i + 2, keyword: String(v[0]).trim().toUpperCase(), category: String(v[1]).trim(),
    active: !isOff_(v[2]), label: String(v[3] || '').trim(), auto: !isOff_(v[4])
  })).filter(r => r.keyword && r.category);
}
// longest matching keyword wins; among equals, the first auto rule listed
function matchRule_(merchant, rules) {
  const m = String(merchant).toUpperCase();
  let best = null;
  rules.forEach(r => { if (r.active && r.auto && m.indexOf(r.keyword) >= 0 && (!best || r.keyword.length > best.keyword.length)) best = r; });
  return best ? best.category : '';
}
// every active rule that fits this merchant, including "choice only" ones
function matchingRules_(merchant, rules) {
  const m = String(merchant).toUpperCase();
  return rules.filter(r => r.active && m.indexOf(r.keyword) >= 0)
    .sort((a, b) => b.keyword.length - a.keyword.length || a.row - b.row)
    .map(r => ({ label: r.label || r.category, category: r.category, keyword: r.keyword, auto: r.auto }));
}
function canonCats_() {
  const canon = {};
  getData_basic_().forEach(n => { canon[n.toLowerCase()] = n; });
  return canon;
}
function getData_basic_() {
  return catBlock_(getSheet_()).rows.map(r => String(r[0]).trim()).filter(Boolean);
}
function getRules_() {
  const canon = canonCats_();
  return { version: API_VERSION, rules: readRules_().map(r => ({ row: r.row, keyword: r.keyword, category: canonCat_(r.category, canon), active: r.active, label: r.label, auto: r.auto })),
    categories: getData_basic_(), aiEnabled: !!aiKey_() };
}
function saveRule_(b) {
  const keyword = String(b.keyword || '').trim().toUpperCase();
  const cat = canonCats_()[String(b.category || '').trim().toLowerCase()];
  if (!keyword) throw new Error('Enter a keyword.');
  if (!cat) throw new Error('Pick one of your budget categories.');
  const sh = ensureTab_(RULES_TAB, RULE_HEADERS);
  let row = Number(b.row) || 0;
  if (row) {
    const cur = readRules_().find(r => r.row === row);
    if (!cur || (b.expected && (cur.keyword !== String(b.expected.keyword).toUpperCase() || cur.category.toLowerCase() !== String(b.expected.category).toLowerCase())))
      throw new Error('That rule changed. Reopen the rules and try again.');
  } else row = Math.max(2, sh.getLastRow() + 1);
  sh.getRange(row, 1, 1, 5).setValues([[keyword, cat, b.active !== false, String(b.label || '').trim(), b.auto !== false]]);
  SpreadsheetApp.flush();
  return getRules_();
}
function deleteRule_(b) {
  const sh = ss_().getSheetByName(RULES_TAB);
  const cur = readRules_().find(r => r.row === Number(b.row));
  if (!sh || !cur || cur.keyword !== String(b.expected && b.expected.keyword).toUpperCase()) throw new Error('That rule changed. Reopen the rules and try again.');
  sh.deleteRow(cur.row);
  SpreadsheetApp.flush();
  return getRules_();
}
// "remember this": make this merchant keyword automatically use the chosen category from now on
function rememberRule_(keyword, category, label) {
  const kw = String(keyword || '').trim().toUpperCase();
  if (!kw) return;
  const rules = readRules_();
  const same = rules.find(r => r.keyword === kw && r.auto);
  const sameLabel = rules.find(r => r.keyword === kw && r.label && label && r.label === label);
  if (same && sameLabel && same.row !== sameLabel.row) {            // flip which labelled choice is the automatic one
    const sh = ss_().getSheetByName(RULES_TAB);
    sh.getRange(same.row, 5).setValue(false); sh.getRange(sameLabel.row, 5).setValue(true);
  } else if (same && same.category.toLowerCase() === String(category).toLowerCase()) {
    return;
  } else if (same) {
    saveRule_({ row: same.row, keyword: kw, category: category, label: label || same.label, active: true, auto: true });
  } else {
    saveRule_({ keyword: kw, category: category, label: label || '', active: true, auto: true });
  }
}

// ---- Chase Imports tab: columns A Imported at | B Date | C Merchant | D Amount | E Card | F Category | G Status | H Message ID | I Source
// Source: 'rule' (a Merchant Rule), 'ai' (picked by Claude, worth a look), 'you' (you set or confirmed it), '' (still pending)
function importCounts_() {
  const sh = ss_().getSheetByName(IMPORT_TAB);
  const out = { pending: 0, recent: 0, ai: 0 };
  if (!sh || sh.getLastRow() < 2) return out;
  const cutoff = Date.now() - 7 * 86400000;
  sh.getRange(2, 1, sh.getLastRow() - 1, 9).getValues().forEach(v => {
    const st = String(v[6]);
    const recent = v[0] instanceof Date && v[0].getTime() >= cutoff;
    if (st === 'pending') out.pending++;
    if ((st === 'pending' || st === 'added') && recent) out.recent++;
    if (st === 'added' && String(v[8]) === 'ai' && recent) out.ai++;
  });
  return out;
}
function getImports_() {
  const sh = ss_().getSheetByName(IMPORT_TAB);
  const tz = ss_().getSpreadsheetTimeZone();
  const rules = readRules_();
  const canon = canonCats_();
  const imports = [];
  if (sh && sh.getLastRow() > 1) {
    const first = Math.max(2, sh.getLastRow() - 59);
    sh.getRange(first, 1, sh.getLastRow() - first + 1, 9).getValues().forEach((v, i) => {
      const st = String(v[6]);
      if (st !== 'added' && st !== 'pending') return;
      imports.push({ row: first + i, date: cellDate_(v[1], tz), merchant: String(v[2]), amount: num_(v[3]), card: String(v[4]), category: canonCat_(v[5], canon),
        status: st, source: String(v[8] || ''), choices: matchingRules_(String(v[2]), rules).map(c => Object.assign(c, { category: canonCat_(c.category, canon) })) });
    });
  }
  imports.reverse();
  return { version: API_VERSION, imports: imports, pending: imports.filter(x => x.status === 'pending').length, categories: getData_basic_() };
}
// Give a charge a category. Pending charge -> added to your budget right now. Already-added -> moved to the new category.
function importSet_(b) {
  const sh = ss_().getSheetByName(IMPORT_TAB);
  const tz = ss_().getSpreadsheetTimeZone();
  const row = Number(b.row);
  if (!sh || row < 2 || row > sh.getLastRow()) throw new Error('Charge not found.');
  const v = sh.getRange(row, 1, 1, 9).getValues()[0];
  const rec = { date: cellDate_(v[1], tz), merchant: String(v[2]), amount: num_(v[3]), category: String(v[5]).trim(), status: String(v[6]), source: String(v[8] || '') };
  if (!b.expected || rec.merchant !== String(b.expected.merchant) || Math.abs(rec.amount - Number(b.expected.amount)) > 0.005) throw new Error('That charge changed. Reopen the list and try again.');
  const cat = canonCats_()[String(b.category || '').trim().toLowerCase()];
  if (!cat) throw new Error('Pick a category.');
  if (rec.status === 'pending') {
    addExpenses_([{ category: cat, amount: rec.amount, note: rec.merchant, date: rec.date }]);
  } else if (rec.status === 'added') {
    if (cat.toLowerCase() !== rec.category.toLowerCase()) {
      const sheet = getSheet_();
      const L = readLog_(sheet);
      let hit = null;
      for (let i = L.rows.length - 1; i >= 0; i--) {
        const p = L.rows[i];
        if (p.note === rec.merchant && Math.abs(p.amount - rec.amount) < 0.005 && p.category.toLowerCase() === rec.category.toLowerCase()) { hit = p; break; }
      }
      if (!hit) throw new Error("Could not find this payment in the current month's log. Change it in History instead.");
      updatePayment_({ row: hit.row, expected: { category: hit.category, amount: hit.amount }, category: cat, amount: hit.amount, note: hit.note });
    }
  } else throw new Error('This charge was skipped.');
  sh.getRange(row, 6).setValue(cat);
  sh.getRange(row, 7).setValue('added');
  sh.getRange(row, 9).setValue('you');
  // you corrected the AI: forget its answer for this merchant so it isn't reused
  if (rec.source === 'ai' && cat.toLowerCase() !== rec.category.toLowerCase()) PropertiesService.getScriptProperties().deleteProperty('ai|' + deriveKeyword_(rec.merchant));
  if (b.remember && b.remember.keyword) rememberRule_(b.remember.keyword, cat, b.remember.label);
  SpreadsheetApp.flush();
  return { data: getData(), imports: getImports_() };
}
// Don't add a pending charge (for example you already entered it by hand)
function importSkip_(b) {
  const sh = ss_().getSheetByName(IMPORT_TAB);
  const row = Number(b.row);
  if (!sh || row < 2 || row > sh.getLastRow()) throw new Error('Charge not found.');
  const v = sh.getRange(row, 1, 1, 8).getValues()[0];
  if (String(v[6]) !== 'pending' || String(v[2]) !== String(b.expected && b.expected.merchant)) throw new Error('That charge changed. Reopen the list and try again.');
  sh.getRange(row, 7).setValue('skipped');
  SpreadsheetApp.flush();
  return { data: getData(), imports: getImports_() };
}
function importedIds_() {
  const sh = ss_().getSheetByName(IMPORT_TAB);
  const ids = {};
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 8, sh.getLastRow() - 1, 1).getValues().forEach(v => { if (v[0]) ids[String(v[0])] = true; });
  return ids;
}

// dryRun = true: reads and reports only, writes nothing anywhere.
function runChaseImport_(dryRun) {
  const tz = ss_().getSpreadsheetTimeZone();
  const start = Number(PropertiesService.getScriptProperties().getProperty('chaseStart') || 0);
  const canon = canonCats_();
  const rules = readRules_();
  const seen = importedIds_();
  const threads = GmailApp.search('from:' + CHASE_SENDER + ' newer_than:' + (dryRun ? 14 : 3) + 'd', 0, 50);
  const found = [];
  threads.forEach(th => th.getMessages().forEach(m => {
    const id = m.getId();
    if (seen[id]) return;
    if (senderAddress_(m.getFrom()) !== CHASE_SENDER) return;   // exact address only (blocks look-alike senders)
    const subject = m.getSubject();
    if (!isSpendAlert_(subject)) { if (dryRun) found.push({ ts: m.getDate().getTime(), id: id, status: 'ignored (not a purchase alert)', subject: subject }); return; }
    if (!dryRun && start && m.getDate().getTime() < start) return;   // never import mail from before you switched this on
    const p = parseChaseAlert_(subject, m.getBody(), m.getPlainBody(), tz);
    const date = p.date || fmt_(m.getDate(), tz);
    if (inTripWindow_(date)) { if (dryRun) found.push({ ts: m.getDate().getTime(), id: id, status: 'ignored (trip dates)', date: date, merchant: p.merchant, amount: p.amount }); return; }
    if (!p.amount || !p.merchant) { found.push({ ts: m.getDate().getTime(), id: id, status: 'could not read', subject: subject }); return; }
    let cat = canon[String(matchRule_(p.merchant, rules)).toLowerCase()] || '';
    let source = cat ? 'rule' : '';
    if (!cat && !dryRun) { cat = aiCategory_(p.merchant, p.amount, canon); if (cat) source = 'ai'; }   // the preview never calls the AI
    found.push({ ts: m.getDate().getTime(), id: id, date: date, merchant: p.merchant, amount: p.amount, card: p.card,
      category: cat, source: source, status: cat ? 'added' : 'pending' });
  }));
  found.sort((a, b) => a.ts - b.ts);
  if (!dryRun) {
    const real = found.filter(r => r.status === 'added' || r.status === 'pending');
    const items = real.filter(r => r.status === 'added').map(r => ({ category: r.category, amount: r.amount, note: r.merchant, date: r.date }));
    if (items.length) addExpenses_(items);
    if (real.length) {
      ensureTab_(RULES_TAB, RULE_HEADERS);
      const sh = ensureTab_(IMPORT_TAB, IMPORT_HEADERS);
      if (!String(sh.getRange(1, 9).getValue())) sh.getRange(1, 9).setValue('Source').setFontWeight('bold');
      const r0 = sh.getLastRow() + 1;
      sh.getRange(r0, 1, real.length, 9).setValues(real.map(r => [new Date(), r.date, r.merchant, r.amount, r.card, r.category, r.status, r.id, r.source]));
    }
  }
  return { dryRun: dryRun, found: found.map(r => ({ status: r.status, date: r.date, merchant: r.merchant, amount: r.amount, card: r.card, category: r.category, source: r.source, subject: r.subject })) };
}
function importChaseAlerts(dryRun) { return withLock_(() => runChaseImport_(dryRun === true)); }
function chaseJob() { importChaseAlerts(false); }
// Run this first: shows what WOULD be imported, changes nothing.
function previewChaseAlerts() {
  const r = importChaseAlerts(true);
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}
// Turns the importer on: checks every 10 minutes, starting from now (older emails are never imported).
function setupChaseTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'chaseJob') ScriptApp.deleteTrigger(t); });
  PropertiesService.getScriptProperties().setProperty('chaseStart', String(Date.now()));
  ensureTab_(RULES_TAB, RULE_HEADERS);
  ensureTab_(IMPORT_TAB, IMPORT_HEADERS);
  ScriptApp.newTrigger('chaseJob').timeBased().everyMinutes(10).create();
}
function stopChaseTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === 'chaseJob') ScriptApp.deleteTrigger(t); });
}
// For 'pending' rows in the Chase Imports tab: type a category in column F, then run this to add them.
function applyPendingCategories() {
  return withLock_(() => {
    const sh = ss_().getSheetByName(IMPORT_TAB);
    if (!sh || sh.getLastRow() < 2) return 0;
    const canon = {};
    getData().categories.forEach(c => { canon[c.name.toLowerCase()] = c.name; });
    const rows = sh.getRange(2, 1, sh.getLastRow() - 1, 8).getValues();
    const items = [], rowsDone = [];
    rows.forEach((v, i) => {
      const cat = canon[String(v[5]).trim().toLowerCase()];
      if (String(v[6]) === 'pending' && cat) {
        items.push({ category: cat, amount: num_(v[3]), note: String(v[2]), date: cellDate_(v[1], ss_().getSpreadsheetTimeZone()) });
        rowsDone.push(i + 2);
      }
    });
    if (items.length) addExpenses_(items);
    rowsDone.forEach(r => { sh.getRange(r, 7).setValue('added'); sh.getRange(r, 9).setValue('you'); });
    return items.length;
  });
}
