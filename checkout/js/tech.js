// Tech page: the form the QR code opens. Take / return / request parts.
import { api, apiBase } from './api.js';
import { esc, fmtQty, fmtDateTime, uuid, store, toast, confirmDialog, compressPhoto, initials, normalizePart } from './util.js';

const app = document.getElementById('app');
const EDIT_WINDOW_MS = 24 * 3600 * 1000;
const MAX_MINE = 20;

const newLine = () => ({ id: uuid(), qty: 1, text: '' });

const state = {
  key: null,
  boot: null,          // { techs, parts } from the server (cached on the device)
  offline: false,
  tech: null,          // { id, name, truck }
  pickingTech: false,
  techQuery: '',
  type: 'take',
  lines: [newLine()],
  dest: 'van',
  job: '',
  neededBy: '',
  note: '',
  photo: null,         // File chosen for this submission
  photoKey: null,      // existing photo when editing
  editing: null,       // { id, editToken }
  submitting: false,
  screen: 'form',      // form | success
  done: null,          // what the success screen shows
};

/* ---------------- boot ---------------- */

async function init() {
  const params = new URLSearchParams(location.search);
  if (params.get('k')) store.set('teamKey', params.get('k').trim());
  if (params.has('k') || params.has('api')) {
    // ?api= is consumed by api.js; drop both from the URL so bookmarks are clean.
    apiBase(); // remembers ?api= on the device
    history.replaceState(null, '', location.pathname);
  }
  state.key = store.get('teamKey');
  if (!state.key) { renderNoKey(); return; }
  state.boot = store.get('boot');
  state.tech = store.get('tech');
  render();
  await refreshBoot();
  flushQueue();
  window.addEventListener('online', () => { refreshBoot(); flushQueue(); });
}

async function refreshBoot() {
  try {
    const b = await api('/v1/bootstrap', { key: state.key });
    state.boot = { techs: b.techs, parts: b.parts };
    store.set('boot', state.boot);
    state.offline = false;
  } catch (e) {
    if (e.status === 401) { store.del('teamKey'); state.key = null; renderBadKey(); return; }
    state.offline = !!e.network;
  }
  if (state.tech && state.boot) {
    const t = state.boot.techs.find(t => t.id === state.tech.id);
    if (t) { state.tech = t; store.set('tech', t); } else { state.tech = null; store.del('tech'); }
  }
  render();
}

/* ---------------- device memory: my submissions, offline queue ---------------- */

const mine = () => store.get('mine', []);
function addMine(entry) {
  store.set('mine', [entry, ...mine().filter(m => m.id !== entry.id)].slice(0, MAX_MINE));
}
function updateMine(id, patch) {
  store.set('mine', mine().map(m => m.id === id ? { ...m, ...patch } : m));
}
function removeMine(id) { store.set('mine', mine().filter(m => m.id !== id)); }
const canEdit = (m) => !!m.editToken && Date.now() - new Date(m.createdAt).getTime() < EDIT_WINDOW_MS;

function recentJobs() {
  const jobs = [];
  for (const m of mine()) {
    if (m.payload.dest === 'job' && m.payload.job && !jobs.includes(m.payload.job)) jobs.push(m.payload.job);
    if (jobs.length >= 5) break;
  }
  return jobs;
}

async function flushQueue() {
  const q = store.get('queue', []);
  if (!q.length || !state.key) return;
  const remaining = [];
  let sent = 0;
  for (const item of q) {
    try {
      const r = await api('/v1/submissions', { method: 'POST', body: item.payload, key: state.key });
      addMine({ id: r.id, editToken: r.editToken, createdAt: r.submission.createdAt, payload: item.payload, techName: item.techName });
      sent++;
    } catch (e) {
      if (e.network) remaining.push(item);
      else toast(`A saved submission was rejected: ${e.message}`, { error: true, duration: 7000 });
    }
  }
  store.set('queue', remaining);
  if (sent) toast(sent === 1 ? 'Saved submission sent' : `${sent} saved submissions sent`);
  if (state.screen === 'form') render();
}

/* ---------------- rendering ---------------- */

const header = () => `
  <header class="hdr">
    <div class="logo">P</div>
    <div><h1>Parts Checkout</h1><span class="sub">Parts room sign-out</span></div>
  </header>`;

