// sxsrc.js - マークの作り方: 自動（rule-based, app/syntax.js） or AI（Claude re-makes the marks of the whole passage）.
// The AI result is stored per passage (readflow:aimarks:<key>) so reopening the passage does not call Claude again,
// and the choice per passage in readflow:sxsrc:<key>. The learner's own corrections are kept per source by main.js
// (readflow:marks:<key> for 自動, readflow:marks:ai:<key> for AI). Sentences the AI could not do keep the
// rule-based marks. Uses the AI chosen in 「AIの設定」 (Claude / Gemini: app/ai.js).
import { MARK_TYPES } from './syntax.js';
import { aiReady, aiJson, aiWhyNot, aiBusyText, aiName, onAiChange } from './ai.js';
import { MARK_RULES, validateMarks, aiErrorText } from './sxai.js';

const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BATCH_WORDS = 150, BATCH_SENTS = 8, CONCURRENCY = 2, TIMEOUT = 180000;
const recKey = (key) => `readflow:aimarks:${key}`, srcKey = (key) => `readflow:sxsrc:${key}`;

let ctx = null;   // { state, renderReader, rebase, useSource, sxSetEdits, saveSxSettings, currentPassage, ask }
// run: the AI job in progress ({ key, rec, sents, todo, done, failed, ctrls, cancelled }).
// ui.why: why AI cannot be used ('' = usable). ui.msg / ui.lastFailed: result of the last run.
let run = null;
const ui = { why: aiWhyNot(), msg: '', err: '', lastFailed: [], lastKey: '' };

// ---- sentences and storage ----
// paras: tokensWithBoundaries() output. Sentence = [start, end] global word indices (same split as syntax.analyze).
export function sentencesOf(paras) {
  const out = [];
  let base = 0;
  paras.forEach((para, p) => {
    let s = 0;
    para.forEach((t, k) => {
      if (t.sentenceEnd || k === para.length - 1) {
        out.push({ start: base + s, end: base + k, p, words: para.slice(s, k + 1).map(x => x.word) });
        s = k + 1;
      }
    });
    base += para.length;
  });
  return out;
}
function loadRec(key, n) {
  try {
    const r = JSON.parse(localStorage.getItem(recKey(key)) || 'null');
    if (!r || !Array.isArray(r.marks) || r.n !== n) return null;
    return { marks: r.marks.filter(m => MARK_TYPES.includes(m.type)), at: r.at || 0, n, failed: (r.failed || []).filter(Number.isInteger) };
  } catch { return null; }
}
function saveRec(key, rec) { try { localStorage.setItem(recKey(key), JSON.stringify({ marks: rec.marks.map(({ type, start, end }) => ({ type, start, end })), at: rec.at, n: rec.n, failed: rec.failed })); } catch { /* ignore */ } }
function loadChoice(key) { try { return localStorage.getItem(srcKey(key)) === 'ai' ? 'ai' : 'auto'; } catch { return 'auto'; } }
function saveChoice(key, src) { try { if (src === 'ai') localStorage.setItem(srcKey(key), 'ai'); else localStorage.removeItem(srcKey(key)); } catch { /* ignore */ } }
// The record for this passage: the one being made right now, or the stored one.
function recFor(key, n) { return run && run.key === key ? run.rec : loadRec(key, n); }

// Called by main.js when the analysis of a passage is ready: which source to show, and the AI record.
export function sourceFor(key, sents) {
  const ai = recFor(key, sents.length);
  return { ai, src: loadChoice(key) === 'ai' && ai ? 'ai' : 'auto' };
}
// AI marks, plus the rule-based marks of the sentences the AI has not made (failed / not yet / cancelled).
export function mergeAi(autoMarks, rec, sents) {
  if (!rec?.failed.length) return rec.marks;
  const keep = rec.failed.map(i => sents[i]).filter(Boolean);
  const inKeep = (m) => keep.some(s => m.start >= s.start && m.end <= s.end);
  return [...rec.marks.filter(m => !inKeep(m)), ...autoMarks.filter(inKeep)].sort((a, b) => a.start - b.start || b.end - a.end);
}

