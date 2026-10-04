import createPiperPhonemize from "./phonemize.js";
import * as ortNs from "onnxruntime-web/wasm";

/* يعمل هذا الملف داخل Web Worker: التوليد الثقيل بعيداً عن خيط الواجهة. */
const ort = ortNs.default || ortNs;
const BASE = new URL(".", self.location.href).href;
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

const post = function (m, tr) { self.postMessage(m, tr || []); };

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
/* ---------- sessions ---------- */
const sessions = {};   // lang → Promise<{session, cfg}>
const state = {};      // lang → "idle" | "loading" | "ready" | "error"
function setState(lang, v) { state[lang] = v; post({ t: "state", lang: lang, value: v }); }

function prepare(lang, onProgress) {
  const v = VOICES[lang];
  if (!v) return Promise.reject(new Error("unknown lang"));
  if (sessions[lang]) return sessions[lang];
  setState(lang, "loading");
  sessions[lang] = (async () => {
    const cfgBlob = await getFile(v.id + ".onnx.json", v.path, null, false);
    const cfg = JSON.parse(await cfgBlob.text());
    const model = await getFile(v.id + ".onnx", v.path, onProgress, true);
    await loadPhonemeAssets();
    const session = await ort.InferenceSession.create(await model.arrayBuffer(), { executionProviders: ["wasm"] });
    setState(lang, "ready");
    return { session, cfg };
  })();
  sessions[lang].catch(function () { setState(lang, "error"); delete sessions[lang]; });
  return sessions[lang];
}

const espeakOk = {};   // lang → اسم صوت espeak الذي نجح
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

/* ضوضاء أقل = نطق أثبت وأوضح بين مرة وأخرى (VITS عشوائي) */
const INF_OVERRIDE = { lb: { noise_scale: 0.5, noise_w: 0.6 } };

/* ls = معامل إبطاء الكلام (>1 أبطأ) */
async function synth(lang, text, ls) {
  const { session, cfg } = await prepare(lang);
  const ids = await phonemizeFor(lang, cfg, text);
  const inf = Object.assign({}, cfg.inference || {}, INF_OVERRIDE[lang] || {});
  const feeds = {
    input: new ort.Tensor("int64", ids, [1, ids.length]),
    input_lengths: new ort.Tensor("int64", [ids.length]),
    scales: new ort.Tensor("float32", [inf.noise_scale ?? 0.667, (inf.length_scale ?? 1) * (ls || 1), inf.noise_w ?? 0.8])
  };
  if (cfg.speaker_id_map && Object.keys(cfg.speaker_id_map).length) feeds.sid = new ort.Tensor("int64", [0]);
  const out = await session.run(feeds);
  return { pcm: out.output.data, rate: cfg.audio.sample_rate };
}

/* WAV 16-bit مع صمت قصير في البداية والنهاية (يمنع قصّ أول الحرف) */
function toWav(pcm, rate) {
  const lead = Math.round(rate * 0.06), tail = Math.round(rate * 0.12);
  const n = pcm.length, total = lead + n + tail;
  const buf = new ArrayBuffer(44 + total * 2), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, 36 + total * 2, true); w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, total * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, pcm[i])); v.setInt16(44 + (lead + i) * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return buf;
}

/* ---------- طابور التوليد (واحد في كل مرة؛ طلب المستخدم قبل التحميل المسبق) ---------- */
const queue = [];
let running = false;
let curTok = 0;

function fail(id, err) { post({ t: "res", id: id, ok: false, err: String((err && err.message) || err) }); }

function pump() {
  if (running) return;
  let i = queue.findIndex(function (j) { return j.prio === 0; });
  if (i < 0) i = queue.length ? 0 : -1;
  if (i < 0) return;
  const job = queue.splice(i, 1)[0];
  if (job.prio === 0 && job.tok !== curTok) { fail(job.id, "cancelled"); return pump(); }
  running = true;
  synth(job.lang, job.text, job.ls).then(function (r) {
    const wav = toWav(r.pcm, r.rate);
    post({ t: "res", id: job.id, ok: true, wav: wav }, [wav]);
  }, function (e) { fail(job.id, e); }).then(function () { running = false; pump(); });
}

self.onmessage = function (ev) {
  const m = ev.data;
  switch (m.t) {
    case "prepare":
      prepare(m.lang, function (l, t, src) { post({ t: "progress", id: m.id, loaded: l, total: t, src: src }); })
        .then(function () { post({ t: "res", id: m.id, ok: true }); }, function (e) { fail(m.id, e); });
      break;
    case "synth":
      queue.push({ id: m.id, key: m.key, lang: m.lang, text: m.text, ls: m.ls, prio: m.prio, tok: m.tok });
      pump();
      break;
    case "tok":
      curTok = m.tok; pump();
      break;
    case "upgrade":
      for (const j of queue) if (j.key === m.key) { j.prio = 0; j.tok = m.tok; }
      break;
    case "dropPrefetch":
      for (let i = queue.length - 1; i >= 0; i--) if (queue[i].prio === 1) fail(queue.splice(i, 1)[0].id, "cancelled");
      post({ t: "dropAck", id: m.id });
      break;
    case "isCached":
      opfsRead(VOICES[m.lang].id + ".onnx").then(function (f) {
        post({ t: "res", id: m.id, ok: true, value: !!(f && f.size >= MIN_ONNX) });
      });
      break;
    case "removeAll":
      curTok = -1;
      while (queue.length) fail(queue.pop().id, "cancelled");
      Object.keys(sessions).forEach(function (k) { delete sessions[k]; setState(k, "idle"); });
      Object.keys(espeakOk).forEach(function (k) { delete espeakOk[k]; });
      navigator.storage.getDirectory()
        .then(function (root) { return root.removeEntry(OPFS_DIR, { recursive: true }); })
        .catch(function () {})
        .then(function () { post({ t: "res", id: m.id, ok: true }); });
      break;
  }
};
