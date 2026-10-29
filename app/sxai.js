// sxai.js - 構文マークをAIに聞いて直す (ask Claude to check the marks of one sentence).
// Flow: 「AIに聞く」 -> click a sentence in the reader -> (optional note) 「この文をAIに聞く」 -> Claude returns
// corrected marks for the whole sentence -> before/after preview -> 「この案を反映」 turns the difference into
// ordinary mark edits (removeMark/addMark), so it is saved with the learner's own corrections and can be
// undone with 「元に戻す」 or 「自動のマークに戻す」. Uses the AI chosen in 「AIの設定」 (Claude / Gemini: app/ai.js).
import { MARK_TYPES, MARK_INFO, decorations, removeMark, addMark, markId, splitPunct } from './syntax.js';
import { aiReady, aiJson, aiBusyText, aiTimeoutText, aiUnavailableText, providerErrorText } from './ai.js';

const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link';
const BRACKETS = ['rel', 'noun', 'adv', 'post'];
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s) => document.querySelector(s);

let ctx = null;          // { state, renderReader, sxSetEdits, saveSxSettings }
// ui.mode: 'off' | 'pick' | 'ready' (sentence chosen) | 'busy' | 'proposal' | 'applied'
const ui = { mode: 'off', key: '', start: -1, end: -1, words: [], para: '', paraBase: 0, proposal: null, undo: null, msg: '', note: '' };

export function initSxAi(c) {
  ctx = c;
  const btn = $('#sxAiAsk');
  if (!btn) return;
  btn.onclick = () => (ui.mode === 'pick' ? close() : startPick());
  // Capture on document so it runs before the reader's own capture handlers (mark editing, 品詞, 訳).
  document.addEventListener('click', onPickClick, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.mode === 'pick') { close(); return; }
    if (ui.mode !== 'pick' || (e.key !== 'Enter' && e.key !== ' ')) return;
    const s = e.target.closest?.('#reader .sent'); if (!s) return;
    e.preventDefault(); e.stopImmediatePropagation(); pickSentence(s);
  }, true);
}

// Called after every reader render (from sxUpdateUi).
export function refreshSxAi() {
  if (!ctx) return;
  const { state } = ctx;
  const btn = $('#sxAiAsk');
  if (btn) {
    btn.hidden = !state.slashed;
    btn.setAttribute('aria-pressed', ui.mode === 'pick');
    btn.textContent = ui.mode === 'pick' ? '文を選ぶのをやめる' : 'この文だけAIに聞く';
    btn.disabled = ui.mode === 'busy';
  }
  const reader = $('#reader');
  reader.classList.toggle('sxai-picking', ui.mode === 'pick');
  reader.querySelectorAll('.sent').forEach(s => {
    if (ui.mode === 'pick') { s.tabIndex = 0; s.setAttribute('role', 'button'); }
    else if (s.getAttribute('role') === 'button') { s.removeAttribute('tabindex'); s.removeAttribute('role'); }
    s.classList.remove('sxai-target');
  });
  // The words changed (new text or analysis): the chosen sentence no longer exists.
  if (ui.mode !== 'off' && (!state.slashed || !state.sx.on.size && state.sx.pos === 'off' || ui.mode !== 'pick' && state.sx.key !== ui.key)) { close(); return; }
  if (ui.start >= 0 && ui.mode !== 'off' && ui.mode !== 'pick') reader.querySelector(`.w[data-i="${ui.start}"]`)?.closest('.sent')?.classList.add('sxai-target');
  render();
}

function startPick() {
  const { state } = ctx;
  ui.mode = 'pick'; ui.proposal = null; ui.undo = null; ui.msg = ''; ui.start = ui.end = -1;
  // The analysis runs only while a mark type is on: turn on the clause marks the learner asked about.
  if (!state.sx.on.size) {
    for (const t of ['noun', 'adv']) { state.sx.on.add(t); const cb = document.querySelector(`[data-sx="${t}"]`); if (cb) cb.checked = true; }
    ctx.saveSxSettings();
  }
  ctx.renderReader();
}
function close() {
  Object.assign(ui, { mode: 'off', start: -1, end: -1, proposal: null, undo: null, msg: '', note: '' });
  ctx.renderReader();
}

