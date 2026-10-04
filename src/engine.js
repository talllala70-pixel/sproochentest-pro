import createPiperPhonemize from "./phonemize.js";
import * as ortNs from "onnxruntime-web/wasm";

const ort = ortNs.default || ortNs;
const BASE = new URL(".", document.currentScript ? document.currentScript.src : location.href).href;
const HF = "https://huggingface.co/rhasspy/piper-voices/resolve/main/";
const VOICES = {
  lb: { id: "lb_LU-marylux-medium", path: "lb/lb_LU/marylux/medium/" },
  fr: { id: "fr_FR-tom-medium",     path: "fr/fr_FR/tom/medium/" }
};
const OPFS_DIR = "sproochentest-piper-v1";
const MIN_ONNX = 5 * 1024 * 1024;

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;
ort.env.wasm.wasmPaths = BASE + "ort/";

/* ---------- OPFS ---------- */
async function dirHandle() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(OPFS_DIR, { create: true });
}
async function opfsRead(name) {
  try {
    const d = await dirHandle();
    const fh = await d.getFileHandle(name);
    return await fh.getFile();
  } catch (e) { return null; }
}
async function opfsWrite(name, blob) {
  try {
    const d = await dirHandle();
    const fh = await d.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return true;
  } catch (e) { return false; }
}
async function opfsRemove(name) {
  try { const d = await dirHandle(); await d.removeEntry(name); } catch (e) {}
}

/* ---------- download with progress ---------- */
async function fetchBlob(url, onProgress, minSize) {
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const ct = (res.headers.get("Content-Type") || "").toLowerCase();
  if (ct.indexOf("text/html") !== -1) throw new Error("not a model file");
  const total = +(res.headers.get("Content-Length") || 0);
  const reader = res.body && res.body.getReader();
  if (!reader) { const b = await res.blob(); if (minSize && b.size < minSize) throw new Error("too small"); return b; }
  const parts = []; let loaded = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value); loaded += r.value.length;
    if (onProgress) onProgress(loaded, total);
  }
  if (minSize && loaded < minSize) throw new Error("too small");
  return new Blob(parts);
}

/* يحاول: OPFS ← models/ المحلي ← Hugging Face (مرة واحدة ثم يُخزَّن) */
async function getFile(fileName, subPath, onProgress, isModel) {
  const cached = await opfsRead(fileName);
  if (cached && (!isModel || cached.size >= MIN_ONNX)) {
    if (onProgress) onProgress(cached.size, cached.size, "cache");
    return cached;
  }
  if (cached) await opfsRemove(fileName);
  let blob = null, lastErr = null;
  const sources = [
    { url: BASE + "models/" + fileName, tag: "local" },
    { url: HF + subPath + fileName, tag: "remote" }
  ];
  for (const s of sources) {
    try {
      blob = await fetchBlob(s.url, function (l, t) { if (onProgress) onProgress(l, t, s.tag); }, isModel ? MIN_ONNX : 0);
      break;
    } catch (e) { lastErr = e; blob = null; }
  }
  if (!blob) throw lastErr || new Error("download failed");
  await opfsWrite(fileName, blob);
  return blob;
}

/* ---------- phonemizer assets (مرة واحدة) ---------- */
let phonemeAssets = null;
async function loadPhonemeAssets() {
  if (phonemeAssets) return phonemeAssets;
  phonemeAssets = (async () => {
    const [w, d] = await Promise.all([
      fetch(BASE + "wasm/piper_phonemize.wasm").then(r => { if (!r.ok) throw new Error("wasm"); return r.blob(); }),
      fetch(BASE + "wasm/piper_phonemize.data").then(r => { if (!r.ok) throw new Error("data"); return r.blob(); })
    ]);
    return { wasm: URL.createObjectURL(w), data: URL.createObjectURL(d) };
  })();
  try { return await phonemeAssets; } catch (e) { phonemeAssets = null; throw e; }
}

async function phonemize(text, espeakVoice) {
  const assets = await loadPhonemeAssets();
  const input = JSON.stringify([{ text: text.trim() }]);
  return new Promise(async (resolve, reject) => {
    try {
      const mod = await createPiperPhonemize({
        print: (data) => { try { resolve(JSON.parse(data).phoneme_ids); } catch (e) { reject(e); } },
        printErr: () => {},
        locateFile: (u) => u.endsWith(".wasm") ? assets.wasm : (u.endsWith(".data") ? assets.data : u)
      });
      mod.callMain(["-l", espeakVoice, "--input", input, "--espeak_data", "/espeak-ng-data"]);
    } catch (e) { reject(e); }
  });
}

