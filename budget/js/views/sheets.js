// Bottom-sheet forms: expense entry (manual / receipt / split), mark-paid,
// recurring definitions, category editor.
import { $, $$, esc, sheet, confirmDialog, toast, fmtMoney, parseMoney, isoDate } from '../ui.js';
import { uuid } from '../db.js';
import { allCategories, GROUP_ORDER } from '../categories.js';
import { saveTxn, deleteTxn, splitSiblings } from '../txns.js';
import { saveRecurring, deleteRecurring, postOccurrence } from '../recurring.js';
import { prepareReceipt, savePhoto, getPhotoUrl, viewPhoto } from '../receipts.js';

function catOptions(cats, selected) {
  let html = '';
  let group = null;
  for (const c of cats) {
    if (c.group !== group) {
      if (group !== null) html += '</optgroup>';
      html += `<optgroup label="${esc(c.group)}">`;
      group = c.group;
    }
    html += `<option value="${esc(c.id)}" ${c.id === selected ? 'selected' : ''}>${esc(c.icon || '')} ${esc(c.name)}</option>`;
  }
  if (group !== null) html += '</optgroup>';
  return html;
}

/* =============== expense sheet =============== */

/**
 * Add or edit an expense.
 *  - receiptFile: a fresh camera capture — compress, OCR, attach.
 *  - txn: existing transaction to edit (split groups open all their lines).
 */