function onPickClick(e) {
  if (ui.mode !== 'pick') return;
  const s = e.target.closest?.('#reader .sent');
  if (!s || e.target.closest('.gap, .ja-pop, .cu-ja, .ja-sent')) return;
  e.preventDefault(); e.stopImmediatePropagation();
  pickSentence(s);
}
function pickSentence(s) {
  const { state } = ctx;
  if (!state.sx.auto) { ui.msg = '構文の解析が終わるまで少し待ってから、もう一度クリックしてください。'; render(); return; }
  const ws = [...s.querySelectorAll('.w')];
  if (!ws.length) return;
  const p = s.closest('p'), pw = [...p.querySelectorAll('.w')];
  Object.assign(ui, {
    mode: 'ready', key: state.sx.key, start: +ws[0].dataset.i, end: +ws[ws.length - 1].dataset.i,
    words: ws.map(w => w.dataset.word || w.textContent), para: pw.map(w => w.dataset.word || w.textContent).join(' '),
    paraBase: +pw[0].dataset.i, proposal: null, undo: null, msg: '', note: '',
  });
  ctx.renderReader();
  $('#sxAi')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

const inSentence = (m) => m.start >= ui.start && m.end <= ui.end;
const currentMarks = () => ctx.state.sx.marks.filter(inSentence).map(({ type, start, end }) => ({ type, start, end }));
const wordAt = (i) => ui.words[i - ui.start] ?? '';
const spanText = (m) => ui.words.slice(m.start - ui.start, m.end - ui.start + 1).join(' ');

// ---- Claude ----
// The mark conventions, shared with the whole-passage remake (app/sxsrc.js).
export const MARK_RULES = [
  'Mark types (Japanese school-grammar conventions). Every span is a range of word indices [start, end], inclusive. Punctuation is attached to words, so just use the word indices.',
  '- rel  { } 関係詞節: a relative clause modifying a preceding noun (先行詞). Starts at the relative word (who, whom, whose, which, that, where, when, why) or at the preposition before it ("in which"). For a contact clause with the relative pronoun omitted ("the book I read"), start at the clause\'s subject. Ends at the last word of the clause.',
  '- noun [ ] 名詞節: a clause that works as a noun: subject, object, complement, or object of a preposition. Starts with that / whether / if (=whether) / what / an interrogative word (who, how, why, where, when, which...) / -ever words. The appositive that-clause after nouns like fact, idea, belief, news (同格の that 節) is also noun. Includes the conjunction; an omitted "that" object clause ("I think he is right") starts at its subject.',
  '- adv  ＜＞ 副詞節: a clause working as an adverb: when, while, because, since, as, if, unless, although, though, even if, even though, before, after, until, once, whereas, so that, in order that, as soon as, etc. Includes the conjunction (multi-word conjunctions start at their first word). For so/such ... that (結果), mark only the that-clause, starting at "that". A comparative "than/as" clause is not marked.',
  '- post ( ) 後置修飾: a participle phrase (-ing / -ed) or to-infinitive phrase that modifies the noun right before it ("people living in cities", "a chance to speak"). NOT prepositional phrases, NOT clauses (those are rel), NOT 分詞構文 or adverbial to-infinitives.',
  '- subj 長い主語 (underline): the complete subject of a MAIN clause, including all its modifiers, only when it is long (4+ words, or it contains a phrase or clause). Do not mark short subjects like "He" or "The students".',
  '- verb V 述語動詞: the finite verb group of each MAIN clause, including auxiliaries ("has been made", "can be", "did not know" -> mark from the first auxiliary to the main verb). Not verbs inside subordinate clauses or phrases. Coordinated main clauses each get their own verb mark.',
];
function buildPrompt(marks, note) {
  const list = ui.words.map((w, k) => `${ui.start + k}: ${w}`).join('\n');
  const cur = marks.length
    ? marks.map(m => `- ${m.type} (${MARK_INFO[m.type].name}) ${m.start}-${m.end}: "${spanText(m)}"`).join('\n')
    : '(none)';
  return [
    `You are an experienced English teacher at a Japanese high school, checking sentence-structure marks (構文マーク) that ${ctx.state.sx.src === 'ai' ? 'an AI' : 'a rule-based program'} put on one sentence of an English reading passage. A student thinks some marks may be wrong.`,
    '',
    ...MARK_RULES,
    '',
    'Rules: mark EVERY clause and phrase of these kinds in the sentence (including nested ones: a clause inside another clause gets its own mark). Bracket spans (rel, noun, adv, post) may nest but must never cross. Keep the existing marks that are already correct with exactly the same indices. Use only word indices from the list below.',
    '',
    'Whole paragraph (context only):', ui.para, '',
    `The sentence to check, as "index: word" (indices ${ui.start}-${ui.end}):`, list, '',
    'Current marks on this sentence:', cur, '',
    `Student's comment: ${note ? note : '(none)'}`,
    'The student may be right or wrong; judge by grammar, and if the student is wrong, explain kindly why.',
    '',
    'Reply with ONLY a JSON object: {"marks":[{"type":"rel|noun|adv|post|subj|verb","start":<index>,"end":<index>}], "explanation_ja":"..."}',
    '"marks" is the complete corrected set for this sentence (all six types). "explanation_ja" is 2-4 short sentences of plain Japanese for a high-school student: which clause does what job (例: that 以下は動詞 believe の目的語になる名詞節), what you changed and why. If the current marks are already correct, say so.',
  ].join('\n');
}

// Keep only well-formed marks inside the sentence; bracket spans must nest (wider ones win on a cross).
export function validateMarks(raw, start, end) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set(), spans = new Set(), out = [];
  const ok = raw.map(m => ({ type: String(m?.type || '').trim(), start: Number(m?.start), end: Number(m?.end) }))
    .filter(m => MARK_TYPES.includes(m.type) && Number.isInteger(m.start) && Number.isInteger(m.end) && m.start >= start && m.end <= end && m.start <= m.end)
    .sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const br = [];
  for (const m of ok) {
    if (seen.has(markId(m))) continue;
    if (BRACKETS.includes(m.type)) {
      const span = `${m.start}-${m.end}`;
      if (spans.has(span)) continue;                    // the same words cannot be two kinds of clause
      if (br.some(b => (m.start < b.start && m.end >= b.start && m.end < b.end) || (m.start > b.start && m.start <= b.end && m.end > b.end))) continue;
      br.push(m); spans.add(span);
    } else if ((m.type === 'subj' || m.type === 'verb') && out.some(o => o.type === m.type && o.start <= m.end && o.end >= m.start)) continue;
    seen.add(markId(m)); out.push(m);
  }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}