/* ---------- sessions ---------- */
const sessions = {};   // lang → Promise<{session, cfg}>
const state = {};      // lang → "idle" | "loading" | "ready" | "error"

function prepare(lang, onProgress) {
  const v = VOICES[lang];
  if (!v) return Promise.reject(new Error("unknown lang"));
  if (sessions[lang]) return sessions[lang];
  state[lang] = "loading";
  sessions[lang] = (async () => {
    const cfgBlob = await getFile(v.id + ".onnx.json", v.path, null, false);
    const cfg = JSON.parse(await cfgBlob.text());
    const model = await getFile(v.id + ".onnx", v.path, onProgress, true);
    await loadPhonemeAssets();
    const session = await ort.InferenceSession.create(await model.arrayBuffer(), { executionProviders: ["wasm"] });
    state[lang] = "ready";
    return { session, cfg };
  })();
  sessions[lang].catch(function () { state[lang] = "error"; delete sessions[lang]; });
  return sessions[lang];
}

const espeakOk = {};   // lang → اسم صوت espeak الذي نجح (لا نعيد المحاولة الفاشلة كل مرة)
async function phonemizeFor(lang, cfg, text) {
  const names = [];
  if (espeakOk[lang]) names.push(espeakOk[lang]);
  else {
    names.push(cfg.espeak.voice);
    const short = String(cfg.espeak.voice).split("-")[0];
    if (short !== cfg.espeak.voice) names.push(short);
  }
  let lastErr;
  for (const n of names) {
    try { const ids = await phonemize(text, n); espeakOk[lang] = n; return ids; }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

async function synth(lang, text) {
  const { session, cfg } = await prepare(lang);
  const ids = await phonemizeFor(lang, cfg, text);
  const inf = cfg.inference || {};
  const feeds = {
    input: new ort.Tensor("int64", ids, [1, ids.length]),
    input_lengths: new ort.Tensor("int64", [ids.length]),
    scales: new ort.Tensor("float32", [inf.noise_scale ?? 0.667, inf.length_scale ?? 1, inf.noise_w ?? 0.8])
  };
  if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor("int64", [0]);
  const out = await session.run(feeds);
  return { pcm: out.output.data, rate: cfg.audio.sample_rate };
}

function toWav(pcm, rate) {
  const n = pcm.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([buf], { type: "audio/wav" });
}

/* ---------- تقسيم النص ---------- */
function chunkify(text, max) {
  max = max || 220;
  const t = String(text).trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?…\n]+[.!?…]*/g) || [t];
  const out = []; let cur = "";
  const push = () => { const c = cur.trim(); if (c) out.push(c); cur = ""; };
  sentences.forEach(function (s) {
    s = s.trim(); if (!s) return;
    if (s.length > max) {
      push();
      let piece = "";
      s.split(/\s+/).forEach(function (wd) {
        if ((piece + " " + wd).trim().length > max) { if (piece) out.push(piece.trim()); piece = wd; }
        else piece = piece ? piece + " " + wd : wd;
      });
      cur = piece;
    } else if ((cur + " " + s).trim().length > max) { push(); cur = s; }
    else cur = cur ? cur + " " + s : s;
  });
  push();
  return out;
}

/* ---------- التشغيل ---------- */
let token = 0;
let current = null;

function release(a) {
  if (!a) return;
  try { a.pause(); } catch (e) {}
  const u = a._url; a._url = null;
  if (u) setTimeout(function () { URL.revokeObjectURL(u); }, 2000);   // لا نُبطل الرابط فوراً (يسبب ERR_FILE_NOT_FOUND)
}

function stop() {
  token++;
  if (current) { release(current); current = null; }
}

function playBlob(blob, myToken) {
  return new Promise(function (resolve, reject) {
    if (myToken !== token) return resolve();
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a._url = url; current = a;
    const fin = function () { if (a._url) { URL.revokeObjectURL(a._url); a._url = null; } if (current === a) current = null; };
    a.onended = function () { fin(); resolve(); };
    a.onerror = function () { fin(); if (myToken !== token) resolve(); else reject(new Error("audio")); };
    const p = a.play();
    if (p && p.catch) p.catch(function (e) {
      fin();
      if (myToken !== token || (e && e.name === "AbortError")) resolve(); else reject(e);
    });
  });
}

