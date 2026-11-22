'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmt = (n) => eur.format(n || 0);
// gleiche Logik wie auf dem Server: "1.400,50" -> 1400.5, "38.500" -> 38500
function parseAmount(v) {
  const t = String(v ?? '').trim().replace(/\s|€/g, '');
  if (!t) return 0;
  if (t.includes(',')) return Number(t.replace(/\./g, '').replace(',', '.')) || 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(t)) return Number(t.replace(/\./g, '')) || 0;
  return Number(t) || 0;
}
const INTERVAL_LABEL = { 1: 'monatlich', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich' };
const fmtMonth = (ym) => (ym ? `${ym.slice(5, 7)}/${ym.slice(0, 4)}` : '');
// Feld „Läuft bis“ für Fixkosten, Budgets und Einkommen
const endMonthInput = (v) => `<label>Läuft bis <span class="muted">(optional)</span>
  <input type="month" name="end_month" value="${v || ''}" placeholder="z. B. 06/2027"></label>
  <div class="hint">Leer lassen = läuft weiter. Sonst zählt der Betrag nach diesem Monat nicht mehr (z. B. Kredit bis 06/2027).</div>`;
const endInfo = (x) => (x.end_month ? (x.ended ? ` · <span class="neg">beendet ${fmtMonth(x.end_month)}</span>` : ` · bis ${fmtMonth(x.end_month)}`) : '');

const state = {
  me: null,
  meta: { categories: [], intervals: [] },
  month: new Date().toISOString().slice(0, 7),
  tab: 'overview',
  list: 'schuld',
  kosten: 'fix',
};

// ---------- API ----------
async function api(method, url, body) {
  if (window.Cloud?.enabled) {
    try { return await Cloud.api(method, url, body); }
    catch (err) {
      if (err.status === 401 && !url.includes('/login')) showAuth();
      throw err;
    }
  }
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.includes('/login')) { showAuth(); throw new Error(data.error || 'Bitte anmelden.'); }
  if (!res.ok) throw new Error(data.error || 'Fehler');
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2200);
}
function monthLabel(m) {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('de-DE', { month: window.innerWidth < 380 ? 'short' : 'long', year: 'numeric' });
}
function shiftMonth(m, delta) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(y, mo - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function todayInMonth(m) {
  const today = new Date();
  const cur = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
  return cur === m ? `${cur}-${String(today.getDate()).padStart(2, '0')}` : `${m}-01`;
}

// ---------- Anmeldung ----------
function showAuth() {
  $('#app').hidden = true;
  $('#auth').hidden = false;
}
$$('[data-auth-tab]').forEach((b) => b.addEventListener('click', () => {
  $$('[data-auth-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $('#loginForm').hidden = b.dataset.authTab !== 'login';
  $('#registerForm').hidden = b.dataset.authTab !== 'register';
  $('#authError').textContent = '';
}));
$$('#registerForm input[name=mode]').forEach((r) => r.addEventListener('change', () => {
  const mode = $('#registerForm input[name=mode]:checked').value;
  $$('#registerForm [data-mode]').forEach((el) => { el.hidden = el.dataset.mode !== mode; });
}));
// Einladungslink: /?code=XXXX öffnet direkt die Registrierung
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  $('[data-auth-tab=register]').click();
  $('#registerForm input[value=join]').checked = true;
  $('#registerForm input[value=join]').dispatchEvent(new Event('change'));
  $('#registerForm [name=inviteCode]').value = urlCode;
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/login', { email: f.get('email'), password: f.get('password') });
    e.target.reset();
    await boot();
  } catch (err) { authMessage(err); }
});
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const join = f.get('mode') === 'join';
  // vor dem Anlegen des Kontos: Hinweis zur Nutzung bestätigen
  if (!noticeOkInSession && !(await showNotice({ confirmText: 'Verstanden – Konto erstellen', cancel: true }))) return;
  noticeOkInSession = true;
  try {
    await api('POST', '/api/register', {
      name: f.get('name'), email: f.get('email'), password: f.get('password'),
      inviteCode: join ? f.get('inviteCode') : '', householdName: join ? '' : f.get('householdName'),
      acceptedNotice: true,
    });
    noticeJustAccepted = true;
    e.target.reset();
    history.replaceState(null, '', location.pathname);
    state.tab = 'kosten';
    state.kosten = 'einkommen';
    await boot();
    toast('Willkommen! Trag zuerst dein Einkommen und deine Fixkosten ein.');
  } catch (err) {
    // Cloud-Modus: E-Mail muss erst bestätigt werden -> zur Anmeldung wechseln
    if (err.info) { $('[data-auth-tab=login]').click(); $('#loginForm [name=email]').value = f.get('email'); }
    authMessage(err);
  }
});
// Passwort vergessen (nur im Cloud-Modus): Supabase schickt einen Link, danach neues Passwort unter ⚙ setzen
if (window.Cloud?.enabled) $('#forgotPw').hidden = false;
$('#forgotPw').addEventListener('click', async () => {
  try {
    await api('POST', '/api/forgot', { email: $('#loginForm [name=email]').value });
    authMessage({ info: true, message: 'Wir haben dir eine E-Mail geschickt. Tippe auf den Link darin und lege danach ein neues Passwort fest.' });
  } catch (err) { authMessage(err); }
});
// ---------- Hinweis zur Nutzung ----------
let noticeJustAccepted = false;
let noticeOkInSession = false; // bei mehreren Versuchen (z. B. Tippfehler im Code) nicht jedes Mal fragen
function showNotice({ confirmText = 'Verstanden', cancel = false } = {}) {
  const d = $('#noticeDlg');
  $('#noticeOk').textContent = confirmText;
  $('#noticeCancel').hidden = !cancel;
  d.showModal();
  $('.notice-text', d).scrollTop = 0;
  return new Promise((resolve) => {
    const done = (ok) => { d.close(); $('#noticeOk').onclick = $('#noticeCancel').onclick = d.oncancel = null; resolve(ok); };
    $('#noticeOk').onclick = () => done(true);
    $('#noticeCancel').onclick = () => done(false);
    d.oncancel = (e) => { e.preventDefault(); if (cancel) done(false); }; // ohne „Abbrechen“ nur mit „Verstanden“ schließen
  });
}
const noticeKey = () => `hinweis-gelesen-${state.me.user.id}`;
function noticeSeen() {
  if (state.me.noticeAccepted) return true;
  try { return localStorage.getItem(noticeKey()) === '1'; } catch { return false; }
}
async function rememberNotice() {
  try { localStorage.setItem(noticeKey(), '1'); } catch { /* privates Fenster */ }
  if (window.Cloud?.enabled) await api('POST', '/api/notice').catch(() => {});
}
$('#showNotice').addEventListener('click', () => showNotice());

function authMessage(err) {
  $('#authError').textContent = err.message;
  $('#authError').classList.toggle('info', !!err.info);
}

// ---------- Navigation ----------
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
// Schulden, Forderungen, Vermögen, Zekât und Geburtstage teilen sich eine Ansicht
const LIST_TABS = ['schuld', 'forderung', 'vermoegen', 'zekat', 'geburtstag'];
function switchTab(tab) {
  state.tab = tab;
  if (LIST_TABS.includes(tab)) state.list = tab;
  const view = LIST_TABS.includes(tab) ? 'lists' : tab;
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== view; });
  // gewählten Bereich in der Leiste sichtbar machen (am Handy wird sie seitlich gewischt)
  const btn = $(`.topnav [data-tab="${tab}"]`);
  if (btn) btn.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  render();
  window.scrollTo(0, 0);
}
$('#prevMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); render(); });
$('#nextMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); render(); });

async function boot() {
  try {
    const [me, meta] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/meta')]);
    state.me = me; state.meta = meta;
  } catch (err) {
    showAuth();
    if (err.status && err.status !== 401) authMessage(err);
    return;
  } finally { $('#loading').hidden = true; }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#hhName').textContent = state.me.household.name;
  $('#hello').textContent = `Hallo ${state.me.user.name}`;
  // bestehende Konten: Hinweis einmal anzeigen
  if (noticeJustAccepted) { noticeJustAccepted = false; rememberNotice(); }
  else if (!noticeSeen()) showNotice().then(rememberNotice);
  if (window.Cloud?.recovery) {
    setOldPasswordNeeded(false);
    history.replaceState(null, '', location.pathname);
    state.tab = 'account';
    toast('Bitte lege jetzt ein neues Passwort fest.');
  }
  switchTab(state.tab);
}

async function render() {
  $('#monthLabel').textContent = monthLabel(state.month);
  try {
    if (state.tab === 'overview') await renderOverview();
    if (state.tab === 'kosten') await renderKosten();
    if (state.tab === 'stats') await renderStats();
    if (LIST_TABS.includes(state.tab)) await renderLists();
    if (state.tab === 'household') await renderHousehold();
    if (state.tab === 'account') renderAccount();
  } catch (err) { toast(err.message); }
}

// ---------- „−“: Eintrag löschen, immer mit Rückfrage ----------
const delBtn = (url, name, extra = '') =>
  `<button type="button" class="del-btn" data-del="${url}" data-del-name="${esc(name)}" data-del-extra="${esc(extra)}" aria-label="${esc(name)} löschen" title="Löschen">−</button>`;
// in der Capture-Phase, damit nicht zusätzlich der Bearbeiten-Dialog der Zeile aufgeht
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  const extra = b.dataset.delExtra ? `\n\n${b.dataset.delExtra}` : '';
  if (!confirm(`„${b.dataset.delName}“ wirklich löschen?${extra}`)) return;
  try {
    await api('DELETE', b.dataset.del);
    toast('Gelöscht');
    render();
  } catch (err) { toast(err.message); }
}, true);

