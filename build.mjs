// يبني src/engine.js إلى piper-engine.js (IIFE يعرّف window.PiperLocal).
// الاستخدام:  npm install && npm run build   (ينتج piper-engine.js و piper-worker.js)
// الملفات الثنائية في wasm/ (من @diffusionstudio/piper-wasm) وort/ (من onnxruntime-web@1.18.0) تُنسخ يدوياً، لا يلمسها هذا السكربت.
import { build } from "esbuild";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const phonemize = path.join(path.dirname(require.resolve("@diffusionstudio/piper-wasm/package.json")), "build", "piper_phonemize.js");

const outDir = process.argv[2] || ".";
// piper-engine.js: واجهة الصفحة (صغير) · piper-worker.js: التوليد داخل Web Worker (onnxruntime + phonemizer)
await build({ entryPoints: ["src/engine.js"], outfile: outDir + "/piper-engine.js", bundle: true, minify: true, format: "iife", platform: "browser", logLevel: "info" });
await build({
  entryPoints: ["src/worker.js"],
  outfile: outDir + "/piper-worker.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  external: ["fs", "path", "crypto", "fs/promises"], // فروع Node فقط، لا تُنفَّذ في المتصفح
  plugins: [{
    name: "phonemize",
    setup(b) { b.onResolve({ filter: /^\.\/phonemize\.js$/ }, () => ({ path: phonemize })); }
  }],
  logLevel: "info"
});
