'use strict';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
const fmt = (n) => eur.format(n || 0);
const INTERVAL_LABEL = { 1: 'monatlich', 3: 'vierteljährlich', 6: 'halbjährlich', 12: 'jährlich' };

const state = {
  me: null,
  meta: { categories: [], intervals: [] },
  month: new Date().toISOString().slice(0, 7),
  tab: 'overview',
};

// ---------- API ----------
async function api(method, url, body) {
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
  return new Date(y, mo - 1, 1).toLocaleDateString('de-DE', { month: 'long', year: 'numeric' });
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
  } catch (err) { $('#authError').textContent = err.message; }
});
$('#registerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const join = f.get('mode') === 'join';
  try {
    await api('POST', '/api/register', {
      name: f.get('name'), email: f.get('email'), password: f.get('password'),
      inviteCode: join ? f.get('inviteCode') : '', householdName: join ? '' : f.get('householdName'),
    });
    e.target.reset();
    history.replaceState(null, '', '/');
    state.tab = 'plan';
    await boot();
    toast('Willkommen! Trag zuerst dein Einkommen und deine Fixkosten ein.');
  } catch (err) { $('#authError').textContent = err.message; }
});

// ---------- Navigation ----------
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
function switchTab(tab) {
  state.tab = tab;
  $$('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== tab; });
  render();
  window.scrollTo(0, 0);
}
$('#prevMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, -1); render(); });
$('#nextMonth').addEventListener('click', () => { state.month = shiftMonth(state.month, 1); render(); });

async function boot() {
  try {
    const [me, meta] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/meta')]);
    state.me = me; state.meta = meta;
  } catch { showAuth(); return; }
  $('#auth').hidden = true;
  $('#app').hidden = false;
  $('#hhName').textContent = state.me.household.name;
  $('#hello').textContent = `Hallo ${state.me.user.name}`;
  switchTab(state.tab);
}

async function render() {
  $('#monthLabel').textContent = monthLabel(state.month);
  try {
    if (state.tab === 'overview') await renderOverview();
    if (state.tab === 'plan') await renderPlan();
    if (state.tab === 'entries') await renderEntries();
    if (state.tab === 'household') await renderHousehold();
    if (state.tab === 'account') renderAccount();
  } catch (err) { toast(err.message); }
}

// ---------- Übersicht ----------
async function renderOverview() {
  const s = await api('GET', `/api/summary?month=${state.month}`);
  const avail = $('#available');
  avail.textContent = fmt(s.available);
  avail.className = 'hero-amount ' + (s.available < 0 ? 'neg' : '');
  $('#plannedHint').textContent = `Geplant ohne Zusatzbuchungen: ${fmt(s.plannedAvailable)}`;
  $('#sIncome').textContent = fmt(s.income);
  $('#sFixed').textContent = fmt(s.fixedTotal);
  $('#sMore').textContent = fmt(s.extraMore);
  $('#sLess').textContent = fmt(s.extraLess);
  $('#sAvail').textContent = fmt(s.available);
  $('#sAvail').className = 'total ' + (s.available < 0 ? 'neg' : 'pos');

  const max = Math.max(1, ...s.categories.map((c) => Math.max(c.total, c.planned)));
  $('#catEmpty').hidden = s.categories.length > 0;
  $('#catList').innerHTML = s.categories.map((c) => {
    const plannedW = (Math.min(c.planned, c.total) / max) * 100;
    const extraW = (Math.max(0, c.extra) / max) * 100;
    let sub = `Geplant ${fmt(c.planned)}`;
    if (c.extra > 0) sub += ` · <span class="neg">+${fmt(c.extra)} mehr</span>`;
    if (c.extra < 0) sub += ` · <span class="pos">${fmt(-c.extra)} weniger</span>`;
    return `<div class="cat-row">
      <div class="top"><span>${esc(c.name)}</span><strong class="num">${fmt(c.total)}</strong></div>
      <div class="bar"><i style="width:${plannedW}%"></i><i class="extra" style="width:${extraW}%"></i></div>
      <div class="sub">${sub}</div>
    </div>`;
  }).join('');
}
$$('[data-quick]').forEach((b) => b.addEventListener('click', () => openEntryDialog({ kind: b.dataset.quick })));

// ---------- Plan ----------
async function renderPlan() {
  const [incomes, fixed] = await Promise.all([api('GET', '/api/incomes'), api('GET', '/api/fixed')]);

  $('#incomeList').innerHTML = incomes.length ? incomes.map((i) => `
    <li data-id="${i.id}">
      <div class="main"><div class="title">${esc(i.name)}</div><div class="meta">${INTERVAL_LABEL[i.interval]}</div></div>
      <div class="right num">${fmt(i.amount)}${i.interval > 1 ? `<div class="meta">${fmt(i.amount / i.interval)} / Monat</div>` : ''}</div>
    </li>`).join('') : '<li class="muted small">Noch kein Einkommen eingetragen.</li>';
  $('#incomeTotal').textContent = fmt(incomes.reduce((s, i) => s + i.amount / i.interval, 0));
  $$('#incomeList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openIncomeDialog(incomes.find((i) => i.id === Number(li.dataset.id)))));

  const groups = {};
  for (const f of fixed) (groups[f.category] ||= []).push(f);
  const monthly = (f) => (f.amount / f.interval) * (f.share / 100);
  $('#fixedList').innerHTML = fixed.length ? Object.entries(groups).map(([cat, items]) => `
    <div class="group-title">${esc(cat)}</div>
    <ul class="list">${items.map((f) => `
      <li data-id="${f.id}">
        <div class="main">
          <div class="title">${esc(f.name)}</div>
          <div class="meta">${fmt(f.amount)} ${INTERVAL_LABEL[f.interval]}${f.share < 100 ? ` · dein Anteil ${f.share.toLocaleString('de-DE')} %` : ''}</div>
        </div>
        <div class="right num">${fmt(monthly(f))}<div class="meta">/ Monat</div></div>
      </li>`).join('')}
    </ul>`).join('') : '<p class="muted small empty">Noch keine Fixkosten eingetragen.</p>';
  $('#fixedTotal').textContent = fmt(fixed.reduce((s, f) => s + monthly(f), 0));
  $$('#fixedList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openFixedDialog(fixed.find((f) => f.id === Number(li.dataset.id)))));
}
$('#addIncome').addEventListener('click', () => openIncomeDialog());
$('#addFixed').addEventListener('click', () => openFixedDialog());

// ---------- Buchungen ----------
async function renderEntries() {
  const entries = await api('GET', `/api/entries?month=${state.month}`);
  $('#entryEmpty').hidden = entries.length > 0;
  $('#entryList').innerHTML = entries.map((e) => `
    <li data-id="${e.id}">
      <div class="main">
        <div class="title">${esc(e.note || e.category)}</div>
        <div class="meta">${new Date(e.date + 'T00:00').toLocaleDateString('de-DE')} · ${esc(e.category)}</div>
      </div>
      <div class="right">
        <div class="num ${e.kind === 'mehr' ? 'neg' : 'pos'}">${e.kind === 'mehr' ? '−' : '+'}${fmt(e.amount)}</div>
        <span class="pill ${e.kind}">${e.kind === 'mehr' ? 'mehr verbraucht' : 'weniger verbraucht'}</span>
      </div>
    </li>`).join('');
  $$('#entryList li[data-id]').forEach((li) => li.addEventListener('click', () =>
    openEntryDialog(entries.find((e) => e.id === Number(li.dataset.id)))));
}
$('#addEntry').addEventListener('click', () => openEntryDialog({ kind: 'mehr' }));

// ---------- Haushalt ----------
async function renderHousehold() {
  const h = await api('GET', `/api/household?month=${state.month}`);
  const block = (name, m, cls = '') => `<div class="hh-member ${cls}">
    <div class="hh-head"><strong>${name}</strong>
      <strong class="num ${m.available < 0 ? 'neg' : 'pos'}">${fmt(m.available)}</strong></div>
    <dl class="calc small">
      <dt>Einkommen</dt><dd>${fmt(m.income)}</dd>
      <dt>Fixkosten &amp; Budgets</dt><dd>${fmt(m.fixedTotal)}</dd>
      <dt>Zusätzlich (netto)</dt><dd>${fmt(m.extraMore - m.extraLess)}</dd>
    </dl>
  </div>`;
  $('#hhTable').innerHTML =
    h.members.map((m) => block(esc(m.name) + (m.isMe ? ' (ich)' : ''), m)).join('') +
    (h.members.length > 1 ? block('Gemeinsam', h.total, 'sum') : '');
  $('#inviteCode').textContent = state.me.household.inviteCode;
}
$('#copyInvite').addEventListener('click', async () => {
  const link = `${location.origin}/?code=${state.me.household.inviteCode}`;
  try { await navigator.clipboard.writeText(link); toast('Einladungslink kopiert'); }
  catch { toast(`Code: ${state.me.household.inviteCode}`); }
});

// ---------- Konto ----------
function renderAccount() {
  $('#accountInfo').textContent = `${state.me.user.name} · ${state.me.user.email} · Haushalt „${state.me.household.name}“ (${state.me.members.map((m) => m.name).join(', ')})`;
}
$('#pwForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await api('POST', '/api/password', { oldPassword: f.get('oldPassword'), newPassword: f.get('newPassword') });
    e.target.reset(); toast('Passwort geändert');
  } catch (err) { toast(err.message); }
});
$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  state.tab = 'overview';
  showAuth();
});

