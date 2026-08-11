// Camera + barcode decoding. Uses the browser's native BarcodeDetector when it
// supports all formats we need (Android Chrome); otherwise the vendored
// zxing-wasm ponyfill (iOS Safari, desktop). Same API either way.

const FORMATS = ['qr_code', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39'];

let _detector = null;
let _detectorKind = null;

export async function getDetector() {
  if (_detector) return _detector;
  if ('BarcodeDetector' in window) {
    try {
      const supported = await window.BarcodeDetector.getSupportedFormats();
      if (FORMATS.every(f => supported.includes(f))) {
        _detector = new window.BarcodeDetector({ formats: FORMATS });
        _detectorKind = 'native';
        return _detector;
      }
    } catch { /* fall through to ponyfill */ }
  }
  const NS = window.BarcodeDetectionAPI;
  if (!NS) throw new Error('Barcode library failed to load');
  // Serve the wasm from our own origin so scanning works fully offline.
  NS.prepareZXingModule({
    overrides: {
      locateFile: (path, prefix) => path.endsWith('.wasm') ? './vendor/zxing/zxing_reader.wasm' : prefix + path,
    },
  });
  _detector = new NS.BarcodeDetector({ formats: FORMATS });
  _detectorKind = 'wasm';
  return _detector;
}

export function detectorKind() { return _detectorKind; }

/** Decode barcodes from a photo (File/Blob). Returns array of {rawValue, format}. */
export async function scanImage(fileOrBlob) {
  const detector = await getDetector();
  let source;
  try {
    source = await createImageBitmap(fileOrBlob);
  } catch {
    source = await blobToImage(fileOrBlob);
  }
  return detector.detect(source);
}

function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read image')); };
    img.src = url;
  });
}

const DETECT_INTERVAL_MS = 130;   // ~8 detect passes per second
const ABSENCE_MS = 900;           // a code must leave the frame this long to count again
const RESUME_WARMUP_MS = 1200;    // after resume(), re-seen codes don't refire immediately

export class Scanner {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.track = null;
    this.facing = 'environment';
    this.onCode = null;          // (rawValue, format) => void
    this.onError = null;
    this._raf = 0;
    this._lastPass = 0;
    this._seen = new Map();
    this._paused = false;
    this._warmUntil = 0;
    this._running = false;
  }

  async start(facing = 'environment') {
    this.stop();
    await getDetector();
    const constraints = {
      audio: false,
      video: {
        facingMode: facing === 'user' ? 'user' : { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    this.track = this.stream.getVideoTracks()[0];
    this.facing = facing;
    this.video.srcObject = this.stream;
    this.video.classList.toggle('mirror', facing === 'user');
    try { await this.video.play(); } catch { /* iOS resolves play() late; stream still renders */ }
    this._running = true;
    this._seen.clear();
    this._warmUntil = 0;
    this._loop();
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
      this.track = null;
    }
    if (this.video) this.video.srcObject = null;
  }

  get active() { return this._running && !!this.stream; }

  async flip() {
    const next = this.facing === 'user' ? 'environment' : 'user';
    await this.start(next);
    return next;
  }

  hasTorch() {
    try { return this.track?.getCapabilities?.().torch === true; } catch { return false; }
  }

  async setTorch(on) {
    if (!this.track) return false;
    try {
      await this.track.applyConstraints({ advanced: [{ torch: !!on }] });
      return true;
    } catch { return false; }
  }

  /** Keep the stream alive but stop firing onCode (used while a sheet is open). */
  pause() { this._paused = true; }
  resume() {
    this._paused = false;
    this._warmUntil = performance.now() + RESUME_WARMUP_MS;
  }

  _loop() {
    this._raf = requestAnimationFrame(async (ts) => {
      if (!this._running) return;
      if (ts - this._lastPass >= DETECT_INTERVAL_MS && this.video.readyState >= 2 && this.video.videoWidth > 0) {
        this._lastPass = ts;
        try {
          const codes = await getDetector().then(d => d.detect(this.video));
          if (this._running && !this._paused) {
            const now = performance.now();
            const warm = now < this._warmUntil;
            for (const c of codes) {
              const value = c.rawValue;
              if (!value) continue;
              const last = this._seen.get(value) ?? -Infinity;
              const isNewAppearance = now - last > ABSENCE_MS;
              this._seen.set(value, now);
              if (isNewAppearance && !warm && this.onCode) {
                this.onCode(value, c.format);
                break; // one code per pass keeps multi-code frames predictable
              }
            }
          } else if (codes.length) {
            // While paused, keep presence fresh so codes still in frame don't refire on resume.
            const now = performance.now();
            for (const c of codes) if (c.rawValue) this._seen.set(c.rawValue, now);
          }
        } catch (e) {
          if (this.onError && this._running) this.onError(e);
        }
      }
      if (this._running) this._loop();
    });
  }
}
