// wordtap.js - 語をタップで意味: tap a word in the reader (#reader .w) to see its meaning in a small popover.
// Self-initialising like tts.js (loaded by a module script after main.js). Reads main.js state through
// window.__readflow.state; asks main.js for 「この区切りの訳」 with the 'wordtap:chunk' event (detail = the .w element).
// Meanings: bundled dictionaries (vendor/dict/basic.json + vocab.json via vocab.js lookupAny, loaded on the first tap).
// 「文脈での意味をAIで」: one quick AI call per word in its sentence (the AI chosen in 「AIの設定」: app/ai.js),
// cached in localStorage (readflow:wordai:<sentence hash>:<word index in the sentence>).
import { loadDictAll, lookupAny } from './vocab.js';
import { POS_NAMES } from './syntax.js';
import { hashText } from './translate.js';
import { aiReady, aiJson, aiWhyNot, aiName, aiUsage, aiTimeoutText, aiUnavailableText, providerErrorText, onAiChange } from './ai.js';

const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link';
const PREF = 'readflow:wordtap', AI_KEY = 'readflow:wordai:';
const HAS_TTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
const $ = (s) => document.querySelector(s);
const st = () => window.__readflow?.state || {};
const reader = () => $('#reader');

let on = true;
let pop = null;            // { el, w, i, word, hadTapped, scrollY }
let aiWhy = aiWhyNot();
let aiChecked = false;
onAiChange(() => { aiChecked = false; aiWhy = aiWhyNot(); if (pop) fill(); });
const aiRuns = new Map();  // cache key -> pending promise (one request per word)

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
function btn(label, cls, onclick) {
  const b = el('button', `btn sm ${cls}`, label); b.type = 'button';
  b.onclick = (ev) => { ev.stopPropagation(); onclick(b); };
  return b;
}

// ---------- the checkbox ----------
function initToggle() {
  const cb = $('#wordTap'); if (!cb) return;
  try { on = localStorage.getItem(PREF) !== '0'; } catch { on = true; }
  cb.checked = on;
  cb.onchange = () => {
    on = cb.checked;
    try { localStorage.setItem(PREF, on ? '1' : '0'); } catch { /* ignore */ }
    sync();
    if (!on) close();
  };
  sync();
}
// main.js's 「タップで区切りの訳」 handler leaves word taps to this module while it is on.
function sync() {
  const s = st(); if (s) s.wordTap = on;
  reader()?.classList.toggle('wt-on', on);
}

// ---------- when a tap is ours ----------
function blocked(e) {
  const s = st(), r = reader();
  if (!on || e.defaultPrevented) return true;
  if (s.sx?.edit || r.classList.contains('sx-editing')) return true;          // 構文マークを直す
  if (r.classList.contains('sxai-picking')) return true;                        // 「この文だけAIに聞く」 sentence pick
  if (e.target.closest('.gap, .mk-b, .mk-q, .sx, .ja-pop, .cu-ja, .ja-sent, button, a, input, textarea, select')) return true;
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim()) return true;           // the tap ended a text selection
  return false;
}

function onReaderClick(e) {
  const w = e.target.closest?.('.w');
  if (!w || !reader().contains(w) || blocked(e)) return;
  if (pop && pop.w === w) { close(); return; }                                  // same word again: close
  open(w);
}

// ---------- popover ----------
function close() {
  if (!pop) return;
  if (!pop.hadTapped && pop.w.isConnected) pop.w.classList.remove('tapped');
  pop.el.remove();
  pop = null;
}

