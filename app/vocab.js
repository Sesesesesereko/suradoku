// Short Japanese glosses for difficult words (about 英検準1級 / CEFR B2 and above), from the
// bundled offline dictionary vendor/dict/vocab.json (EJDict + CEFR-J/Octanove + wordfreq; see
// vendor/dict/LICENSE-dict.md). Lookup order mirrors work/dict/scripts/lookup.js, which the
// easy/difficult thresholds were tuned with.

let data = null, loading = null;
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

export function loadVocab() {
  if (data) return Promise.resolve(data);
  if (!loading) loading = fetch(new URL('../vendor/dict/vocab.json', import.meta.url))
    .then(r => { if (!r.ok) throw new Error(`辞書データを読み込めませんでした（${r.status}）`); return r.json(); })
    .then(j => { data = { easy: new Set(j.easy || []), gloss: j.gloss || {}, lv: j.lv || {}, irregular: j.irregular || {} }; return data; })
    .finally(() => { loading = null; });
  return loading;
}

const V = /[aeiou]/;
const CVC = /[^aeiou][aeiou][^aeiouwxy]$/;          // hop|e, rat|e: try "+e" first
const DBL = /([b-df-hj-np-tv-z])\1$/;
function stemVariants(s) {                          // stem left after removing -ed / -ing
  const c = [];
  if (DBL.test(s)) c.push(s.slice(0, -1));          // stopped -> stop
  if (CVC.test(s)) c.push(s + 'e', s); else c.push(s, s + 'e');
  return c;
}
function inflCands(w) {
  const c = [], L = w.length;
  if (L > 4 && w.endsWith('ies')) c.push(w.slice(0, -3) + 'y');
  if (L > 3 && w.endsWith('s') && !/(ss|us|is)$/.test(w)) c.push(w.slice(0, -1));
  if (L > 4 && w.endsWith('es')) c.push(w.slice(0, -2));
  if (L > 4 && w.endsWith('ied')) c.push(w.slice(0, -3) + 'y');
  if (L > 3 && w.endsWith('ed')) c.push(...stemVariants(w.slice(0, -2)));
  if (L > 4 && w.endsWith('ing')) {
    const s = w.slice(0, -3);
    if (V.test(s)) { if (s.endsWith('y')) c.push(s.slice(0, -1) + 'ie'); c.push(...stemVariants(s)); }
  }
  return c.filter(x => x.length >= 3);
}
// Comparatives are tried last, so "ponder" never becomes "pond".
function degreeCands(w) {
  const c = [];
  for (const suf of ['er', 'est']) {
    if (w.length > suf.length + 2 && w.endsWith(suf)) {
      const s = w.slice(0, -suf.length);
      if (s.endsWith('i')) c.push(s.slice(0, -1) + 'y');
      c.push(s, s + 'e');
      if (DBL.test(s)) c.push(s.slice(0, -1));
    }
  }
  return c;
}
export function lemmas(word) { const w = word.toLowerCase(); return [w, ...inflCands(w), ...degreeCands(w)]; }