// ---- UI ----
export function initSxSrc(c) {
  ctx = c;
  document.querySelectorAll('[data-sxsrc]').forEach(b => b.onclick = () => choose(b.dataset.sxsrc));
  const seg = $('.sxsrc');
  seg?.addEventListener('keydown', (e) => {          // radiogroup arrows
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const bs = [...seg.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    if (i < 0 || bs.length < 2) return;
    e.preventDefault(); bs[(i + 1) % bs.length].focus();
  });
  // The link version may still be unable to reach Claude (not logged in): say so before the learner tries.
  if (LINK) aiReady().then(() => { ui.why = aiWhyNot(); refreshSxSrc(); });
  onAiChange(() => { ui.why = aiWhyNot(); refreshSxSrc(); });
}

async function choose(src) {
  const { state } = ctx;
  if (!state.slashed) return;
  const { key, sents } = ctx.currentPassage();
  if (src === 'auto') {
    if (run && run.key === key) cancel(true);
    saveChoice(key, 'auto'); ui.msg = ''; ui.err = '';
    ctx.useSource('auto', recFor(key, sents.length));
    return;
  }
  if (ui.why || (run && run.key === key)) return;
  ensureTypes();
  const rec = loadRec(key, sents.length);
  if (rec && rec.failed.length < rec.n) {               // made before: reuse, no call
    saveChoice(key, 'ai'); ui.msg = ''; ui.err = ''; ui.lastFailed = [];
    ctx.useSource('ai', rec);
    return;
  }
  await start(key, sents, sents.map((_, i) => i), null);
}
// The marks are drawn only for the checked types: make sure the AI's work is visible.
function ensureTypes() {
  const { state } = ctx;
  if (state.sx.on.size) return;
  for (const t of ['rel', 'noun', 'adv']) { state.sx.on.add(t); const cb = document.querySelector(`[data-sx="${t}"]`); if (cb) cb.checked = true; }
  ctx.saveSxSettings();
}

// Make (or remake) the AI marks of the sentences `todo` (indices into sents). Call from a click.
async function start(key, sents, todo, rec) {
  ui.msg = aiBusyText(); ui.err = ''; ui.lastFailed = [];
  refreshSxSrc();
  if (!(await aiReady())) {
    ui.why = aiWhyNot();
    ui.msg = ''; ui.err = aiErrorText('unavailable') + '。'; ui.lastKey = key; ctx.renderReader(); return;
  }
  rec ||= recFor(key, sents.length) || { marks: [], at: Date.now(), n: sents.length, failed: sents.map((_, i) => i) };
  const me = run = { key, rec, sents, todo, done: 0, failed: [], ctrls: new Set(), cancelled: false, errCode: '' };
  ui.lastKey = key;
  saveChoice(key, 'ai');
  ctx.useSource('ai', rec);
  const batches = makeBatches(sents, todo);
  let next = 0;
  const worker = async () => {
    while (next < batches.length && !me.cancelled) {
      const b = batches[next++];
      try {
        const got = await askBatch(b, sents, me);
        if (me.cancelled) return;
        applyBatch(me, b, got);
      } catch (e) {
        if (me.cancelled) return;
        console.error(e);
        me.failed.push(...b); me.errCode ||= e?.code || '';
      }
      me.done += b.length;
      if (run === me) refreshSxSrc();
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
  if (run !== me) return;            // cancelled (cancel() reports) or replaced
  run = null;
  finish(me);
}
function makeBatches(sents, todo) {
  const out = [];
  let cur = [], words = 0;
  for (const i of todo) {
    const n = sents[i].words.length;
    if (cur.length && (cur.length >= BATCH_SENTS || words + n > BATCH_WORDS)) { out.push(cur); cur = []; words = 0; }
    cur.push(i); words += n;
  }
  if (cur.length) out.push(cur);
  return out;
}
function batchPrompt(b, sents) {
  const paras = [...new Set(b.map(i => sents[i].p))];
  const context = paras.map(p => sents.filter(s => s.p === p).map(s => s.words.join(' ')).join(' ')).join('\n\n');
  const list = b.map(i => {
    const s = sents[i];
    return `S${i + 1} (words ${s.start}-${s.end}): ${s.words.map((w, k) => `${s.start + k}:${w}`).join(' ')}`;
  }).join('\n');
  return [
    'You are an experienced English teacher at a Japanese high school. Put sentence-structure marks (構文マーク) on the sentences below, taken from an English reading passage, so that a student can see the structure while reading aloud.',
    '',
    ...MARK_RULES,
    '',
    'Rules: in each sentence, mark EVERY clause and phrase of these kinds (including nested ones: a clause inside another clause gets its own mark). Bracket spans (rel, noun, adv, post) may nest but must never cross. A mark never goes beyond its own sentence. Use only the word indices given (each word is written as index:word).',
    '',
    'Paragraph(s) the sentences come from (context only):', context, '',
    'Sentences:', list, '',
    'Reply with ONLY a JSON object: {"sentences":[{"id":"S1","marks":[{"type":"rel|noun|adv|post|subj|verb","start":<index>,"end":<index>}]}]}',
    `Include every sentence id above (${b.map(i => `S${i + 1}`).join(', ')}), with an empty "marks" array if it has nothing to mark. No explanations.`,
  ].join('\n');
}
async function askBatch(b, sents, me) {
  const ctrl = new AbortController(); me.ctrls.add(ctrl);
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT);
  try {
    const out = await Promise.race([
      aiJson(batchPrompt(b, sents), { modelTier: 'complex', signal: ctrl.signal }),
      new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: me.cancelled ? 'cancelled' : 'timeout' })))),
    ]);
    // {"sentences":[{id, marks}]} (asked for), or a flat {"marks":[...]} / [...] for the whole batch.
    const got = new Map();
    if (out && Array.isArray(out.sentences)) {
      for (const s of out.sentences) {
        const i = parseInt(String(s?.id ?? '').replace(/^S/i, ''), 10) - 1;
        if (b.includes(i) && Array.isArray(s.marks)) got.set(i, s.marks);
      }
    } else {
      const flat = Array.isArray(out) ? out : out && Array.isArray(out.marks) ? out.marks : null;
      if (flat) for (const i of b) got.set(i, flat);
    }
    if (!got.size) throw Object.assign(new Error('bad reply'), { code: 'invalid_json' });
    return got;
  } finally { clearTimeout(timer); me.ctrls.delete(ctrl); }
}
function applyBatch(me, b, got) {
  const { rec, sents } = me;
  const ok = b.filter(i => got.has(i));
  me.failed.push(...b.filter(i => !got.has(i)));
  if (!ok.length) return;
  const inOk = (m) => ok.some(i => m.start >= sents[i].start && m.end <= sents[i].end);
  const fresh = ok.flatMap(i => validateMarks(got.get(i), sents[i].start, sents[i].end));
  rec.marks = [...rec.marks.filter(m => !inOk(m)), ...fresh].sort((a, b2) => a.start - b2.start || b2.end - a.end);
  rec.failed = rec.failed.filter(i => !ok.includes(i));
  rec.at = Date.now();
  saveRec(me.key, rec);
  if (ctx.state.sx.key === me.key && ctx.state.sx.src === 'ai') ctx.rebase();
}
function finish(me) {
  const failed = [...new Set(me.failed)].sort((a, b) => a - b);
  ui.lastFailed = failed;
  const made = me.todo.length - failed.length;
  if (!failed.length) { ui.msg = `AIが ${made}文のマークを作りました。`; ui.err = ''; }
  else {
    ui.msg = made ? `AIが ${made}文のマークを作りました。` : '';
    ui.err = `${sentNames(failed)}はAIで作れませんでした${me.rec.failed.some(i => failed.includes(i)) ? '（自動のマークのまま）' : '（前のAIのマークのまま）'}。${aiErrorText(me.errCode)}。`;
  }
  if (me.rec.failed.length === me.rec.n) { try { localStorage.removeItem(recKey(me.key)); } catch { /* ignore */ } }
  else saveRec(me.key, me.rec);
  if (ctx.state.sx.key === me.key && ctx.state.sx.src === 'ai') ctx.rebase(); else refreshSxSrc();
}
function sentNames(idx) {
  const s = idx.slice(0, 6).map(i => i + 1).join('・');
  return `第${s}文${idx.length > 6 ? ` ほか${idx.length - 6}文` : ''}`;
}
// quiet: switching to 自動 while running.
function cancel(quiet) {
  const me = run; if (!me) return;
  me.cancelled = true; run = null;
  for (const c of me.ctrls) c.abort('cancelled');
  const none = me.rec.failed.length === me.rec.n;
  if (none) { try { localStorage.removeItem(recKey(me.key)); } catch { /* ignore */ } }
  ui.err = ''; ui.lastFailed = [];
  if (quiet) { ui.msg = ''; return; }
  if (none) {
    // Nothing was made: back to 自動.
    saveChoice(me.key, 'auto'); ui.msg = '中止しました。自動のマークを表示しています。';
    ctx.useSource('auto', null);
    return;
  }
  ui.msg = '中止しました。作り終わった文だけAIのマークになっています。';
  ctx.rebase();
}
async function retry() {
  const { key, sents } = ctx.currentPassage();
  const rec = recFor(key, sents.length);
  const todo = ui.lastKey === key && ui.lastFailed.length ? ui.lastFailed : rec?.failed || [];
  if (todo.length) await start(key, sents, todo, rec);
}
async function remake() {
  const { state } = ctx;
  const { key, sents } = ctx.currentPassage();
  if (state.sx.src === 'ai' && state.sx.key === key && (state.sx.edits?.removed?.length || state.sx.edits?.added?.length)) {
    if (!(await ctx.ask('AIで全文のマークを作り直します。AIのマークに自分で加えた修正は消えます。よろしいですか？', '作り直す'))) return;
    ctx.sxSetEdits(null);
  }
  await start(key, sents, sents.map((_, i) => i), recFor(key, sents.length));
}