function renderNoKey() {
  app.innerHTML = `${header()}
    <section class="card">
      <h3>Scan the QR code</h3>
      <p class="dim">Open this page by scanning the QR code in the parts room. After the first scan the link is remembered on this phone.</p>
    </section>`;
}
function renderBadKey() {
  app.innerHTML = `${header()}
    <section class="card">
      <h3>This link is no longer valid</h3>
      <p class="dim">Scan the current QR code in the parts room to open the form again.</p>
    </section>`;
}

function summarize(p, techName) {
  const head = { take: 'TAKE', return: 'RETURN', request: 'REQUEST' }[p.type];
  const dest = p.dest === 'van' ? 'Van stock' : p.dest === 'job' ? `Job ${p.job}` : p.job || 'Other';
  const out = [`${head} — ${dest}${techName ? ' — ' + techName : ''}`];
  for (const l of p.lines) out.push(`${fmtQty(l.qty)} × ${l.partText}`);
  if (p.neededBy) out.push(`Needed by ${p.neededBy}`);
  if (p.note) out.push(`Note: ${p.note}`);
  return out.join('\n');
}
const oneLine = (p) => p.lines.map(l => `${fmtQty(l.qty)}× ${l.partText}`).join(', ');

function lineHtml(l) {
  return `
    <div class="line" data-line="${l.id}">
      <div class="stepper">
        <button type="button" data-step="-1" aria-label="Less">−</button>
        <input type="text" inputmode="decimal" data-qty value="${fmtQty(l.qty)}" aria-label="Quantity">
        <button type="button" data-step="1" aria-label="More">+</button>
      </div>
      <div class="part-wrap">
        <input type="text" data-part value="${esc(l.text)}" placeholder="Part number" autocomplete="off" autocapitalize="characters" autocorrect="off" spellcheck="false" enterkeyhint="next">
        <div class="suggest" data-suggest></div>
      </div>
      <button type="button" class="icon-btn plain" data-removeline aria-label="Remove part" ${state.lines.length === 1 ? 'style="visibility:hidden"' : ''}>✕</button>
    </div>`;
}

function techPicker() {
  const techs = state.boot?.techs || [];
  if (!state.boot) return `<div class="empty">${state.offline ? 'No connection and nothing saved yet — connect to the internet and reload.' : 'Loading…'}</div>`;
  if (!techs.length) return `<div class="empty">No technicians are set up yet. Ask the parts manager to add names in the dashboard.</div>`;
  const q = state.techQuery.trim().toLowerCase();
  const shown = q ? techs.filter(t => (t.name + ' ' + (t.truck || '')).toLowerCase().includes(q)) : techs;
  return `
    ${techs.length > 8 ? `<div class="field"><input type="search" data-tech-search placeholder="Search names" value="${esc(state.techQuery)}" autocomplete="off"></div>` : ''}
    <div class="pick-list">
      ${shown.map(t => `<button type="button" data-pick-tech="${esc(t.id)}" class="${state.tech?.id === t.id ? 'on' : ''}">${esc(t.name)}${t.truck ? `<small>Truck ${esc(t.truck)}</small>` : ''}</button>`).join('') || '<div class="empty">No match.</div>'}
    </div>
    ${state.tech ? '<button type="button" class="btn btn-sm mt" data-cancel-pick>Cancel</button>' : ''}`;
}

function whoCard() {
  const t = state.tech;
  return `
    <div class="who">
      <div class="avatar">${esc(initials(t.name))}</div>
      <div class="grow"><div class="name">${esc(t.name)}</div>${t.truck ? `<div class="dim small">Truck ${esc(t.truck)}</div>` : ''}</div>
      <button type="button" class="btn btn-sm" data-change-tech>Not you?</button>
    </div>`;
}

function photoField() {
  const label = state.type === 'return' ? 'Photo of the parts (optional)' : 'Photo (optional)';
  const has = state.photo || state.photoKey;
  return `
    <div class="field">
      <label>${label}</label>
      <div class="row">
        <label class="btn btn-sm" style="cursor:pointer">${has ? 'Change photo' : '📷 Add photo'}
          <input type="file" accept="image/*" capture="environment" data-photo hidden></label>
        ${has ? `<span class="small dim">${state.photo ? esc(state.photo.name || 'photo') : 'photo attached'}</span><button type="button" class="btn btn-sm btn-danger" data-photo-remove>Remove</button>` : ''}
      </div>
    </div>`;
}

