// slsrc.js - 区切りの作り方: 自動（rule-based, app/chunker.js） or AI（Claude re-makes the slashes of the whole passage）.
// Mirrors the 構文マーク source switch (app/sxsrc.js). Claude only chooses WHERE the slashes go: it gets the
// words with their global indices and answers with indices ("a slash after word i"); the slashed text is then
// rebuilt with fromTokens() from the passage's own tokens, so the words can never change. Everything keyed by
// word index / words hash (構文マーク, わかりにくい marks, translations) stays valid.
// Storage: readflow:aislash:<wordsHash>:<level> = the AI result for that passage and level (no second call),
// readflow:slsrc:<wordsHash> = the level whose AI slashes are on screen (absent = 自動),
// readflow:slpref = 'ai' when 「区切りを提案する」 in step ④ should use AI.
// Sentences the AI could not do keep the rule-based slashes. Uses the AI chosen in 「AIの設定」 (app/ai.js).
import { chunkText, tokensWithBoundaries, fromTokens } from './chunker.js';
import { aiReady, aiJson, aiWhyNot, aiBusyText, aiName, onAiChange } from './ai.js';
import { sentencesOf } from './sxsrc.js';
import { aiErrorText } from './sxai.js';

const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const BATCH_WORDS = 150, BATCH_SENTS = 8, CONCURRENCY = 2, TIMEOUT = 180000;
const LEVELS = ['fine', 'standard', 'coarse'];
const LEVEL_JA = { fine: '細かめ', standard: '標準', coarse: '大きめ' };
const LEVEL_LEN = { fine: '2-5 words (about 3)', standard: '3-8 words (about 5)', coarse: '5-13 words (about 8)' };
const recKey = (key, level) => `readflow:aislash:${key}:${level}`, srcKey = (key) => `readflow:slsrc:${key}`, PREF = 'readflow:slpref';
const NOTE = 'AIの区切りも正解は1つではありません。';

let ctx = null;   // { state, setSlashed(text, edited), ask, wordsHash, level() }
// run: the AI job in progress ({ key, level, rec, sents, todo, done, failed, ctrls, cancelled }).
let run = null;
const ui = { why: aiWhyNot(), msg: '', err: '', lastFailed: [], lastKey: '' };

// ---- passage, storage ----
function passage(slashed) {
  const paras = tokensWithBoundaries(slashed || '');
  const words = paras.flat().map(t => t.word);
  return { paras, words, key: words.length ? ctx.wordsHash(words) : '', sents: sentencesOf(paras), plain: paras.map(ts => ts.map(t => t.word).join(' ')).join('\n\n') };
}
function loadRec(key, level, n) {
  try {
    const r = JSON.parse(localStorage.getItem(recKey(key, level)) || 'null');
    if (!r || r.n !== n || !r.breaks || typeof r.breaks !== 'object') return null;
    const ints = (a) => (Array.isArray(a) ? a.filter(Number.isInteger) : []);
    const breaks = {}, major = {};
    for (const [i, b] of Object.entries(r.breaks)) { breaks[i] = ints(b); major[i] = ints(r.major?.[i]); }
    return { breaks, major, at: r.at || 0, n, level, failed: ints(r.failed) };
  } catch { return null; }
}
function saveRec(key, rec) { try { localStorage.setItem(recKey(key, rec.level), JSON.stringify({ breaks: rec.breaks, major: rec.major, at: rec.at, n: rec.n, failed: rec.failed })); } catch { /* ignore */ } }
function dropRec(key, level) { try { localStorage.removeItem(recKey(key, level)); } catch { /* ignore */ } }
function loadChoice(key) { try { const v = localStorage.getItem(srcKey(key)); return LEVELS.includes(v) ? v : ''; } catch { return ''; } }
function saveChoice(key, level) { try { if (level) localStorage.setItem(srcKey(key), level); else localStorage.removeItem(srcKey(key)); } catch { /* ignore */ } }
function loadPref() { try { return localStorage.getItem(PREF) === 'ai' ? 'ai' : 'auto'; } catch { return 'auto'; } }
function savePref(v) { try { if (v === 'ai') localStorage.setItem(PREF, 'ai'); else localStorage.removeItem(PREF); } catch { /* ignore */ } }
const recFor = (key, level, n) => (run && run.key === key && run.level === level ? run.rec : loadRec(key, level, n));
const usable = (rec) => rec && rec.failed.length < rec.n;