// ---------- Übersicht ----------
async function renderOverview() {
  const s = await api('GET', `/api/summary?month=${state.month}`);
  const avail = $('#available');
  avail.textContent = fmt(s.available);
  avail.className = 'hero-amount ' + (s.available < 0 ? 'neg' : '');
  $('#plannedHint').textContent = s.budgetLeft > 0
    ? `${fmt(s.budgetLeft)} Budget sind noch reserviert – was davon übrig bleibt, kommt dazu.`
    : `Geplant (nur Fixkosten & Budgets): ${fmt(s.plannedAvailable)}`;
  $('#calc').innerHTML = `
    <dt>Einkommen</dt><dd>${fmt(s.income)}</dd>
    <dt>− Fixkosten</dt><dd>${fmt(s.fixedTotal)}</dd>
    <dt>− Variable Ausgaben</dt><dd>${fmt(s.spent)}</dd>
    ${s.budgetLeft > 0 ? `<dt>− Noch offenes Budget</dt><dd>${fmt(s.budgetLeft)}</dd>` : ''}
    ${s.refunds > 0 ? `<dt>+ Einnahmen / Erstattungen</dt><dd>${fmt(s.refunds)}</dd>` : ''}
    <dt class="total">= Verfügbar</dt><dd class="total ${s.available < 0 ? 'neg' : 'pos'}">${fmt(s.available)}</dd>`;

  $('#dueNote').hidden = !s.dueThisMonth.length;
  $('#dueNote').innerHTML = s.dueThisMonth.length ? `📅 Diesen Monat fällig: ${s.dueThisMonth
    .map((d) => `<strong>${esc(d.name)}</strong> ${fmt(d.amount)}`).join(', ')} – ist bei den Fixkosten schon abgezogen.` : '';
  renderTeaser(s);
  renderFixVar(s);
  const max = Math.max(1, ...s.categories.map((c) => c.fixed + Math.max(c.budget, c.spent)));
  $('#catEmpty').hidden = s.categories.length > 0;
  $('#catList').innerHTML = s.categories.filter((c) => c.total > 0).map((c) => {
    const parts = [];
    if (c.fixed) parts.push(`Fix ${fmt(c.fixed)}`);
    if (c.budget) {
      parts.push(`${fmt(c.spent)} von ${fmt(c.budget)} Budget`);
      if (c.spent > c.budget) parts.push(`<span class="neg">⚠ ${fmt(c.spent - c.budget)} drüber</span>`);
      else parts.push(`<span class="pos">noch ${fmt(c.budget - c.spent)}</span>`);
    } else if (c.spent) parts.push(`ausgegeben ${fmt(c.spent)}${c.count ? ` (${c.count}×)` : ''}`);
    const w = (v) => (v / max) * 100;
    const within = Math.min(c.spent, c.budget);
    const over = c.budget ? Math.max(0, c.spent - c.budget) : 0;
    const rest = Math.max(0, c.budget - c.spent);
    return `<div class="cat-row">
      <div class="top"><span>${esc(c.name)}</span><strong class="num">${fmt(c.total)}</strong></div>
      <div class="bar">
        ${c.fixed ? `<i style="width:${w(c.fixed)}%"></i>` : ''}
        ${c.budget ? `<i class="extra" style="width:${w(within)}%"></i><i class="rest" style="width:${w(rest)}%"></i>` : `<i class="extra" style="width:${w(c.spent)}%"></i>`}
        ${over ? `<i class="over" style="width:${w(over)}%"></i>` : ''}
      </div>
      <div class="sub">${parts.join(' · ')}</div>
    </div>`;
  }).join('');
}
// Tabelle: pro Kategorie Fixkosten und variable Kosten (ausgegeben, bei Budget „von …“)
function renderFixVar(s) {
  const rows = s.categories.filter((c) => c.fixed || c.spent || c.budget)
    .sort((a, b) => (b.fixed + b.spent) - (a.fixed + a.spent));
  const fixSum = rows.reduce((t, c) => t + c.fixed, 0);
  const varSum = rows.reduce((t, c) => t + c.spent, 0);
  const cell = (v) => (v ? fmt(v) : '<span class="muted">–</span>');
  $('#fixVarTable').innerHTML = rows.length ? `
    <thead><tr><th>Kategorie</th><th class="r">Fix</th><th class="r">Variabel</th><th class="r">Gesamt</th></tr></thead>
    <tbody>${rows.map((c) => `<tr><td>${esc(c.name)}</td><td class="num r">${cell(c.fixed)}</td>
      <td class="num r">${cell(c.spent)}${c.budget ? `<div class="muted small">von ${fmt(c.budget)}</div>` : ''}</td>
      <td class="num r"><strong>${fmt(c.fixed + c.spent)}</strong></td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Summe</td><td class="num r">${fmt(fixSum)}</td><td class="num r">${fmt(varSum)}</td><td class="num r">${fmt(fixSum + varSum)}</td></tr></tfoot>`
    : '<tbody><tr><td class="muted small">Noch keine Kosten in diesem Monat.</td></tr></tbody>';
}
$$('[data-quick]').forEach((b) => b.addEventListener('click', () => openEntryDialog({ kind: b.dataset.quick })));

// ---------- Kosten: Umschalter Einkommen | Fixkosten | Variabel ----------
$$('[data-kosten]').forEach((b) => b.addEventListener('click', () => { state.kosten = b.dataset.kosten; renderKosten(); }));
async function renderKosten() {
  $$('[data-kosten]').forEach((b) => b.classList.toggle('active', b.dataset.kosten === state.kosten));
  $$('[data-kostenview]').forEach((v) => { v.hidden = v.dataset.kostenview !== state.kosten; });
  if (state.kosten === 'variabel') return renderEntries();
  return renderPlan();
}
async function renderPlan() {
  const [incomes, fixed] = await Promise.all([api('GET', `/api/incomes?month=${state.month}`), api('GET', `/api/fixed?month=${state.month}`)]);

  $('#incomeList').innerHTML = incomes.length ? incomes.map((i) => `
    <li data-id="${i.id}">
      <div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${INTERVAL_LABEL[i.interval]}${endInfo(i)}</div></div>
      <div class="right num ${i.ended ? 'muted' : ''}">${fmt(i.amount)}${i.interval > 1 ? `<div class="meta">${fmt(i.amount / i.interval)} / Monat</div>` : ''}</div>
      ${delBtn(`/api/incomes/${i.id}`, i.name)}
    </li>`).join('') : '<li class="muted small">Noch kein Einkommen eingetragen.</li>';
  $('#incomeTotal').textContent = fmt(incomes.filter((i) => !i.ended).reduce((s, i) => s + i.amount / i.interval, 0));
  $$('#incomeList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openIncomeDialog(incomes.find((i) => i.id === Number(li.dataset.id)))));

  const groups = {};
  for (const f of fixed) (groups[f.category] ||= []).push(f);
  const monthly = (f) => f.thisMonth;
  const rightSide = (f) => f.ended ? `<span class="muted">0,00 €</span><div class="meta">beendet</div>` : f.dueMode
    ? (f.dueNow ? `${fmt(f.thisMonth)}<div class="meta">diesen Monat fällig</div>` : `<span class="muted">0,00 €</span><div class="meta">diesen Monat</div>`)
    : `${fmt(f.thisMonth)}<div class="meta">/ Monat</div>`;
  $('#fixedList').innerHTML = fixed.length ? Object.entries(groups).map(([cat, items]) => `
    <div class="group-title">${esc(cat)}</div>
    <ul class="list">${items.map((f) => `
      <li data-id="${f.id}">
        <div class="main">
          <div class="title">${esc(f.name)} ${f.kind === 'budget' ? '<span class="pill budget">Budget</span>' : ''}</div>
          <div class="meta">${fmt(f.amount)} ${INTERVAL_LABEL[f.interval]}${f.share < 100 ? ` · dein Anteil ${f.share.toLocaleString('de-DE')} %` : ''}${endInfo(f)}</div>
          ${f.dueMode && f.nextDue ? `<div class="meta">📅 nächste Fälligkeit ${fmtDate(f.nextDue)}</div>` : ''}
          ${!f.dueMode && f.interval > 1 && f.kind !== 'budget' ? '<div class="meta">auf die Monate verteilt</div>' : ''}
        </div>
        <div class="right num">${rightSide(f)}</div>
        ${delBtn(`/api/fixed/${f.id}`, f.name)}
      </li>`).join('')}
    </ul>`).join('') : '<p class="muted small empty">Noch keine Fixkosten eingetragen.</p>';
  const fixSum = fixed.filter((f) => f.kind !== 'budget').reduce((s, f) => s + monthly(f), 0);
  const budSum = fixed.filter((f) => f.kind === 'budget').reduce((s, f) => s + monthly(f), 0);
  $('#fixedTotal').innerHTML = budSum
    ? `${fmt(fixSum + budSum)}<div class="meta" style="font-weight:400">${fmt(fixSum)} fix + ${fmt(budSum)} Budgets</div>`
    : fmt(fixSum);
  $$('#fixedList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openFixedDialog(fixed.find((f) => f.id === Number(li.dataset.id)))));
}
$('#addIncome').addEventListener('click', () => openIncomeDialog());
$('#addFixed').addEventListener('click', () => openFixedDialog());

// ---------- Variable Ausgaben ----------
async function renderEntries() {
  const entries = await api('GET', `/api/entries?month=${state.month}`);
  const out = entries.filter((e) => e.kind === 'mehr').reduce((s, e) => s + e.amount, 0);
  const inc = entries.filter((e) => e.kind === 'weniger').reduce((s, e) => s + e.amount, 0);
  $('#entrySummary').innerHTML = entries.length ? `<div class="summary-row">
      <div><small>Ausgegeben</small><strong class="neg">${fmt(out)}</strong></div>
      ${inc ? `<div><small>Einnahmen / Erstattungen</small><strong class="pos">${fmt(inc)}</strong></div>` : ''}
      <div><small>Anzahl</small><strong>${entries.length}</strong></div>
    </div>` : '';
  $('#entryEmpty').hidden = entries.length > 0;
  $('#entryList').innerHTML = entries.map((e) => `
    <li data-id="${e.id}">
      <div class="main">
        <div class="title">${e.shop ? `<span class="shop-tag">${esc(e.shop)}</span>${e.note ? ' · ' : ''}` : ''}${esc(e.note || (e.shop ? '' : e.category))}</div>
        <div class="meta">${new Date(e.date + 'T00:00').toLocaleDateString('de-DE')} · ${esc(e.category)}${e.files ? ` · <span class="clip">📎 ${e.files}</span>` : ''}</div>
      </div>
      <div class="right">
        <div class="num ${e.kind === 'mehr' ? 'neg' : 'pos'}">${e.kind === 'mehr' ? '−' : '+'}${fmt(e.amount)}</div>
        ${e.kind === 'weniger' ? '<span class="pill weniger">Einnahme</span>' : ''}
      </div>
      ${delBtn(`/api/entries/${e.id}`, `${e.shop || e.note || e.category} ${fmt(e.amount)}`, e.files ? 'Die angehängten Belege werden auch gelöscht.' : '')}
    </li>`).join('');
  $$('#entryList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openEntryDialog(entries.find((e) => e.id === Number(li.dataset.id)))));
}
$('#addEntry').addEventListener('click', () => openEntryDialog({ kind: 'mehr' }));

// ---------- Ausgaben: Auswertung ----------
const shortMonth = (m) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('de-DE', { month: 'short' }); };
async function renderStats() {
  const st = await api('GET', `/api/stats?month=${state.month}`);
  const s = st.summary;
  const delta = st.avgSpent != null ? s.spent - st.avgSpent : null;
  $('#statsKpis').innerHTML = `
    <div><small>Variable Ausgaben</small><strong class="num">${fmt(s.spent)}</strong>
      <span class="delta">${delta == null ? 'noch kein Vergleich' : `${delta > 0 ? '▲' : '▼'} ${fmt(Math.abs(delta))} ggü. Ø ${fmt(st.avgSpent)}`}</span></div>
    <div><small>Käufe</small><strong class="num">${st.count}</strong><span class="delta">Ø ${fmt(st.avgPurchase)} pro Kauf</span></div>
    <div><small>Sparquote</small><strong class="num ${st.savingsRate < 0 ? 'neg' : ''}">${st.savingsRate == null ? '–' : st.savingsRate + ' %'}</strong>
      <span class="delta">${fmt(s.available)} übrig</span></div>`;

  const ICON = { warn: '⚠️', idea: '💡', good: '✅' };
  $('#potential').textContent = st.potential > 0 ? `bis ${fmt(st.potential)}/Monat` : '';
  $('#tips').innerHTML = st.tips.length ? st.tips.map((t) => `
    <li><span class="ico" aria-hidden="true">${ICON[t.type]}</span><div><b>${esc(t.title)}</b><span class="t">${esc(t.text)}</span></div></li>`).join('')
    : '<li><span class="ico">ℹ️</span><div><b>Noch zu wenig Daten</b><span class="t">Trag ein paar Ausgaben mit Händler ein – dann zeigt dir die App, wo du sparen kannst.</span></div></li>';

  const maxShop = Math.max(1, ...st.byShop.map((x) => x.total));
  $('#shopBars').innerHTML = st.byShop.length ? st.byShop.map((x) => `
    <div class="hbar" title="${esc(x.name)}: ${fmt(x.total)} bei ${x.count} Käufen">
      <div class="top"><span>${esc(x.name)}</span><strong class="num">${fmt(x.total)}</strong></div>
      <div class="track"><i style="width:${(x.total / maxShop) * 100}%"></i></div>
      <div class="sub">${x.count} Kauf${x.count === 1 ? '' : 'e'} · ${Math.round((x.total / s.spent) * 100)} % deiner Ausgaben</div>
    </div>`).join('') : '<p class="muted small empty">Keine Ausgaben in diesem Monat.</p>';

  const cats = s.categories.filter((c) => c.budget > 0 || c.spent > 0);
  $('#budgetBars').innerHTML = cats.length ? cats.map((c) => {
    const scale = Math.max(c.budget, c.spent, 1);
    const within = Math.min(c.spent, c.budget || c.spent);
    const over = c.budget ? Math.max(0, c.spent - c.budget) : 0;
    const status = !c.budget ? 'kein Budget festgelegt'
      : over ? `⚠ ${fmt(over)} über Budget` : `noch ${fmt(c.budget - c.spent)} übrig`;
    return `<div class="hbar" title="${esc(c.name)}: ${fmt(c.spent)} ausgegeben${c.budget ? ` von ${fmt(c.budget)}` : ''}">
      <div class="top"><span>${esc(c.name)}</span><strong class="num">${fmt(c.spent)}${c.budget ? ` <span class="muted" style="font-weight:400">/ ${fmt(c.budget)}</span>` : ''}</strong></div>
      <div class="track">
        <i class="${over ? 'under' : ''}" style="width:${(within / scale) * 100}%"></i>
        ${over ? `<i class="over" style="width:${(over / scale) * 100}%"></i>` : ''}
        ${c.budget && over ? `<span class="limit" style="left:${(c.budget / scale) * 100}%"></span>` : ''}
      </div>
      <div class="sub ${over ? 'neg' : ''}">${status}</div>
    </div>`;
  }).join('') : '<p class="muted small empty">Keine Daten in diesem Monat.</p>';

  const maxT = Math.max(1, ...st.trend.map((t) => t.spent));
  $('#trend').setAttribute('aria-label', 'Variable Ausgaben: ' + st.trend.map((t) => `${shortMonth(t.month)} ${fmt(t.spent)}`).join(', '));
  $('#trend').innerHTML = st.trend.map((t) => `
    <div class="col ${t.month === state.month ? 'cur' : ''}" title="${monthLabel(t.month)}: ${fmt(t.spent)}">
      <span class="v">${t.spent ? Math.round(t.spent).toLocaleString('de-DE') + ' €' : ''}</span>
      <i style="height:${(t.spent / maxT) * 100}%"></i>
      <span class="m">${shortMonth(t.month)}</span>
    </div>`).join('');
  $('#trendTable').innerHTML = `<thead><tr><th>Monat</th><th>Variabel</th><th>Fix</th><th>Übrig</th></tr></thead><tbody>${
    st.trend.slice().reverse().map((t) => `<tr><td>${monthLabel(t.month)}</td><td class="num">${fmt(t.spent)}</td>
      <td class="num">${fmt(t.fixedTotal)}</td><td class="num ${t.available < 0 ? 'neg' : ''}">${fmt(t.available)}</td></tr>`).join('')}</tbody>`;

  $('#topList').innerHTML = st.top.length ? st.top.map((e) => `
    <li><div class="main"><div class="title">${esc(e.shop || e.category)}${e.note ? ` <span class="muted">· ${esc(e.note)}</span>` : ''}</div>
      <div class="meta">${new Date(e.date + 'T00:00').toLocaleDateString('de-DE')} · ${esc(e.category)}</div></div>
      <div class="right num">${fmt(e.amount)}</div></li>`).join('') : '<li class="muted small">Keine Ausgaben.</li>';
}

// ---------- Haushalt ----------
async function renderHousehold() {
  const h = await api('GET', `/api/household?month=${state.month}`);
  const block = (name, m, cls = '') => `<div class="hh-member ${cls}">
    <div class="hh-head"><strong>${name}</strong>
      <strong class="num ${m.available < 0 ? 'neg' : 'pos'}">${fmt(m.available)}</strong></div>
    <dl class="calc small">
      <dt>Einkommen</dt><dd>${fmt(m.income)}</dd>
      <dt>Fixkosten</dt><dd>${fmt(m.fixedTotal)}</dd>
      <dt>Variable Ausgaben</dt><dd>${fmt(m.spent)}${m.budgetTotal ? ` <span class="muted">/ ${fmt(m.budgetTotal)} Budget</span>` : ''}</dd>
      ${m.refunds ? `<dt>Einnahmen / Erstattungen</dt><dd>${fmt(m.refunds)}</dd>` : ''}
    </dl>
  </div>`;
  $('#hhTable').innerHTML =
    h.members.map((m) => block(esc(m.name) + (m.isMe ? ' (ich)' : ''), m)).join('') +
    (h.members.length > 1 ? block('Gemeinsam', h.total, 'sum') : '');
  $('#inviteCode').textContent = state.me.household.inviteCode;
}
$('#copyInvite').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}?code=${state.me.household.inviteCode}`;
  try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert'); }
  catch { toast(`Code: ${state.me.household.inviteCode}`); }
});

