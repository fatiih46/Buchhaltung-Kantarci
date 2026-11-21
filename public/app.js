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
  list: 'schuld',
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
    if (state.tab === 'lists') await renderLists();
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

  renderTeaser(s);
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
          <div class="title">${esc(f.name)} ${f.kind === 'budget' ? '<span class="pill budget">Budget</span>' : ''}</div>
          <div class="meta">${fmt(f.amount)} ${INTERVAL_LABEL[f.interval]}${f.share < 100 ? ` · dein Anteil ${f.share.toLocaleString('de-DE')} %` : ''}</div>
        </div>
        <div class="right num">${fmt(monthly(f))}<div class="meta">/ Monat</div></div>
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

// ---------- Ausgaben: Liste ----------
state.sub = 'list';
$$('[data-sub]').forEach((b) => b.addEventListener('click', () => { state.sub = b.dataset.sub; render(); }));
async function renderEntries() {
  $$('[data-sub]').forEach((b) => b.classList.toggle('active', b.dataset.sub === state.sub));
  $$('[data-subview]').forEach((v) => { v.hidden = v.dataset.subview !== state.sub; });
  if (state.sub === 'stats') return renderStats();
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
        <div class="meta">${new Date(e.date + 'T00:00').toLocaleDateString('de-DE')} · ${esc(e.category)}</div>
      </div>
      <div class="right">
        <div class="num ${e.kind === 'mehr' ? 'neg' : 'pos'}">${e.kind === 'mehr' ? '−' : '+'}${fmt(e.amount)}</div>
        ${e.kind === 'weniger' ? '<span class="pill weniger">Einnahme</span>' : ''}
      </div>
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
function openDialog({ title, html, onSave, onDelete, onOpen }) {
  $('#dlgTitle').textContent = title;
  $('#dlgBody').innerHTML = html;
  if (onOpen) onOpen($('#dlgBody'));
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
  const kind = item?.kind || 'fix';
  openDialog({
    title: item ? 'Bearbeiten' : 'Fixkosten / Budget hinzufügen',
    html: `
      <fieldset>
        <legend>Art</legend>
        <label class="radio"><input type="radio" name="kind" value="fix" ${kind === 'fix' ? 'checked' : ''}> Fixkosten – jeden Monat gleich</label>
        <label class="radio"><input type="radio" name="kind" value="budget" ${kind === 'budget' ? 'checked' : ''}> Budget – Obergrenze für variable Ausgaben</label>
      </fieldset>
      <label>Bezeichnung <input name="name" required maxlength="120" value="${esc(item?.name)}" placeholder="z. B. Hausabtrag, Einkaufen, Kfz-Versicherung"></label>
      ${categorySelect(item?.category)}
      <div class="row2">${amountInput(item?.amount)}${intervalSelect(item?.interval)}</div>
      <label>Mein Anteil (%) <input name="share" inputmode="decimal" value="${item?.share ?? 100}"></label>
      <div class="hint">Bei gemeinsamen Kosten (z. B. Hausabtrag halbe-halbe) den Gesamtbetrag eintragen und 50 % wählen.
        Bei einem Budget werden deine Ausgaben derselben Kategorie damit verrechnet.</div>`,
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
      <label>Notiz <input name="note" maxlength="200" value="${esc(item.note)}" placeholder="z. B. Winterjacke, Reifenwechsel"></label>`,
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
    },
    onSave: (d) => isEdit ? api('PUT', `/api/entries/${item.id}`, d) : api('POST', '/api/entries', d),
    onDelete: isEdit && (() => api('DELETE', `/api/entries/${item.id}`)),
  });
}

// ---------- Schulden, Forderungen, Geburtstage ----------
const fmtDate = (iso) => iso ? new Date(iso + 'T00:00').toLocaleDateString('de-DE') : '';
const todayIso = () => todayInMonth(new Date().toISOString().slice(0, 7));
const GIFT_STATUS = { offen: 'noch offen', idee: 'Idee', gekauft: 'gekauft', verschenkt: 'verschenkt' };
const inDays = (n) => n === 0 ? 'heute' : n === 1 ? 'morgen' : `in ${n} Tagen`;

function renderTeaser(s) {
  const show = s.debtsOpen > 0 || s.receivablesOpen > 0 || s.upcomingBirthdays.length > 0;
  $('#listsTeaser').hidden = !show;
  if (!show) return;
  $('#teaserCalc').innerHTML =
    (s.debtsOpen > 0 ? `<dt>Offene Schulden</dt><dd class="neg">${fmt(s.debtsOpen)}</dd>` : '') +
    (s.receivablesOpen > 0 ? `<dt>Bekomme ich zurück</dt><dd class="pos">${fmt(s.receivablesOpen)}</dd>` : '');
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
  switchTab('lists');
});

$$('[data-list]').forEach((b) => b.addEventListener('click', () => { state.list = b.dataset.list; renderLists(); }));
$('#listAdd').addEventListener('click', () => state.list === 'geburtstag' ? openBirthdayDialog() : openDebtDialog({ direction: state.list }));

const LIST_TEXT = {
  schuld: { title: 'Meine Schulden', add: 'Schuld', hint: 'Was du noch zurückzahlen musst – Kredite, Ratenkäufe, geliehenes Geld. Mit „Zahlung“ trägst du jede Rückzahlung ein, der offene Betrag rechnet sich selbst.', empty: 'Keine Schulden eingetragen. 🎉' },
  forderung: { title: 'Bekomme ich zurück', add: 'Forderung', hint: 'Geld, das du verliehen hast oder das dir noch jemand schuldet. Mit „Erhalten“ trägst du Rückzahlungen ein.', empty: 'Niemand schuldet dir etwas.' },
  geburtstag: { title: 'Geburtstage & Geschenke', add: 'Geburtstag', hint: 'Sortiert nach dem nächsten Geburtstag. Tippe auf eine Person, um das Geschenk für dieses Jahr zu planen.', empty: 'Noch keine Geburtstage eingetragen.' },
};

async function renderLists() {
  $$('[data-list]').forEach((b) => b.classList.toggle('active', b.dataset.list === state.list));
  const t = LIST_TEXT[state.list];
  $('#listTitle').textContent = t.title;
  $('#listHint').textContent = t.hint;
  $('#listEmpty').textContent = t.empty;
  if (state.list === 'geburtstag') return renderBirthdays();

  const all = await api('GET', '/api/debts');
  const debts = all.filter((d) => d.direction === state.list).sort((a, b) => a.done - b.done);
  const isDebt = state.list === 'schuld';
  const open = debts.reduce((s, d) => s + Math.max(0, d.remaining), 0);
  const paid = debts.reduce((s, d) => s + d.paid, 0);
  const rates = debts.filter((d) => !d.done).reduce((s, d) => s + d.monthly_rate, 0);
  $('#listSummary').innerHTML = debts.length ? `<div class="summary-row">
      <div><small>Noch offen</small><strong class="${isDebt ? 'neg' : 'pos'}">${fmt(open)}</strong></div>
      <div><small>${isDebt ? 'Schon zurückgezahlt' : 'Schon erhalten'}</small><strong>${fmt(paid)}</strong></div>
      ${rates > 0 ? `<div><small>Raten / Monat</small><strong>${fmt(rates)}</strong></div>` : ''}
    </div>` : '';
  $('#listEmpty').hidden = debts.length > 0;
  $('#listBody').innerHTML = debts.map((d) => {
    const pct = Math.min(100, (d.paid / d.amount) * 100);
    const meta = [
      d.monthly_rate > 0 && !d.done ? `Rate ${fmt(d.monthly_rate)}/Monat${d.monthsLeft ? ` · noch ca. ${d.monthsLeft} Monat${d.monthsLeft === 1 ? '' : 'e'}` : ''}` : '',
      d.due_date && !d.done ? `fällig ${fmtDate(d.due_date)}` : '',
      d.in_budget && !d.done ? 'zählt bei Fixkosten' : '',
    ].filter(Boolean).join(' · ');
    return `<li data-id="${d.id}">
      <div class="grow">
        <div class="title">${esc(d.person)}${d.title ? ` <span class="muted">– ${esc(d.title)}</span>` : ''}</div>
        <div class="meta">${d.done ? 'vollständig ' + (isDebt ? 'zurückgezahlt' : 'erhalten') : `offen <strong class="num">${fmt(d.remaining)}</strong> von ${fmt(d.amount)}`}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        <div class="progress"><i style="width:${pct}%"></i></div>
      </div>
      <div class="row-actions">
        ${d.done ? '<span class="pill done">erledigt ✓</span>' : `<button type="button" class="btn small" data-pay="${d.id}">${isDebt ? '＋ Zahlung' : '＋ Erhalten'}</button>`}
      </div>
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
        ${amountInput(item.amount, 'Gesamtbetrag (€)')}
        <label>Rate / Monat (€) <input name="monthly_rate" inputmode="decimal" value="${item.monthly_rate ? String(item.monthly_rate).replace('.', ',') : ''}" placeholder="optional"></label>
      </div>
      <div class="row2">
        <label>Seit <input type="date" name="start_date" value="${esc(v('start_date'))}"></label>
        <label>Fällig bis <input type="date" name="due_date" value="${esc(v('due_date'))}"></label>
      </div>
      ${isDebt ? `<label class="check"><input type="checkbox" name="in_budget" ${item.in_budget ? 'checked' : ''}> Monatliche Rate bei Fixkosten mitrechnen</label>
      <div class="hint">Nur anhaken, wenn du die Rate nicht schon unter „Plan → Fixkosten“ eingetragen hast.</div>` : ''}
      <label>Notiz <input name="note" maxlength="300" value="${esc(v('note'))}"></label>
      ${isEdit && item.payments.length ? `<div class="subhead">${isDebt ? 'Zahlungen' : 'Erhalten'} (${fmt(item.paid)})</div>
        <ul class="history">${item.payments.map((p) => `<li>
          <span>${fmtDate(p.date)}${p.note ? ' · ' + esc(p.note) : ''}${p.entry_id ? ' · <span class="muted">gebucht</span>' : ''}</span>
          <span class="num">${fmt(p.amount)} <button type="button" class="x-btn" data-del-payment="${p.id}" aria-label="Zahlung löschen">×</button></span>
        </li>`).join('')}</ul>` : ''}`,
    onOpen: (body) => body.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-del-payment]');
      if (!btn || !confirm('Diese Zahlung löschen?')) return;
      await api('DELETE', `/api/payments/${btn.dataset.delPayment}`);
      btn.closest('li').remove();
      render();
    }),
    onSave: (d) => isEdit ? api('PUT', `/api/debts/${item.id}`, d) : api('POST', '/api/debts', d),
    onDelete: isEdit && (() => api('DELETE', `/api/debts/${item.id}`)),
  });
}

function openPaymentDialog(debt) {
  const isDebt = debt.direction === 'schuld';
  const suggest = debt.monthly_rate > 0 ? Math.min(debt.monthly_rate, debt.remaining) : null;
  openDialog({
    title: isDebt ? `Zahlung an ${debt.person}` : `Erhalten von ${debt.person}`,
    html: `
      <p class="muted small" style="margin:0">Noch offen: <strong>${fmt(debt.remaining)}</strong></p>
      <div class="row2">
        ${amountInput(suggest)}
        <label>Datum <input type="date" name="date" required value="${todayIso()}"></label>
      </div>
      <label>Notiz <input name="note" maxlength="200" placeholder="optional"></label>
      <label class="check"><input type="checkbox" name="book" ${isDebt && debt.in_budget ? '' : 'checked'}>
        ${isDebt ? 'Als Ausgabe in diesem Monat buchen' : 'Als Einnahme in diesem Monat buchen'}</label>
      ${isDebt ? `<div class="hint">${debt.in_budget ? 'Die Rate zählt schon bei den Fixkosten – nur für Sonderzahlungen anhaken.' : 'Nicht anhaken, wenn diese Rate schon in deinen Fixkosten steckt.'}</div>` : ''}`,
    onSave: (d) => api('POST', `/api/debts/${debt.id}/payments`, d),
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

boot();