// Called after every reader render (from sxUpdateUi) and on progress.
export function refreshSxSrc() {
  if (!ctx) return;
  const { state } = ctx;
  const seg = $('.sxsrc');
  if (!seg) return;
  const key = state.slashed ? ctx.currentPassage().key : '';
  if (run && key && key !== run.key) cancel(true);   // the words changed: a new passage starts from its own choice
  const running = run && run.key === key ? run : null;
  const src = state.sx.key === key ? state.sx.src : running ? 'ai' : 'auto';
  seg.querySelectorAll('[data-sxsrc]').forEach(b => {
    b.setAttribute('aria-checked', b.dataset.sxsrc === src);
    b.tabIndex = b.dataset.sxsrc === src ? 0 : -1;
    if (b.dataset.sxsrc === 'ai') { b.disabled = !!ui.why || !state.slashed; b.title = ui.why || `AI（${aiName()}）が全文の構文マークを作り直します。少し時間がかかります`; }
    else b.disabled = !state.slashed;
  });
  const box = $('#sxSrcStatus');
  if (!box) return;
  let h = '';
  if (ui.why) h += `<span class="hint">${esc(ui.why)}</span>`;
  if (running) {
    h += `<span class="sxsrc-prog" role="status">AIで作り直し中… ${running.done}/${running.todo.length}文<span class="hint">（できた文から表示します）</span></span>
      <button class="btn sm" data-sxsrcact="cancel">中止</button>`;
  } else if (src === 'ai' && state.sx.key === key && state.sx.ai) {
    const rec = state.sx.ai;
    if (ui.lastKey === key && (ui.msg || ui.err)) {
      if (ui.msg) h += `<span class="sxsrc-msg">${esc(ui.msg)}</span>`;
      if (ui.err) h += `<span class="sxsrc-err">${esc(ui.err)}</span>`;
    } else if (rec.at) h += `<span class="hint">AIのマーク（${fmtTime(rec.at)}に作成・この端末に保存）</span>`;
    if ((ui.lastKey === key && ui.lastFailed.length) || rec.failed.length) {
      if (!(ui.lastKey === key && ui.err) && rec.failed.length) h += `<span class="sxsrc-err">${esc(sentNames(rec.failed))}は自動のマークです。</span>`;
      h += `<button class="btn sm" data-sxsrcact="retry">再試行</button>`;
    }
    h += `<button class="btn sm sxsrc-again" data-sxsrcact="remake">AIでもう一度作り直す</button>`;
  } else if (ui.lastKey === key && (ui.msg || ui.err)) {
    if (ui.msg) h += `<span class="sxsrc-msg">${esc(ui.msg)}</span>`;
    if (ui.err) h += `<span class="sxsrc-err">${esc(ui.err)}</span>`;
  } else if (!running && run) h += '<span class="hint">別の英文のAIマークを作っています…</span>';
  box.innerHTML = h;
  box.hidden = !h || !state.slashed;
  box.querySelectorAll('[data-sxsrcact]').forEach(b => b.onclick = () => {
    const a = b.dataset.sxsrcact;
    if (a === 'cancel') cancel(false);
    else if (a === 'retry') retry();
    else if (a === 'remake') remake();
  });
}
function fmtTime(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const sxSrcRunning = (key) => !!(run && run.key === key);