export async function openExpenseSheet({ txn = null, receiptFile = null, onDone = null } = {}) {
  const cats = await allCategories();
  if (!cats.length) { toast('Add a category first (Settings)', { error: true }); return; }

  let siblings = [];
  if (txn && txn.splitGroup) siblings = (await splitSiblings(txn.splitGroup)).sort((a, b) => a.createdAt - b.createdAt);
  const isEdit = !!txn;
  const primary = siblings[0] || txn || {};
  let splitMode = siblings.length > 1;
  let photoKey = primary.photo || null;
  let receiptBlobs = null; // {ocrBlob, storeBlob} while a new capture is pending

  const totalCents = siblings.length > 1
    ? siblings.reduce((s, t) => s + t.amountCents, 0)
    : (txn ? txn.amountCents : null);

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="rc-preview" data-role="preview" hidden></div>
    <div class="ocr-hint" data-role="ocr" hidden></div>
    <div class="field">
      <label>Amount</label>
      <input data-role="amount" type="text" inputmode="decimal" placeholder="0.00"
        value="${totalCents != null ? (totalCents / 100).toFixed(2) : ''}">
      <div class="chips" data-role="candidates" hidden></div>
    </div>
    <div data-role="single">
      <div class="field">
        <label>Category</label>
        <select data-role="category">${catOptions(cats, primary.categoryId)}</select>
      </div>
      <button class="btn btn-ghost btn-sm" data-role="to-split">Split across categories…</button>
    </div>
    <div data-role="split" hidden>
      <div class="field"><label>Split across categories</label>
        <div data-role="split-rows"></div>
        <button class="btn btn-sm" data-role="add-split">+ Add category</button>
        <div class="split-left" data-role="split-left"></div>
      </div>
    </div>
    <div class="field-row">
      <div class="field"><label>Date</label>
        <input data-role="date" type="date" value="${esc(primary.date || isoDate())}"></div>
      <div class="field"><label>Merchant / payee</label>
        <input data-role="merchant" type="text" placeholder="e.g. Walmart" value="${esc(primary.merchant || '')}"></div>
    </div>
    <div class="field"><label>Note (optional)</label>
      <input data-role="note" type="text" value="${esc(primary.note || '')}"></div>
    <div class="sheet-actions">
      ${isEdit ? '<button class="btn btn-danger" data-role="delete">Delete</button>' : ''}
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">Save</button>
    </div>`;

  const s = sheet({ title: isEdit ? 'Edit expense' : (receiptFile ? 'Receipt' : 'Add expense'), content: wrap });
  const el = (r) => $(`[data-role="${r}"]`, wrap);

  /* ---- split rows ---- */
  const splitRowHtml = (categoryId = '', cents = null) => `
    <div class="split-row">
      <select>${catOptions(cats, categoryId)}</select>
      <input type="text" inputmode="decimal" placeholder="0.00" value="${cents != null ? (cents / 100).toFixed(2) : ''}">
      <button class="icon-btn" data-x aria-label="Remove">✕</button>
    </div>`;

  const refreshRemainder = () => {
    const total = parseMoney(el('amount').value) || 0;
    const used = $$('.split-row input', wrap).reduce((s2, i) => s2 + (parseMoney(i.value) || 0), 0);
    const left = total - used;
    const lbl = el('split-left');
    lbl.textContent = left === 0 ? 'Fully allocated ✓' : `${fmtMoney(Math.abs(left))} ${left > 0 ? 'left to allocate' : 'over the total'}`;
    lbl.classList.toggle('bad', left !== 0);
  };

  const wireSplitRow = (row) => {
    $('[data-x]', row).addEventListener('click', () => { row.remove(); refreshRemainder(); });
    $('input', row).addEventListener('input', refreshRemainder);
  };

  const enterSplitMode = (lines) => {
    splitMode = true;
    el('single').hidden = true;
    el('split').hidden = false;
    const box = el('split-rows');
    box.innerHTML = '';
    for (const l of lines) box.insertAdjacentHTML('beforeend', splitRowHtml(l.categoryId, l.amountCents));
    $$('.split-row', box).forEach(wireSplitRow);
    refreshRemainder();
  };

  el('to-split').addEventListener('click', () => {
    const total = parseMoney(el('amount').value);
    enterSplitMode([
      { categoryId: el('category').value, amountCents: total },
      { categoryId: cats[0].id, amountCents: null },
    ]);
  });
  el('add-split').addEventListener('click', () => {
    el('split-rows').insertAdjacentHTML('beforeend', splitRowHtml());
    wireSplitRow(el('split-rows').lastElementChild);
    refreshRemainder();
  });
  el('amount').addEventListener('input', () => { if (splitMode) refreshRemainder(); });
  if (splitMode) enterSplitMode(siblings.map(t => ({ categoryId: t.categoryId, amountCents: t.amountCents })));

  /* ---- existing photo preview ---- */
  if (photoKey) {
    const url = await getPhotoUrl(photoKey);
    if (url) {
      el('preview').hidden = false;
      el('preview').style.backgroundImage = `url("${url}")`;
      el('preview').addEventListener('click', () => viewPhoto(photoKey));
    }
  }

  /* ---- fresh receipt: preview + OCR ---- */
  if (receiptFile) {
    const ocrEl = el('ocr');
    ocrEl.hidden = false;
    ocrEl.innerHTML = `<span class="spin"></span> Reading receipt…`;
    try {
      receiptBlobs = await prepareReceipt(receiptFile);
      const url = URL.createObjectURL(receiptBlobs.storeBlob);
      el('preview').hidden = false;
      el('preview').style.backgroundImage = `url("${url}")`;
    } catch {
      ocrEl.textContent = 'Could not read that image';
      toast('Could not process that photo', { error: true });
    }
    if (receiptBlobs) {
      import('../ocr.js')
        .then(m => m.readReceipt(receiptBlobs.ocrBlob))
        .then(res => {
          if (!wrap.isConnected) return;
          if (!res || res.bestCents == null) {
            ocrEl.textContent = res ? 'Couldn’t spot a total — enter it below' : 'Couldn’t read it — enter the amount below';
            return;
          }
          ocrEl.textContent = 'Total read from the receipt — double-check it:';
          if (!el('amount').value) {
            el('amount').value = (res.bestCents / 100).toFixed(2);
            if (splitMode) refreshRemainder();
          }
          if (res.merchantGuess && !el('merchant').value) el('merchant').value = res.merchantGuess;
          const others = res.candidates.filter(c => c !== res.bestCents);
          if (others.length) {
            const box = el('candidates');
            box.hidden = false;
            box.innerHTML = others.map(c => `<button class="chip" data-cents="${c}">${fmtMoney(c)}</button>`).join('');
            $$('.chip', box).forEach(ch => ch.addEventListener('click', () => {
              el('amount').value = (Number(ch.dataset.cents) / 100).toFixed(2);
              if (splitMode) refreshRemainder();
            }));
          }
        })
        .catch(() => { if (wrap.isConnected) ocrEl.textContent = 'Couldn’t read it — enter the amount below'; });
    }
  }

  /* ---- actions ---- */
  el('cancel').addEventListener('click', () => s.close());

  if (isEdit) {
    el('delete').addEventListener('click', async () => {
      const n = siblings.length > 1 ? `all ${siblings.length} parts of this split` : 'this expense';
      if (!(await confirmDialog(`Delete ${n}?`, { danger: true, okLabel: 'Delete' }))) return;
      for (const t of (siblings.length ? siblings : [txn])) await deleteTxn(t.id);
      s.close();
      toast('Expense deleted');
      if (onDone) onDone();
    });
  }

  el('save').addEventListener('click', async () => {
    const btn = el('save');
    const total = parseMoney(el('amount').value);
    if (total == null || total <= 0) { toast('Enter the amount', { error: true }); return; }
    const shared = {
      date: el('date').value || isoDate(),
      merchant: el('merchant').value,
      note: el('note').value,
    };

    let lines;
    if (splitMode) {
      lines = $$('.split-row', wrap).map(row => ({
        categoryId: $('select', row).value,
        amountCents: parseMoney($('input', row).value),
      })).filter(l => l.amountCents != null && l.amountCents > 0);
      if (!lines.length) { toast('Add at least one split line', { error: true }); return; }
      const sum = lines.reduce((s2, l) => s2 + l.amountCents, 0);
      if (sum !== total) { toast(`Splits must add up to ${fmtMoney(total)}`, { error: true }); return; }
    } else {
      lines = [{ categoryId: el('category').value, amountCents: total }];
    }

    btn.disabled = true;
    try {
      const splitGroup = lines.length > 1 ? (primary.splitGroup || uuid()) : null;
      // A fresh capture keys its photo to the group (or single txn) id.
      const existing = siblings.length ? siblings : (txn ? [txn] : []);
      const keptIds = [];
      const source = receiptBlobs || photoKey ? (primary.source === 'recurring' ? primary.source : 'receipt') : (primary.source || 'manual');

      let newPhotoKey = photoKey;
      const firstId = existing[0]?.id || uuid();
      if (receiptBlobs) {
        newPhotoKey = 'rc-' + (splitGroup || firstId);
        await savePhoto(newPhotoKey, receiptBlobs.storeBlob);
      }

      for (let i = 0; i < lines.length; i++) {
        const prev = existing[i];
        const id = prev?.id || (i === 0 ? firstId : uuid());
        keptIds.push(id);
        await saveTxn({
          ...(prev || {}),
          id,
          ...shared,
          categoryId: lines[i].categoryId,
          amountCents: lines[i].amountCents,
          splitGroup,
          photo: newPhotoKey,
          source: prev?.source || source,
        });
      }
      // Lines removed while editing a split get tombstoned.
      for (const t of existing) if (!keptIds.includes(t.id)) await deleteTxn(t.id);

      s.close();
      toast(isEdit ? 'Expense updated' : `Saved ${fmtMoney(total)}`);
      if (onDone) onDone();
    } catch (e) {
      toast('Could not save: ' + (e.message || e), { error: true });
    } finally {
      btn.disabled = false;
    }
  });
}

/** The "＋" entry point: snap a receipt or type it in. */
export function openAddSheet({ onDone = null } = {}) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button class="btn btn-primary btn-block" data-role="snap" style="min-height:64px;font-size:17px">📷 &nbsp;Snap a receipt</button>
    <div style="height:10px"></div>
    <button class="btn btn-block" data-role="manual" style="min-height:56px">⌨️ &nbsp;Enter manually</button>
    <input data-role="file" type="file" accept="image/*" capture="environment" hidden>`;
  const s = sheet({ title: 'Add expense', content: wrap });
  const file = $('[data-role="file"]', wrap);
  $('[data-role="snap"]', wrap).addEventListener('click', () => file.click());
  file.addEventListener('change', () => {
    const f = file.files && file.files[0];
    if (!f) return;
    s.close();
    openExpenseSheet({ receiptFile: f, onDone });
  });
  $('[data-role="manual"]', wrap).addEventListener('click', () => {
    s.close();
    openExpenseSheet({ onDone });
  });
}

