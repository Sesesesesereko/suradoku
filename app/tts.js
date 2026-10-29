// お手本の読み上げ（区切りごと／文ごと）、一時停止・再開、「わかりにくい」印。
// Self-contained: works on the reader DOM that main.js renders (#reader .w spans with data-i = global
// word index, data-c = chunk index, data-word) and re-applies its classes after every render, which
// main.js announces with a 'reader:rendered' event on document.
//
// Pause does not use speechSynthesis.pause()/resume() (broken on Android Chrome, and Chrome drops long
// paused utterances): it cancels and remembers where it was; resume speaks again from the start of the
// current chunk. Everything is kept as word indices, never element references, because the reader DOM
// is rebuilt often.

const $ = (s) => document.querySelector(s);
const reader = () => $('#reader');
const LAG_MS = 600;            // a わかりにくい press this soon after a new chunk starts means the previous one
const CHUNK_GAP_MS = 180;      // silence between chunks when 区切りごとに間をとる is on
const MARK_GAP_MS = 450;       // silence between chunks in 印の所だけ続けて聞く
const HAS_TTS = 'speechSynthesis' in window && typeof window.SpeechSynthesisUtterance === 'function';

// ---------- passage model (rebuilt from the DOM after each render) ----------
let words = [];        // words[i] = { word, c (chunk), s (sentence) }
let els = [];          // els[i] = the .w element for word i in the current DOM
let key = '';          // hash of the words: identifies the passage

