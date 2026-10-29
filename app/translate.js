// English → Japanese translation with the browser's built-in, on-device Translator API
// (Chrome / Edge desktop). Text never leaves the device; the language pack is downloaded once.
// Results are cached per text and can be corrected by the learner; corrections win.

const KEY = 'readflow:tr:';
const INDEX = 'readflow:tr-index';   // machine translations in insertion order, for eviction
const MAX_MACHINE = 1500;            // keeps the cache far below the localStorage quota
const memory = new Map();
const pending = new Map();           // one request per text, shared by every caller
let translator = null, creating = null;

export function hashText(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}${s.length.toString(36)}`;
}
const norm = (s) => s.replace(/\s*\/+\s*/g, ' ').replace(/\s+/g, ' ').trim();
const keyOf = (text) => hashText(norm(text));

function readIndex() { try { return JSON.parse(localStorage.getItem(INDEX) || '[]'); } catch { return []; } }
function writeIndex(ix) { try { localStorage.setItem(INDEX, JSON.stringify(ix)); } catch { /* ignore */ } }
// Drop the oldest machine translations (never the learner's own) to make room.
function evict(count) {
  const ix = readIndex();
  for (const k of ix.splice(0, count)) {
    try { const v = JSON.parse(localStorage.getItem(KEY + k) || 'null'); if (v && !v.edited) localStorage.removeItem(KEY + k); } catch { /* ignore */ }
    memory.delete(k);
  }
  writeIndex(ix);
}

// Cached translation: { ja, edited } or null.
export function cached(text) {
  const k = keyOf(text);
  if (memory.has(k)) return memory.get(k);
  try { const v = JSON.parse(localStorage.getItem(KEY + k) || 'null'); if (v) memory.set(k, v); return v; } catch { return null; }
}
export function store(text, ja, edited = false) {
  const k = keyOf(text), v = { ja, edited };
  memory.set(k, v);
  const put = () => localStorage.setItem(KEY + k, JSON.stringify(v));
  try { put(); }
  catch { try { evict(300); put(); } catch { return v; } }   // storage full: prune once, else keep in memory only
  if (!edited) {
    const ix = readIndex().filter(x => x !== k); ix.push(k);
    writeIndex(ix);
    if (ix.length > MAX_MACHINE) evict(ix.length - MAX_MACHINE);
  }
  return v;
}
export function forget(text) {
  const k = keyOf(text);
  memory.delete(k);
  try { localStorage.removeItem(KEY + k); } catch { /* ignore */ }
}

// 'available' | 'downloadable' | 'downloading' | 'unavailable' | 'unsupported'
export async function status() {
  if (!('Translator' in self)) return 'unsupported';
  try {
    // Some embedded Chromium builds expose the API but never answer; treat a hang as unavailable.
    return await Promise.race([
      Translator.availability({ sourceLanguage: 'en', targetLanguage: 'ja' }),
      new Promise(res => setTimeout(() => res('unavailable'), 4000)),
    ]);
  } catch { return 'unavailable'; }
}

// Must be called from a click when the pack is not downloaded yet (the API needs user activation).
// Some browsers accept create() but never deliver the pack; give up when the download makes no
// progress for STALL_MS. After the download completes, setup may be silent for a while: allow more.
const STALL_MS = 60000, SETUP_MS = 300000;
export async function ready(onProgress) {
  if (translator) return translator;
  if (!creating) {
    const ctrl = new AbortController();
    let timer, failStall;
    const stall = new Promise((_, reject) => { failStall = reject; });
    const arm = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => { ctrl.abort(); const e = new Error('翻訳データの準備が進みません'); e.name = 'StallError'; failStall(e); }, ms);
    };
    arm(STALL_MS);
    const created = Translator.create({
      sourceLanguage: 'en', targetLanguage: 'ja', signal: ctrl.signal,
      monitor(m) { m.addEventListener('downloadprogress', (e) => { arm(e.loaded >= 1 ? SETUP_MS : STALL_MS); onProgress?.(e.loaded); }); },
    });
    creating = Promise.race([created, stall])
      .then(t => (translator = t))
      .finally(() => { clearTimeout(timer); creating = null; });
  }
  return creating;
}

// ---- AI backend (Claude in the claude.ai link version, or Gemini with the learner's key: app/ai.js) ----
// Inside a claude.ai artifact the browser translator is not available, but the page may ask
// Claude through the `sample` capability, on the viewer's own account (first use asks consent), or
// Gemini when the learner chose it in 「AIの設定」. Requests made in the same tick for the same
// paragraph are sent as ONE call, with the whole paragraph as context, so slash chunks are translated in context.
import { useClaude, isClaude, claudeJson, aiJson, aiActive, providerErrorText } from './ai.js';
export { useClaude, isClaude, claudeJson };
let contextOf = () => '';
export function setContextLookup(fn) { contextOf = fn; }

const batches = new Map();   // context paragraph -> { items: Map(text -> {resolve, reject}) }
function claudeTranslate(text) {
  const ctx = contextOf(text) || text;
  let b = batches.get(ctx);
  if (!b) {
    b = { items: new Map() };
    batches.set(ctx, b);
    queueMicrotask(() => { batches.delete(ctx); runBatch(ctx, b.items); });
  }
  return new Promise((resolve, reject) => {
    const prev = b.items.get(text);
    if (prev) prev.waiters.push({ resolve, reject }); else b.items.set(text, { waiters: [{ resolve, reject }] });
  });
}
function settle(entry, fn, value) { for (const w of entry.waiters) w[fn](value); }
function runBatch(ctx, items) {
  const texts = [...items.keys()];
  queue = queue.then(async () => {
    const todo = texts.filter(t => !cached(t));
    for (const t of texts) if (cached(t)) settle(items.get(t), 'resolve', cached(t));
    if (!todo.length) return;
    const prompt = [
      'You translate an English university-entrance-exam passage into Japanese for a Japanese high-school student practising slash reading.',
      'Context paragraph (for meaning only):', ctx, '',
      'Translate EACH item below into natural Japanese that fits this context. Items are whole sentences or short phrase chunks taken in order from the paragraph.',
      'For a chunk, translate only that chunk, keeping the English word order of meaning (前から順に意味を取る直訳寄り), short, without adding content from other chunks.',
      'Keep blank markers like "[ 15 ]" or "( A )" as they are. Reply with ONLY a JSON array of strings, one per item, same order and length.',
      '', 'Items:', JSON.stringify(todo.map(norm)),
    ].join('\n');
    try {
      const out = await aiJson(prompt, { modelTier: 'quick', cache: { gcTime: 86400000 } });
      if (!Array.isArray(out) || out.length !== todo.length) throw Object.assign(new Error('翻訳結果の形式が合いませんでした'), { code: 'invalid_json' });
      todo.forEach((t, i) => settle(items.get(t), 'resolve', store(t, String(out[i] ?? '').trim(), false)));
    } catch (e) {
      const err = Object.assign(new Error(providerErrorText(e?.code)), { code: e?.code || 'upstream_error' });
      for (const t of todo) settle(items.get(t), 'reject', err);
    }
  });
}
// Kept for older callers: the messages of the selected provider.
export const claudeErrorText = providerErrorText;

let queue = Promise.resolve();
// Translate one piece of text. Requests run one at a time (the engine is sequential), and
// concurrent requests for the same text share one job.
export function translate(text) {
  const hit = cached(text);
  if (hit) return Promise.resolve(hit);
  const k = keyOf(text);
  if (pending.has(k)) return pending.get(k);
  if (aiActive()) {
    const job = claudeTranslate(text).finally(() => pending.delete(k));
    pending.set(k, job);
    return job;
  }
  const job = queue.then(async () => {
    const again = cached(text);
    if (again) return again;
    const t = await ready();
    const ja = (await t.translate(norm(text))).trim();
    return store(text, ja, false);
  }).finally(() => pending.delete(k));
  pending.set(k, job);
  queue = job.catch(() => {});
  return job;
}