function recentHtml() {
  const list = mine().slice(0, 8);
  if (!list.length) return '';
  return `
    <div class="section-title">Recent from this phone</div>
    <section class="card pad0">
      <div style="padding:0 16px">
      ${list.map(m => `
        <div class="list-row">
          <div class="main">
            <div class="title"><span class="badge ${m.payload.type}">${m.payload.type}</span> <span class="small dim">${esc(fmtDateTime(m.createdAt))}</span></div>
            <div class="lines-text">${esc(oneLine(m.payload))}</div>
            <div class="sub">${esc(m.payload.dest === 'van' ? 'Van stock' : m.payload.dest === 'job' ? 'Job ' + m.payload.job : m.payload.job || 'Other')}</div>
          </div>
          ${canEdit(m) ? `<div class="row"><button type="button" class="btn btn-sm" data-fix="${esc(m.id)}">Fix</button><button type="button" class="btn btn-sm btn-danger" data-del="${esc(m.id)}">Delete</button></div>` : ''}
        </div>`).join('')}
      </div>
    </section>
    <p class="small dim" style="text-align:center">Submissions can be fixed or deleted from this phone for 24 hours.</p>`;
}

function queueBanner() {
  const n = store.get('queue', []).length;
  return n ? `<div class="banner">${n === 1 ? '1 submission is' : n + ' submissions are'} saved on this phone and will send when there's a connection.</div>` : '';
}

const submitLabel = () => ({ take: 'Sign out parts', return: 'Return parts', request: 'Send request' }[state.type]);

function render() {
  if (!state.key) return;
  if (state.screen === 'success') return renderSuccess();
  const jobs = recentJobs();
  app.innerHTML = `
    ${header()}
    ${state.offline ? '<div class="banner">No connection — fill this out anyway; it will send when you\'re back online.</div>' : ''}
    ${queueBanner()}
    ${state.editing ? '<div class="banner info">Fixing an earlier submission — save to replace it.</div>' : ''}
    <section class="card">
      <h2>Who</h2>
      ${state.tech && !state.pickingTech ? whoCard() : techPicker()}
    </section>
    <section class="card">
      <h2>What</h2>
      <div class="seg">
        <button type="button" data-type="take" class="${state.type === 'take' ? 'on' : ''}">Take</button>
        <button type="button" data-type="return" class="${state.type === 'return' ? 'on' : ''}">Return</button>
        <button type="button" data-type="request" class="${state.type === 'request' ? 'on' : ''}">Request</button>
      </div>
    </section>
    <section class="card">
      <h2>${state.type === 'request' ? 'Parts needed' : 'Parts'}</h2>
      <div data-lines>${state.lines.map(lineHtml).join('')}</div>
      <button type="button" class="btn btn-sm" data-addline>+ Add another part</button>
    </section>
    <section class="card">
      <h2>For</h2>
      <div class="seg">
        <button type="button" data-dest="van" class="${state.dest === 'van' ? 'on' : ''}">Van stock</button>
        <button type="button" data-dest="job" class="${state.dest === 'job' ? 'on' : ''}">Job #</button>
        <button type="button" data-dest="other" class="${state.dest === 'other' ? 'on' : ''}">Other</button>
      </div>
      ${state.dest !== 'van' ? `
        <div class="field mt">
          <label>${state.dest === 'job' ? 'Job number' : 'Where is it going?'}</label>
          <input type="text" data-job value="${esc(state.job)}" class="${state.dest === 'job' ? 'mono' : ''}"
            placeholder="${state.dest === 'job' ? 'e.g. 49020597 or LPF301087' : 'e.g. shop, customer name'}"
            autocapitalize="characters" autocomplete="off" autocorrect="off" spellcheck="false">
          ${state.dest === 'job' && jobs.length ? `<div class="chips">${jobs.map(j => `<button type="button" class="chip ${state.job === j ? 'on' : ''}" data-chip-job="${esc(j)}">${esc(j)}</button>`).join('')}</div>` : ''}
        </div>` : ''}
      ${state.type === 'request' ? `<div class="field mt"><label>Needed by (optional)</label><input type="date" data-neededby value="${esc(state.neededBy)}"></div>` : ''}
    </section>
    <section class="card">
      ${state.type !== 'take' ? photoField() : ''}
      <div class="field" style="margin-bottom:0"><label>Note (optional)</label><textarea data-note placeholder="Anything the parts manager should know" rows="2">${esc(state.note)}</textarea></div>
    </section>
    <button type="button" class="btn btn-primary btn-xl" data-submit ${state.submitting ? 'disabled' : ''}>${state.submitting ? 'Sending…' : state.editing ? 'Save changes' : submitLabel()}</button>
    ${state.editing ? '<button type="button" class="btn btn-xl mt" data-cancel-edit>Cancel</button>' : ''}
    ${recentHtml()}`;
}