function hashWords(ws) {
  const plain = ws.join(' ');
  let h = 2166136261;
  for (let i = 0; i < plain.length; i++) { h ^= plain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${plain.length}`;
}
function scan() {
  words = []; els = [];
  reader()?.querySelectorAll('.w').forEach((el) => {
    const i = +el.dataset.i;
    els[i] = el;
    words[i] = { word: el.dataset.word || el.textContent, c: +el.dataset.c, s: +(el.closest('.sent')?.dataset.s ?? -1) };
  });
  return words.length ? hashWords(words.map(w => w.word)) : '';
}
// Word indices of the chunk (as the slashes are now) that word i belongs to.
function chunkOf(i) {
  const c = words[i]?.c; if (c == null) return [];
  let a = i, b = i;
  while (a > 0 && words[a - 1]?.c === c) a--;
  while (b < words.length - 1 && words[b + 1]?.c === c) b++;
  return range(a, b);
}
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, k) => a + k);
function groups(prop) {
  const out = []; let cur = null, last = null;
  words.forEach((w, i) => { if (!cur || w[prop] !== last) { cur = []; out.push(cur); last = w[prop]; } cur.push(i); });
  return out;
}
const textOf = (idx) => idx.map(i => words[i]?.word ?? '').join(' ');

// ---------- わかりにくい marks: word ranges [start, end], stored per passage ----------
let marks = [];
const storeKey = () => `readflow:hard:${key}`;
function loadMarks() {
  marks = [];
  if (!key) return;
  try {
    const v = JSON.parse(localStorage.getItem(storeKey()) || 'null');
    if (Array.isArray(v?.r)) marks = normalize(v.r.filter(r => Array.isArray(r) && Number.isInteger(r[0]) && Number.isInteger(r[1]) && r[0] >= 0 && r[1] < words.length && r[0] <= r[1]));
  } catch { marks = []; }
}
function saveMarks() {
  if (!key) return;
  try { if (marks.length) localStorage.setItem(storeKey(), JSON.stringify({ v: 1, r: marks })); else localStorage.removeItem(storeKey()); } catch { /* storage unavailable */ }
}
function normalize(rs) {           // sort and merge overlapping ranges
  const s = rs.map(r => [r[0], r[1]]).sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of s) { const p = out[out.length - 1]; if (p && r[0] <= p[1]) p[1] = Math.max(p[1], r[1]); else out.push(r); }
  return out;
}
function markedSet() { const s = new Set(); for (const [a, b] of marks) for (let i = a; i <= b; i++) s.add(i); return s; }
function addMark(idx) { if (!idx.length) return; marks = normalize([...marks, [idx[0], idx[idx.length - 1]]]); afterMarksChanged(); }
function removeMark(idx) {        // remove the words idx[0]..idx[last] from every range (splitting if needed)
  if (!idx.length) return;
  const a = idx[0], b = idx[idx.length - 1];
  marks = marks.flatMap(([s, e]) => (e < a || s > b) ? [[s, e]] : [...(s < a ? [[s, a - 1]] : []), ...(e > b ? [[b + 1, e]] : [])]);
  afterMarksChanged();
}
function toggleChunkMark(i) {
  const ch = chunkOf(i); if (!ch.length) return;
  const set = markedSet();
  if (ch.some(k => set.has(k))) { removeMark(ch); say(`「${textOf(ch)}」の印を外しました。`); }
  else { addMark(ch); say(`「${textOf(ch)}」に印をつけました。`); }
}
// Current chunks that contain a marked word, in reading order.
function markedChunks() {
  const set = markedSet(), seen = new Set(), out = [];
  [...set].sort((x, y) => x - y).forEach((i) => {
    if (!words[i] || seen.has(words[i].c)) return;
    seen.add(words[i].c); out.push(chunkOf(i));
  });
  return out;
}
function afterMarksChanged() { saveMarks(); paintMarks(); renderList(); }

// The element a marker goes next to: the word, or its bracket wrapper (.sx-nb) so a bracket stays with it.
const holder = (el) => (el.parentElement?.classList.contains('sx-nb') ? el.parentElement : el);
const btnsOn = () => !!$('#mkBtns')?.checked;

// Per-chunk "?" buttons, right after the last word of each chunk (before the slash / sentence end).
// The glyph is CSS content, so copying the text never picks it up; TTS reads only .w data.
function injectChunkButtons() {
  const r = reader(); if (!r) return;
  r.querySelectorAll('.mk-b').forEach(x => x.remove());
  if (!btnsOn()) return;
  for (const ch of groups('c')) {
    const last = ch[ch.length - 1], el = els[last]; if (!el) continue;
    // A span, not a <button>: an inline element never line-wraps away from the word it follows.
    const b = document.createElement('span');
    b.className = 'mk-b'; b.dataset.i = last; b.tabIndex = 0;
    b.setAttribute('role', 'button'); b.setAttribute('aria-pressed', 'false');
    holder(el).after(b);
  }
}
function paintMarks() {
  const r = reader(); if (!r) return;
  r.querySelectorAll('.w.mk').forEach(x => x.classList.remove('mk', 'mk-first'));
  r.querySelectorAll('.mk-q').forEach(x => x.remove());
  const set = markedSet();
  const showQ = !btnsOn();                 // with the per-chunk buttons on, the pressed button is the sign
  for (const ch of markedChunks()) {
    const first = ch.find(k => set.has(k));
    ch.forEach(k => { if (set.has(k)) els[k]?.classList.add('mk'); });
    const el = els[first]; if (!el) continue;
    el.classList.add('mk-first');
    if (!showQ) continue;
    const q = document.createElement('span'); q.className = 'mk-q'; q.textContent = '?'; q.setAttribute('aria-hidden', 'true');
    holder(el).before(q);
  }
  r.querySelectorAll('.mk-b').forEach((b) => {
    const ch = chunkOf(+b.dataset.i), on = ch.some(k => set.has(k));
    const t = textOf(ch);
    b.setAttribute('aria-pressed', on);
    b.setAttribute('aria-label', on ? `「${t}」の印を外す` : `「${t}」をわかりにくいに印`);
    b.title = on ? 'この区切りの印を外す' : 'この区切りを「わかりにくい」に印';
  });
}
function renderList() {
  const box = $('#mkBox'), list = $('#mkList'); if (!box || !list) return;
  const chs = markedChunks();
  box.hidden = !chs.length;
  $('#mkCount').textContent = chs.length;
  list.textContent = '';
  chs.forEach((ch) => {
    const li = document.createElement('li');
    const play = button('▶', 'mk-play', `「${textOf(ch)}」を聞く`, () => start([ch], 'one'));
    const t = document.createElement('span'); t.className = 'mk-text'; t.lang = 'en'; t.textContent = textOf(ch);
    t.onclick = () => { if (play.status !== 'idle') setFollow(false); scrollToWord(ch[0]); };
    const del = button('×', 'mk-del', `「${textOf(ch)}」の印を外す`, () => { removeMark(ch); say('印を外しました。'); });
    li.append(play, t, del);
    list.append(li);
  });
  $('#mkPlayAll').disabled = !chs.length;
}
function button(label, cls, aria, onclick) {
  const b = document.createElement('button'); b.type = 'button'; b.className = `btn sm ${cls}`; b.textContent = label;
  b.setAttribute('aria-label', aria); b.title = aria; b.onclick = onclick; return b;
}
function say(msg) { const el = $('#mkInfo'); if (el) el.textContent = msg; }

// ---------- playback ----------
// queue: units of word indices. pos: current unit. offset: where in the unit to (re)start.
const play = { status: 'idle', queue: [], pos: 0, offset: 0, mode: 'all', key: '', id: 0, voice: null, sentence: false,
  now: [], nowAt: 0, prev: [] };

function info(msg) { const el = $('#ttsInfo'); if (el) el.textContent = msg; }
function updateButtons() {
  const idle = play.status === 'idle';
  for (const p of [$('#pause'), $('#barPause')]) {
    if (!p) continue;
    p.disabled = idle;
    p.textContent = play.status === 'paused' ? '再開' : '一時停止';
    p.setAttribute('aria-pressed', play.status === 'paused');
  }
  for (const st of [$('#stop'), $('#barStop')]) if (st) st.disabled = idle;
  for (const mk of [$('#mkNow'), $('#barMk')]) if (mk) mk.disabled = idle || !play.now.length;
  reader()?.classList.toggle('tts-on', !idle);
  updateBar();
}
function setNow(idx) {
  if (idx.join() === play.now.join()) return;
  if (play.now.length) play.prev = play.now;
  play.now = idx; play.nowAt = performance.now();
  paintNow(true);
  updateButtons();
}
function paintNow(scroll) {
  const r = reader(); if (!r) return;
  r.querySelectorAll('.chunk-now').forEach(x => x.classList.remove('chunk-now'));
  play.now.forEach(i => els[i]?.classList.add('chunk-now'));
  if (scroll && play.status === 'playing' && follow.on && followWanted()) {
    const el = els[play.now[0]];
    if (el && offScreen(el)) scrollToWord(play.now[0]);
  }
}

// ---------- following the reading position without fighting the user ----------
// Auto-scroll only while follow.on. Any scroll the user makes (wheel, touch, scroll keys, scrollbar drag,
// or a scroll event we did not cause) turns it off until 「読んでいる所へ ↑」 or the next play/resume.
const follow = { on: true, progUntil: 0, lastY: 0 };
const followWanted = () => $('#ttsFollow')?.checked !== false;
const barH = () => { const b = $('#ttsBar'); return b && !b.hidden ? b.offsetHeight : 0; };
function offScreen(el) {
  const b = el.getBoundingClientRect();
  return b.top < 70 || b.bottom > innerHeight - barH() - 40;
}
function scrollToWord(i) {
  const el = els[i]; if (!el) return;
  follow.progUntil = performance.now() + 1200;       // scroll events until then are ours
  const b = el.getBoundingClientRect();
  const y = scrollY + b.top - (innerHeight - barH()) / 2 + b.height / 2;
  scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
}
function setFollow(on) {
  if (follow.on === on) return;
  follow.on = on;
  updateBar();
}
function userScrolled() {
  if (play.status === 'idle') return;
  follow.progUntil = 0;                               // a user gesture ends our smooth scroll's grace period
  setFollow(false);
}
function updateBar() {
  const bar = $('#ttsBar'); if (!bar) return;
  const show = play.status !== 'idle';
  if (bar.hidden === show) bar.hidden = !show;
  const back = $('#barBack');
  if (back) back.hidden = !show || (follow.on && followWanted());
  document.body.classList.toggle('tts-bar-on', show);
  document.documentElement.style.setProperty('--tts-bar-h', `${show ? bar.offsetHeight : 0}px`);
}
function backToNow() {
  follow.on = true;
  if (play.now.length) scrollToWord(play.now[0]);
  updateBar();
}

function loadVoices() {
  const v = speechSynthesis.getVoices();
  if (v.length) return Promise.resolve(v);
  return new Promise(res => { const done = () => res(speechSynthesis.getVoices()); speechSynthesis.addEventListener('voiceschanged', done, { once: true }); setTimeout(done, 1500); });
}
const pickVoice = (vs) => vs.find(v => /^en[-_]US/i.test(v.lang) && v.localService) || vs.find(v => /^en[-_]US/i.test(v.lang)) || vs.find(v => /^en/i.test(v.lang)) || null;
function voiceInfo(voices) {
  if (play.voice) info(`音声: ${play.voice.name}（端末の読み上げ機能。発音・区切りは機械的です）`);
  else if (voices.length) info('英語の音声が見つかりません。端末の設定で英語の音声を追加してください（追加するまでは既定の音声で読みます）。');
  else info('端末の既定の英語音声で読みます（端末の読み上げ機能。発音・区切りは機械的です）。');
}
// Synchronous on purpose: iOS Safari (and Chrome on iOS, also WebKit) only lets speechSynthesis start when the first
// speak() runs inside the tap's own task — after an await or a timer it stays silent. So the first unit is spoken
// right away, with the voice list as it is now (often still empty on the first tap on iOS: lang 'en-US' then picks
// the system English voice); a voice list that arrives later is used from the next unit on.
function start(queue, mode) {
  if (!HAS_TTS) { info('このブラウザは読み上げに対応していません。'); return; }
  key = scan() || key;
  queue = queue.filter(u => u.length);
  if (!queue.length) return;
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch { /* ignore */ }   // iOS can be left paused after an interruption
  Object.assign(play, { status: 'playing', queue, pos: 0, offset: 0, mode, key, now: [], prev: [], nowAt: 0 });
  follow.on = true;
  let voices = [];
  try { voices = speechSynthesis.getVoices() || []; } catch { voices = []; }
  play.voice = pickVoice(voices);
  voiceInfo(voices);
  speakCurrent();
  if (!voices.length) {
    const run = play.key;
    loadVoices().then((vs) => {
      if (play.status === 'idle' || play.key !== run || play.voice) return;
      play.voice = pickVoice(vs || []);
      if (play.voice) voiceInfo(vs);
    }).catch(() => { /* keep the default voice */ });
  }
}
function speakCurrent() {
  const id = ++play.id;
  const unit = play.queue[play.pos];
  if (!unit) return finish();
  const part = unit.slice(play.offset);
  if (!part.length) return next(id);
  // Character offset of each word in the utterance text, for onboundary.
  const starts = []; let n = 0;
  part.forEach((i) => { starts.push(n); n += (words[i]?.word ?? '').length + 1; });
  const sentenceUnit = play.sentence && play.mode === 'all';
  // Highlight: a chunk unit is highlighted whole; a sentence unit starts with the chunk of its first word
  // (moved on by word boundaries when the voice reports them), the whole sentence without them.
  const inUnit = (idx) => idx.filter(k => part.includes(k));
  setNow(sentenceUnit ? inUnit(chunkOf(part[0])) : unit);
  let gotBoundary = false;
  const u = new SpeechSynthesisUtterance(textOf(part));
  if (play.voice) u.voice = play.voice;
  u.lang = play.voice?.lang || 'en-US';
  u.rate = +($('#rate')?.value || 0.9);
  if (sentenceUnit) {
    u.onboundary = (e) => {
      if (id !== play.id || (e.name && e.name !== 'word')) return;
      gotBoundary = true;
      let w = 0; while (w + 1 < starts.length && starts[w + 1] <= e.charIndex) w++;
      setNow(inUnit(chunkOf(part[w])));
    };
    // No word boundaries reported shortly after the start: highlight the whole sentence instead.
    setTimeout(() => { if (id === play.id && !gotBoundary && play.status === 'playing') setNow(part); }, 900);
  }
  // Watchdog: WebKit sometimes drops onend (after an interruption such as a call, Siri or the lock screen). When the
  // utterance is long overdue and the engine says it is idle, move on instead of hanging in 「再生中」.
  const due = performance.now() + 4000 + (u.text.length * 110) / Math.max(0.5, u.rate);
  const watch = setInterval(() => {
    if (id !== play.id || play.status !== 'playing') { clearInterval(watch); return; }
    if (performance.now() > due && !speechSynthesis.speaking && !speechSynthesis.pending) { clearInterval(watch); next(id); }
  }, 1000);
  u.onend = () => { clearInterval(watch); if (id === play.id) next(id); };
  u.onerror = (e) => {
    clearInterval(watch);
    if (id !== play.id || e.error === 'interrupted' || e.error === 'canceled') return;
    if (e.error === 'not-allowed') { stop(); info('読み上げを始められませんでした。もう一度「お手本を聞く」を押してください。'); return; }
    stop(); info(`読み上げに失敗しました（${e.error}）。`);
  };
  speechSynthesis.speak(u);
}
function next(id) {
  play.pos++; play.offset = 0;
  if (play.pos >= play.queue.length) return finish();
  const gap = play.mode === 'marks' ? MARK_GAP_MS : (play.sentence && play.mode === 'all') ? 0 : CHUNK_GAP_MS;
  setTimeout(() => { if (id === play.id && play.status === 'playing') speakCurrent(); }, gap);
}
function finish() {
  play.id++;
  Object.assign(play, { status: 'idle', queue: [], pos: 0, offset: 0, now: [], prev: [] });
  paintNow(false); updateButtons();
}
function stop() {
  play.id++;
  try { if (HAS_TTS) speechSynthesis.cancel(); } catch { /* ignore */ }
  finish();
}
function pause() {
  if (play.status !== 'playing') return;
  play.id++;                                          // the cancelled utterance's onend/onerror are ignored
  try { speechSynthesis.cancel(); } catch { /* ignore */ }
  // Resume from the start of the chunk being read (a sentence unit restarts mid-sentence at that chunk).
  const unit = play.queue[play.pos] || [];
  const at = play.now.length ? unit.indexOf(play.now[0]) : -1;
  play.offset = at > 0 ? at : 0;
  play.status = 'paused';
  updateButtons();
  info('一時停止中。「再開」でいまの区切りの頭から読み直します。');
}
function resume() {
  if (play.status !== 'paused') return;
  if (scan() !== play.key) { stop(); info('英文が変わったので、はじめから再生してください。'); return; }
  play.status = 'playing';
  follow.on = true;
  updateButtons();
  try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch { /* ignore */ }
  speakCurrent();                       // synchronous inside the tap (iOS)
  paintNow(true);                       // the same chunk again: bring it back into view if needed
}
function playAll() {
  key = scan() || key;
  play.sentence = !$('#chunkPause')?.checked;
  start(groups(play.sentence ? 's' : 'c'), 'all');
}
function markNow() {
  if (play.status === 'idle' || !play.now.length) return;
  const lag = play.status === 'playing' && play.prev.length && performance.now() - play.nowAt < LAG_MS;
  const target = lag ? play.prev : play.now;
  // A whole-sentence highlight (no word boundaries) is marked chunk by chunk.
  const chunks = new Set(target.map(i => words[i]?.c));
  const set = markedSet();
  const fresh = target.filter(i => !set.has(i));
  if (!fresh.length) { say(`「${textOf(target)}」にはもう印がついています。`); return; }
  if (chunks.size > 1) [...chunks].forEach(c => addMark(target.filter(i => words[i]?.c === c)));
  else addMark(target);
  say(`「${textOf(target)}」に印をつけました${lag ? '（直前の区切り）' : ''}。`);
}

// ---------- after each render of the reader ----------
function onRendered() {
  const k = scan();
  if (k !== key) {
    key = k;
    if (play.status !== 'idle' && play.key !== k) { stop(); info('英文が変わったので読み上げを止めました。'); }
    loadMarks();
  }
  injectChunkButtons();
  paintMarks();
  paintNow(false);
  renderList();
  updateButtons();
}

// ---------- wiring ----------
function isTyping(t) {
  return !!t?.closest?.('input, textarea, select, button, [contenteditable=""], [contenteditable="true"], [role="button"], [role="radio"], summary, a[href], dialog[open]');
}
function practiceVisible() {
  const s5 = $('#s5'); if (!s5 || s5.hidden || !reader() || reader().hidden) return false;
  const b = s5.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight;
}
function init() {
  if (!$('#play')) return;
  $('#play').onclick = playAll;
  const togglePause = () => (play.status === 'paused' ? resume() : pause());
  const stopAll = () => { stop(); info(''); };
  $('#pause').onclick = togglePause;
  $('#stop').onclick = stopAll;
  $('#mkNow').onclick = markNow;
  if ($('#barPause')) {
    $('#barPause').onclick = togglePause;
    $('#barStop').onclick = stopAll;
    $('#barMk').onclick = markNow;
    $('#barBack').onclick = backToNow;
  }
  $('#mkPlayAll').onclick = () => start(markedChunks(), 'marks');
  $('#mkClear').onclick = () => { marks = []; afterMarksChanged(); say('印をすべて外しました。'); };
  // 区切りごとに印ボタンを出す (remembered per device).
  const mb = $('#mkBtns');
  if (mb) {
    try { const v = localStorage.getItem('readflow:mkbtns'); if (v != null) mb.checked = v === '1'; } catch { /* ignore */ }
    mb.onchange = () => {
      try { localStorage.setItem('readflow:mkbtns', mb.checked ? '1' : '0'); } catch { /* ignore */ }
      injectChunkButtons(); paintMarks();
    };
  }
  const fw = $('#ttsFollow');
  if (fw) fw.onchange = () => { if (fw.checked) backToNow(); else updateBar(); };
  if (!HAS_TTS) { $('#play').disabled = true; info('このブラウザは読み上げに対応していません。印は各区切りの後ろの「?」で付けられます。'); }
  // Per-chunk "?" buttons. Registered on window in the capture phase, so it runs before every other
  // click handler (main.js's reader handlers for 構文マーク editing / 品詞 / tap translation, and the
  // document-level capture handlers of sxai.js / structure.js pick modes) and stops them.
  window.addEventListener('click', (e) => {
    const b = e.target.closest?.('#reader .mk-b'); if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    toggleChunkMark(+b.dataset.i);
  }, true);
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const b = e.target.closest?.('#reader .mk-b'); if (!b) return;
    e.preventDefault(); e.stopImmediatePropagation();
    if (!e.repeat) toggleChunkMark(+b.dataset.i);
  }, true);
  // Keep the other reader handlers from seeing presses on the button at all (focus, drag-select starts).
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'dblclick']) {
    window.addEventListener(t, (e) => { if (e.target.closest?.('#reader .mk-b')) e.stopImmediatePropagation(); }, true);
  }
  // User scrolling suspends auto-follow (see follow above).
  const opts = { passive: true, capture: true };
  window.addEventListener('wheel', userScrolled, opts);
  window.addEventListener('touchmove', userScrolled, opts);
  window.addEventListener('keydown', (e) => {
    if (['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) && !isTyping(e.target)) userScrolled();
  }, true);
  window.addEventListener('mousedown', (e) => {          // grabbing the page scrollbar
    if (e.clientX >= document.documentElement.clientWidth || e.clientY >= document.documentElement.clientHeight) userScrolled();
  }, true);
  follow.lastY = scrollY;
  window.addEventListener('scroll', () => {
    const dy = Math.abs(scrollY - follow.lastY); follow.lastY = scrollY;
    if (performance.now() < follow.progUntil || dy < 2) return;
    userScrolled();
  }, { passive: true });
  window.addEventListener('resize', () => updateBar());
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing || isTyping(e.target) || !practiceVisible()) return;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      if (play.status === 'playing') pause(); else if (play.status === 'paused') resume(); else if (HAS_TTS) playAll();
    } else if ((e.key === 'm' || e.key === 'M' || e.key === '?') && play.status !== 'idle') { e.preventDefault(); markNow(); }
    else if (e.key === 'Escape' && play.status !== 'idle') { stop(); info(''); }
  });
  document.addEventListener('reader:rendered', onRendered);
  // Leaving the page (iOS: app switch, lock screen, tab switch) stops the voice but keeps the place: playback becomes
  // 一時停止 and 「再開」 reads again from the current chunk. Timers are frozen in the background on iOS, so carrying
  // on is not possible there; desktops with a mouse only keep playing in a background tab as before.
  const touchy = () => navigator.maxTouchPoints > 0 || matchMedia('(any-pointer:coarse)').matches;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && play.status === 'playing' && touchy()) {
      pause(); info('画面を離れたので一時停止しました。「再開」でいまの区切りの頭から読み直します。');
    }
  });
  window.addEventListener('pagehide', () => {
    if (play.status === 'playing') pause();
    try { if (HAS_TTS) speechSynthesis.cancel(); } catch { /* ignore */ }
  });
  onRendered();
}
init();

// Test hook.
window.__tts = { play, get marks() { return marks; }, markedChunks, toggleChunkMark, pause, resume, stop, playAll, markNow };