// ---------- Konto ----------
function renderAccount() {
  $('#accountInfo').textContent = `${state.me.user.name} · ${state.me.user.email} · Haushalt „${state.me.household.name}“ (${state.me.members.map((m) => m.name).join(', ')})`;
  $('#adminCard').hidden = !state.me.isAdmin;
  if (state.me.isAdmin) renderAdmin();
}
// ---------- Nutzer-Übersicht (nur Besitzer, ohne Inhalte) ----------
const DAY = 86400000;
function agoText(iso) {
  if (!iso) return 'noch nie';
  const days = Math.floor((Date.now() - new Date(iso)) / DAY);
  if (days <= 0) return 'heute';
  if (days === 1) return 'gestern';
  if (days < 30) return `vor ${days} Tagen`;
  return new Date(iso).toLocaleDateString('de-DE');
}
async function renderAdmin() {
  let rows;
  try { rows = await api('GET', '/api/admin/users'); } catch (err) { $('#adminList').innerHTML = `<li class="muted small">${esc(err.message)}</li>`; return; }
  const lastActive = (r) => [r.last_seen_at, r.last_saved_at, r.last_sign_in_at].filter(Boolean).sort().pop() || null;
  const activeWithin = (days) => rows.filter((r) => { const t = lastActive(r); return t && Date.now() - new Date(t) <= days * DAY; }).length;
  const households = new Set(rows.map((r) => r.household).filter(Boolean)).size;
  $('#adminStats').innerHTML = `
    <div><small>Konten</small><strong>${rows.length}</strong></div>
    <div><small>Aktiv (7 Tage)</small><strong class="pos">${activeWithin(7)}</strong></div>
    <div><small>Aktiv (30 Tage)</small><strong>${activeWithin(30)}</strong></div>
    <div><small>Haushalte</small><strong>${households}</strong></div>`;
  $('#adminList').innerHTML = rows.length ? rows.map((r) => {
    const t = lastActive(r);
    const fresh = t && Date.now() - new Date(t) <= 7 * DAY;
    return `<li>
      <span class="dot ${fresh ? 'on' : ''}" aria-hidden="true"></span>
      <div class="grow">
        <div class="title">${esc(r.name || '(noch nicht eingerichtet)')}</div>
        <div class="meta">${esc(r.email)}${r.confirmed ? '' : ' · <span class="neg">E-Mail nicht bestätigt</span>'}</div>
        <div class="meta">${r.household ? `🏠 ${esc(r.household)}${r.household_members > 1 ? ` (${r.household_members} Personen)` : ''} · ` : ''}registriert ${new Date(r.registered_at).toLocaleDateString('de-DE')}</div>
      </div>
      <div class="right small">zuletzt aktiv<div class="${fresh ? 'pos' : 'muted'}"><strong>${agoText(t)}</strong></div></div>
    </li>`;
  }).join('') : '<li class="muted small">Noch niemand registriert.</li>';
}
$('#adminReload').addEventListener('click', renderAdmin);
function setOldPasswordNeeded(needed) {
  $('#oldPwLabel').hidden = !needed;
  $('#pwForm [name=oldPassword]').required = needed;
}
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/password', { oldPassword: f.get('oldPassword'), newPassword: f.get('newPassword') });
    e.target.reset(); toast('Passwort geändert');
    setOldPasswordNeeded(true);
  } catch (err) { toast(err.message); }
});
// ---------- „＋“ unten rechts: Schnell eintragen ----------
const QUICK = {
  scan: () => $('#scanInput').click(),
  ausgabe: () => openEntryDialog({ kind: 'mehr' }),
  einnahme: () => openEntryDialog({ kind: 'weniger' }),
  fix: () => openFixedDialog(),
  einkommen: () => openIncomeDialog(),
  zahlung: async () => {
    const open = (await api('GET', '/api/debts')).filter((d) => !d.done);
    if (!open.length) { toast('Noch keine offenen Schulden oder Forderungen – erst über ＋ „Schuld“ oder „Bekomme ich zurück“ anlegen.'); return; }
    openPaymentDialog(open[0], open);
  },
  schuld: () => openDebtDialog({ direction: 'schuld' }),
  forderung: () => openDebtDialog({ direction: 'forderung' }),
  vermoegen: () => openAssetDialog(),
  geburtstag: () => openBirthdayDialog(),
};
$('#fab').addEventListener('click', () => $('#quickDlg').showModal());
$('#scanInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  openEntryDialog({ kind: 'mehr' });
  scanInto($('#dlgBody'), file);
});
$('#quickClose').addEventListener('click', () => $('#quickDlg').close());
$('#quickDlg').addEventListener('click', (e) => {
  if (e.target === $('#quickDlg')) { $('#quickDlg').close(); return; } // Tipp neben das Menü schließt es
  const b = e.target.closest('[data-qa]');
  if (!b) return;
  $('#quickDlg').close();
  QUICK[b.dataset.qa]();
});

// CSV-Export: im Cloud-Modus direkt im Browser erzeugen
$('#exportCsv').addEventListener('click', async (e) => {
  if (!window.Cloud?.enabled) return;
  e.preventDefault();
  try {
    const blob = new Blob([await Cloud.exportCsv()], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'haushaltsbuch.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  } catch (err) { toast(err.message); }
});
// Daten wurden auf einem anderen Gerät geändert -> neu anzeigen
window.addEventListener('haushalt:sync', () => { if (!$('#app').hidden) render(); });
$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.tab = 'overview';
  showAuth();
});

// ---------- Dialoge ----------
const dlg = $('#dlg');
let dlgHandlers = null;
function openDialog({ title, html, onSave, onDelete, onOpen }) {
  $('#dlgTitle').textContent = title;
  // frisches Element, damit keine Event-Listener vom vorherigen Dialog übrig bleiben
  const fresh = $('#dlgBody').cloneNode(false);
  $('#dlgBody').replaceWith(fresh);
  fresh.innerHTML = html;
  pendingFiles = [];
  setupFilePicker(fresh);
  mountAttachments(fresh);
  if (onOpen) onOpen($('#dlgBody'));
  $('#dlgError').textContent = '';
  $('#dlgDelete').hidden = !onDelete;
  dlgHandlers = { onSave, onDelete };
  dlg.showModal();
  const first = $('#dlgBody input, #dlgBody select');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
}
$('#dlgCancel').addEventListener('click', () => dlg.close());
dlg.addEventListener('close', () => { if (attChanged) { attChanged = false; render(); } });
$('#dlgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await dlgHandlers.onSave(Object.fromEntries(new FormData(e.target)));
    dlg.close(); render();
    toast('Gespeichert ✓');
  } catch (err) { $('#dlgError').textContent = err.message; }
});
$('#dlgDelete').addEventListener('click', async () => {
  if (!confirm('Wirklich löschen?')) return;
  try { await dlgHandlers.onDelete(); dlg.close(); render(); }
  catch (err) { $('#dlgError').textContent = err.message; }
});

const intervalSelect = (v = 1) => `<label>Wie oft?
  <select name="interval">${state.meta.intervals.map((i) => `<option value="${i}" ${i === v ? 'selected' : ''}>${INTERVAL_LABEL[i]}</option>`).join('')}</select></label>`;
