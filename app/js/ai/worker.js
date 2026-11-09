// Runs Schedule Iguana's small language model in the background so the app stays smooth.
// Model: Gemma 3 270M instruction-tuned by Google (Gemma Terms of Use), 4-bit, about 0.3 GB. It loads from the offline package's
// models/ folder when present, otherwise downloads once from Hugging Face and is cached by the browser.
import { env, pipeline } from '../../vendor/transformers/transformers.min.js';

const MODEL = 'onnx-community/gemma-3-270m-it-ONNX';
env.backends.onnx.wasm.wasmPaths = new URL('../../vendor/transformers/', import.meta.url).href;
env.localModelPath = new URL('../../models/', import.meta.url).href;
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;
// All cores when the page is cross-origin isolated (the service worker turns that on); one otherwise.
env.backends.onnx.wasm.numThreads = self.crossOriginIsolated ? Math.min(8, self.navigator?.hardwareConcurrency || 4) : 1;

let generator = null;

async function load(id) {
  if (generator) return post(id, { ready: true, device: generator.device });
  // The offline package ships the 4-bit file, which runs on any processor.
  const packaged = await fetch(`${env.localModelPath}${MODEL}/onnx/model_q4.onnx`, { method: 'HEAD' }).then(r => r.ok, () => false);
  // Graphics-chip mode stays off for now: on a Ryzen laptop's Radeon graphics the q4f16 model answered
  // with garbage after 56 s (Nov 2026). The processor (q8) is the reliable path.
  const GPU_MODE = false;
  const gpu = GPU_MODE && !packaged && !!(self.navigator?.gpu && await self.navigator.gpu.requestAdapter().catch(() => null));
  const device = gpu ? 'webgpu' : 'wasm';
  const files = new Map();
  generator = await pipeline('text-generation', MODEL, {
    device, dtype: gpu ? 'q4f16' : 'q4',
    progress_callback: p => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let done = 0, total = 0;
      files.forEach(([l, t]) => { done += l; total += t; });
      post(id, { progress: done / total, loadedMB: Math.round(done / 1e6), totalMB: Math.round(total / 1e6) });
    },
  });
  generator.device = device;
  post(id, { ready: true, device, threads: env.backends.onnx.wasm.numThreads });
}

async function ask(id, messages, maxTokens = 48) {
  if (!generator) await load(id);
  const t0 = performance.now();
  const out = await generator(messages, { max_new_tokens: maxTokens, do_sample: false, return_full_text: false });
  // Chat output can come back as a message list or as raw text that still carries the role header
  // ("assistant"); keep only what the model actually answered.
  const g = out[0]?.generated_text;
  let text = Array.isArray(g) ? String(g.at(-1)?.content ?? '') : String(g ?? '');
  text = text.split(/<\|end_header_id\|>|\bassistant\b\s*\n+/i).pop().replace(/<\|eot_id\|>[\s\S]*$|<end_of_turn>[\s\S]*$/, '');
  post(id, { text: text.trim(), ms: Math.round(performance.now() - t0) });
}

function post(id, data) { self.postMessage({ id, ...data }); }

self.onmessage = async e => {
  const { id, type, messages, maxTokens } = e.data;
  try {
    if (type === 'load') await load(id);
    else if (type === 'ask') await ask(id, messages, maxTokens);
  } catch (err) { post(id, { error: String(err?.message || err) }); }
};