function wordsHash(words) {          // same as main.js: tells whether state.sx.auto belongs to these words
  const plain = words.join(' ');
  let h = 2166136261;
  for (let i = 0; i < plain.length; i++) { h ^= plain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${plain.length}`;
}
function posOf(i) {
  const sx = st().sx;
  if (!sx?.auto?.pos || !sx.key) return '';
  const words = [...reader().querySelectorAll('.w')].map(x => x.dataset.word);
  if (wordsHash(words) !== sx.key) return '';
  const p = sx.auto.pos[i];
  return p ? p.split('・').map(x => POS_NAMES[x] || x).join('・') : '';
}
function sentenceOf(w) {
  const s = w.closest('.sent');
  const ws = s ? [...s.querySelectorAll('.w')] : [w];
  return { words: ws.map(x => x.dataset.word), k: Math.max(0, ws.indexOf(w)) };
}

function open(w) {
  close();
  const i = +w.dataset.i, word = w.dataset.word || w.textContent;
  const box = el('div', 'wt-pop');
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', `「${word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')}」の意味`);
  box.lang = 'ja';
  box.addEventListener('click', (ev) => ev.stopPropagation());
  pop = { el: box, w, i, word, hadTapped: w.classList.contains('tapped'), scrollY: scrollY };
  w.classList.add('tapped');
  document.body.append(box);
  box.append(el('p', 'wt-loading hint', '辞書を読み込んでいます…'));
  place();
  const me = pop;
  loadDictAll().then(() => { if (pop === me) fill(); }).catch((err) => {
    if (pop !== me) return;
    fill(err.message || '辞書データを読み込めませんでした');
  });
  if (!aiChecked) {
    aiChecked = true;
    aiReady().then(ok => {
      const was = aiWhy;
      aiWhy = ok ? '' : aiWhyNot() || aiUnavailableText();
      if (pop && aiWhy !== was) fill();
    });
  }
}

function senses(ja) {
  const ol = el('ol', 'wt-senses');
  ja.split(' / ').filter(Boolean).forEach(s => ol.append(el('li', '', s)));
  return ol;
}

// (Re)build the popover's content for pop.w. dictErr: the dictionary failed to load.
function fill(dictErr) {
  if (!pop) return;
  const { el: box, w, i, word } = pop;
  const shown = word.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '') || word;
  const hit = dictErr ? null : lookupAny(word);
  const pos = posOf(i);
  box.textContent = '';

  const head = el('div', 'wt-head');
  const hw = el('span', 'wt-word', shown); hw.lang = 'en';
  head.append(hw);
  if (pos) head.append(el('span', 'wt-pos', pos));
  if (hit?.level) { const lv = el('span', 'wt-lv', hit.level); lv.title = `CEFR ${hit.level}（B2 ≒ 英検準1級程度の目安）`; head.append(lv); }
  const x = btn('×', 'wt-x', close); x.setAttribute('aria-label', '閉じる'); x.title = '閉じる';
  head.append(x);
  box.append(head);

  if (hit?.note) box.append(el('p', 'wt-note', hit.note));
  const plain = shown.toLowerCase().replace(/['’]s$/, '').replace(/-/g, '');
  if (hit && !hit.parts && !hit.note && hit.lemma && hit.lemma.replace(/-/g, '') !== plain) {
    const b = el('p', 'wt-base'); b.append(el('span', 'wt-k', '原形'), ' ');
    const lm = el('b', '', hit.lemma); lm.lang = 'en'; b.append(lm); box.append(b);
  }
  if (dictErr) box.append(el('p', 'wt-none', dictErr));
  else if (!hit) box.append(el('p', 'wt-none', '辞書にありません'));
  else if (hit.parts) {
    box.append(el('p', 'wt-k', 'この形では辞書になく、部分ごとの意味:'));
    const ul = el('ul', 'wt-parts');
    for (const p of hit.parts) {
      const li = el('li'); const b = el('b', '', p.lemma); b.lang = 'en';
      li.append(b, ' ', p.ja ? p.ja.split(' / ').slice(0, 2).join('、') : '（辞書にありません）'); ul.append(li);
    }
    box.append(ul);
  } else {
    box.append(senses(hit.ja));
    for (const a of hit.also || []) {
      const p = el('p', 'wt-also'); const b = el('b', '', a.lemma); b.lang = 'en';
      p.append(el('span', 'wt-k', 'ほかに'), ' ', b, ` ${a.note.replace(new RegExp(`^${a.lemma}\\s*`), '')}: `, a.ja.split(' / ').slice(0, 2).join('、'));
      box.append(p);
    }
  }
  if (hit && !dictErr) box.append(el('p', 'wt-src hint', '辞書の意味です。文脈に合うものを選んでください。'));

  // AI answer (cached) or its slot
  const aiBox = el('div', 'wt-ai'); aiBox.setAttribute('aria-live', 'polite');
  box.append(aiBox);
  const ck = aiKey(w);
  const cachedAi = readAi(ck);
  if (cachedAi) showAi(aiBox, cachedAi, true);
  else if (aiRuns.has(ck)) { aiBox.textContent = `${aiName()} に聞いています…`; waitAi(ck, aiBox); }

  const row = el('div', 'wt-actions');
  if (HAS_TTS) row.append(btn('発音', 'wt-say', () => say(shown)));
  if (!cachedAi) {
    const ai = btn('文脈での意味をAIで', `wt-aibtn${hit ? '' : ' primary'}`, (b) => askAi(b, aiBox));
    if (aiWhy) { ai.disabled = true; ai.title = aiWhy; }
    else ai.title = `この文の中での意味を ${aiName()} に聞きます（送るのはこの1文だけ。${aiUsage()}）`;
    if (aiRuns.has(ck)) ai.disabled = true;
    row.append(ai);
  }
  if (st().ja === 'tap') row.append(btn('この区切りの訳', 'wt-chunk', () => chunk()));
  box.append(row);
  if (!cachedAi && aiWhy) box.append(el('p', 'wt-why hint', aiWhy));
  place();
}

// ---------- 「この区切りの訳」 (タップで区切りの訳 mode) ----------
function chunk() {
  if (!pop) return;
  const w = pop.w, c = w.dataset.c;
  close();
  if (reader().querySelector(`.ja-pop[data-c="${c}"]`)) return;                // already shown
  document.dispatchEvent(new CustomEvent('wordtap:chunk', { detail: w }));
}

// ---------- 発音 ----------
let voice = null;
function pickVoice() {
  if (voice) return voice;
  const vs = speechSynthesis.getVoices();
  voice = vs.find(v => /^en[-_]US/i.test(v.lang) && v.localService) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
  return voice;
}
function say(word) {
  try {
    const t = window.__tts;
    if (t?.play?.status === 'playing') t.pause();                                // お手本の再生は一時停止にする
    // Spoken synchronously inside the tap: iOS (WebKit) ignores a speak() that comes after an await or a timer.
    speechSynthesis.cancel();
    if (speechSynthesis.paused) speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(word);
    const v = pickVoice(); if (v) u.voice = v;
    u.lang = v?.lang || 'en-US'; u.rate = 0.85;
    speechSynthesis.speak(u);
  } catch { /* unsupported: nothing to do */ }
}

// ---------- 文脈での意味をAIで ----------
function aiKey(w) {
  const { words, k } = sentenceOf(w);
  return `${AI_KEY}${hashText(words.join(' '))}:${k}`;
}
function readAi(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }
function writeAi(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* full: keep for this view only */ } }
function aiErrText(code) {
  if (code === 'unavailable') return aiUnavailableText();
  if (code === 'timeout') return aiTimeoutText();
  if (code === 'refused') return 'この語の意味は答えられませんでした';
  if (code === 'invalid_json' || code === 'shape') return 'AIの答えを読み取れませんでした。もう一度押してください';
  const known = providerErrorText(code), fallback = providerErrorText('');
  return known !== fallback ? known : '意味を聞けませんでした。もう一度押してください';
}
function prompt(words, k) {
  const marked = words.map((x, j) => (j === k ? `⟦${x}⟧` : x)).join(' ');
  return [
    'You help a Japanese high-school student who is reading an English university-entrance-exam passage.',
    'Explain the meaning of ONE word as it is used in this sentence.',
    '', `Sentence: ${words.join(' ')}`, `The word is marked with ⟦ ⟧: ${marked}`, `Word: ${words[k]}`, '',
    'Reply with ONLY a JSON object with these keys:',
    '"lemma": the dictionary form of the word (English),',
    '"pos_ja": its part of speech here in Japanese, with the form if useful (e.g. "動詞（過去分詞）", "名詞（複数形）"),',
    '"meaning_ja": its meaning in THIS sentence, short natural Japanese (at most about 25 characters),',
    '"note_ja": one short Japanese note that helps here (an idiom it belongs to, a grammar point, or why the usual meaning does not fit), at most about 60 characters, or "" if nothing is needed.',
  ].join('\n');
}
function askAi(b, aiBox) {
  if (!pop) return;
  const w = pop.w, ck = aiKey(w);
  const { words, k } = sentenceOf(w);
  b.disabled = true;
  aiBox.textContent = `${aiName()} に聞いています…`;
  if (!aiRuns.has(ck)) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 60000);
    const job = Promise.race([
      aiJson(prompt(words, k), { modelTier: 'quick', signal: ctrl.signal }),
      new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })))),
    ]).then((out) => {
      if (!out || typeof out !== 'object' || typeof out.meaning_ja !== 'string' || !out.meaning_ja.trim()) throw Object.assign(new Error('shape'), { code: 'shape' });
      const v = { lemma: String(out.lemma || '').trim(), pos_ja: String(out.pos_ja || '').trim(), meaning_ja: out.meaning_ja.trim(), note_ja: String(out.note_ja || '').trim() };
      writeAi(ck, v);
      return v;
    }).finally(() => { clearTimeout(t); aiRuns.delete(ck); });
    aiRuns.set(ck, job);
  }
  waitAi(ck, aiBox);
}
function waitAi(ck, aiBox) {
  const me = pop;
  aiRuns.get(ck)?.then(() => { if (pop === me) fill(); }).catch((e) => {
    if (['unavailable', 'blocked', 'no_key'].includes(e?.code)) aiWhy = aiErrText(e.code);
    if (pop !== me) return;
    fill();
    const box = pop.el.querySelector('.wt-ai');
    if (box) { box.textContent = ''; box.append(el('p', 'wt-err', aiErrText(e?.code))); }
    place();
  });
}
function showAi(box, v) {
  box.textContent = '';
  const h = el('p', 'wt-ai-h'); h.append(el('span', 'wt-k', 'この文では'), ' ');
  if (v.pos_ja) h.append(el('span', 'wt-pos', v.pos_ja), ' ');
  if (v.lemma) { const b = el('b', '', v.lemma); b.lang = 'en'; h.append(b); }
  box.append(h, el('p', 'wt-ai-m', v.meaning_ja));
  if (v.note_ja) box.append(el('p', 'wt-ai-n', v.note_ja));
  box.append(el('p', 'wt-src hint', 'AIの説明です。間違うことがあります。'));
}