const categorySelect = (v) => `<label>Kategorie
  <select name="category">${state.meta.categories.map((c) => `<option ${c === v ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>`;
const amountInput = (v, label = 'Betrag (€)') =>
  `<label>${label} <input name="amount" inputmode="decimal" required value="${v != null ? String(v).replace('.', ',') : ''}" placeholder="0,00"></label>`;

function openIncomeDialog(item) {
  openDialog({
    title: item ? 'Einkommen bearbeiten' : 'Einkommen hinzufügen',
    html: `
      <label>Bezeichnung <input name="name" required maxlength="120" value="${esc(item?.name)}" placeholder="z. B. Gehalt netto, Kindergeld"></label>
      <div class="row2">${amountInput(item?.amount)}${intervalSelect(item?.interval)}</div>
      ${endMonthInput(item?.end_month)}`,
    onSave: (d) => item ? api('PUT', `/api/incomes/${item.id}`, d) : api('POST', '/api/incomes', d),
    onDelete: item && (() => api('DELETE', `/api/incomes/${item.id}`)),
  });
}

function openFixedDialog(item) {
  const kind = item?.kind || 'fix';
  // neue Einträge: im Fälligkeitsmonat; ältere Einträge mit 3/6/12 Monaten ohne Datum bleiben „verteilt“
  const dueMode = !item || item.due_date || item.interval === 1 ? 'faellig' : 'verteilt';
  openDialog({
    title: item ? 'Bearbeiten' : 'Fixkosten / Budget hinzufügen',
    html: `
      <fieldset>
        <legend>Art</legend>
        <label class="radio"><input type="radio" name="kind" value="fix" ${kind === 'fix' ? 'checked' : ''}> Fixkosten – feste Beträge (monatlich, vierteljährlich, halbjährlich, jährlich)</label>
        <label class="radio"><input type="radio" name="kind" value="budget" ${kind === 'budget' ? 'checked' : ''}> Budget – Obergrenze für variable Ausgaben</label>
      </fieldset>
      <label>Bezeichnung <input name="name" required maxlength="120" value="${esc(item?.name)}" placeholder="z. B. Hausabtrag, Einkaufen, Kfz-Versicherung"></label>
      ${categorySelect(item?.category)}
      <div class="row2">${amountInput(item?.amount)}${intervalSelect(item?.interval)}</div>
      <fieldset data-due-box hidden>
        <legend>Wann wird abgezogen?</legend>
        <label class="radio"><input type="radio" name="due_mode" value="faellig" ${dueMode === 'faellig' ? 'checked' : ''}> Im Monat der Fälligkeit – ganzer Betrag</label>
        <label data-due-date>Nächste Fälligkeit <input type="date" name="due_date" value="${esc(item?.due_date || '')}"></label>
        <div class="hint" data-due-date>Danach zieht die App den Betrag automatisch wieder ab – <span data-due-every></span>.</div>
        <label class="radio"><input type="radio" name="due_mode" value="verteilt" ${dueMode === 'verteilt' ? 'checked' : ''}> Jeden Monat einen Teil zurücklegen</label>
      </fieldset>
      <label>Mein Anteil (%) <input name="share" inputmode="decimal" value="${item?.share ?? 100}"></label>
      <div class="hint">Bei gemeinsamen Kosten (z. B. Hausabtrag halbe-halbe) den Gesamtbetrag eintragen und 50 % wählen.
        Bei einem Budget werden deine Ausgaben derselben Kategorie damit verrechnet.</div>
      ${endMonthInput(item?.end_month)}`,
    onOpen: (root) => {
      const EVERY = { 3: 'alle 3 Monate', 6: 'alle 6 Monate', 12: 'jedes Jahr' };
      const update = () => {
        const iv = Number($('[name=interval]', root).value);
        const isFix = $('[name=kind]:checked', root).value === 'fix';
        const box = $('[data-due-box]', root);
        box.hidden = !(isFix && iv > 1);
        const faellig = $('[name=due_mode]:checked', root).value === 'faellig';
        $$('[data-due-date]', root).forEach((el) => { el.hidden = !faellig; });
        $('[name=due_date]', root).required = !box.hidden && faellig;
        $('[data-due-every]', root).textContent = EVERY[iv] || '';
      };
      root.addEventListener('change', update);
      update();
    },
    onSave: (d) => item ? api('PUT', `/api/fixed/${item.id}`, d) : api('POST', '/api/fixed', d),
    onDelete: item && (() => api('DELETE', `/api/fixed/${item.id}`)),
  });
}

// Händler-Vorschläge: bekannte Plattformen + bisher genutzte, mit passender Kategorie
const SHOP_DEFAULTS = {
  'PayPal': 'Sonstiges', 'Vinted': 'Kleidung & Shopping', 'eBay': 'Sonstiges', 'Kleinanzeigen': 'Sonstiges',
  'Amazon': 'Sonstiges', 'Zalando': 'Kleidung & Shopping', 'Temu': 'Kleidung & Shopping', 'Shein': 'Kleidung & Shopping',
  'Lidl': 'Einkaufen & Lebensmittel', 'Aldi': 'Einkaufen & Lebensmittel', 'Rewe': 'Einkaufen & Lebensmittel',
  'Edeka': 'Einkaufen & Lebensmittel', 'Kaufland': 'Einkaufen & Lebensmittel', 'Netto': 'Einkaufen & Lebensmittel',
  'Penny': 'Einkaufen & Lebensmittel', 'dm': 'Drogerie & Haushalt', 'Rossmann': 'Drogerie & Haushalt',
  'Tankstelle': 'Auto & Verschleiß', 'Werkstatt': 'Auto & Verschleiß', 'Lieferando': 'Essen gehen & Lieferdienste',
  'Restaurant': 'Essen gehen & Lieferdienste', 'Apotheke': 'Gesundheit', 'Bargeld': 'Sonstiges',
};
let shopCache = null;
async function loadShops() {
  const used = await api('GET', '/api/shops').catch(() => []);
  const map = new Map(Object.entries(SHOP_DEFAULTS).map(([k, v]) => [k.toLowerCase(), { shop: k, category: v, count: 0 }]));
  for (const u of used) map.set(u.shop.toLowerCase(), u);
  shopCache = [...map.values()].sort((a, b) => b.count - a.count || a.shop.localeCompare(b.shop, 'de'));
  $('#shopList').innerHTML = shopCache.map((x) => `<option value="${esc(x.shop)}">`).join('');
}

function openEntryDialog(item = {}) {
  const isEdit = !!item.id;
  const kind = item.kind || 'mehr';
  loadShops();
  openDialog({
    title: isEdit ? 'Eintrag bearbeiten' : (kind === 'mehr' ? 'Neue Ausgabe' : 'Einnahme / Erstattung'),
    html: `
      ${isEdit ? '' : `<div class="scan-box">
        <label class="btn scan-btn">📷 Kassenbon scannen<input type="file" accept="image/*" capture="environment" data-scan hidden></label>
        <div class="muted small" data-scan-status>Betrag, Geschäft und Datum werden automatisch eingetragen – du prüfst und speicherst.</div>
      </div>`}
      <fieldset>
        <legend>Art</legend>
        <label class="radio"><input type="radio" name="kind" value="mehr" ${kind === 'mehr' ? 'checked' : ''}> Ausgabe</label>
        <label class="radio"><input type="radio" name="kind" value="weniger" ${kind === 'weniger' ? 'checked' : ''}> Einnahme / Erstattung (z. B. Verkauf, Rücksendung)</label>
      </fieldset>
      <div class="row2">
        ${amountInput(item.amount)}
        <label>Datum <input type="date" name="date" required value="${item.date || todayInMonth(state.month)}"></label>
      </div>
      <label>Wo? (Händler / Plattform) <input name="shop" list="shopList" maxlength="60" autocomplete="off" value="${esc(item.shop)}" placeholder="z. B. PayPal, Vinted, eBay, Lidl"></label>
      ${categorySelect(item.category || 'Sonstiges')}
      <label>Notiz <input name="note" maxlength="200" value="${esc(item.note)}" placeholder="z. B. Winterjacke, Reifenwechsel"></label>
      ${isEdit ? attWidget('entry', item.id, 'Belege / Kassenbon') : filePicker('Beleg / Kassenbon (optional)')}`,
    onOpen: (body) => {
      const shop = $('[name=shop]', body);
      const sel = $('[name=category]', body);
      let touched = isEdit;
      sel.addEventListener('change', () => { touched = true; });
      shop.addEventListener('input', () => {
        if (touched || !shopCache) return;
        const hit = shopCache.find((x) => x.shop.toLowerCase() === shop.value.trim().toLowerCase());
        if (hit?.category) sel.value = hit.category;
      });
      $('[data-scan]', body)?.addEventListener('change', (e) => {
        const file = e.target.files[0];
        e.target.value = '';
        if (file) scanInto(body, file);
      });
    },
    onSave: async (d) => {
      if (isEdit) return api('PUT', `/api/entries/${item.id}`, d);
      const { id } = await api('POST', '/api/entries', d);
      await uploadPending('entry', id);
    },
    onDelete: isEdit && (() => api('DELETE', `/api/entries/${item.id}`)),
  });
}

// ---------- Kassenbon scannen: Texterkennung direkt auf dem Handy (Tesseract), danach bestätigen ----------
let ocrWorker = null;
let ocrProgress = null; // Rückmeldung in Prozent an das gerade offene Formular
function loadScriptOnce(src) {
  loadScriptOnce.cache ||= {};
  return (loadScriptOnce.cache[src] ||= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = src; el.onload = resolve;
    el.onerror = () => { delete loadScriptOnce.cache[src]; reject(new Error('Texterkennung konnte nicht geladen werden.')); };
    document.head.appendChild(el);
  }));
}
// wird einmal geladen und danach wiederverwendet (Sprachdaten speichert der Browser zwischen)
async function getOcrWorker() {
  await loadScriptOnce('vendor/tesseract/tesseract.min.js');
  if (!ocrWorker) {
    const base = new URL('vendor/tesseract/', location.href).href;
    ocrWorker = Tesseract.createWorker('deu', 1, {
      workerPath: base + 'worker.min.js', corePath: base, langPath: base, gzip: true,
      logger: (m) => { if (m.status === 'recognizing text' && ocrProgress) ocrProgress(Math.round(m.progress * 100)); },
    }).catch((err) => { ocrWorker = null; throw err; });
  }
  return ocrWorker;
}
// Foto für die Erkennung verkleinern (schneller, gleiche Genauigkeit)
async function ocrImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  } catch { return file; }
}
async function readReceipt(file, onProgress) {
  ocrProgress = onProgress;
  try {
    const worker = await getOcrWorker();
    const { data } = await worker.recognize(await ocrImage(file));
    return HaushaltReceipt.parseReceipt(data.text);
  } finally { ocrProgress = null; }
}
async function scanInto(root, file) {
  const status = $('[data-scan-status]', root);
  // Foto gleich als Beleg anhängen
  file.url = URL.createObjectURL(file);
  pendingFiles.push(file);
  $('.att-pick', root)?.redraw?.();
  status.className = 'small scan-status busy';
  status.textContent = 'Kassenbon wird gelesen … (beim ersten Mal dauert es etwas länger)';
  let r;
  try {
    r = await readReceipt(file, (p) => { if (root.isConnected) status.textContent = `Kassenbon wird gelesen … ${p} %`; });
  } catch (err) {
    if (!root.isConnected) return;
    status.className = 'small scan-status warn';
    status.textContent = `⚠️ ${err.message || 'Texterkennung hat nicht geklappt.'} Bitte selbst eintragen – das Foto ist als Beleg angehängt.`;
    return;
  }
  if (!root.isConnected) return; // Formular wurde inzwischen geschlossen
  const mark = (el) => { el.classList.add('auto-filled'); el.addEventListener('input', () => el.classList.remove('auto-filled'), { once: true }); };
  const found = [];
  if (r.amount != null) {
    const el = $('[name=amount]', root);
    el.value = r.amount.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    mark(el); found.push('Betrag');
  }
  if (r.shop) { const el = $('[name=shop]', root); el.value = r.shop; mark(el); found.push('Geschäft'); }
  if (r.date) { const el = $('[name=date]', root); el.value = r.date; mark(el); found.push('Datum'); }
  if (r.category) { const el = $('[name=category]', root); el.value = r.category; mark(el); }
  if (found.length) {
    status.className = 'small scan-status ok';
    status.textContent = `✅ Erkannt: ${found.join(', ')}. Bitte prüfen (farbig markiert) und auf „Speichern“ tippen.`;
  } else {
    status.className = 'small scan-status warn';
    status.textContent = '⚠️ Auf dem Foto konnte nichts sicher erkannt werden. Bitte selbst eintragen – das Foto ist als Beleg angehängt.';
  }
  if (r.amount == null) $('[name=amount]', root).focus();
}

// ---------- Schulden, Forderungen, Geburtstage ----------
const fmtDate = (iso) => iso ? new Date(iso + 'T00:00').toLocaleDateString('de-DE') : '';
const todayIso = () => todayInMonth(new Date().toISOString().slice(0, 7));
const GIFT_STATUS = { offen: 'noch offen', idee: 'Idee', gekauft: 'gekauft', verschenkt: 'verschenkt' };
const inDays = (n) => n === 0 ? 'heute' : n === 1 ? 'morgen' : `in ${n} Tagen`;

function renderTeaser(s) {
  const show = s.debtsOpen > 0 || s.receivablesOpen > 0 || s.zakatOpen > 0 || s.assetsTotal > 0 || s.upcomingBirthdays.length > 0;
  $('#listsTeaser').hidden = !show;
  if (!show) return;
  $('#teaserCalc').innerHTML =
    (s.debtsOpen > 0 ? `<dt>Offene Schulden</dt><dd class="neg">${fmt(s.debtsOpen)}</dd>` : '') +
    (s.receivablesOpen > 0 ? `<dt>Bekomme ich zurück</dt><dd class="pos">${fmt(s.receivablesOpen)}</dd>` : '') +
    (s.zakatOpen > 0 ? `<dt>Zekât noch zu geben</dt><dd>${fmt(s.zakatOpen)}</dd>` : '') +
    (s.assetsTotal > 0 ? `<dt>Vermögen <span class="muted small">(nur Übersicht)</span></dt><dd>${fmt(s.assetsTotal)}</dd>` : '');
  $('#teaserBirthdays').innerHTML = s.upcomingBirthdays.map((b) => `
    <li data-goto-lists="geburtstag">
      <div class="main"><div class="title">🎂 ${esc(b.name)}${b.turns ? ` (wird ${b.turns})` : ''}</div>
        <div class="meta">${fmtDate(b.nextDate)} · ${inDays(b.daysUntil)}</div></div>
      <span class="pill ${b.gift?.status || 'offen'}">${b.gift?.idea ? esc(b.gift.idea) : 'kein Geschenk'}</span>
    </li>`).join('');
}
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-goto-lists]');
  if (!el) return;
  if (el.dataset.gotoLists) state.list = el.dataset.gotoLists;
  else if (!$('#teaserCalc').innerHTML) state.list = 'geburtstag';
  switchTab(state.list);
});

$('#listAdd').addEventListener('click', () => {
  if (state.list === 'geburtstag') openBirthdayDialog();
  else if (state.list === 'zekat') openZakatYearDialog();
  else if (state.list === 'vermoegen') openAssetDialog();
  else openDebtDialog({ direction: state.list });
});

const LIST_TEXT = {
  schuld: { title: 'Meine Schulden', add: 'Schuld', hint: 'Was du noch zurückzahlen musst – Kredite, Ratenkäufe, geliehenes Geld. Mit „± Eintragen“ erfasst du Teilzahlungen oder wenn du dir noch mehr geliehen hast – der offene Betrag rechnet sich selbst.', empty: 'Keine Schulden eingetragen. 🎉' },
  forderung: { title: 'Bekomme ich zurück', add: 'Forderung', hint: 'Geld, das du verliehen hast oder das dir noch jemand schuldet. Mit „± Eintragen“ erfasst du Teil-Rückzahlungen oder wenn du noch mehr verliehen hast.', empty: 'Niemand schuldet dir etwas.' },
  vermoegen: { title: 'Mein Vermögen', add: 'Posten', hint: 'Nur zur Übersicht: Konten, Bargeld, Gold, Aktien & Co. Nichts davon wird von deinem verfügbaren Geld oder deinen Schulden abgezogen. Gold und Silber in Gramm – mit dem aktuellen Grammpreis rechnet die App den Wert aus.', empty: 'Noch nichts eingetragen. Tippe auf „＋ Neu“, z. B. für dein Tagesgeld oder deinen Goldschmuck.' },
  zekat: { title: 'Zekât', add: 'Jahr', hint: 'Pro Jahr: wie viel Zekât du geben musst, was du schon gegeben hast und was noch offen ist. Alle Zahlungen mit Belegen bleiben als Dokumentation über die Jahre erhalten.', empty: 'Noch kein Zekât-Jahr angelegt. Tippe auf „＋ Neu“.' },
  geburtstag: { title: 'Geburtstage & Geschenke', add: 'Geburtstag', hint: 'Sortiert nach dem nächsten Geburtstag. Tippe auf eine Person, um das Geschenk für dieses Jahr zu planen.', empty: 'Noch keine Geburtstage eingetragen.' },
};

async function renderLists() {
  const t = LIST_TEXT[state.list];
  $('#listTitle').textContent = t.title;
  $('#listHint').textContent = t.hint;
  $('#listEmpty').textContent = t.empty;
  if (state.list === 'geburtstag') return renderBirthdays();
  if (state.list === 'zekat') return renderZakat();
  if (state.list === 'vermoegen') return renderAssets();

  const all = await api('GET', '/api/debts');
  const debts = all.filter((d) => d.direction === state.list).sort((a, b) => a.done - b.done);
  const isDebt = state.list === 'schuld';
  const open = debts.reduce((s, d) => s + Math.max(0, d.remaining), 0);
  const paid = debts.reduce((s, d) => s + d.paid + d.autoPaid, 0);
  const rates = debts.filter((d) => !d.done).reduce((s, d) => s + d.monthly_rate, 0);
  $('#listSummary').innerHTML = debts.length ? `<div class="summary-row">
      <div><small>Noch offen</small><strong class="${isDebt ? 'neg' : 'pos'}">${fmt(open)}</strong></div>
      <div><small>${isDebt ? 'Schon zurückgezahlt' : 'Schon erhalten'}</small><strong>${fmt(paid)}</strong></div>
      ${rates > 0 ? `<div><small>Raten / Monat</small><strong>${fmt(rates)}</strong></div>` : ''}
    </div>` : '';
  $('#listEmpty').hidden = debts.length > 0;
  $('#listBody').innerHTML = debts.map((d) => {
    const pct = Math.min(100, ((d.paid + d.autoPaid) / d.total) * 100);
    const meta = [
      d.auto_pay && d.monthly_rate > 0 && !d.done ? `🔁 ${fmt(d.monthly_rate)} jeden Monat automatisch${d.autoEnd ? ` bis ${fmtMonth(d.autoEnd)}` : ''}${d.autoMonths ? ` · schon ${d.autoMonths}× (${fmt(d.autoPaid)})` : ' · startet ' + fmtDate(d.start_date)}` : '',
      !d.auto_pay && d.monthly_rate > 0 && !d.done ? `Rate ${fmt(d.monthly_rate)}/Monat${d.monthsLeft ? ` · noch ca. ${d.monthsLeft} Monat${d.monthsLeft === 1 ? '' : 'e'}` : ''}` : '',
      d.due_date && !d.done ? `fällig ${fmtDate(d.due_date)}` : '',
      d.in_budget && !d.done ? 'zählt bei Fixkosten' : '',
    ].filter(Boolean).join(' · ');
    return `<li data-id="${d.id}">
      <div class="grow">
        <div class="title">${esc(d.person)}${d.title ? ` <span class="muted">– ${esc(d.title)}</span>` : ''}</div>
        <div class="meta">${d.done ? 'vollständig ' + (isDebt ? 'zurückgezahlt' : 'erhalten') : `offen <strong class="num">${fmt(d.remaining)}</strong> von ${fmt(d.total)}`}</div>
        ${d.increased > 0 ? `<div class="meta">${fmt(d.amount)} + ${fmt(d.increased)} ${isDebt ? 'nachträglich geliehen' : 'nachträglich verliehen'}</div>` : ''}
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${d.filesTotal ? `<div class="meta clip">📎 ${d.filesTotal} Beleg${d.filesTotal === 1 ? '' : 'e'}</div>` : ''}
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="row-actions">
        ${d.done ? '<span class="pill done">erledigt ✓</span>' : ''}
        <button type="button" class="btn small" data-pay="${d.id}">± Eintragen</button>
      </div>
      ${delBtn(`/api/debts/${d.id}`, d.person + (d.title ? ' – ' + d.title : ''), 'Alle Teilzahlungen und Belege dazu werden auch gelöscht.')}
    </li>`;
  }).join('');
  $$('#listBody li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    const d = debts.find((x) => x.id === Number(li.dataset.id));
    if (e.target.closest('[data-pay]')) openPaymentDialog(d); else openDebtDialog(d);
  }));
}

function openDebtDialog(item) {
  const isEdit = !!item.id;
  const isDebt = item.direction !== 'forderung';
  const v = (k) => item[k] ?? '';
  openDialog({
    title: isEdit ? (isDebt ? 'Schuld bearbeiten' : 'Forderung bearbeiten') : (isDebt ? 'Neue Schuld' : 'Neue Forderung'),
    html: `
      <input type="hidden" name="direction" value="${isDebt ? 'schuld' : 'forderung'}">
      <label>${isDebt ? 'Bei wem? (Bank, Person …)' : 'Wer schuldet dir Geld?'}
        <input name="person" required maxlength="120" value="${esc(v('person'))}" placeholder="${isDebt ? 'z. B. Sparkasse, Bruder' : 'z. B. Mehmet'}"></label>
      <label>Wofür? <input name="title" maxlength="120" value="${esc(v('title'))}" placeholder="${isDebt ? 'z. B. Autokredit, Handy-Raten' : 'z. B. für Umzug geliehen'}"></label>
      <div class="row2">
        ${amountInput(item.amount, isEdit ? 'Ursprünglicher Betrag (€)' : 'Betrag (€)')}
        <label>Rate / Monat (€) <input name="monthly_rate" inputmode="decimal" value="${item.monthly_rate ? String(item.monthly_rate).replace('.', ',') : ''}" placeholder="optional"></label>
      </div>
      <div class="row2">
        <label>Seit / ab wann <input type="date" name="start_date" value="${esc(v('start_date'))}"></label>
        <label>${isDebt ? 'Zurückzahlen bis' : 'Zurück bis'} <input type="date" name="due_date" value="${esc(v('due_date'))}"></label>
      </div>
      <button type="button" class="btn small" data-calc-rate>🧮 Rate ausrechnen (Betrag bis zum Datum verteilen)</button>
      <label class="check"><input type="checkbox" name="auto_pay" ${item.auto_pay ? 'checked' : ''}> 🔁 Rate jeden Monat automatisch abziehen</label>
      <div class="hint">${isDebt
        ? 'Ab „Seit / ab wann“ wird die Rate jeden Monat von der Schuld abgezogen und zählt bei deinen Fixkosten – bis „Zurückzahlen bis“ oder bis alles bezahlt ist. Sonderzahlungen trägst du mit „± Eintragen“ ein.'
        : 'Ab „Seit / ab wann“ wird die Rate jeden Monat als zurückbekommen gezählt (als Einnahme) – bis „Zurück bis“ oder bis alles zurück ist.'}</div>
      ${isDebt ? `<label class="check" data-in-budget><input type="checkbox" name="in_budget" ${item.in_budget ? 'checked' : ''}> Monatliche Rate bei Fixkosten mitrechnen (ohne automatisch abzuziehen)</label>
      <div class="hint" data-in-budget>Nur anhaken, wenn du die Rate nicht schon unter „Kosten → Fixkosten“ eingetragen hast.</div>` : ''}
      <label>Notiz <input name="note" maxlength="300" value="${esc(v('note'))}"></label>
      ${!isEdit ? `<label class="check"><input type="checkbox" name="book">
        ${isDebt ? 'Ich habe das Geld bekommen – als Einnahme buchen' : 'Das Geld ist von mir weggegangen – als Ausgabe buchen'}</label>
        <div class="hint">${isDebt ? 'Z. B. Bargeld vom Bruder. Nicht anhaken bei Krediten, die direkt an den Händler gingen (Auto, Handy).' : 'Dann siehst du in deiner Monatsrechnung, dass das Geld gerade fehlt – kommt es zurück, wird es wieder gutgeschrieben.'}</div>` : ''}
      ${isEdit ? attWidget('debt', item.id, isDebt ? 'Belege zur Schuld (z. B. Vertrag)' : 'Belege (z. B. Schuldschein)') : filePicker('Belege (optional, z. B. Vertrag)')}
      ${isEdit && item.payments.length ? `<div class="subhead">Verlauf · jetzt offen ${fmt(item.remaining)}</div>
        <ul class="history">
          <li><span>${item.start_date ? fmtDate(item.start_date) + ' · ' : ''}Anfangsbetrag</span><span class="num">${fmt(item.amount)}</span></li>
          ${item.payments.slice().reverse().map((p) => `<li>
          <span>${fmtDate(p.date)} · ${p.type === 'erhoehung' ? (isDebt ? 'mehr geliehen' : 'mehr verliehen') : (isDebt ? 'zurückgezahlt' : 'zurückbekommen')}${p.note ? ' · ' + esc(p.note) : ''}${p.entry_id ? ' · <span class="muted">gebucht</span>' : ''}</span>
          <span class="num ${p.type === 'erhoehung' ? '' : 'pos'}">${p.type === 'erhoehung' ? '+' : '−'}${fmt(p.amount)} <button type="button" class="x-btn" data-del-payment="${p.id}" aria-label="Eintrag löschen">×</button></span>
          ${attWidget('debt_payment', p.id, '', true)}
        </li>`).join('')}</ul>` : ''}`,
    onOpen: (body) => {
      // „automatisch abziehen“ ersetzt „bei Fixkosten mitrechnen“
      const syncAuto = () => {
        const auto = $('[name=auto_pay]', body).checked;
        $$('[data-in-budget]', body).forEach((el) => { el.hidden = auto; });
      };
      $('[name=auto_pay]', body).addEventListener('change', syncAuto);
      syncAuto();
      body.addEventListener('click', async (e) => {
        if (e.target.closest('[data-calc-rate]')) {
          const due = $('[name=due_date]', body).value;
          if (!due) { toast('Bitte zuerst „bis“-Datum eintragen.'); return; }
          const from = $('[name=start_date]', body).value || todayIso();
          const months = (Number(due.slice(0, 4)) * 12 + Number(due.slice(5, 7))) - (Number(from.slice(0, 4)) * 12 + Number(from.slice(5, 7))) + 1;
          const base = isEdit ? Math.max(0, item.total - item.paid) : parseAmount($('[name=amount]', body).value);
          if (!base || months < 1) { toast('Bitte Betrag und gültige Daten eintragen.'); return; }
          const rate = Math.ceil((base / months) * 100) / 100;
          $('[name=monthly_rate]', body).value = rate.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          toast(`${fmt(base)} in ${months} Monat${months === 1 ? '' : 'en'} = ${fmt(rate)} pro Monat`);
          return;
        }
        const btn = e.target.closest('[data-del-payment]');
        if (!btn || !confirm('Diesen Eintrag löschen?')) return;
        await api('DELETE', `/api/payments/${btn.dataset.delPayment}`);
        btn.closest('li').remove();
        render();
      });
    },
    onSave: async (d) => {
      if (isEdit) return api('PUT', `/api/debts/${item.id}`, d);
      const { id } = await api('POST', '/api/debts', d);
      await uploadPending('debt', id);
    },
    onDelete: isEdit && (() => api('DELETE', `/api/debts/${item.id}`)),
  });
}

// choices: Liste offener Schulden/Forderungen – dann kann man oben auswählen, wofür die Zahlung ist
function openPaymentDialog(debt, choices = null) {
  const isDebt = debt.direction === 'schuld';
  const suggest = debt.monthly_rate > 0 && debt.remaining > 0 && !debt.auto_pay ? Math.min(debt.monthly_rate, debt.remaining) : null;
  const L = isDebt
    ? { zahlung: 'Ich habe zurückgezahlt', zahlungHint: 'Schuld wird kleiner', erhoehung: 'Ich habe mir mehr geliehen', erhoehungHint: 'Schuld wird größer',
        bookZ: 'Als Ausgabe in diesem Monat buchen', bookE: 'Als Einnahme buchen (ich habe das Geld bekommen)' }
    : { zahlung: 'Ich habe Geld zurückbekommen', zahlungHint: 'Forderung wird kleiner', erhoehung: 'Ich habe weiteres Geld verliehen', erhoehungHint: 'Forderung wird größer',
        bookZ: 'Als Einnahme in diesem Monat buchen', bookE: 'Als Ausgabe buchen (das Geld ist weg)' };
  openDialog({
    title: choices ? 'Zahlung eintragen' : `${debt.person}${debt.title ? ' – ' + debt.title : ''}`,
    html: `
      ${choices ? `<label>Wofür? <select name="debt_pick">${['schuld', 'forderung'].map((dir) => {
        const list = choices.filter((c) => c.direction === dir);
        return list.length ? `<optgroup label="${dir === 'schuld' ? 'Meine Schulden' : 'Bekomme ich zurück'}">${list.map((c) => `<option value="${c.id}" ${c.id === debt.id ? 'selected' : ''}>${esc(c.person)}${c.title ? ' – ' + esc(c.title) : ''} (offen ${fmt(c.remaining)})</option>`).join('')}</optgroup>` : '';
      }).join('')}</select></label>` : ''}
      <p class="muted small" style="margin:0">Aktuell offen: <strong>${fmt(debt.remaining)}</strong></p>
      <fieldset>
        <legend>Was ist passiert?</legend>
        <label class="radio"><input type="radio" name="type" value="zahlung" checked> ${L.zahlung} <span class="muted small">(${L.zahlungHint})</span></label>
        <label class="radio"><input type="radio" name="type" value="erhoehung"> ${L.erhoehung} <span class="muted small">(${L.erhoehungHint})</span></label>
      </fieldset>
      <div class="row2">
        ${amountInput(suggest)}
        <label>Datum <input type="date" name="date" required value="${todayIso()}"></label>
      </div>
      <label>Notiz <input name="note" maxlength="200" placeholder="optional, z. B. bar gegeben"></label>
      <label class="check"><input type="checkbox" name="book" ${isDebt && debt.in_budget ? '' : 'checked'}> <span id="bookLabel">${L.bookZ}</span></label>
      <div class="hint" id="bookHint">${isDebt ? (debt.in_budget ? 'Die Rate zählt schon bei den Fixkosten – nur für Sonderzahlungen anhaken.' : 'Nicht anhaken, wenn diese Rate schon in deinen Fixkosten steckt.') : ''}</div>
      <div class="hint" id="newTotal"></div>
      ${filePicker('Beleg / Quittung (optional)')}`,
    onOpen: (body) => {
      // andere Schuld/Forderung gewählt: Formular für diese neu öffnen (Betrag und Datum bleiben)
      $('[name=debt_pick]', body)?.addEventListener('change', (e) => {
        const next = choices.find((c) => c.id === Number(e.target.value));
        const keep = { amount: $('[name=amount]', body).value, date: $('[name=date]', body).value };
        dlg.close();
        openPaymentDialog(next, choices);
        if (keep.amount) $('#dlgBody [name=amount]').value = keep.amount;
        $('#dlgBody [name=date]').value = keep.date;
        $('#dlgBody [name=amount]').dispatchEvent(new Event('input', { bubbles: true }));
      });
      const update = () => {
        const type = $('[name=type]:checked', body).value;
        const amt = parseAmount($('[name=amount]', body).value);
        $('#bookLabel', body).textContent = type === 'erhoehung' ? L.bookE : L.bookZ;
        $('#bookHint', body).hidden = type === 'erhoehung';
        const after = type === 'erhoehung' ? debt.remaining + amt : debt.remaining - amt;
        $('#newTotal', body).innerHTML = amt ? `Danach offen: <strong>${fmt(Math.max(0, after))}</strong>${after < 0 ? ` (${fmt(-after)} zu viel)` : ''}` : '';
      };
      body.addEventListener('change', update);
      body.addEventListener('input', update);
      update();
    },
    onSave: async (d) => {
      const { id } = await api('POST', `/api/debts/${debt.id}/payments`, d);
      await uploadPending('debt_payment', id);
    },
  });
}

async function renderBirthdays() {
  const list = await api('GET', '/api/birthdays');
  const thisYear = list.filter((b) => b.gift);
  const budget = thisYear.reduce((s, b) => s + (b.gift.price || b.gift.budget || 0), 0);
  const soon = list.filter((b) => b.daysUntil <= 30).length;
  $('#listSummary').innerHTML = list.length ? `<div class="summary-row">
      <div><small>Nächste 30 Tage</small><strong>${soon} Geburtstag${soon === 1 ? '' : 'e'}</strong></div>
      <div><small>Geplante Geschenke</small><strong>${fmt(budget)}</strong></div>
    </div>` : '';
  $('#listEmpty').hidden = list.length > 0;
  $('#listBody').innerHTML = list.map((b) => {
    const d = new Date(b.nextDate + 'T00:00');
    const g = b.gift;
    const giftText = g && g.idea ? esc(g.idea) : 'Noch kein Geschenk geplant';
    const money = g ? (g.price ? fmt(g.price) : g.budget ? `Budget ${fmt(g.budget)}` : '') : '';
    return `<li data-id="${b.id}">
      <div class="date-badge ${b.daysUntil <= 14 ? 'soon' : ''}"><b>${d.getDate()}</b><small>${d.toLocaleDateString('de-DE', { month: 'short' })}</small></div>
      <div class="grow">
        <div class="title">${esc(b.name)}</div>
        <div class="meta">${b.turns ? `wird ${b.turns} · ` : ''}${inDays(b.daysUntil)}</div>
        <div class="meta">🎁 ${giftText}${money ? ' · ' + money : ''}</div>
      </div>
      <span class="pill ${g?.status || 'offen'}">${GIFT_STATUS[g?.status || 'offen']}</span>
      ${delBtn(`/api/birthdays/${b.id}`, b.name, 'Die geplanten Geschenke werden auch gelöscht.')}
    </li>`;
  }).join('');
  $$('#listBody li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openBirthdayDialog(list.find((b) => b.id === Number(li.dataset.id)))));
}

function openBirthdayDialog(item) {
  const isEdit = !!item;
  const g = item?.gift || {};
  const giftYear = item?.nextYear ?? new Date().getFullYear();
  const monthOpts = Array.from({ length: 12 }, (_, i) =>
    `<option value="${i + 1}" ${item?.month === i + 1 ? 'selected' : ''}>${new Date(2000, i, 1).toLocaleDateString('de-DE', { month: 'long' })}</option>`).join('');
  const past = (item?.gifts || []).filter((x) => x.year !== giftYear);
  openDialog({
    title: isEdit ? item.name : 'Geburtstag hinzufügen',
    html: `
      <label>Name <input name="name" required maxlength="120" value="${esc(item?.name)}" placeholder="z. B. Mama, Emre"></label>
      <div class="row3">
        <label>Tag <input name="day" inputmode="numeric" required value="${item?.day ?? ''}" placeholder="TT"></label>
        <label>Monat <select name="month" required>${monthOpts}</select></label>
        <label>Geburtsjahr <input name="year" inputmode="numeric" value="${item?.year ?? ''}" placeholder="optional"></label>
      </div>
      <div class="subhead">Geschenk ${isEdit ? giftYear : '(nächster Geburtstag)'}</div>
      <label>Geschenkidee <input name="idea" maxlength="200" value="${esc(g.idea)}" placeholder="z. B. Parfum, Gutschein"></label>
      <div class="row2">
        <label>Budget (€) <input name="budget" inputmode="decimal" value="${g.budget ? String(g.budget).replace('.', ',') : ''}"></label>
        <label>Tatsächlicher Preis (€) <input name="price" inputmode="decimal" value="${g.price ? String(g.price).replace('.', ',') : ''}"></label>
      </div>
      <label>Status <select name="status">${Object.entries(GIFT_STATUS).map(([k, l]) =>
        `<option value="${k}" ${(g.status || 'offen') === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
      ${g.entry_id ? '<div class="hint">✓ Bereits als Ausgabe gebucht – Preisänderungen werden übernommen.</div>'
        : '<label class="check"><input type="checkbox" name="book" checked> Wenn gekauft: Preis als Ausgabe (Geschenke) buchen</label>'}
      <label>Notiz <input name="note" maxlength="300" value="${esc(item?.note)}" placeholder="z. B. Kleidergröße, Hobbys"></label>
      ${past.length ? `<div class="subhead">Frühere Geschenke</div><ul class="history">${past.map((x) =>
        `<li><span>${x.year}: ${esc(x.idea || '–')}</span><span class="num">${x.price ? fmt(x.price) : ''}</span></li>`).join('')}</ul>` : ''}`,
    onSave: async (d) => {
      let id = item?.id;
      if (isEdit) await api('PUT', `/api/birthdays/${id}`, d);
      else id = (await api('POST', '/api/birthdays', d)).id;
      const hasGift = d.idea || d.budget || d.price || d.status !== 'offen' || item?.gift;
      if (hasGift) {
        let year = giftYear;
        if (!isEdit) {
          // nächstes Vorkommen des Geburtstags bestimmen
          const now = new Date(); const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
          year = new Date(now.getFullYear(), Number(d.month) - 1, Number(d.day)) < t ? now.getFullYear() + 1 : now.getFullYear();
        }
        await api('PUT', `/api/birthdays/${id}/gift`, { ...d, year });
      }
    },
    onDelete: isEdit && (() => api('DELETE', `/api/birthdays/${item.id}`)),
  });
}