function renderSuccess() {
  const d = state.done;
  app.innerHTML = `
    ${header()}
    <section class="card success">
      <div class="check">✓</div>
      <h3>${d.queued ? 'Saved on this phone' : d.edited ? 'Submission updated' : 'Sent to the parts room'}</h3>
      <p class="dim" style="margin:0">${d.queued ? 'No connection right now — it will send automatically when you are back online.' : esc(fmtDateTime(d.createdAt))}</p>
      <div class="summary">${esc(summarize(d.payload, d.techName))}</div>
      <button type="button" class="btn btn-primary btn-xl" data-submit-another>Done</button>
      ${!d.queued ? `
        <div class="row mt" style="justify-content:center">
          <button type="button" class="btn btn-sm" data-fix="${esc(d.id)}">Fix this</button>
          <button type="button" class="btn btn-sm btn-danger" data-del="${esc(d.id)}">Delete</button>
        </div>
        <p class="small dim" style="margin-bottom:0">You can change or delete this from this phone for 24 hours.</p>` : ''}
    </section>`;
}

/* ---------------- autocomplete ---------------- */

function suggestions(text) {
  const q = normalizePart(text);
  if (!q || !state.boot) return [];
  const starts = [], contains = [];
  for (const p of state.boot.parts) {
    const n = p.number.toUpperCase();
    if (n === q) continue;
    if (n.startsWith(q)) starts.push(p);
    else if (n.includes(q) || (p.description || '').toUpperCase().includes(q)) contains.push(p);
    if (starts.length >= 6) break;
  }
  return [...starts, ...contains].slice(0, 6);
}

function showSuggestions(lineEl) {
  const input = lineEl.querySelector('[data-part]');
  const box = lineEl.querySelector('[data-suggest]');
  const list = suggestions(input.value);
  box.innerHTML = list.map(p => `
    <button type="button" data-sug="${esc(p.number)}">
      <span class="num">${esc(p.number)}</span>${p.description ? `<span class="desc">${esc(p.description)}</span>` : ''}
    </button>`).join('');
}
function hideSuggestions(lineEl) { const box = lineEl?.querySelector('[data-suggest]'); if (box) box.innerHTML = ''; }

/* ---------------- form actions ---------------- */

function resetForm({ keepTech = true } = {}) {
  state.lines = [newLine()];
  state.dest = 'van'; state.job = ''; state.neededBy = ''; state.note = '';
  state.photo = null; state.photoKey = null; state.editing = null;
  state.type = 'take';
  if (!keepTech) state.tech = null;
}

function loadForFix(m) {
  state.editing = { id: m.id, editToken: m.editToken };
  state.type = m.payload.type;
  state.lines = m.payload.lines.map(l => ({ id: uuid(), qty: l.qty, text: l.partText }));
  state.dest = m.payload.dest; state.job = m.payload.job || '';
  state.neededBy = m.payload.neededBy || ''; state.note = m.payload.note || '';
  state.photo = null; state.photoKey = m.payload.photoKey || null;
  state.screen = 'form';
  render();
  window.scrollTo({ top: 0 });
}