// ---- building slashed text (words never change) ----
// The rule-based slashes of `level` for these words, with the AI's breaks put on the sentences `rec` has.
function build(p, level, rec) {
  const paras = tokensWithBoundaries(chunkText(p.plain, level));
  if (rec) setBreaks(paras, p.sents, rec, p.sents.map((_, i) => i).filter(i => !rec.failed.includes(i)));
  return checked(p, fromTokens(paras));
}
// Put the AI breaks of sentences `idx` onto token paragraphs (in place).
function setBreaks(paras, sents, rec, idx) {
  const flat = paras.flat();
  for (const i of idx) {
    const s = sents[i], b = new Set(rec.breaks[i] || []);
    if (!s) continue;
    for (let w = s.start; w < s.end; w++) if (flat[w]) flat[w].slashAfter = b.has(w);
  }
}
// Guard: the rebuilt text must have exactly the same words (else keep the old text).
function checked(p, text) {
  const w = tokensWithBoundaries(text).flat().map(t => t.word);
  return w.length === p.words.length && w.every((x, i) => x === p.words[i]) ? text : null;
}

// 「大きな区切りだけ」: breaks the coarse rule level keeps; for sentences with AI slashes, the AI's clause-level
// breaks instead. Used by main.js renderReader and print.js. `paras` = tokensWithBoundaries(state.slashed).
export function majorBreaks(paras) {
  const plain = paras.map(ts => ts.map(t => t.word).join(' ')).join('\n\n');
  const major = new Set();
  let k = 0;
  for (const ts of tokensWithBoundaries(chunkText(plain, 'coarse'))) for (const t of ts) { if (t.slashAfter) major.add(k); k++; }
  if (!ctx) return major;
  const words = paras.flat().map(t => t.word);
  const key = words.length ? ctx.wordsHash(words) : '';
  const level = key && (loadChoice(key) || (run && run.key === key ? run.level : ''));
  if (!level) return major;
  const sents = sentencesOf(paras), rec = recFor(key, level, sents.length);
  if (!rec) return major;
  sents.forEach((s, i) => {
    if (rec.failed.includes(i) || !rec.major[i]) return;
    for (let w = s.start; w < s.end; w++) major.delete(w);
    for (const w of rec.major[i]) major.add(w);
  });
  return major;
}