export function aiErrorText(code) {
  if (code === 'timeout') return aiTimeoutText();
  if (code === 'invalid_json') return 'AIの答えを読み取れませんでした。もう一度押してください';
  if (code === 'unavailable') return aiUnavailableText();
  if (code === 'refused') return 'この文は答えてもらえませんでした';
  const known = providerErrorText(code), fallback = providerErrorText('');
  return known !== fallback ? known : 'AIに聞けませんでした。もう一度押してください';
}

async function askClaude() {
  const note = ($('#sxAiNote')?.value || '').trim().slice(0, 300);
  ui.note = note;
  const before = currentMarks();
  ui.mode = 'busy'; ui.msg = aiBusyText();
  refreshSxAi();
  try {
    if (!(await aiReady())) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 120000);
    const out = await Promise.race([
      aiJson(buildPrompt(before, note), { modelTier: 'complex', signal: ctrl.signal }),
      new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })))),
    ]).finally(() => clearTimeout(timer));
    if (ui.mode !== 'busy') return;                       // closed meanwhile
    if (!out || typeof out !== 'object' || !Array.isArray(out.marks)) throw Object.assign(new Error('bad'), { code: 'invalid_json' });
    const after = validateMarks(out.marks, ui.start, ui.end);
    const dropped = out.marks.length - after.length;
    ui.proposal = { before, after, explanation: String(out.explanation_ja || '').trim().slice(0, 800), dropped };
    ui.mode = 'proposal'; ui.msg = '';
  } catch (e) {
    console.error(e);
    if (ui.mode !== 'busy') return;
    ui.mode = 'ready'; ui.msg = aiErrorText(e?.code) + '。';
  }
  refreshSxAi();
}