// ---------- position ----------
let saProbe = null;
function safeArea() {                                        // env(safe-area-inset-*) in px, read from a hidden probe
  if (!saProbe) {
    saProbe = document.createElement('div');
    saProbe.setAttribute('aria-hidden', 'true');
    saProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;top:0;left:0;width:0;height:0;'
      + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.append(saProbe);
  }
  const cs = getComputedStyle(saProbe);
  return { left: parseFloat(cs.paddingLeft) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0 };
}
function place() {
  if (!pop) return;
  const { el: box, w } = pop;
  const r = (w.getClientRects()[0] || w.getBoundingClientRect());
  const vw = document.documentElement.clientWidth, vh = innerHeight;
  const bar = $('#ttsBar'), barTop = bar && !bar.hidden ? bar.getBoundingClientRect().top : vh;
  const steps = $('.steps'), topMin = (steps ? Math.max(0, steps.getBoundingClientRect().bottom) : 0) + 6;
  const sa = safeArea();                                     // iPhone landscape: keep clear of the notch / home bar
  const minL = 8 + sa.left, maxR = vw - 8 - sa.right;
  const width = Math.min(vw * 0.92, 360, maxR - minL);
  box.style.width = `${width}px`;
  box.style.maxHeight = '';
  let h = box.offsetHeight;
  let left = r.left + r.width / 2 - width / 2;
  left = Math.max(minL, Math.min(left, maxR - width));
  let top = r.bottom + 6;
  const below = Math.min(barTop, vh - sa.bottom) - 8 - top, above = r.top - 6 - topMin;
  // Short screens (phone landscape): the popover scrolls inside the larger of the two spaces.
  const room = Math.max(below, above);
  if (h > room && room >= 120) { box.style.maxHeight = `${Math.floor(room)}px`; h = box.offsetHeight; }
  if (h > below && above > below) top = Math.max(topMin, r.top - 6 - h);   // flip above the word
  box.classList.toggle('wt-above', top < r.top);
  box.style.left = `${left + scrollX}px`;
  box.style.top = `${top + scrollY}px`;
}