// ---- UI ----
export function initSlSrc(c) {
  ctx = c;
  document.querySelectorAll('[data-slsrc]').forEach(b => b.onclick = () => choose(b.dataset.slsrc));
  document.querySelectorAll('[data-slpref]').forEach(b => b.onclick = () => { if (!b.disabled) { savePref(b.dataset.slpref); refreshSlSrc(); } });
  document.querySelectorAll('.slsrc').forEach(seg => seg.addEventListener('keydown', (e) => {   // radiogroup arrows
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const bs = [...seg.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
    if (i < 0 || bs.length < 2) return;
    e.preventDefault(); bs[(i + 1) % bs.length].focus(); bs[(i + 1) % bs.length].click();
  }));
  $('#level')?.addEventListener('change', refreshSlSrc);
  document.addEventListener('reader:rendered', refreshSlSrc);
  if (LINK) aiReady().then(() => { ui.why = aiWhyNot(); refreshSlSrc(); });
  onAiChange(() => { ui.why = aiWhyNot(); refreshSlSrc(); });
  refreshSlSrc();
}
const level = () => (LEVELS.includes(ctx.level()) ? ctx.level() : 'standard');

// Called by main.js right after 「区切りを提案する」 put the rule-based slashes on screen (after its own
// confirm). With the step ④ choice AI: the stored AI slashes, or (allowCall, i.e. that button) ask Claude.
export async function afterPropose({ allowCall = true } = {}) {
  const { state } = ctx;
  const p = passage(state.slashed);
  if (!p.key) return;
  if (run) cancel(true);
  ui.msg = ''; ui.err = ''; ui.lastFailed = [];
  if (loadPref() !== 'ai' || ui.why) { saveChoice(p.key, ''); refreshSlSrc(); return; }
  const lv = level(), rec = loadRec(p.key, lv, p.sents.length);
  if (usable(rec)) { const t = build(p, lv, rec); if (t) { saveChoice(p.key, lv); ctx.setSlashed(t, false); return; } }
  if (!allowCall) {
    saveChoice(p.key, ''); ui.lastKey = p.key;
    ui.msg = '本文が変わったので、自動の区切りにしました。「AI」を押すとAIで区切り直します。';
    refreshSlSrc(); return;
  }
  await start(p, lv, p.sents.map((_, i) => i), null);
}

async function choose(src) {
  const { state } = ctx;
  if (!state.slashed) return;
  const p = passage(state.slashed);
  const cur = currentSrc(p.key);
  savePref(src);
  if (src === cur && !(src === 'ai' && loadChoice(p.key) !== level() && !run)) { refreshSlSrc(); return; }
  if (src === 'auto') {
    if (state.slashEdited && !(await ctx.ask('手で直した区切りを、自動の区切りで置き換えますか？', '置き換える'))) { refreshSlSrc(); return; }
    if (run && run.key === p.key) cancel(true);
    saveChoice(p.key, ''); ui.msg = ''; ui.err = ''; ui.lastFailed = [];
    ctx.setSlashed(chunkText(p.plain, level()), false);
    return;
  }
  if (ui.why || (run && run.key === p.key)) { refreshSlSrc(); return; }
  if (state.slashEdited && !(await ctx.ask('手で直した区切りを、AIの区切りで置き換えますか？', '置き換える'))) { refreshSlSrc(); return; }
  const lv = level(), rec = loadRec(p.key, lv, p.sents.length);
  if (usable(rec)) {                                  // made before: reuse, no call
    const t = build(p, lv, rec);
    if (t) { saveChoice(p.key, lv); ui.msg = ''; ui.err = ''; ui.lastFailed = []; ctx.setSlashed(t, false); return; }
  }
  await start(p, lv, p.sents.map((_, i) => i), null);
}
function currentSrc(key) { return (run && run.key === key) || loadChoice(key) ? 'ai' : 'auto'; }

// Make (or remake) the AI slashes of the sentences `todo` (indices into p.sents). Call from a click.
// prev: the AI record to start from (remake / retry); null = a fresh run on top of the rule-based slashes.
async function start(p, lv, todo, prev, { rebuild = true } = {}) {
  ui.msg = aiBusyText(); ui.err = ''; ui.lastFailed = []; ui.lastKey = p.key;
  refreshSlSrc();
  if (!(await aiReady())) {
    ui.why = aiWhyNot(); ui.msg = ''; ui.err = aiErrorText('unavailable') + '。';
    refreshSlSrc(); return;
  }
  const rec = prev || { breaks: {}, major: {}, at: Date.now(), n: p.sents.length, level: lv, failed: p.sents.map((_, i) => i) };
  const me = run = { key: p.key, level: lv, rec, sents: p.sents, todo, done: 0, failed: [], ctrls: new Set(), cancelled: false, errCode: '' };
  saveChoice(p.key, lv);
  // The rule-based slashes of this level (plus the AI ones already made) under the sentences still to come.
  if (rebuild) { const t = build(p, lv, prev); if (t) ctx.setSlashed(t, false); else refreshSlSrc(); }
  else refreshSlSrc();
  const batches = makeBatches(p.sents, todo);
  let next = 0;
  const worker = async () => {
    while (next < batches.length && !me.cancelled) {
      const b = batches[next++];
      try {
        const got = await askBatch(b, me);
        if (me.cancelled) return;
        applyBatch(me, b, got);
      } catch (e) {
        if (me.cancelled) return;
        console.error(e);
        me.failed.push(...b); me.errCode ||= e?.code || '';
      }
      me.done += b.length;
      if (run === me) refreshSlSrc();
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

// The slash-reading conventions taught in Japanese high schools.
export const SLASH_RULES = [
  'Slash reading (スラッシュリーディング) as taught in Japanese high schools: the student reads the sentence from left to right in chunks of meaning (意味のまとまり), understanding each chunk in English word order without going back. A slash goes between two chunks.',
  'Where to put a slash (when the chunk before it would otherwise be long enough):',
  '- at commas, semicolons, colons and dashes (after the word that carries the punctuation);',
  '- after a long subject, before its verb ("The students who studied abroad / improved quickly"); not after a short subject like "He" or "The boy";',
  '- before a relative pronoun / relative adverb (who, which, that, where, when, whose...) that starts a relative clause;',
  '- before a that-clause or wh-clause that is an object or complement ("Scientists believe / that ...", "I wonder / why ...");',
  '- before a subordinate conjunction (because, when, if, although, while, since, as, until, before, after, so that, even though...);',
  '- before a coordinating conjunction (and, but, or, so) that joins clauses or long phrases;',
  '- before a prepositional phrase when the chunk would get long ("He studied / in the library / after school");',
  '- before a to-infinitive phrase and before a participle (-ing / -ed) phrase or 分詞構文, when it starts a new piece of meaning;',
  '- after an introductory adverbial phrase ("In the 19th century, / ...").',
  'Never split: article/determiner + noun ("the / book"), adjective + noun, auxiliary + verb ("can / be"), a phrasal verb ("give up", "look after"), a fixed expression ("as well as", "according to", "in spite of", "a lot of", "at the same time"), "to" + its verb, a preposition from its object. Never put a slash after the last word of a sentence.',
];
function batchPrompt(b, sents, lv) {
  const paras = [...new Set(b.map(i => sents[i].p))];
  const context = paras.map(p => sents.filter(s => s.p === p).map(s => s.words.join(' ')).join(' ')).join('\n\n');
  const list = b.map(i => {
    const s = sents[i];
    return `S${i + 1} (words ${s.start}-${s.end}): ${s.words.map((w, k) => `${s.start + k}:${w}`).join(' ')}`;
  }).join('\n');
  return [
    'You are an experienced English teacher at a Japanese high school. Put slashes (/) into the sentences below, taken from an English reading passage, for a student practising slash reading and reading aloud (音読).',
    '',
    ...SLASH_RULES,
    '',
    `Chunk size for this student (区切りの細かさ: ${LEVEL_JA[lv]}): chunks of ${LEVEL_LEN[lv]}. A very short sentence may have no slash at all.`,
    'Each word is written as index:word (punctuation is attached to the word). A slash "after word i" goes between word i and word i+1. Use only the indices given, and never the last index of a sentence.',
    'Also say which of your slashes are major (clause-level) boundaries: the ones a more advanced reader would still keep (between clauses, after a long subject, at punctuation).',
    '',
    'Paragraph(s) the sentences come from (context only):', context, '',
    'Sentences:', list, '',
    'Reply with ONLY a JSON object: {"sentences":[{"id":"S1","breaks":[<index of the word a slash comes after>, ...],"major":[<subset of breaks>]}]}',
    `Include every sentence id above (${b.map(i => `S${i + 1}`).join(', ')}), with an empty "breaks" array if it needs no slash. No explanations.`,
  ].join('\n');
}
// Keep integer indices inside the sentence and not at its last word; sorted, no duplicates.
export function validateBreaks(raw, start, end) {
  if (!Array.isArray(raw)) return null;
  const out = new Set();
  for (const x of raw) {
    const n = typeof x === 'string' && /^\s*\d+\s*$/.test(x) ? Number(x) : x;
    if (Number.isInteger(n) && n >= start && n < end) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}
async function askBatch(b, me) {
  const ctrl = new AbortController(); me.ctrls.add(ctrl);
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT);
  try {
    const out = await Promise.race([
      aiJson(batchPrompt(b, me.sents, me.level), { modelTier: 'complex', signal: ctrl.signal }),
      new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: me.cancelled ? 'cancelled' : 'timeout' })))),
    ]);
    // {"sentences":[{id, breaks, major}]} (asked for), or a flat {"breaks":[...]} / [...] for the whole batch.
    const got = new Map();
    const take = (i, br, mj) => {
      const s = me.sents[i], breaks = validateBreaks(br, s.start, s.end);
      if (!breaks) return;
      const set = new Set(breaks);
      got.set(i, { breaks, major: (validateBreaks(mj, s.start, s.end) || []).filter(w => set.has(w)), hasMajor: Array.isArray(mj) });
    };
    if (out && Array.isArray(out.sentences)) {
      for (const s of out.sentences) {
        const i = parseInt(String(s?.id ?? '').replace(/^S/i, ''), 10) - 1;
        if (b.includes(i)) take(i, s.breaks, s.major);
      }
    } else {
      const flat = Array.isArray(out) ? out : out && Array.isArray(out.breaks) ? out.breaks : null;
      if (flat) for (const i of b) take(i, flat, out?.major);
    }
    if (!got.size) throw Object.assign(new Error('bad reply'), { code: 'invalid_json' });
    return got;
  } finally { clearTimeout(timer); me.ctrls.delete(ctrl); }
}
// New AI breaks for some sentences: patch only those sentences of the slashes on screen.
function applyBatch(me, b, got) {
  const { rec, sents } = me;
  const ok = b.filter(i => got.has(i));
  me.failed.push(...b.filter(i => !got.has(i)));
  if (!ok.length) return;
  for (const i of ok) {
    const g = got.get(i);
    rec.breaks[i] = g.breaks;
    if (g.hasMajor) rec.major[i] = g.major; else delete rec.major[i];
  }
  rec.failed = rec.failed.filter(i => !ok.includes(i));
  rec.at = Date.now();
  saveRec(me.key, rec);
  const { state } = ctx;
  const p = passage(state.slashed);
  if (p.key !== me.key) return;
  setBreaks(p.paras, sents, rec, ok);
  const t = checked(p, fromTokens(p.paras));
  if (t) ctx.setSlashed(t, state.slashEdited);
}
function finish(me) {
  const failed = [...new Set(me.failed)].sort((a, b) => a - b);
  ui.lastFailed = failed;
  const made = me.todo.length - failed.length;
  if (!failed.length) { ui.msg = `AIが ${made}文の区切りを作りました。`; ui.err = ''; }
  else {
    ui.msg = made ? `AIが ${made}文の区切りを作りました。` : '';
    ui.err = `${sentNames(failed)}はAIで区切れませんでした${me.rec.failed.some(i => failed.includes(i)) ? '（自動の区切りのまま）' : '（前のAIの区切りのまま）'}。${aiErrorText(me.errCode)}。`;
  }
  if (me.rec.failed.length === me.rec.n) { dropRec(me.key, me.level); saveChoice(me.key, ''); }
  else saveRec(me.key, me.rec);
  refreshSlSrc();
}
function sentNames(idx) {
  const s = idx.slice(0, 6).map(i => i + 1).join('・');
  return `第${s}文${idx.length > 6 ? ` ほか${idx.length - 6}文` : ''}`;
}
// quiet: switching to 自動 / a new passage while running.
function cancel(quiet) {
  const me = run; if (!me) return;
  me.cancelled = true; run = null;
  for (const c of me.ctrls) c.abort('cancelled');
  const none = me.rec.failed.length === me.rec.n;
  if (none) { dropRec(me.key, me.level); saveChoice(me.key, ''); }
  ui.err = ''; ui.lastFailed = [];
  if (quiet) { ui.msg = ''; return; }
  ui.msg = none ? '中止しました。自動の区切りのままです。' : '中止しました。区切り終わった文だけAIの区切りになっています。';
  refreshSlSrc();
}
async function retry() {
  const p = passage(ctx.state.slashed), lv = loadChoice(p.key) || level();
  const rec = recFor(p.key, lv, p.sents.length);
  const todo = ui.lastKey === p.key && ui.lastFailed.length ? ui.lastFailed : rec?.failed || [];
  if (todo.length) await start(p, lv, todo, rec, { rebuild: false });   // keep the slashes on screen (and hand edits)
}
async function remake() {
  const { state } = ctx;
  const p = passage(state.slashed), lv = level();
  if (state.slashEdited && !(await ctx.ask('AIで全文の区切りを作り直します。手で直した区切りは消えます。よろしいですか？', '作り直す'))) return;
  await start(p, lv, p.sents.map((_, i) => i), loadChoice(p.key) === lv ? recFor(p.key, lv, p.sents.length) : null);
}

