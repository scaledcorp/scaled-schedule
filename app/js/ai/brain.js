// Schedule Iguana's AI layer. The small model never edits the schedule: it only rewrites a request into
// one of the phrasings Iguana's rules already understand, and the rules do the rest (preview, undo).
const FLAG = 'scaled-schedule:iguana-ai';

const SYSTEM = `You rewrite a request about a project schedule into exactly one command from this list:
add <name> <N> days after <task> and give it to <person>
add <name> milestone after <task>
link <task> to <task>
move <task> to <date>
make <task> <N> days
rename <task> to <new name>
delete <task>
give <task> to <person>
<task> is <N>% done
what's on the critical path?
who's over-booked?
when does <task> finish?
when does the project finish?
why did <task> move?
how much does it cost?
Leave out parts the request doesn't mention. Use task names exactly as listed. If nothing fits, reply: help
Reply with the command only.`;

const EXAMPLES = [
  ['can we squeeze in a QA pass for three days once Build wraps up? Ana can own it', 'add QA pass 3 days after Build and give it to Ana'],
  ['push the launch out to march 3rd', 'move Launch to March 3'],
  ["build is gonna take a week", 'make Build 5 days'],
  ['Ana wrapped up the design work', 'Design is 100% done'],
  ["what's going to make us late?", "what's on the critical path?"],
  ['design has to be finished before build can start', 'link Design to Build'],
  ['we need a sign-off milestone after launch', 'add Sign-off milestone after Launch'],
  ['are we over budget, what does this cost', 'how much does it cost?'],
];

export class Brain {
  constructor() { this.worker = null; this.seq = 0; this.waiting = new Map(); this.ready = false; }

  // Was the model downloaded before (or is it in the offline package)? Then no need to ask first.
  async known() {
    try { if (localStorage.getItem(FLAG) === 'on') return true; } catch { /* storage blocked */ }
    try { return (await fetch(new URL('../../models/onnx-community/Qwen2.5-0.5B-Instruct/config.json', import.meta.url), { method: 'HEAD' })).ok; }
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
    this.device = r.device;
    try { localStorage.setItem(FLAG, 'on'); } catch { /* per-viewer convenience only */ }
    return r;
  }

  // Returns { command, ms }.
  async rewrite(text, project) {
    const names = project.tasks.slice(0, 80).map((t, i) => `${i + 1}. ${t.name || 'Untitled'}`).join('\n');
    const messages = [{ role: 'system', content: `${SYSTEM}\n\nTasks:\n${names || '(none yet)'}` }];
    EXAMPLES.forEach(([u, a]) => messages.push({ role: 'user', content: u }, { role: 'assistant', content: a }));
    messages.push({ role: 'user', content: text });
    const r = await this.call('ask', { messages, maxTokens: 40 });
    return { command: r.text.split('\n')[0].replace(/^["'`]+|["'`]+$/g, '').trim(), ms: r.ms };
  }
}