// ---------- wiring ----------
function init() {
  const r = reader(); if (!r) return;
  initToggle();
  r.addEventListener('click', onReaderClick);              // bubble phase: after main.js's capture handlers (構文マーク editing)
  document.addEventListener('click', (e) => {              // outside tap closes
    if (!pop || pop.el.contains(e.target) || e.target === pop.w || pop.w.contains(e.target)) return;
    close();
  });
  // iOS Safari fires no click on the document for a tap on plain, non-clickable content (a paragraph, empty page),
  // so a touch tap (finger down and up in place) outside the popover and outside a word closes it too.
  let down = null;
  document.addEventListener('pointerdown', (e) => { down = e.pointerType === 'mouse' ? null : { x: e.clientX, y: e.clientY }; }, true);
  document.addEventListener('pointerup', (e) => {
    const d = down; down = null;
    if (!pop || !d || e.pointerType === 'mouse' || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 10) return;
    if (pop.el.contains(e.target) || e.target.closest?.('#reader .w, #reader .gap, #reader .mk-b, button, a, input, select, textarea, label')) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pop) close(); });
  addEventListener('scroll', () => {
    if (pop && Math.abs(scrollY - pop.scrollY) > innerHeight * 0.6) close();
  }, { passive: true });
  addEventListener('resize', () => place());
  // The reader is rebuilt after slash / mode changes: keep the popover on the same word if it is still there.
  document.addEventListener('reader:rendered', () => {
    sync();
    if (!pop) return;
    const nw = reader().querySelector(`.w[data-i="${pop.i}"]`);
    if (!nw || nw.dataset.word !== pop.word || reader().hidden || !on || st().sx?.edit) { pop.w = nw || pop.w; close(); return; }
    pop.w = nw; pop.hadTapped = nw.classList.contains('tapped'); nw.classList.add('tapped');
    fill();
  });
  if (HAS_TTS) speechSynthesis.addEventListener?.('voiceschanged', () => { voice = null; });
}
init();

// Test hook.
window.__wordtap = { get open() { return pop ? { i: pop.i, word: pop.word } : null; }, close, get on() { return on; } };