/* ---------- طابور التوليد + ذاكرة الصوت ----------
   التوليد يتم واحداً تلو الآخر. طلب المستخدم (الأولوية 0) يتقدّم على التحميل المسبق (الأولوية 1)،
   فإذا كانت البطاقة جاهزة مسبقاً يبدأ الصوت فوراً عند الضغط. */
const CACHE_MAX = 150;
const cache = new Map();   // "lang|text" → { p: Promise<Blob>, job }
const queue = [];
let running = false;

function dropJob(job) {
  const hit = cache.get(job.key);
  if (hit && hit.job === job) cache.delete(job.key);
  job.reject(new Error("cancelled"));
}

function pump() {
  if (running) return;
  let i = queue.findIndex(function (j) { return j.prio === 0; });
  if (i < 0) i = queue.length ? 0 : -1;
  if (i < 0) return;
  const job = queue.splice(i, 1)[0];
  if (job.prio === 0 && job.tok !== token) { dropJob(job); return pump(); }   // لم يعد مطلوباً
  running = true; job.started = true;
  synth(job.lang, job.text)
    .then(function (r) { job.resolve(toWav(r.pcm, r.rate)); }, job.reject)
    .then(function () { running = false; pump(); });
}

function getBlob(lang, text, prio) {
  const key = lang + "|" + text;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); cache.set(key, hit);
    if (prio === 0 && hit.job && !hit.job.started) { hit.job.prio = 0; hit.job.tok = token; }
    return hit.p;
  }
  const job = { lang: lang, text: text, key: key, prio: prio, tok: prio === 0 ? token : null, started: false };
  const p = new Promise(function (res, rej) { job.resolve = res; job.reject = rej; });
  p.catch(function () { const h = cache.get(key); if (h && h.job === job) cache.delete(key); });
  cache.set(key, { p: p, job: job });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  queue.push(job); pump();
  return p;
}

let prefetchGen = 0;
async function prefetch(items) {
  const gen = ++prefetchGen;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio === 1) dropJob(queue.splice(i, 1)[0]);
  for (const it of items || []) {
    if (!it || !it.text || !VOICES[it.lang]) continue;
    const lang = it.lang;
    if (state[lang] !== "ready" && state[lang] !== "loading") {
      let cached = false;
      try { cached = await isCached(lang); } catch (e) {}
      if (gen !== prefetchGen) return;
      if (!cached) continue;                       // لا نبدأ تنزيل الصوت تلقائياً
      prepare(lang).catch(function () {});
    }
    chunkify(it.text, 220).slice(0, 3).forEach(function (c) { getBlob(lang, c, 1).catch(function () {}); });
  }
}

async function speak(text, lang, opts) {
  opts = opts || {};
  const my = ++token;
  if (current) { release(current); current = null; }
  const chunks = chunkify(text, 220);
  if (!chunks.length) return;
  await prepare(lang, opts.onProgress);
  if (my !== token) return;
  let next = getBlob(lang, chunks[0], 0);
  for (let i = 0; i < chunks.length; i++) {
    let blob;
    try { blob = await next; } catch (e) { if (my !== token) return; throw e; }
    if (my !== token) return;
    if (i + 1 < chunks.length) next = getBlob(lang, chunks[i + 1], 0);
    await playBlob(blob, my);
    if (my !== token) return;
  }
}

async function isCached(lang) {
  const f = await opfsRead(VOICES[lang].id + ".onnx");
  return !!(f && f.size >= MIN_ONNX);
}

async function removeAll() {
  token++; prefetchGen++;
  queue.length = 0; cache.clear();
  Object.keys(sessions).forEach(function (k) { delete sessions[k]; state[k] = "idle"; });
  Object.keys(espeakOk).forEach(function (k) { delete espeakOk[k]; });
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(OPFS_DIR, { recursive: true }); } catch (e) {}
}

window.PiperLocal = {
  supported: !!(navigator.storage && navigator.storage.getDirectory && window.WebAssembly),
  voices: VOICES,
  prepare: prepare,
  speak: speak,
  prefetch: prefetch,
  stop: stop,
  removeAll: removeAll,
  state: function (lang) { return state[lang] || "idle"; },
  isCached: isCached
};