// ---------- Dialoge ----------
const dlg = $('#dlg');
let dlgHandlers = null;
function openDialog({ title, html, onSave, onDelete }) {
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  $('#dlgError').textContent = '';
  $('#dlgDelete').hidden = !onDelete;
  dlgHandlers = { onSave, onDelete };
  dlg.showModal();
  const first = $('#dlgBody input, #dlgBody select');
  if (first && window.matchMedia('(pointer: fine)').matches) first.focus();
}
$('#dlgCancel').addEventListener('click', () => dlg.close());
$('#dlgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await dlgHandlers.onSave(Object.fromEntries(new FormData(e.target)));
    dlg.close(); render();
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
      <div class="row2">${amountInput(item?.amount)}${intervalSelect(item?.interval)}</div>`,
    onSave: (d) => item ? api('PUT', `/api/incomes/${item.id}`, d) : api('POST', '/api/incomes', d),
    onDelete: item && (() => api('DELETE', `/api/incomes/${item.id}`)),
  });
}

function openFixedDialog(item) {
  openDialog({
    title: item ? 'Fixkosten bearbeiten' : 'Fixkosten / Budget hinzufügen',
    html: `
      <label>Bezeichnung <input name="name" required maxlength="120" value="${esc(item?.name)}" placeholder="z. B. Hausabtrag, Einkaufen, Kfz-Versicherung"></label>
      ${categorySelect(item?.category)}
      <div class="row2">${amountInput(item?.amount)}${intervalSelect(item?.interval)}</div>
      <label>Mein Anteil (%) <input name="share" inputmode="decimal" value="${item?.share ?? 100}"></label>
      <div class="hint">Bei gemeinsamen Kosten (z. B. Hausabtrag halbe-halbe) den Gesamtbetrag eintragen und 50 % wählen.</div>`,
    onSave: (d) => item ? api('PUT', `/api/fixed/${item.id}`, d) : api('POST', '/api/fixed', d),
    onDelete: item && (() => api('DELETE', `/api/fixed/${item.id}`)),
  });
}

function openEntryDialog(item = {}) {
  const isEdit = !!item.id;
  const kind = item.kind || 'mehr';
  openDialog({
    title: isEdit ? 'Buchung bearbeiten' : (kind === 'mehr' ? 'Mehr verbraucht' : 'Weniger verbraucht'),
    html: `
      <fieldset>
        <legend>Art</legend>
        <label class="radio"><input type="radio" name="kind" value="mehr" ${kind === 'mehr' ? 'checked' : ''}> Mehr verbraucht (zusätzliche Ausgabe)</label>
        <label class="radio"><input type="radio" name="kind" value="weniger" ${kind === 'weniger' ? 'checked' : ''}> Weniger verbraucht / Extra-Einnahme</label>
      </fieldset>
      ${amountInput(item.amount)}
      ${categorySelect(item.category || 'Einkaufen & Lebensmittel')}
      <label>Datum <input type="date" name="date" required value="${item.date || todayInMonth(state.month)}"></label>
      <label>Notiz <input name="note" maxlength="200" value="${esc(item.note)}" placeholder="z. B. Reifenwechsel, Geburtstagsgeschenk"></label>`,
    onSave: (d) => isEdit ? api('PUT', `/api/entries/${item.id}`, d) : api('POST', '/api/entries', d),
    onDelete: isEdit && (() => api('DELETE', `/api/entries/${item.id}`)),
  });
}

boot();