function diff(before, after) {
  const b = new Set(before.map(markId)), a = new Set(after.map(markId));
  return { add: after.filter(m => !b.has(markId(m))), remove: before.filter(m => !a.has(markId(m))) };
}

function apply() {
  const { state } = ctx;
  const p = ui.proposal; if (!p || !state.sx.auto) return;
  const { add, remove } = diff(currentMarks(), p.after);
  const prev = state.sx.edits ? { removed: [...state.sx.edits.removed], added: [...state.sx.edits.added] } : null;
  let e = state.sx.edits;
  for (const m of remove) e = removeMark(e, m);
  for (const m of add) e = addMark(e, m);
  // Show every kind of mark the proposal touched.
  let turned = false;
  for (const m of add) if (!state.sx.on.has(m.type)) {
    state.sx.on.add(m.type); turned = true;
    const cb = document.querySelector(`[data-sx="${m.type}"]`); if (cb) cb.checked = true;
  }
  if (turned) ctx.saveSxSettings();
  ui.undo = prev; ui.mode = 'applied';
  ui.msg = add.length || remove.length ? `反映しました（付けた ${add.length}・外した ${remove.length}）。直した内容はこの端末に保存されます。` : '変更はありませんでした。';
  ctx.sxSetEdits(e);
}
function undo() {
  ui.mode = 'proposal'; ui.msg = '反映を取り消しました。';
  const prev = ui.undo; ui.undo = null;
  ctx.sxSetEdits(prev && (prev.removed.length || prev.added.length) ? prev : null);
}