// ---------- Zekât ----------
const ZAKAT_KIND = { zekat: 'Zekât', fitre: 'Fitre', sadaka: 'Sadaka' };
let zakatCache = null;

async function renderZakat() {
  const z = await api('GET', '/api/zakat');
  zakatCache = z;
  const t = z.totals;
  const belege = z.years.reduce((s, y) => s + y.payments.reduce((n, p) => n + p.files, 0), 0);
  $('#listSummary').innerHTML = z.years.length ? `<div class="summary-row">
      <div><small>Noch zu geben</small><strong class="${t.open > 0 ? 'neg' : 'pos'}">${fmt(t.open)}</strong></div>
      <div><small>Zekât gegeben (alle Jahre)</small><strong>${fmt(t.paid)}</strong></div>
      ${t.fitre || t.sadaka ? `<div><small>Fitre / Sadaka</small><strong>${fmt(t.fitre + t.sadaka)}</strong></div>` : ''}
    </div>
    <div class="doc-row">
      <span class="muted small">📁 Dokumentation: ${z.years.length} Jahr${z.years.length === 1 ? '' : 'e'}, ${z.years.reduce((s, y) => s + y.payments.length, 0)} Zahlungen, ${belege} Beleg${belege === 1 ? '' : 'e'}</span>
      <button type="button" class="btn small" id="zakatReport">📄 Nachweis drucken / PDF</button>
    </div>` : '';
  $('#listEmpty').hidden = z.years.length > 0;
  $('#listBody').innerHTML = z.years.map((y) => {
    const pct = y.due > 0 ? Math.min(100, (y.paid / y.due) * 100) : 0;
    const extra = [y.fitre ? `Fitre ${fmt(y.fitre)}` : '', y.sadaka ? `Sadaka ${fmt(y.sadaka)}` : ''].filter(Boolean).join(' · ');
    const files = y.payments.reduce((n, p) => n + p.files, 0);
    return `<li data-id="${y.id}">
      <div class="date-badge year"><b>${esc(y.label)}</b></div>
      <div class="grow">
        <div class="title">Zekât ${esc(y.label)}</div>
        <div class="meta">${y.due > 0 ? `gegeben <strong class="num">${fmt(y.paid)}</strong> von ${fmt(y.due)}` : `gegeben ${fmt(y.paid)} · Betrag noch nicht festgelegt`}</div>
        <div class="meta">${y.done ? 'vollständig gegeben' : y.due > 0 ? `noch offen <strong class="num neg">${fmt(y.remaining)}</strong>` : ''}${y.due_date && !y.done ? ` · bis ${fmtDate(y.due_date)}` : ''}</div>
        ${extra || files ? `<div class="meta">${extra}${extra && files ? ' · ' : ''}${files ? `📎 ${files} Beleg${files === 1 ? '' : 'e'}` : ''}</div>` : ''}
        ${y.due > 0 ? `<div class="progress"><i style="width:${pct}%"></i></div>` : ''}
      </div>
      <div class="row-actions">
        ${y.done ? '<span class="pill done">erledigt ✓</span>' : ''}
        <button type="button" class="btn small" data-zpay="${y.id}">＋ Zahlung</button>
      </div>
    </li>`;
  }).join('');
  $$('#listBody li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    const y = z.years.find((x) => x.id === Number(li.dataset.id));
    if (e.target.closest('[data-zpay]')) openZakatPaymentDialog(y); else openZakatYearDialog(y);
  }));
  $('#zakatReport')?.addEventListener('click', () => openZakatReport(z));
}

