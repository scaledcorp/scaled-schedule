// Reading files in the browser: text in either UTF-8 or the Windows encoding older tools write,
// and zip archives (.xlsx, .pptx and .docx are zips of XML). Nothing here touches the network.

export function decodeText(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
  catch { return new TextDecoder('windows-1252').decode(buf); }
}

const u16 = (v, o) => v.getUint16(o, true);
const u32 = (v, o) => v.getUint32(o, true);

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Returns { names, has(name), bytes(name), text(name) } for a zip held in memory.
export function unzip(buf) {
  const data = new Uint8Array(buf), v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (u32(v, i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error("This file isn't a readable zip archive.");
  const entries = new Map(), utf8 = new TextDecoder();
  let p = u32(v, end + 16);
  for (let n = u16(v, end + 10); n > 0 && u32(v, p) === 0x02014b50; n--) {
    const nameLen = u16(v, p + 28), extra = u16(v, p + 30), comment = u16(v, p + 32);
    const name = utf8.decode(data.subarray(p + 46, p + 46 + nameLen));
    entries.set(name.replace(/^\//, ''), { method: u16(v, p + 10), size: u32(v, p + 20), local: u32(v, p + 42) });
    p += 46 + nameLen + extra + comment;
  }
  const bytes = async name => {
    const e = entries.get(name.replace(/^\//, ''));
    if (!e) return null;
    const start = e.local + 30 + u16(v, e.local + 26) + u16(v, e.local + 28);
    const raw = data.subarray(start, start + e.size);
    if (e.method === 0) return raw;
    if (e.method === 8) return inflate(raw);
    throw new Error('This file uses a zip compression the browser cannot read.');
  };
  return {
    names: [...entries.keys()],
    has: name => entries.has(name.replace(/^\//, '')),
    bytes,
    text: async name => { const b = await bytes(name); return b == null ? null : utf8.decode(b); },
  };
}

// Child elements by local name, ignoring XML namespaces.
export const kids = (el, name) => (el ? [...el.children].filter(n => n.localName === name) : []);
export const kid = (el, name) => kids(el, name)[0];
export const txt = (el, name, dflt = '') => kid(el, name)?.textContent.trim() ?? dflt;

export function parseXML(text, what) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (!doc.documentElement || doc.querySelector('parsererror')) throw new Error(`This ${what} couldn't be read.`);
  return doc;
}