function lookup(word) {
  const { easy, gloss, irregular: irr, lv } = data;
  const hit = (k) => ({ lemma: k, ja: gloss[k], level: lv[k] || '' });
  const w = word.toLowerCase().replace(/['’]s$/, '');
  if (easy.has(w)) return null;
  if (has(irr, w)) { const b = irr[w]; if (easy.has(b)) return null; if (has(gloss, b)) return hit(b); }
  const ic = inflCands(w);
  if (ic.some(x => easy.has(x) || (has(irr, x) && easy.has(irr[x])))) return null;
  if (has(gloss, w)) return hit(w);
  for (const x of ic) if (has(gloss, x)) return hit(x);
  const dc = degreeCands(w);
  if (dc.some(x => easy.has(x))) return null;
  for (const x of dc) if (has(gloss, x)) return hit(x);
  return null;
}

// Gloss for a token as it appears in the text, or null when it is easy, unknown, or a name.
// names: lowercase words seen capitalised mid-sentence elsewhere in the passage.
export function glossFor(token, { sentenceStart = false, names = null } = {}) {
  if (!data) return null;
  const t = token.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '');
  if (!t || !/^[A-Za-z]/.test(t)) return null;
  if (/[’']/.test(t) && !/['’]s$/i.test(t)) return null;                 // contractions
  if (/^[A-Z]{2,}$/.test(t)) return null;                               // acronyms
  if (/^[A-Z]/.test(t) && (!sentenceStart || names?.has(t.toLowerCase()))) return null; // names
  const whole = lookup(t);
  if (whole || !t.includes('-')) return whole;
  for (const part of t.split('-')) { const g = part && lookup(part); if (g) return g; }
  return null;
}

// Words that appear capitalised mid-sentence are treated as names throughout the passage.
export function namesIn(tokens) {
  const s = new Set();
  tokens.forEach((w, i) => {
    const prevEnds = i === 0 || /[.!?:;]["'”’)\]]?$/.test(tokens[i - 1]);
    const t = w.replace(/^[^A-Za-z]+/, '');
    if (!prevEnds && /^[A-Z][a-z]/.test(t)) s.add(t.replace(/[^A-Za-z'’-]+$/, '').toLowerCase());
  });
  return s;
}

// ---------- Any word (語をタップで意味, app/wordtap.js) ----------
// The "easy" words have no gloss in vocab.json, so their meanings come from vendor/dict/basic.json
// (up to three short senses per word from EJDict-hand; see LICENSE-dict.md). It is loaded only when
// the learner first taps a word.
let basic = null, basicLoading = null;
export function loadDictAll() {
  if (!basicLoading) basicLoading = fetch(new URL('../vendor/dict/basic.json', import.meta.url))
    .then(r => { if (!r.ok) throw new Error(`辞書データを読み込めませんでした（${r.status}）`); return r.json(); })
    .then(j => { basic = j.gloss || {}; })
    .catch(e => { basicLoading = null; throw e; });
  return Promise.all([loadVocab(), basicLoading]).then(() => true);
}
// Contractions: [pattern, (match) => [main word, other word], expansion shown to the learner].
// "don't" is explained by its verb (do); "I'm", "we'll", "it's" by the pronoun, with the verb under 「ほかに」.
const CONTRACTIONS = [
  [/^(ca|wo|sha)n['’]t$/, (m) => [{ ca: 'can', wo: 'will', sha: 'shall' }[m[1]], 'not'], (m) => `${{ ca: 'can', wo: 'will', sha: 'shall' }[m[1]]} not`],
  [/^(.+)n['’]t$/, (m) => [m[1], 'not'], (m) => `${m[1]} not`],
  [/^(.+)['’]re$/, (m) => [m[1], 'be'], (m) => `${m[1]} are`],
  [/^(.+)['’]ll$/, (m) => [m[1], 'will'], (m) => `${m[1]} will`],
  [/^(.+)['’]ve$/, (m) => [m[1], 'have'], (m) => `${m[1]} have`],
  [/^(i)['’]m$/, (m) => [m[1], 'be'], () => 'I am'],
  [/^(.+)['’]d$/, (m) => [m[1], 'would'], (m) => `${m[1]} would / ${m[1]} had`],
  [/^let['’]s$/, () => ['let', 'us'], () => 'let us'],
  [/^(it|he|she|that|there|here|what|who|where|how|when|everything|nothing|someone|everyone)['’]s$/, (m) => [m[1], 'be'], (m) => `${m[1]} is / ${m[1]} has`],
];
const LETTER_SENSE = /アルファベットの第\d+字|字形|字型/;     // "I": 私は / 英語アルファベットの第9字 / I字型
function entry(k) {
  let ja = (basic && has(basic, k) ? basic[k] : null) || (has(data.gloss, k) ? data.gloss[k] : null);
  if (ja && LETTER_SENSE.test(ja)) { const keep = ja.split(' / ').filter(x => !LETTER_SENSE.test(x)); if (keep.length) ja = keep.join(' / '); }
  return ja ? { lemma: k, ja, level: data.lv[k] || '', basic: data.easy.has(k) } : null;
}
const EXTRA_IRREGULAR = { media: 'medium', data: 'datum' };   // not in vocab.json's irregular map
function lookupLoose(w) {
  const own = entry(w);
  const ic = inflCands(w), dc = degreeCands(w);
  const irr = has(data.irregular, w) ? data.irregular[w] : !own && has(EXTRA_IRREGULAR, w) ? EXTRA_IRREGULAR[w] : null;
  if (irr) {                                          // went, children, found (find), left (leave)
    const b = entry(irr);
    if (b) {
      const also = own ? [{ ...own, note: `${w} という語として` }] : [];
      const reg = ic.map(entry).find(e => e && e.lemma !== b.lemma);   // lives: life + live, leaves: leaf + leave
      if (reg && !also.some(a => a.lemma === reg.lemma)) also.push({ ...reg, note: `${reg.lemma} の変化形として` });
      return { ...b, form: w, also };
    }
  }
  if (own) {                                          // used / glasses / news: the word itself first
    const base = ic.map(entry).find(Boolean);
    return { ...own, also: base && base.lemma !== w ? [{ ...base, note: `${base.lemma} の変化形として` }] : [] };
  }
  for (const x of ic) { const e = entry(x); if (e) return { ...e, form: w, also: [] }; }
  for (const x of ic) if (has(data.irregular, x)) { const e = entry(data.irregular[x]); if (e) return { ...e, form: w, also: [] }; }
  for (const x of dc) { const e = entry(x); if (e) return { ...e, form: w, also: [] }; }
  return null;
}
// Meaning for any word as it appears in the text (punctuation, capitals, 's, inflections, irregular forms,
// contractions and hyphenated compounds handled). Returns null when the dictionary has nothing.
// { word, lemma, ja, level, basic, form?, note?, also: [{lemma, ja, level, note}], parts?: [{word, lemma, ja}] }
export function lookupAny(token) {
  if (!data || !basic) return null;
  const t = String(token).replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '');
  if (!t || !/^[A-Za-z]/.test(t) || /\d/.test(t)) return null;           // 1990s, 3rd, A4: not dictionary words
  const lw = t.toLowerCase();
  for (const [re, parts, expand] of CONTRACTIONS) {
    const m = lw.match(re); if (!m) continue;
    const [a, b] = parts(m), ra = lookupLoose(a), rb = lookupLoose(b);
    const main = a === 'not' || !ra ? rb : ra, other = main === ra ? rb : ra;
    if (!main) return null;
    const note = `${expand(m).replace(/^i /, 'I ')} の短縮形`;
    return { ...main, word: t, form: lw, note, also: other && other.lemma !== main.lemma ? [{ ...other, note: `${other.lemma} として` }] : [] };
  }
  const w = lw.replace(/['’]s$/, '');
  const whole = lookupLoose(w);
  if (whole) return { ...whole, word: t };
  if (!w.includes('-')) return null;
  const joined = lookupLoose(w.replace(/-/g, ''));        // e-mail -> email, co-operate -> cooperate
  if (joined) return { ...joined, word: t, form: w };
  const parts = w.split('-').filter(Boolean).map(p => ({ word: p, hit: p.length > 1 ? lookupLoose(p) : null }));
  if (!parts.some(p => p.hit)) return null;
  return { word: t, lemma: w, ja: '', level: '', also: [], parts: parts.map(p => ({ word: p.word, lemma: p.hit?.lemma || p.word, ja: p.hit?.ja || '' })) };
}