const CALC_FIELDS = [
  ['cash', 'Bargeld & Bankkonten'], ['gold', 'Gold & Silber (Wert in €)'], ['other', 'Aktien, Fonds, sonstige Ersparnisse'],
  ['receivables', 'Forderungen (Geld, das du sicher zurückbekommst)'], ['debts', 'abzüglich fällige Schulden'],
];
function calcZakat(c) {
  const n = (k) => parseAmount(c[k]);
  const wealth = n('cash') + n('gold') + n('other') + n('receivables') - n('debts');
  const nisab = n('nisab');
  const due = nisab && wealth < nisab ? 0 : Math.max(0, Math.round(wealth * 0.025 * 100) / 100);
  return { wealth, nisab, due, below: !!nisab && wealth < nisab };
}

function openZakatYearDialog(item, { autofill = false } = {}) {
  const isEdit = !!item;
  const c = item?.calc || {};
  const num2 = (v) => v != null && v !== '' ? String(v).replace('.', ',') : '';
  openDialog({
    title: isEdit ? `Zekât ${item.label}` : 'Neues Zekât-Jahr',
    html: `
      <div class="row2">
        <label>Jahr <input name="label" required maxlength="40" value="${esc(item?.label ?? new Date().getFullYear())}" placeholder="z. B. 2026 oder 1447"></label>
        <label>Zu geben bis <input type="date" name="due_date" value="${esc(item?.due_date ?? '')}"></label>
      </div>
      <label>Zekât für dieses Jahr (€) <input name="due" inputmode="decimal" value="${num2(item?.due || '')}" placeholder="Betrag oder Rechner nutzen"></label>
      <details class="calc-box" ${!isEdit || autofill ? 'open' : ''}>
        <summary>🧮 Zekât-Rechner (2,5 %)</summary>
        <div class="stack">
          <button type="button" class="btn small" id="calcFromAssets">📥 Werte aus „Vermögen“ übernehmen</button>
          ${CALC_FIELDS.map(([k, l]) => `<label>${l} <input name="calc_${k}" inputmode="decimal" value="${num2(c[k])}" placeholder="0"></label>`).join('')}
          <label>Nisab-Grenze (€) <input name="calc_nisab" inputmode="decimal" value="${num2(c.nisab)}" placeholder="optional, aktueller Wert von ca. 85 g Gold"></label>
          <div class="calc-result" id="calcResult"></div>
          <button type="button" class="btn small" id="calcApply">Betrag übernehmen</button>
          <div class="hint">Der Rechner ist eine Hilfe. Im Zweifel bei der Gemeinde oder beim Imam nachfragen.</div>
        </div>
      </details>
      <label>Notiz <input name="note" maxlength="300" value="${esc(item?.note ?? '')}"></label>
      ${isEdit ? `<div class="subhead">Zahlungen & Belege</div>
        ${item.payments.length ? `<ul class="history">${item.payments.map((p) => `<li>
          <span>${fmtDate(p.date)} · <b>${ZAKAT_KIND[p.kind]}</b>${p.recipient ? ' an ' + esc(p.recipient) : ''}${p.note ? ' · ' + esc(p.note) : ''}</span>
          <span class="num">${fmt(p.amount)} <button type="button" class="x-btn" data-zdel="${p.id}" aria-label="Zahlung löschen">×</button></span>
          ${attWidget('zakat_payment', p.id, '', true)}
        </li>`).join('')}</ul>` : '<p class="muted small" style="margin:0">Noch keine Zahlungen.</p>'}` : ''}`,
    onOpen: (body) => {
      const calcInputs = () => Object.fromEntries(['cash', 'gold', 'other', 'receivables', 'debts', 'nisab']
        .map((k) => [k, $(`[name=calc_${k}]`, body).value]));
      const show = () => {
        const r = calcZakat(calcInputs());
        $('#calcResult', body).innerHTML = r.wealth
          ? `Zekât-pflichtiges Vermögen: <b>${fmt(r.wealth)}</b><br>${r.below
            ? `Unter der Nisab-Grenze (${fmt(r.nisab)}) – keine Zekât-Pflicht.`
            : `2,5 % davon = <b>${fmt(r.due)}</b>`}` : 'Werte eintragen, das Ergebnis erscheint hier.';
        return r;
      };
      body.addEventListener('input', (e) => { if (e.target.name?.startsWith('calc_')) show(); });
      show();
      $('#calcApply', body).addEventListener('click', () => {
        $('[name=due]', body).value = String(show().due).replace('.', ',');
      });
      const fillFromAssets = async () => {
        const a = await api('GET', '/api/assets');
        const set = (k, v) => { $(`[name=calc_${k}]`, body).value = v ? String(v).replace('.', ',') : ''; };
        set('cash', a.zakatCalc.cash); set('gold', a.zakatCalc.gold); set('other', a.zakatCalc.other);
        if (a.nisab) set('nisab', a.nisab);
        const r = show();
        toast(a.missingPrice ? 'Übernommen – Gold-/Silberpreis fehlt noch, bitte unter „Vermögen“ eintragen.' : 'Werte aus dem Vermögen übernommen');
        return r;
      };
      $('#calcFromAssets', body).addEventListener('click', fillFromAssets);
      if (autofill) fillFromAssets().then((r) => { $('[name=due]', body).value = String(r.due).replace('.', ','); });
      body.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-zdel]');
        if (del && confirm('Diese Zahlung löschen? Angehängte Belege werden mit gelöscht.')) {
          await api('DELETE', `/api/zakat/payments/${del.dataset.zdel}`);
          del.closest('li').remove(); render();
        }
      });
    },
    onSave: (d) => {
      const calc = {};
      for (const k of ['cash', 'gold', 'other', 'receivables', 'debts', 'nisab']) { calc[k] = d['calc_' + k]; delete d['calc_' + k]; }
      const payload = { ...d, calc };
      return isEdit ? api('PUT', `/api/zakat/years/${item.id}`, payload) : api('POST', '/api/zakat/years', payload);
    },
    onDelete: isEdit && (() => api('DELETE', `/api/zakat/years/${item.id}`)),
  });
}