/* =============== mark-paid sheet =============== */

export function openMarkPaidSheet(def, dueDate, { onDone = null } = {}) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p style="color:var(--text-dim);font-size:13.5px;margin:-6px 0 12px">
      ${esc(def.name)} — due ${esc(dueDate)}. Adjust the amount if the bill differed.</p>
    <div class="field"><label>Amount paid</label>
      <input data-role="amount" type="text" inputmode="decimal" value="${(def.amountCents / 100).toFixed(2)}"></div>
    <div class="field"><label>Date paid</label>
      <input data-role="date" type="date" value="${isoDate()}"></div>
    <div class="sheet-actions">
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">Mark paid</button>
    </div>`;
  const s = sheet({ title: 'Mark paid', content: wrap });
  $('[data-role="cancel"]', wrap).addEventListener('click', () => s.close());
  $('[data-role="save"]', wrap).addEventListener('click', async () => {
    const cents = parseMoney($('[data-role="amount"]', wrap).value);
    if (cents == null || cents <= 0) { toast('Enter the amount', { error: true }); return; }
    await postOccurrence(def, dueDate, { amountCents: cents, date: $('[data-role="date"]', wrap).value || isoDate() });
    s.close();
    toast(`${def.name} marked paid`);
    if (onDone) onDone();
  });
}

/* =============== recurring sheet =============== */

export async function openRecurringSheet({ def = null, onDone = null } = {}) {
  const cats = await allCategories();
  const isEdit = !!def;
  const d = def || { name: '', amountCents: null, categoryId: cats[0]?.id, freq: { unit: 'month', interval: 1 }, anchorDate: isoDate(), mode: 'autopost', active: 1 };
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field"><label>Name</label>
      <input data-role="name" type="text" placeholder="e.g. Netflix" value="${esc(d.name)}"></div>
    <div class="field-row">
      <div class="field"><label>Amount</label>
        <input data-role="amount" type="text" inputmode="decimal" placeholder="0.00"
          value="${d.amountCents != null ? (d.amountCents / 100).toFixed(2) : ''}"></div>
      <div class="field"><label>Category</label>
        <select data-role="category">${catOptions(cats, d.categoryId)}</select></div>
    </div>
    <div class="field-row">
      <div class="field"><label>Repeats every</label>
        <input data-role="interval" type="number" min="1" step="1" value="${d.freq.interval}"></div>
      <div class="field"><label>&nbsp;</label>
        <select data-role="unit">
          <option value="week" ${d.freq.unit === 'week' ? 'selected' : ''}>week(s)</option>
          <option value="month" ${d.freq.unit === 'month' ? 'selected' : ''}>month(s)</option>
          <option value="year" ${d.freq.unit === 'year' ? 'selected' : ''}>year(s)</option>
        </select></div>
    </div>
    <div class="field"><label>First / next due date</label>
      <input data-role="anchor" type="date" value="${esc(d.anchorDate)}"></div>
    <div class="field"><label>When due</label>
      <select data-role="mode">
        <option value="autopost" ${d.mode === 'autopost' ? 'selected' : ''}>Post automatically (fixed amount)</option>
        <option value="remind" ${d.mode === 'remind' ? 'selected' : ''}>Remind me — I'll confirm the amount</option>
      </select></div>
    ${isEdit ? `
    <div class="set-row" style="border:1px solid var(--border);border-radius:12px">
      <div class="grow">Active</div>
      <label class="switch"><input data-role="active" type="checkbox" ${d.active ? 'checked' : ''}><span></span></label>
    </div>` : ''}
    <div class="sheet-actions">
      ${isEdit ? '<button class="btn btn-danger" data-role="delete">Delete</button>' : ''}
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">Save</button>
    </div>`;
  const s = sheet({ title: isEdit ? 'Edit recurring' : 'New subscription / bill', content: wrap });
  const el = (r) => $(`[data-role="${r}"]`, wrap);
  el('cancel').addEventListener('click', () => s.close());
  if (isEdit) {
    el('delete').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete "${d.name}"? Past posted bills stay in your history.`, { danger: true, okLabel: 'Delete' }))) return;
      await deleteRecurring(d.id);
      s.close();
      if (onDone) onDone();
    });
  }
  el('save').addEventListener('click', async () => {
    const cents = parseMoney(el('amount').value);
    if (cents == null || cents <= 0) { toast('Enter the amount', { error: true }); return; }
    try {
      await saveRecurring({
        ...(def || {}),
        name: el('name').value,
        amountCents: cents,
        categoryId: el('category').value,
        freq: { unit: el('unit').value, interval: Number(el('interval').value) || 1 },
        anchorDate: el('anchor').value || isoDate(),
        mode: el('mode').value,
        active: isEdit ? (el('active').checked ? 1 : 0) : 1,
      });
      s.close();
      toast('Saved');
      if (onDone) onDone();
    } catch (e) {
      toast(e.message || 'Could not save', { error: true });
    }
  });
}

/* =============== category sheet =============== */

export async function openCategorySheet({ cat = null, onDone = null } = {}) {
  const { saveCategory, deleteCategory } = await import('../categories.js');
  const cats = await allCategories({ includeArchived: true });
  const groups = [...new Set([...GROUP_ORDER, ...cats.map(c => c.group)])];
  const isEdit = !!cat;
  const c = cat || { name: '', group: groups[0], budgetCents: null, icon: '🧾' };
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="field-row">
      <div class="field" style="flex:0 0 84px"><label>Icon</label>
        <input data-role="icon" type="text" maxlength="4" value="${esc(c.icon || '')}"></div>
      <div class="field"><label>Name</label>
        <input data-role="name" type="text" value="${esc(c.name)}"></div>
    </div>
    <div class="field"><label>Group</label>
      <input data-role="group" type="text" list="cat-groups" value="${esc(c.group)}">
      <datalist id="cat-groups">${groups.map(g => `<option value="${esc(g)}">`).join('')}</datalist></div>
    <div class="field"><label>Monthly budget</label>
      <input data-role="budget" type="text" inputmode="decimal" placeholder="0.00"
        value="${c.budgetCents != null ? (c.budgetCents / 100).toFixed(2) : ''}"></div>
    ${isEdit ? `
    <div class="set-row" style="border:1px solid var(--border);border-radius:12px">
      <div class="grow">Archived<span class="hint">Hidden from forms; history kept</span></div>
      <label class="switch"><input data-role="archived" type="checkbox" ${c.archived ? 'checked' : ''}><span></span></label>
    </div>` : ''}
    <div class="sheet-actions">
      ${isEdit ? '<button class="btn btn-danger" data-role="delete">Delete</button>' : ''}
      <button class="btn" data-role="cancel">Cancel</button>
      <button class="btn btn-primary" data-role="save">Save</button>
    </div>`;
  const s = sheet({ title: isEdit ? 'Edit category' : 'New category', content: wrap });
  const el = (r) => $(`[data-role="${r}"]`, wrap);
  el('cancel').addEventListener('click', () => s.close());
  if (isEdit) {
    el('delete').addEventListener('click', async () => {
      if (!(await confirmDialog(`Delete "${c.name}"? Its expenses keep their history but lose the category.`, { danger: true, okLabel: 'Delete' }))) return;
      await deleteCategory(c.id);
      s.close();
      if (onDone) onDone();
    });
  }
  el('save').addEventListener('click', async () => {
    try {
      await saveCategory({
        ...(cat || {}),
        name: el('name').value,
        group: el('group').value || 'Other',
        icon: el('icon').value || '🧾',
        budgetCents: parseMoney(el('budget').value) || 0,
        archived: isEdit ? (el('archived').checked ? 1 : 0) : 0,
      });
      s.close();
      if (onDone) onDone();
    } catch (e) {
      toast(e.message || 'Could not save', { error: true });
    }
  });
}