async function deleteMine(id) {
  const m = mine().find(x => x.id === id);
  if (!m) return;
  const yes = await confirmDialog('Delete this submission? The parts manager will no longer see it.', { okLabel: 'Delete', danger: true });
  if (!yes) return;
  try {
    await api(`/v1/submissions/${id}`, { method: 'DELETE', key: state.key, editToken: m.editToken });
    removeMine(id);
    toast('Deleted');
    if (state.editing?.id === id) resetForm();
    state.screen = 'form';
    render();
  } catch (e) { toast(e.message, { error: true }); }
}

async function submit() {
  if (!state.tech) { toast('Pick your name first', { error: true }); state.pickingTech = true; render(); window.scrollTo({ top: 0 }); return; }
  const lines = state.lines
    .map(l => ({ partText: l.text.trim().toUpperCase().replace(/\s+/g, ' '), qty: Number(String(l.qty).replace(',', '.')) }))
    .filter(l => l.partText);
  if (!lines.length) { toast('Enter at least one part number', { error: true }); app.querySelector('[data-part]')?.focus(); return; }
  const bad = lines.find(l => !(l.qty > 0));
  if (bad) { toast(`Enter a quantity for ${bad.partText}`, { error: true }); return; }
  if (state.dest === 'job' && !state.job.trim()) { toast('Enter the job number', { error: true }); app.querySelector('[data-job]')?.focus(); return; }

  const payload = {
    type: state.type, techId: state.tech.id, dest: state.dest,
    job: state.dest === 'van' ? '' : state.job.trim(),
    neededBy: state.type === 'request' && state.neededBy ? state.neededBy : null,
    note: state.note.trim(), photoKey: state.type === 'take' ? null : state.photoKey, lines,
  };
  const techName = state.tech.name;
  state.submitting = true; render();
  try {
    if (state.photo && state.type !== 'take') {
      try {
        const blob = await compressPhoto(state.photo);
        const pkey = uuid();
        await api(`/v1/photo/${pkey}`, { method: 'PUT', body: blob, key: state.key });
        payload.photoKey = pkey;
      } catch (e) {
        if (e.network) throw e;
        toast('The photo could not be uploaded — sending without it', { error: true, duration: 4000 });
      }
    }
    if (state.editing) {
      const r = await api(`/v1/submissions/${state.editing.id}`, { method: 'PUT', body: payload, key: state.key, editToken: state.editing.editToken });
      updateMine(state.editing.id, { payload });
      state.done = { id: state.editing.id, createdAt: r.submission.createdAt, payload, techName, edited: true };
    } else {
      const r = await api('/v1/submissions', { method: 'POST', body: payload, key: state.key });
      addMine({ id: r.id, editToken: r.editToken, createdAt: r.submission.createdAt, payload, techName });
      state.done = { id: r.id, createdAt: r.submission.createdAt, payload, techName };
    }
    state.screen = 'success';
    resetForm();
    refreshBoot(); // picks up newly learned part numbers for next time
  } catch (e) {
    if (e.network && !state.editing) {
      const q = store.get('queue', []);
      q.push({ tempId: uuid(), techName, payload: { ...payload, photoKey: null, createdAt: new Date().toISOString() } });
      store.set('queue', q);
      state.done = { payload, techName, queued: true };
      state.screen = 'success';
      resetForm();
    } else {
      toast(e.message, { error: true, duration: 4000 });
    }
  } finally {
    state.submitting = false;
    render();
  }
}

/* ---------------- events (delegated) ---------------- */