function openZakatPaymentDialog(year) {
  const recipients = [...new Set((zakatCache?.years || []).flatMap((y) => y.payments.map((p) => p.recipient)).filter(Boolean))];
  openDialog({
    title: `Zahlung – Zekât ${year.label}`,
    html: `
      ${year.due > 0 ? `<p class="muted small" style="margin:0">Noch offen: <strong>${fmt(Math.max(0, year.remaining))}</strong></p>` : ''}
      <fieldset>
        <legend>Art</legend>
        <label class="radio"><input type="radio" name="kind" value="zekat" checked> Zekât</label>
        <label class="radio"><input type="radio" name="kind" value="fitre"> Fitre</label>
        <label class="radio"><input type="radio" name="kind" value="sadaka"> Sadaka (freiwillige Spende)</label>
      </fieldset>
      <div class="row2">
        ${amountInput(year.remaining > 0 ? year.remaining : null)}
        <label>Datum <input type="date" name="date" required value="${todayIso()}"></label>
      </div>
      <label>An wen? <input name="recipient" list="recipList" maxlength="120" placeholder="z. B. Moschee, Verwandte, Hilfsorganisation"></label>
      <datalist id="recipList">${recipients.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>
      <label>Notiz <input name="note" maxlength="200" placeholder="optional, z. B. bar übergeben, Überweisung"></label>
      ${filePicker('Beleg / Quittung (optional)')}
      <label class="check"><input type="checkbox" name="book" checked> Als Ausgabe in diesem Monat buchen (Spenden & Zekât)</label>
      <div class="hint" id="zAfter"></div>`,
    onOpen: (body) => {
      const update = () => {
        const kind = $('[name=kind]:checked', body).value;
        const amt = parseAmount($('[name=amount]', body).value);
        $('#zAfter', body).innerHTML = kind === 'zekat' && year.due > 0 && amt
          ? `Danach noch offen: <strong>${fmt(Math.max(0, year.remaining - amt))}</strong>`
          : kind !== 'zekat' ? 'Fitre und Sadaka werden dokumentiert, zählen aber nicht gegen die Zekât-Summe.' : '';
      };
      body.addEventListener('input', update); body.addEventListener('change', update); update();
    },
    onSave: async (d) => {
      const { id } = await api('POST', `/api/zakat/years/${year.id}/payments`, d);
      await uploadPending('zakat_payment', id);
    },
  });
}

