// Runs Schedule Iguana's small language model in the background so the app stays smooth.
// Model: Qwen2.5-0.5B-Instruct (Apache 2.0), compressed. It loads from the offline package's
// models/ folder when present, otherwise downloads once from Hugging Face and is cached by the browser.
import { env, pipeline } from '../../vendor/transformers/transformers.min.js';

const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
env.backends.onnx.wasm.wasmPaths = new URL('../../vendor/transformers/', import.meta.url).href;
env.localModelPath = new URL('../../models/', import.meta.url).href;
env.allowLocalModels = true;
env.allowRemoteModels = true;
env.useBrowserCache = true;

let generator = null;

async function load(id) {
  if (generator) return post(id, { ready: true, device: generator.device });
  // The offline package ships the q8 file, which runs on any processor; online, use the graphics chip
  // (q4f16) when the browser offers it.
  const packaged = await fetch(`${env.localModelPath}${MODEL}/onnx/model_quantized.onnx`, { method: 'HEAD' }).then(r => r.ok, () => false);
  // Graphics-chip mode stays off for now: on a Ryzen laptop's Radeon graphics the q4f16 model answered
  // with garbage after 56 s (Nov 2026). The processor (q8) is the reliable path.
  const GPU_MODE = false;
  const gpu = GPU_MODE && !packaged && !!(self.navigator?.gpu && await self.navigator.gpu.requestAdapter().catch(() => null));
  const device = gpu ? 'webgpu' : 'wasm';
  const files = new Map();
  generator = await pipeline('text-generation', MODEL, {
    device, dtype: gpu ? 'q4f16' : 'q8',
    progress_callback: p => {
      if (p.status !== 'progress' || !p.total) return;
      files.set(p.file, [p.loaded, p.total]);
      let done = 0, total = 0;
      files.forEach(([l, t]) => { done += l; total += t; });
      post(id, { progress: done / total, loadedMB: Math.round(done / 1e6), totalMB: Math.round(total / 1e6) });
    },
  });
  generator.device = device;
  post(id, { ready: true, device });
}

async function ask(id, messages, maxTokens = 48) {
  if (!generator) await load(id);
  const t0 = performance.now();
  const out = await generator(messages, { max_new_tokens: maxTokens, do_sample: false, return_full_text: false });
  const text = (out[0]?.generated_text?.at?.(-1)?.content ?? out[0]?.generated_text ?? '').toString();
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
