/* واجهة الصفحة: تتكلم مع piper-worker.js وتشغّل الصوت. تعرّف window.PiperLocal. */
const BASE = new URL(".", document.currentScript ? document.currentScript.src : location.href).href;
const LANGS = ["lb", "fr"];
const BASE_SCALE = { lb: 1.3, fr: 1.0 };   // اللوكسمبورغي أبطأ افتراضياً (سرعته الأصلية عالية)
let speed = 1;                              // معامل المستخدم: >1 أبطأ

let worker = null, seq = 0;
const pending = new Map();                  // id → { resolve, reject, onProgress }
const state = {};
const prepP = {};
let dropWaiters = {};

function getWorker() {
  if (worker) return worker;
  worker = new Worker(BASE + "piper-worker.js");
  worker.onmessage = function (ev) {
    const m = ev.data;
    if (m.t === "state") { state[m.lang] = m.value; if (m.value === "error" || m.value === "idle") delete prepP[m.lang]; return; }
    if (m.t === "progress") { const p = pending.get(m.id); if (p && p.onProgress) p.onProgress(m.loaded, m.total, m.src); return; }
    if (m.t === "dropAck") { const f = dropWaiters[m.id]; if (f) { delete dropWaiters[m.id]; f(); } return; }
    if (m.t === "res") {
      const p = pending.get(m.id); if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.wav ? new Blob([m.wav], { type: "audio/wav" }) : m.value); else p.reject(new Error(m.err));
    }
  };
  worker.onerror = function () {
    pending.forEach(function (p) { p.reject(new Error("worker")); });
    pending.clear();
    worker = null;
    LANGS.forEach(function (l) { state[l] = "error"; delete prepP[l]; });
  };
  return worker;
}
function call(msg, onProgress) {
  const id = ++seq;
  return new Promise(function (resolve, reject) {
    pending.set(id, { resolve: resolve, reject: reject, onProgress: onProgress });
    msg.id = id;
    getWorker().postMessage(msg);
  });
}

const progressCb = {};
function prepare(lang, onProgress) {
  if (state[lang] === "ready") return Promise.resolve();
  if (onProgress) progressCb[lang] = onProgress;
  if (prepP[lang]) return prepP[lang];
  const p = call({ t: "prepare", lang: lang }, function (l, t, src) { if (progressCb[lang]) progressCb[lang](l, t, src); });
  prepP[lang] = p;
  p.then(function () { delete prepP[lang]; }, function () { delete prepP[lang]; });
  return p;
}
function isCached(lang) { return call({ t: "isCached", lang: lang }); }

/* ---------- التشغيل ---------- */
let token = 0;
let current = null;

function release(a) {
  if (!a) return;
  try { a.pause(); } catch (e) {}
  const u = a._url; a._url = null;
  if (u) setTimeout(function () { URL.revokeObjectURL(u); }, 2000);   // لا نُبطل الرابط فوراً (ERR_FILE_NOT_FOUND)
}
function bumpToken() {
  token++;
  if (worker) worker.postMessage({ t: "tok", tok: token });
  return token;
}
function stop() {
  bumpToken();
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

/* ---------- ذاكرة الصوت ---------- */
const CACHE_MAX = 200;
const cache = new Map();   // "lang|scale|text" → { p, prio, id }

function scaleFor(lang) { return +((BASE_SCALE[lang] || 1) * speed).toFixed(3); }

function getBlob(lang, text, prio) {
  const ls = scaleFor(lang);
  const key = lang + "|" + ls + "|" + text;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); cache.set(key, hit);
    if (prio === 0 && hit.prio === 1) { hit.prio = 0; getWorker().postMessage({ t: "upgrade", key: key, tok: token }); }
    return hit.p;
  }
  const entry = { prio: prio };
  entry.p = call({ t: "synth", key: key, lang: lang, text: text, ls: ls, prio: prio, tok: prio === 0 ? token : null });
  entry.p.catch(function () { if (cache.get(key) === entry) cache.delete(key); });
  cache.set(key, entry);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry.p;
}

function flatten(plan) {
  const out = [];
  (plan || []).forEach(function (it) {
    if (!it || !it.text || !BASE_SCALE[it.lang]) return;
    chunkify(it.text, 220).forEach(function (c) { out.push({ lang: it.lang, text: c }); });
  });
  return out;
}

/* تقسيم النص ≤ max حرفاً */
function chunkify(text, max) {
  max = max || 220;
  const t = String(text).trim();
  if (!t) return [];
  const sentences = t.match(/[^.!?…\n]+[.!?…]*/g) || [t];
  const out = []; let cur = "";
  const push = function () { const c = cur.trim(); if (c) out.push(c); cur = ""; };
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

/* تحميل مسبق: يُلغي ما لم يبدأ من التحميل المسبق السابق ثم يضيف القائمة الجديدة بالترتيب */
let prefetchGen = 0;
async function prefetch(plans) {
  const gen = ++prefetchGen;
  const parts = [];
  (plans || []).forEach(function (plan) { flatten(plan).slice(0, 3).forEach(function (x) { parts.push(x); }); });
  const id = ++seq;
  await new Promise(function (res) { dropWaiters[id] = res; getWorker().postMessage({ t: "dropPrefetch", id: id }); });
  if (gen !== prefetchGen) return;
  for (const it of parts) {
    const lang = it.lang;
    if (state[lang] !== "ready" && state[lang] !== "loading" && !prepP[lang]) {
      let cached = false;
      try { cached = await isCached(lang); } catch (e) {}
      if (gen !== prefetchGen) return;
      if (!cached) continue;                       // لا نبدأ تنزيل الصوت تلقائياً
      prepare(lang).catch(function () {});
    }
    getBlob(lang, it.text, 1).catch(function () {});
  }
}

/* plan = [{text, lang}, ...] — يُنطق بالترتيب، وكل جزء بصوت لغته */
async function speak(plan, opts) {
  opts = opts || {};
  const my = bumpToken();
  if (current) { release(current); current = null; }
  const parts = flatten(plan);
  if (!parts.length) return;
  const langs = [];
  parts.forEach(function (p) { if (langs.indexOf(p.lang) < 0) langs.push(p.lang); });
  await Promise.all(langs.map(function (l) { return prepare(l, opts.onProgress); }));
  if (my !== token) return;
  let next = getBlob(parts[0].lang, parts[0].text, 0);
  for (let i = 0; i < parts.length; i++) {
    let blob;
    try { blob = await next; } catch (e) { if (my !== token) return; throw e; }
    if (my !== token) return;
    if (i + 1 < parts.length) next = getBlob(parts[i + 1].lang, parts[i + 1].text, 0);
    await playBlob(blob, my);
    if (my !== token) return;
  }
}

async function removeAll() {
  token++; prefetchGen++;
  cache.clear();
  if (current) { release(current); current = null; }
  try { await call({ t: "removeAll" }); } catch (e) {}
  LANGS.forEach(function (l) { state[l] = "idle"; delete prepP[l]; });
}

function setSpeed(m) { if (m > 0.4 && m < 3) speed = m; }

window.PiperLocal = {
  supported: !!(navigator.storage && navigator.storage.getDirectory && window.WebAssembly && window.Worker),
  prepare: prepare,
  speak: speak,
  prefetch: prefetch,
  stop: stop,
  removeAll: removeAll,
  setSpeed: setSpeed,
  state: function (lang) { return state[lang] || "idle"; },
  isCached: isCached
};