// Fotos vor dem Hochladen verkleinern (spart Platz), PDFs unverändert
async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.type === 'image/heic' || file.size < 1_000_000) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    return blob ? new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
  } catch { return file; }
}
async function uploadFile(type, id, original) {
  const file = await shrinkImage(original);
  if (file.size > 8 * 1024 * 1024) throw new Error(`${original.name}: zu groß (max. 8 MB).`);
  if (window.Cloud?.enabled) return Cloud.upload(type, id, file);
  const res = await fetch(`/api/attachments?type=${type}&id=${id}`, {
    method: 'POST', credentials: 'same-origin',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
    body: file,
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Upload fehlgeschlagen');
}

// ---------- Belege: Fotos & PDFs an Einträgen ----------
let pendingFiles = [];   // ausgewählte Dateien für einen Eintrag, der erst beim Speichern angelegt wird
let attChanged = false;  // Belege wurden geändert -> Listen beim Schließen neu laden

const pickButtons = (cls) => `
  <label class="btn small att-btn">📷 Foto aufnehmen<input type="file" class="${cls}" accept="image/*" capture="environment" hidden></label>
  <label class="btn small att-btn">🖼️ Galerie / PDF<input type="file" class="${cls}" accept="image/*,application/pdf" multiple hidden></label>`;

// Für neue Einträge: Dateien sammeln (mehrere Fotos nacheinander möglich), hochladen nach dem Speichern
function filePicker(label) {
  return `<div class="att-pick"><div class="att-label">${label}</div>
    <div class="att-thumbs" data-pending></div>
    <div class="att-buttons">${pickButtons('pick-input')}</div></div>`;
}
function setupFilePicker(root) {
  const box = $('.att-pick', root);
  if (!box) return;
  const draw = () => {
    $('[data-pending]', box).innerHTML = pendingFiles.map((f, i) => `
      <div class="att-thumb">${f.type.startsWith('image/') ? `<img src="${f.url}" alt="">` : `<span class="att-pdf">📄<small>${esc(f.name)}</small></span>`}
        <button type="button" class="att-del" data-pending-del="${i}" aria-label="Entfernen">×</button></div>`).join('');
  };
  box.redraw = draw;
  box.addEventListener('change', (e) => {
    if (!e.target.classList.contains('pick-input')) return;
    for (const f of e.target.files) { f.url = URL.createObjectURL(f); pendingFiles.push(f); }
    e.target.value = '';
    draw();
  });
  box.addEventListener('click', (e) => {
    const del = e.target.closest('[data-pending-del]');
    if (!del) return;
    pendingFiles.splice(Number(del.dataset.pendingDel), 1);
    draw();
  });
}
async function uploadPending(type, id) {
  const files = pendingFiles;
  pendingFiles = [];
  const failed = [];
  for (const f of files) {
    try { await uploadFile(type, id, f); } catch (err) { failed.push(err.message); }
  }
  if (failed.length) toast(`Gespeichert, aber ${failed.length} Beleg(e) nicht: ${failed[0]}`);
}

// Für bestehende Einträge: Belege anzeigen, sofort hinzufügen oder löschen
function attWidget(type, id, label = '', compact = false) {
  return `<div class="att ${compact ? 'compact' : ''}" data-att-type="${type}" data-att-id="${id}" data-att-label="${esc(label)}"></div>`;
}
function mountAttachments(root) {
  $$('.att[data-att-type]', root).forEach((el) => {
    drawAttachments(el);
    el.addEventListener('change', async (e) => {
      if (!e.target.classList.contains('att-input')) return;
      const files = [...e.target.files];
      e.target.value = '';
      const status = $('.att-status', el);
      let n = 0;
      for (const f of files) {
        status.textContent = `Lade hoch … ${++n}/${files.length}`;
        try { await uploadFile(el.dataset.attType, el.dataset.attId, f); }
        catch (err) { toast(err.message); }
      }
      attChanged = true;
      drawAttachments(el);
    });
    el.addEventListener('click', async (e) => {
      const del = e.target.closest('[data-file-del]');
      if (!del) return;
      e.preventDefault();
      if (!confirm('Diesen Beleg löschen?')) return;
      await api('DELETE', `/api/files/${del.dataset.fileDel}`);
      attChanged = true;
      drawAttachments(el);
    });
  });
}
async function drawAttachments(el) {
  const compact = el.classList.contains('compact');
  let list = [];
  try { list = await api('GET', `/api/attachments?type=${el.dataset.attType}&id=${el.dataset.attId}`); } catch { /* leer anzeigen */ }
  const label = el.dataset.attLabel;
  el.innerHTML = `${label ? `<div class="att-label">${esc(label)}${list.length ? ` (${list.length})` : ''}</div>` : ''}
    <div class="att-thumbs">${list.map((a) => `
      <a class="att-thumb" href="${esc(a.url || `/api/files/${a.id}`)}" target="_blank" rel="noopener" title="${esc(a.file_name)}">
        ${a.file_type.startsWith('image/') && a.file_type !== 'image/heic' ? `<img src="${esc(a.url || `/api/files/${a.id}`)}" alt="${esc(a.file_name)}" loading="lazy">`
          : `<span class="att-pdf">${a.file_type === 'application/pdf' ? '📄' : '🖼️'}<small>${esc(a.file_name)}</small></span>`}
        <button type="button" class="att-del" data-file-del="${a.id}" aria-label="Beleg löschen">×</button>
      </a>`).join('')}
      ${compact ? `<span class="att-buttons mini">
        <label class="att-mini" title="Foto aufnehmen">📷<input type="file" class="att-input" accept="image/*" capture="environment" hidden></label>
        <label class="att-mini" title="Aus Galerie oder PDF">＋<input type="file" class="att-input" accept="image/*,application/pdf" multiple hidden></label>
      </span>` : ''}
    </div>
    ${compact ? '' : `<div class="att-buttons">${pickButtons('att-input')}</div>`}
    <div class="att-status muted small"></div>`;
}

// Druckbarer Nachweis über alle Jahre (im Browser „Als PDF speichern“)
function openZakatReport(z) {
  const w = window.open('', '_blank');
  if (!w) { toast('Bitte Pop-ups für diese Seite erlauben.'); return; }
  const rows = z.years.map((y) => `
    <h2>Zekât ${esc(y.label)}</h2>
    <p>Zu geben: <b>${fmt(y.due)}</b> · Gegeben: <b>${fmt(y.paid)}</b> · Offen: <b>${fmt(Math.max(0, y.remaining))}</b>
      ${y.fitre ? ` · Fitre: ${fmt(y.fitre)}` : ''}${y.sadaka ? ` · Sadaka: ${fmt(y.sadaka)}` : ''}</p>
    ${y.calc ? `<p class="small">Berechnung: ${CALC_FIELDS.filter(([k]) => y.calc[k]).map(([k, l]) => `${l} ${fmt(y.calc[k])}`).join(' · ')}${y.calc.nisab ? ` · Nisab ${fmt(y.calc.nisab)}` : ''}</p>` : ''}
    ${y.payments.length ? `<table><thead><tr><th>Datum</th><th>Art</th><th>Empfänger</th><th>Notiz</th><th>Beleg</th><th class="r">Betrag</th></tr></thead><tbody>
      ${y.payments.slice().reverse().map((p) => `<tr><td>${fmtDate(p.date)}</td><td>${ZAKAT_KIND[p.kind]}</td><td>${esc(p.recipient)}</td>
        <td>${esc(p.note)}</td><td>${p.files ? `${p.files} Beleg${p.files === 1 ? '' : 'e'}` : '–'}</td><td class="r">${fmt(p.amount)}</td></tr>`).join('')}
    </tbody></table>` : '<p class="small">Keine Zahlungen erfasst.</p>'}`).join('');
  w.document.write(`<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Zekât-Nachweis ${esc(state.me.user.name)}</title>
    <style>body{font-family:system-ui,sans-serif;color:#111;max-width:800px;margin:2rem auto;padding:0 1rem;line-height:1.4}
    h1{margin:0 0 .2rem}h2{margin:1.6rem 0 .3rem;border-bottom:2px solid #1f6f5c;padding-bottom:.2rem}
    table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:.35rem .3rem;border-bottom:1px solid #ddd}
    th{font-size:.8rem;color:#555}.r{text-align:right;white-space:nowrap}.small{font-size:.85rem;color:#444}
    .tot{background:#eef6f3;padding:.8rem 1rem;border-radius:8px;margin-top:1rem}@media print{button{display:none}}</style></head><body>
    <button onclick="print()" style="float:right;padding:.5rem 1rem">Drucken / als PDF speichern</button>
    <h1>Zekât-Nachweis</h1>
    <div class="small">${esc(state.me.user.name)} · erstellt am ${new Date().toLocaleDateString('de-DE')}</div>
    <div class="tot">Zekât gegeben (alle Jahre): <b>${fmt(z.totals.paid)}</b> von ${fmt(z.totals.due)}
      · noch offen: <b>${fmt(z.totals.open)}</b>${z.totals.fitre ? ` · Fitre: ${fmt(z.totals.fitre)}` : ''}${z.totals.sadaka ? ` · Sadaka: ${fmt(z.totals.sadaka)}` : ''}</div>
    ${rows}</body></html>`);
  w.document.close();
}

// ---------- Vermögen (nur Übersicht) ----------
const ASSET_ICON = { bargeld: '💶', konto: '🏦', gold: '🥇', silber: '🥈', aktien: '📈', krypto: '🪙', immobilie: '🏠', auto: '🚗', sonstiges: '📦' };
const PURITY = {
  gold: [[1, '24 Karat (999)'], [0.9167, '22 Karat (916)'], [0.875, '21 Karat (875)'], [0.75, '18 Karat (750)'],
    [0.585, '14 Karat (585)'], [0.375, '9 Karat (375)'], [0.333, '8 Karat (333)']],
  silber: [[1, 'Feinsilber (999)'], [0.925, 'Sterling (925)'], [0.9, '900'], [0.835, '835'], [0.8, '800']],
};
const purityLabel = (type, v) => (PURITY[type] || []).find(([p]) => Math.abs(p - v) < 0.001)?.[1].split(' (')[0] || `${Math.round(v * 1000)}`;
const fmtG = (g) => `${g.toLocaleString('de-DE', { maximumFractionDigits: 2 })} g`;
let assetCache = null;

async function renderAssets() {
  const a = await api('GET', '/api/assets');
  assetCache = a;
  const gramsOf = (t) => a.byType.find((x) => x.type === t)?.grams;
  $('#listSummary').innerHTML = `
    ${a.assets.length ? `<div class="summary-row">
      <div><small>Vermögen gesamt</small><strong>${fmt(a.totals.total)}</strong></div>
      <div><small>davon zählt für Zekât</small><strong>${fmt(a.totals.zakatable)}</strong></div>
      ${gramsOf('gold') ? `<div><small>Gold</small><strong>${fmtG(gramsOf('gold'))}</strong></div>` : ''}
    </div>` : ''}
    <div class="price-box">
      <div>🥇 Gold (24 K): <b>${a.prices.gold != null ? fmt(a.prices.gold) + '/g' : '–'}</b>
        · 🥈 Silber: <b>${a.prices.silber != null ? fmt(a.prices.silber) + '/g' : '–'}</b></div>
      ${a.nisab ? `<div class="muted small">Nisab (85 g Gold) = ${fmt(a.nisab)}${a.totals.zakatable >= a.nisab ? ' – du liegst darüber' : ' – du liegst darunter'}</div>` : ''}
      ${a.missingPrice ? '<div class="neg small">⚠ Bitte Grammpreis eintragen, damit Gold/Silber bewertet werden.</div>' : ''}
      <div class="price-actions">
        <button type="button" class="btn small" id="editPrices">Preise ändern</button>
        ${a.assets.length ? '<button type="button" class="btn small primary" id="zakatFromAssets">🧮 Zekât damit berechnen</button>' : ''}
      </div>
    </div>`;
  $('#listEmpty').hidden = a.assets.length > 0;
  const groups = a.byType.map((t) => `
    <li class="group-head"><span>${ASSET_ICON[t.type]} ${esc(t.label)}</span><span class="num">${t.grams != null ? fmtG(t.grams) + ' · ' : ''}${fmt(t.value)}</span></li>
    ${a.assets.filter((x) => x.type === t.type).map((x) => `
      <li data-id="${x.id}">
        <div class="grow">
          <div class="title">${esc(x.name)}</div>
          <div class="meta">${x.unit === 'g' ? `${fmtG(x.amount)} · ${purityLabel(x.type, x.purity ?? 1)}` : ''}${x.unit === 'g' ? ' · ' : ''}${x.zakat ? 'zählt für Zekât' : 'keine Zekât'}${x.files ? ` · <span class="clip">📎 ${x.files}</span>` : ''}</div>
          ${x.note ? `<div class="meta">${esc(x.note)}</div>` : ''}
        </div>
        <div class="row-actions">
          <strong class="num">${x.value == null ? '<span class="neg small">Preis fehlt</span>' : fmt(x.value)}</strong>
          <button type="button" class="btn small" data-amove="${x.id}">± Eintragen</button>
        </div>
        ${delBtn(`/api/assets/${x.id}`, x.name, 'Alle Zu- und Abgänge dazu werden auch gelöscht.')}
      </li>`).join('')}`).join('');
  $('#listBody').innerHTML = groups;
  $$('#listBody li[data-id]').forEach((li) => li.addEventListener('click', (e) => {
    const x = a.assets.find((y) => y.id === Number(li.dataset.id));
    if (e.target.closest('[data-amove]')) openAssetMoveDialog(x); else openAssetDialog(x);
  }));
  $('#editPrices').addEventListener('click', () => openPriceDialog(a.prices));
  $('#zakatFromAssets')?.addEventListener('click', async () => {
    const z = await api('GET', '/api/zakat');
    zakatCache = z;
    const year = String(new Date().getFullYear());
    openZakatYearDialog(z.years.find((y) => y.label === year), { autofill: true });
  });
}

function openPriceDialog(prices) {
  const v = (n) => n != null ? String(n).replace('.', ',') : '';
  openDialog({
    title: 'Aktuelle Grammpreise',
    html: `
      <label>Goldpreis pro Gramm, 24 Karat (€) <input name="gold" inputmode="decimal" value="${v(prices.gold)}" placeholder="z. B. 95,50"></label>
      <label>Silberpreis pro Gramm, Feinsilber (€) <input name="silver" inputmode="decimal" value="${v(prices.silber)}" placeholder="z. B. 1,05"></label>
      <div class="hint">Den aktuellen Preis findest du z. B. bei deiner Bank, einem Goldhändler oder Juwelier. Schmuck mit weniger Karat rechnet die App automatisch anteilig.</div>`,
    onSave: (d) => api('PUT', '/api/settings/prices', d),
  });
}

function openAssetDialog(item) {
  const isEdit = !!item;
  const types = assetCache?.types || {};
  let type = item?.type || 'konto';
  const qtyLabel = (t) => (types[t]?.unit === 'g'
    ? (isEdit && item.moves.length ? 'Anfangsmenge (g)' : 'Menge (Gramm)')
    : (isEdit && item.moves.length ? 'Anfangswert (€)' : 'Wert (€)'));
  const purityOptions = (t) => (PURITY[t] || []).map(([p, l]) =>
    `<option value="${p}" ${Math.abs((item?.purity ?? (t === 'gold' ? 0.9167 : 1)) - p) < 0.001 ? 'selected' : ''}>${l}</option>`).join('');
  openDialog({
    title: isEdit ? item.name : 'Vermögen hinzufügen',
    html: `
      <label>Art <select name="type">${Object.entries(types).map(([k, t]) =>
        `<option value="${k}" ${k === type ? 'selected' : ''}>${ASSET_ICON[k]} ${t.label}</option>`).join('')}</select></label>
      <label>Bezeichnung <input name="name" required maxlength="120" value="${esc(item?.name ?? '')}" placeholder="z. B. Sparkasse Tagesgeld, Goldarmreifen"></label>
      <div class="row2">
        <label><span id="qtyLabel">${qtyLabel(type)}</span> <input name="quantity" inputmode="decimal" required value="${item ? String(item.quantity).replace('.', ',') : ''}" placeholder="0"></label>
        <label id="purityWrap" ${types[type]?.unit === 'g' ? '' : 'hidden'}>Feinheit <select name="purity">${purityOptions(type)}</select></label>
      </div>
      ${isEdit && item.moves.length ? `<div class="hint">Aktueller Stand: <b>${item.unit === 'g' ? fmtG(item.amount) : fmt(item.amount)}</b>${item.unit === 'g' && item.value != null ? ` = ${fmt(item.value)}` : ''}</div>` : ''}
      <label class="check"><input type="checkbox" name="zakat" ${(item ? item.zakat : types[type]?.zakat) ? 'checked' : ''}> Zählt für die Zekât</label>
      <div class="hint">Selbst genutztes Haus und Auto zählen normalerweise nicht. Im Zweifel bei der Gemeinde nachfragen.</div>
      <label>Notiz <input name="note" maxlength="300" value="${esc(item?.note ?? '')}" placeholder="optional, z. B. Schließfach, Depot bei …"></label>
      ${isEdit ? attWidget('asset', item.id, 'Belege (z. B. Kaufrechnung, Kontoauszug)') : filePicker('Belege (optional)')}
      ${isEdit && item.moves.length ? `<div class="subhead">Verlauf</div>
        <ul class="history">
          <li><span>Anfangsbestand</span><span class="num">${item.unit === 'g' ? fmtG(item.quantity) : fmt(item.quantity)}</span></li>
          ${item.moves.slice().reverse().map((m) => `<li>
            <span>${fmtDate(m.date)} · ${m.amount > 0 ? 'Zugang' : 'Abgang'}${m.note ? ' · ' + esc(m.note) : ''}</span>
            <span class="num ${m.amount > 0 ? 'pos' : 'neg'}">${m.amount > 0 ? '+' : '−'}${item.unit === 'g' ? fmtG(Math.abs(m.amount)) : fmt(Math.abs(m.amount))}
              <button type="button" class="x-btn" data-amdel="${m.id}" aria-label="Eintrag löschen">×</button></span>
          </li>`).join('')}
        </ul>` : ''}`,
    onOpen: (body) => {
      const sel = $('[name=type]', body);
      sel.addEventListener('change', () => {
        type = sel.value;
        $('#qtyLabel', body).textContent = qtyLabel(type);
        $('#purityWrap', body).hidden = types[type]?.unit !== 'g';
        $('[name=purity]', body).innerHTML = purityOptions(type);
        if (!isEdit) $('[name=zakat]', body).checked = !!types[type]?.zakat;
      });
      body.addEventListener('click', async (e) => {
        const del = e.target.closest('[data-amdel]');
        if (!del || !confirm('Diesen Eintrag löschen?')) return;
        await api('DELETE', `/api/asset-moves/${del.dataset.amdel}`);
        del.closest('li').remove(); attChanged = true;
      });
    },
    onSave: async (d) => {
      if (types[d.type]?.unit !== 'g') delete d.purity;
      if (isEdit) return api('PUT', `/api/assets/${item.id}`, d);
      const { id } = await api('POST', '/api/assets', d);
      await uploadPending('asset', id);
    },
    onDelete: isEdit && (() => api('DELETE', `/api/assets/${item.id}`)),
  });
}

function openAssetMoveDialog(asset) {
  const g = asset.unit === 'g';
  const show = (n) => (g ? fmtG(n) : fmt(n));
  openDialog({
    title: `${ASSET_ICON[asset.type]} ${asset.name}`,
    html: `
      <p class="muted small" style="margin:0">Aktuell: <strong>${show(asset.amount)}</strong>${g && asset.value != null ? ` = ${fmt(asset.value)}` : ''}</p>
      <fieldset>
        <legend>Was ist passiert?</legend>
        <label class="radio"><input type="radio" name="direction" value="zugang" checked> Dazugekommen ${g ? '(z. B. gekauft, geschenkt bekommen)' : '(z. B. eingezahlt, gespart)'}</label>
        <label class="radio"><input type="radio" name="direction" value="abgang"> Weggegangen ${g ? '(z. B. verkauft, verschenkt)' : '(z. B. abgehoben, ausgegeben)'}</label>
        <label class="radio"><input type="radio" name="direction" value="stand"> Neuen Stand eintragen ${g ? '(z. B. nachgewogen)' : '(z. B. laut Kontoauszug)'}</label>
      </fieldset>
      <div class="row2">
        <label><span id="mvLabel">${g ? 'Menge (g)' : 'Betrag (€)'}</span> <input name="amount" inputmode="decimal" required placeholder="0"></label>
        <label>Datum <input type="date" name="date" required value="${todayIso()}"></label>
      </div>
      <label>Notiz <input name="note" maxlength="200" placeholder="optional, z. B. Hochzeitsgeschenk, Sparplan"></label>
      <div class="hint" id="mvAfter"></div>`,
    onOpen: (body) => {
      const update = () => {
        const dir = $('[name=direction]:checked', body).value;
        const amt = parseAmount($('[name=amount]', body).value);
        $('#mvLabel', body).textContent = dir === 'stand' ? (g ? 'Neuer Stand (g)' : 'Neuer Stand (€)') : (g ? 'Menge (g)' : 'Betrag (€)');
        const after = dir === 'stand' ? amt : dir === 'abgang' ? asset.amount - amt : asset.amount + amt;
        $('#mvAfter', body).innerHTML = amt ? `Danach: <strong>${show(Math.max(0, after))}</strong>` : '';
      };
      body.addEventListener('input', update); body.addEventListener('change', update); update();
    },
    onSave: async (d) => {
      if (d.direction === 'stand') {
        const delta = Math.round((parseAmount(d.amount) - asset.amount) * 100) / 100;
        if (!delta) return;
        d = { ...d, direction: delta > 0 ? 'zugang' : 'abgang', amount: String(Math.abs(delta)), note: d.note || 'Stand angepasst' };
      }
      await api('POST', `/api/assets/${asset.id}/moves`, d);
    },
  });
}

boot();
