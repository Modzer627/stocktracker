// On-device receipt OCR via vendored Tesseract.js. Everything here is
// best-effort: any failure (missing vendor files, timeout, unreadable photo)
// resolves to null and the expense form simply stays manual.
const OCR_TIMEOUT_MS = 25000;

let workerPromise = null; // one OCR worker per session, reused across receipts

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('OCR library failed to load'));
    document.head.appendChild(s);
  });
}

async function getWorker() {
  if (!workerPromise) {
    workerPromise = (async () => {
      // The OCR worker runs from a blob URL, so every asset path must be
      // absolute — relative paths would resolve against the blob and 404.
      const base = new URL('./vendor/tesseract/', location.href).href.replace(/\/$/, '');
      if (typeof Tesseract === 'undefined') {
        await loadScript(`${base}/tesseract.min.js`);
      }
      // All assets point at the vendored copies; cacheMethod 'none' stops
      // tesseract duplicating the traineddata into its own IndexedDB store.
      // workerBlobURL false → a plain same-origin Worker, whose requests go
      // through the service worker and get runtime-cached for offline OCR.
      return Tesseract.createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: base,
        langPath: base,
        gzip: true,
        cacheMethod: 'none',
        workerBlobURL: false,
      });
    })();
    workerPromise.catch(() => { workerPromise = null; }); // allow retry later
  }
  return workerPromise;
}

/** Warm the OCR engine (Settings "download OCR files" button). */
export async function warmUp() {
  await getWorker();
  return true;
}

/**
 * Read a receipt image blob. Resolves to
 * { bestCents, candidates: [cents...], merchantGuess, text } or null.
 */
export async function readReceipt(blob) {
  try {
    const result = await Promise.race([
      (async () => {
        const worker = await getWorker();
        return worker.recognize(blob);
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('OCR timed out')), OCR_TIMEOUT_MS)),
    ]);
    const text = result?.data?.text || '';
    if (!text.trim()) return null;
    return { ...parseReceipt(text), text };
  } catch {
    return null;
  }
}

/**
 * Pick the most-likely total from raw OCR text. Scores every currency-shaped
 * amount: +10 on a TOTAL-ish line, −5 on subtotal/tax/change lines, +2 in the
 * bottom third (receipts put the total at the end), +3 for the max amount.
 */
export function parseReceipt(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const found = []; // {cents, line, idx}
  const amountRe = /\$?\s?(\d{1,4}[.,]\d{2})\b/g;
  lines.forEach((line, idx) => {
    for (const m of line.matchAll(amountRe)) {
      const cents = Math.round(parseFloat(m[1].replace(',', '.')) * 100);
      if (cents > 0 && cents < 1000000) found.push({ cents, line, idx });
    }
  });
  if (!found.length) {
    return { bestCents: null, candidates: [], merchantGuess: guessMerchant(lines) };
  }
  const maxCents = Math.max(...found.map(f => f.cents));
  const scored = found.map(f => {
    let score = 0;
    if (/(?:^|[^a-z])(total|amount\s*due|balance\s*due|grand\s*total)/i.test(f.line)) score += 10;
    if (/sub\s*-?\s*total|tax|change|cash|tender|tip|save[d]?|discount/i.test(f.line)) score -= 5;
    if (f.idx >= lines.length * 2 / 3) score += 2;
    if (f.cents === maxCents) score += 3;
    return { ...f, score };
  }).sort((a, b) => b.score - a.score || b.cents - a.cents);

  const best = scored[0];
  const candidates = [...new Set(scored.map(s => s.cents))].slice(0, 5);
  return { bestCents: best.cents, candidates, merchantGuess: guessMerchant(lines) };
}

function guessMerchant(lines) {
  // First early line that's mostly letters — receipts start with the store name.
  for (const line of lines.slice(0, 5)) {
    const letters = (line.match(/[a-z]/gi) || []).length;
    if (letters >= 3 && letters >= line.length / 2 && !/receipt|welcome|thank/i.test(line)) {
      return line.replace(/\s+/g, ' ').slice(0, 40);
    }
  }
  return '';
}