// ---- rendering ----
// One sentence with brackets, underline and V, as HTML. `hl` = mark ids to emphasise (changed ones).
function preview(marks, enabled, hl = new Set()) {
  const local = marks.map(m => ({ ...m, start: m.start - ui.start, end: m.end - ui.start }));
  const deco = decorations(local, enabled, ui.words.length);
  const br = (m, open) => {
    const id = markId({ type: m.type, start: m.start + ui.start, end: m.end + ui.start });
    return `<span class="sx sx-${m.type}${hl.has(id) ? ' sxai-chg' : ''}">${esc(open ? MARK_INFO[m.type].open : MARK_INFO[m.type].close)}</span>`;
  };
  let h = '';
  ui.words.forEach((w, k) => {
    const d = deco[k];
    const [core, trail] = d.closes.length ? splitPunct(w) : [w, ''];
    const cls = ['w', d.subj ? 'sx-subj' : '', d.verb ? 'sx-verb' : '', d.verb && d.verb.start === k ? 'sx-vstart' : ''].filter(Boolean).join(' ');
    const chg = (d.subj && hl.has(markId({ ...d.subj, start: d.subj.start + ui.start, end: d.subj.end + ui.start }))) || (d.verb && hl.has(markId({ ...d.verb, start: d.verb.start + ui.start, end: d.verb.end + ui.start })));
    h += `<span class="sx-nb">${d.opens.map(m => br(m, true)).join('')}<span class="${cls}${chg ? ' sxai-chgw' : ''}">${esc(core)}</span>${d.closes.map(m => br(m, false)).join('')}${esc(trail)}</span>`;
    if (k < ui.words.length - 1) h += d.subj && deco[k + 1].subj === d.subj ? '<span class="sx-subj"> </span>' : ' ';
  });
  return h;
}
function describe(m) {
  const i = MARK_INFO[m.type];
  const t = spanText(m).replace(/[.,;:!?"'”’]+$/, '');
  return i.open ? `${i.name} ${i.open}${t}${i.close}` : `${i.name}: ${t}`;
}

function render() {
  const box = $('#sxAi');
  if (!box) return;
  const { state } = ctx;
  if (ui.mode === 'off') { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  // Keep a half-typed note across re-renders.
  const typed = $('#sxAiNote')?.value;
  if (typed !== undefined) ui.note = typed;
  if (ui.mode === 'pick') {
    box.innerHTML = `<p class="sxai-lead"><b>この文だけAIに聞く:</b> おかしいと思うマークがある文をクリックしてください。</p>
      ${ui.msg ? `<p class="hint">${esc(ui.msg)}</p>` : ''}
      <div class="row wrap"><button class="btn sm" data-sxai="cancel">やめる</button></div>`;
    wire(box); return;
  }
  const allTypes = new Set(MARK_TYPES);
  const cur = currentMarks();
  let h = `<p class="sxai-lead"><b>この文だけAIに聞く</b>（${ui.start}〜${ui.end}語目の文）</p>`;
  if (ui.mode === 'ready' || ui.mode === 'busy') {
    h += `<p class="sxai-label">いまのマーク</p><p class="sxai-sent" lang="en">${preview(cur, allTypes)}</p>
      <label class="field block sm">どこが変だと思う？（任意）
        <input type="text" id="sxAiNote" maxlength="300" placeholder="例: that 以下は名詞節では？／because の範囲が短い" value="${esc(ui.note)}" ${ui.mode === 'busy' ? 'disabled' : ''}>
      </label>
      <div class="row wrap">
        <button class="btn sm primary" data-sxai="ask" ${ui.mode === 'busy' ? 'disabled' : ''}>この文をAIに聞く</button>
        <button class="btn sm" data-sxai="repick" ${ui.mode === 'busy' ? 'disabled' : ''}>別の文を選ぶ</button>
        <button class="btn sm" data-sxai="cancel">やめる</button>
      </div>`;
  } else {
    const p = ui.proposal;
    const { add, remove } = diff(ui.mode === 'applied' ? p.before : cur, p.after);
    const changed = add.length + remove.length;
    h += `<div class="sxai-cmp">
        <p class="sxai-label">いま</p><p class="sxai-sent" lang="en">${preview(ui.mode === 'applied' ? p.before : cur, allTypes, new Set(remove.map(markId)))}</p>
        <p class="sxai-label">AIの案</p><p class="sxai-sent" lang="en">${preview(p.after, allTypes, new Set(add.map(markId)))}</p>
      </div>`;
    if (changed) {
      h += `<ul class="sxai-diff">${remove.map(m => `<li><span class="sxai-tag sxai-rm">外す</span><span lang="en">${esc(describe(m))}</span></li>`).join('')}${add.map(m => `<li><span class="sxai-tag sxai-add">付ける</span><span lang="en">${esc(describe(m))}</span></li>`).join('')}</ul>`;
    } else h += '<p class="hint">AIの案は、いまのマークと同じです。</p>';
    if (p.explanation) h += `<p class="sxai-expl">${esc(p.explanation)}</p>`;
    if (p.dropped > 0) h += `<p class="hint">形の合わないマーク ${p.dropped}個は使いませんでした。</p>`;
    h += '<p class="hint sxai-warn">AIの説明も間違うことがあります。文法書や先生の説明と照らし合わせてから使ってください。</p><div class="row wrap">';
    if (ui.mode === 'applied') h += `<button class="btn sm" data-sxai="undo">元に戻す</button><button class="btn sm" data-sxai="repick">別の文を聞く</button><button class="btn sm" data-sxai="cancel">閉じる</button>`;
    else h += `${changed ? '<button class="btn sm primary" data-sxai="apply">この案を反映</button>' : ''}<button class="btn sm" data-sxai="again">聞き直す</button><button class="btn sm" data-sxai="cancel">やめる</button>`;
    h += '</div>';
  }
  if (ui.msg) h += `<p class="hint" role="status">${esc(ui.msg)}</p>`;
  if (!state.sx.auto) h += '<p class="hint">構文を解析しています…</p>';
  box.innerHTML = h;
  wire(box);
}
function wire(box) {
  box.querySelectorAll('[data-sxai]').forEach(b => b.onclick = () => {
    const a = b.dataset.sxai;
    if (a === 'cancel') close();
    else if (a === 'repick') startPick();
    else if (a === 'ask') askClaude();
    else if (a === 'again') { ui.mode = 'ready'; ui.proposal = null; ui.msg = ''; refreshSxAi(); $('#sxAiNote')?.focus(); }
    else if (a === 'apply') apply();
    else if (a === 'undo') undo();
  });
  const note = box.querySelector('#sxAiNote');
  if (note) note.onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); askClaude(); } };
}
