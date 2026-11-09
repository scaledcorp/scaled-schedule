// Schedule Iguana's AI helper. It never edits the schedule: when Iguana's rules can't match a request,
// they still list likely commands, and the small model only picks which one the person meant.
// Iguana then shows its normal preview, so every change can be checked and undone.
const FLAG = 'scaled-schedule:iguana-gemma';
const MODEL_DIR = '../../models/onnx-community/gemma-3-270m-it-ONNX/';

export class Brain {
  constructor() { this.worker = null; this.seq = 0; this.waiting = new Map(); this.ready = false; }

  // Was the model downloaded before (or is it in the offline package)? Then no need to ask first.
  async known() {
    try { if (localStorage.getItem(FLAG) === 'on') return true; } catch { /* storage blocked */ }
    try { return (await fetch(new URL(`${MODEL_DIR}config.json`, import.meta.url), { method: 'HEAD' })).ok; }
    catch { return false; }
  }

  call(type, data = {}, onProgress) {
    if (!this.worker) {
      this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = e => {
        const w = this.waiting.get(e.data.id);
        if (!w) return;
        if (e.data.progress != null) { w.onProgress?.(e.data); return; }
        this.waiting.delete(e.data.id);
        e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data);
      };
    }
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, onProgress });
      this.worker.postMessage({ id, type, ...data });
    });
  }

  async load(onProgress) {
    const r = await this.call('load', {}, onProgress);
    this.ready = true;
    try { localStorage.setItem(FLAG, 'on'); } catch { /* per-viewer convenience only */ }
    return r;
  }

  // Returns the chosen option's text, or null when none fits.
  async choose(text, options) {
    const list = options.map((o, i) => `${i + 1}. ${o}`).join('\n');
    const messages = [
      { role: 'system', content: 'You match a request about a project schedule to the option that means the same thing. Reply with the option number only. Reply 0 if no option fits.' },
      { role: 'user', content: 'Request: push the kickoff back to friday\nOptions:\n1. when does Kickoff finish?\n2. move Kickoff to friday\n3. Kickoff is done' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: `Request: ${text}\nOptions:\n${list}` },
    ];
    const r = await this.call('ask', { messages, maxTokens: 3 });
    const n = parseInt((r.text.match(/\d+/) || ['0'])[0], 10);
    this.lastMs = r.ms;
    return n >= 1 && n <= options.length ? options[n - 1] : null;
  }
}