app.addEventListener('click', (e) => {
  const t = e.target.closest('button, label');
  if (!t) return;
  const lineEl = t.closest('[data-line]');
  const line = lineEl && state.lines.find(l => l.id === lineEl.dataset.line);

  if (t.dataset.type) { state.type = t.dataset.type; render(); return; }
  if (t.dataset.dest) { state.dest = t.dataset.dest; render(); if (state.dest !== 'van') app.querySelector('[data-job]')?.focus(); return; }
  if (t.hasAttribute('data-addline')) {
    state.lines.push(newLine()); render();
    const inputs = app.querySelectorAll('[data-part]'); inputs[inputs.length - 1]?.focus();
    return;
  }
  if (t.hasAttribute('data-removeline') && line) { state.lines = state.lines.filter(l => l !== line); if (!state.lines.length) state.lines = [newLine()]; render(); return; }
  if (t.dataset.step && line) {
    const cur = Number(String(line.qty).replace(',', '.')) || 0;
    line.qty = Math.max(1, Math.round((cur + Number(t.dataset.step)) * 1000) / 1000);
    lineEl.querySelector('[data-qty]').value = fmtQty(line.qty);
    return;
  }
  if (t.dataset.sug !== undefined && line) {
    line.text = t.dataset.sug;
    lineEl.querySelector('[data-part]').value = line.text;
    hideSuggestions(lineEl);
    return;
  }
  if (t.dataset.pickTech) {
    const tech = state.boot.techs.find(x => x.id === t.dataset.pickTech);
    if (tech) { state.tech = tech; store.set('tech', tech); state.pickingTech = false; state.techQuery = ''; render(); }
    return;
  }
  if (t.hasAttribute('data-change-tech')) { state.pickingTech = true; render(); return; }
  if (t.hasAttribute('data-cancel-pick')) { state.pickingTech = false; state.techQuery = ''; render(); return; }
  if (t.dataset.chipJob) { state.job = t.dataset.chipJob; render(); return; }
  if (t.hasAttribute('data-photo-remove')) { state.photo = null; state.photoKey = null; render(); return; }
  if (t.hasAttribute('data-submit')) { submit(); return; }
  if (t.hasAttribute('data-cancel-edit')) { resetForm(); render(); return; }
  if (t.hasAttribute('data-submit-another')) { state.screen = 'form'; render(); window.scrollTo({ top: 0 }); return; }
  if (t.dataset.fix) { const m = mine().find(x => x.id === t.dataset.fix); if (m) loadForFix(m); return; }
  if (t.dataset.del) { deleteMine(t.dataset.del); return; }
});

app.addEventListener('input', (e) => {
  const el = e.target;
  const lineEl = el.closest('[data-line]');
  const line = lineEl && state.lines.find(l => l.id === lineEl.dataset.line);
  if (el.hasAttribute('data-qty') && line) { line.qty = el.value; return; }
  if (el.hasAttribute('data-part') && line) { line.text = el.value; showSuggestions(lineEl); return; }
  if (el.hasAttribute('data-job')) { state.job = el.value; return; }
  if (el.hasAttribute('data-neededby')) { state.neededBy = el.value; return; }
  if (el.hasAttribute('data-note')) { state.note = el.value; return; }
  if (el.hasAttribute('data-tech-search')) {
    state.techQuery = el.value;
    const caret = el.selectionStart;
    render();
    const n = app.querySelector('[data-tech-search]');
    if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(caret, caret); } catch { /* ok */ } }
  }
});

app.addEventListener('change', (e) => {
  const el = e.target;
  if (el.hasAttribute('data-photo')) {
    const f = el.files && el.files[0];
    if (f) { state.photo = f; state.photoKey = null; render(); }
    return;
  }
  if (el.hasAttribute('data-qty')) {
    const lineEl = el.closest('[data-line]');
    const line = lineEl && state.lines.find(l => l.id === lineEl.dataset.line);
    if (!line) return;
    const v = Number(String(el.value).replace(',', '.'));
    line.qty = v > 0 ? Math.round(v * 1000) / 1000 : 1;
    el.value = fmtQty(line.qty);
  }
});

app.addEventListener('focusout', (e) => {
  if (e.target.hasAttribute?.('data-part')) {
    const lineEl = e.target.closest('[data-line]');
    setTimeout(() => hideSuggestions(lineEl), 200);
  }
});
app.addEventListener('focusin', (e) => {
  if (e.target.hasAttribute?.('data-part')) showSuggestions(e.target.closest('[data-line]'));
});
app.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.hasAttribute?.('data-part')) {
    e.preventDefault();
    const lineEl = e.target.closest('[data-line]');
    hideSuggestions(lineEl);
    const all = [...app.querySelectorAll('[data-part]')];
    const i = all.indexOf(e.target);
    if (i === all.length - 1) { if (e.target.value.trim()) { state.lines.push(newLine()); render(); app.querySelectorAll('[data-part]')[i + 1]?.focus(); } }
    else all[i + 1].focus();
  }
});

init();