// Called after every reader render ('reader:rendered'), on progress and when the level changes.
export function refreshSlSrc() {
  if (!ctx) return;
  const { state } = ctx;
  const p = state.slashed ? passage(state.slashed) : null;
  const key = p?.key || '';
  if (run && key !== run.key) cancel(true);          // the words changed: a new passage starts from its own choice
  const running = run && run.key === key ? run : null;
  const src = key ? currentSrc(key) : 'auto';
  const aiLevel = key ? (running?.level || loadChoice(key)) : '';
  const why = ui.why;
  const pref = loadPref();
  // Step ④: which way 「区切りを提案する」 works.
  document.querySelectorAll('[data-slpref]').forEach(b => {
    const on = b.dataset.slpref === (why ? 'auto' : pref);
    b.setAttribute('aria-checked', on); b.tabIndex = on ? 0 : -1;
    if (b.dataset.slpref === 'ai') { b.disabled = !!why; b.title = why || `AI（${aiName()}）が意味のまとまりで区切ります。少し時間がかかります`; }
  });
  const pw = $('#slPrefWhy');
  if (pw) { pw.textContent = why ? why : pref === 'ai' ? `AIが「${LEVEL_JA[level()]}」の細かさで区切ります（同じ英文・細かさの2回目からは保存した区切りを使います）。${NOTE}` : ''; pw.hidden = !pw.textContent; }
  // Step ⑤
  document.querySelectorAll('[data-slsrc]').forEach(b => {
    b.setAttribute('aria-checked', b.dataset.slsrc === src);
    b.tabIndex = b.dataset.slsrc === src ? 0 : -1;
    if (b.dataset.slsrc === 'ai') { b.disabled = !!why || !state.slashed; b.title = why || `AI（${aiName()}）が全文を意味のまとまりで区切り直します。少し時間がかかります`; }
    else b.disabled = !state.slashed;
  });
  const ed = $('#editSlash'); if (ed) ed.disabled = !!running;   // the text editor would fight the incoming slashes
  const box = $('#slSrcStatus');
  if (!box) return;
  const lvNow = level();
  let h = '';
  if (why) h += `<span class="hint">${esc(why)}</span>`;
  if (running) {
    h += `<span class="sxsrc-prog" role="status">AIで区切り直し中… ${running.done}/${running.todo.length}文<span class="hint">（できた文から表示します）</span></span>
      <button class="btn sm" data-slsrcact="cancel">中止</button>`;
  } else if (src === 'ai') {
    const rec = recFor(key, aiLevel, p.sents.length);
    if (ui.lastKey === key && (ui.msg || ui.err)) {
      if (ui.msg) h += `<span class="sxsrc-msg">${esc(ui.msg)}</span>`;
      if (ui.err) h += `<span class="sxsrc-err">${esc(ui.err)}</span>`;
    } else if (rec?.at) h += `<span class="hint">AIの区切り（${LEVEL_JA[aiLevel]}・${fmtTime(rec.at)}に作成・この端末に保存）${state.slashEdited ? '＋手で調整' : ''}</span>`;
    if (rec && ((ui.lastKey === key && ui.lastFailed.length) || rec.failed.length)) {
      if (!(ui.lastKey === key && ui.err) && rec.failed.length) h += `<span class="sxsrc-err">${esc(sentNames(rec.failed))}は自動の区切りです。</span>`;
      h += '<button class="btn sm" data-slsrcact="retry">再試行</button>';
    }
    if (aiLevel !== lvNow) h += `<span class="hint">区切りの細かさが「${LEVEL_JA[lvNow]}」に変わっています。</span>`;
    if (!why) h += `<button class="btn sm sxsrc-again" data-slsrcact="remake">AIでもう一度区切り直す${aiLevel !== lvNow ? `（${LEVEL_JA[lvNow]}）` : ''}</button>`;
    h += `<span class="hint">${NOTE}</span>`;
  } else if (ui.lastKey === key && (ui.msg || ui.err)) {
    if (ui.msg) h += `<span class="sxsrc-msg">${esc(ui.msg)}</span>`;
    if (ui.err) h += `<span class="sxsrc-err">${esc(ui.err)}</span>`;
  } else if (run) h += '<span class="hint">別の英文のAIの区切りを作っています…</span>';
  box.innerHTML = h;
  box.hidden = !h || !state.slashed;
  box.querySelectorAll('[data-slsrcact]').forEach(b => b.onclick = () => {
    const a = b.dataset.slsrcact;
    if (a === 'cancel') cancel(false);
    else if (a === 'retry') retry();
    else if (a === 'remake') remake();
  });
}
function fmtTime(t) {
  const d = new Date(t), p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const slSrcRunning = () => !!run;
