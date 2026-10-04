import { createPiperPhonemize } from "./phonemize.js";
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

async function synth(lang, text) {
  const { session, cfg } = await prepare(lang);
  let ids;
  try { ids = await phonemize(text, cfg.espeak.voice); }
  catch (e) {
    const short = String(cfg.espeak.voice).split("-")[0];
    if (short === cfg.espeak.voice) throw e;
    ids = await phonemize(text, short);
  }
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

function stop() {
  token++;
  if (current) { try { current.pause(); } catch (e) {} if (current._url) URL.revokeObjectURL(current._url); current = null; }
}

function playBlob(blob, myToken) {
  return new Promise(function (resolve, reject) {
    if (myToken !== token) return resolve();
    const url = URL.createObjectURL(blob);
    const a = new Audio(url);
    a._url = url; current = a;
    const done = function () { URL.revokeObjectURL(url); if (current === a) current = null; resolve(); };
    a.onended = done;
    a.onerror = function () { URL.revokeObjectURL(url); reject(new Error("audio")); };
    const p = a.play();
    if (p && p.catch) p.catch(function (e) { URL.revokeObjectURL(url); reject(e); });
  });
}

async function speak(text, lang, opts) {
  opts = opts || {};
  const my = ++token;
  if (current) { try { current.pause(); } catch (e) {} current = null; }
  const chunks = chunkify(text, 220);
  if (!chunks.length) return;
  await prepare(lang, opts.onProgress);
  if (my !== token) return;
  let next = synth(lang, chunks[0]);
  for (let i = 0; i < chunks.length; i++) {
    const r = await next;
    if (my !== token) return;
    if (i + 1 < chunks.length) next = synth(lang, chunks[i + 1]);
    await playBlob(toWav(r.pcm, r.rate), my);
    if (my !== token) return;
  }
}

async function removeAll() {
  Object.keys(sessions).forEach(function (k) { delete sessions[k]; state[k] = "idle"; });
  try { const root = await navigator.storage.getDirectory(); await root.removeEntry(OPFS_DIR, { recursive: true }); } catch (e) {}
}

window.PiperLocal = {
  supported: !!(navigator.storage && navigator.storage.getDirectory && window.WebAssembly),
  voices: VOICES,
  prepare: prepare,
  speak: speak,
  stop: stop,
  removeAll: removeAll,
  state: function (lang) { return state[lang] || "idle"; },
  isCached: async function (lang) {
    const f = await opfsRead(VOICES[lang].id + ".onnx");
    return !!(f && f.size >= MIN_ONNX);
  }
};
