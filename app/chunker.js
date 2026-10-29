// chunker.js - slash-reading chunk proposals for English reading-aloud practice.
// Pure ES module, no dependencies. Breaks are chosen per sentence by dynamic
// programming over break positions, scoring syntactic/prosodic cues against
// level-specific chunk-length preferences.

// ---------------------------------------------------------------------------
// Word lists
// ---------------------------------------------------------------------------

const set = (s) => new Set(s.split(/\s+/).filter(Boolean));

const ABBREVIATIONS = set(
  'mr. mrs. ms. dr. prof. st. jr. sr. vs. etc. e.g. i.e. u.s. u.k. a.m. p.m. no. fig. cf. approx.'
);

const PREPOSITIONS = set(
  'in on at for with from by into onto through during without within between among against ' +
  'toward towards across about despite under over beyond around behind like unlike upon via ' +
  'including regarding rather'
);

// Words after which a chunk must not end (it would cut a phrase in half).
const CANNOT_END = set(
  // articles / determiners / possessives
  'a an the my your his her its our their every each no another several whose ' +
  // prepositions (particle-like ones such as around/over/about/behind/through are allowed)
  'in on at for with from by into onto during without within between among against toward ' +
  'towards across despite upon via like unlike including regarding of to than ' +
  // conjunctions / subordinators
  'and or but nor that if because although though whereas while when whenever unless until ' +
  'whether so as ' +
  // auxiliaries / modals / be
  'will would can could should may might must shall do does did be been being ' +
  // degree words / negation
  'not very more most such too ' +
  // subject pronouns and relative pronouns
  'i we they he she who whom which'
);

// Words that can end a chunk but usually should not (soft penalty).
const SOFT_END = set(
  'this these those some any many much few all both either neither other ' +
  'is am are was were has have had also just even only quite rather there ' +
  'one two three four five six seven eight nine ten hundred thousand million first second last'
);

// Verbs/nouns after which "that" introduces a complement clause (believed that, the idea that).
const THAT_HEADS = set(
  'believe believed believes think thought thinks found find finds know knew known says said ' +
  'say suggest suggested suggests show showed shown shows assume assumed assumes argue argued ' +
  'argues claim claimed claims realize realized feel felt hope hoped notice noticed report ' +
  'reported indicate indicated indicates reveal revealed reveals mean means meant worry worried ' +
  'discover discovered conclude concluded learned explain explained insist insisted predict ' +
  'predicted agree agreed fact idea belief evidence view notion assumption possibility sure aware'
);

const BE_FORMS = set('is are was were be been');

const DETERMINERS = set(
  'a an the this that these those my your his her its our their some any every each no ' +
  'another many much few several all both either neither'
);

const SUBORDINATORS = set(
  'because although though while whereas when whenever if unless since until after before once whether'
);

const WH_WORDS = set('which who whom whose where why how');

// Verbs before which "to" is part of the verb phrase (have to, want to, ...).
const TO_GOVERNORS = set(
  'have has had want wants wanted need needs needed going able unable used ought try tries ' +
  'tried tend tends tended seem seems seemed likely began begin begins decided decide hope ' +
  'hoped plan planned refuse refused fail failed managed learn learned continue ' +
  'continued started start appear appears appeared wish would like'
);

// Common finite verbs that often follow a long subject.
const MAIN_VERBS = set(
  'is are was were has have had can will would should must may might seems seem seemed ' +
  'shows show showed suggests suggest suggested means mean meant found find finds ' +
  'became becomes remain remains remained indicates indicate indicated reveals revealed ' +
  'appears appeared makes made depends depended tend tends tended need needs needed help helps ' +
  'helped allow allows allowed lead leads led cause causes caused do does did'
);

// "as" is not a clause opener after these (as ... as, such as, known as).
const AS_BLOCKERS = set('as such same so more less twice just known regarded seen defined described used');

// Multi-word expressions whose internal positions are never broken.
const FIXED_PHRASES = [
  'as well as', 'rather than', 'such as', 'in order to', 'so that', 'even if', 'even though',
  'as if', 'as though', 'as soon as', 'according to', 'because of', 'instead of',
  'in spite of', 'due to', 'a lot of', 'lots of', 'kind of', 'sort of', 'each other',
  'one another', 'out of', 'more than', 'less than', 'at least', 'at first', 'of course',
  'in fact', 'for example', 'for instance', 'as a result', 'on the other hand',
  'in addition', 'in addition to', 'as long as', 'no longer', 'not only', 'at the same time',
].map((p) => p.split(' '));

// Level settings: preferred chunk length range (words) and fixed cost per break.
const LEVELS = {
  fine: { min: 2, max: 5, breakCost: 1 },
  standard: { min: 3, max: 8, breakCost: 3 },
  coarse: { min: 5, max: 13, breakCost: 6 },
};

const FORBID = -100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const normalizeSpace = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

// Lowercased bare word: strip surrounding quotes, brackets and punctuation.
function bare(token) {
  return (token || '')
    .toLowerCase()
    .replace(/^[\s"'“”‘’(\[{]+/, '')
    .replace(/[\s"'“”‘’)\]}.,;:!?—–-]+$/, '');
}

const isDashToken = (t) => /^(—|–|--|-)$/.test(t);

// Token ends with punctuation that marks a strong prosodic boundary.
function endsStrong(token) {
  const t = token.replace(/["'“”‘’]+$/, '');
  return /[,;:)\]—–]$/.test(t) || /--$/.test(t) || isDashToken(token);
}

// ---------------------------------------------------------------------------
// Paragraph and sentence splitting
// ---------------------------------------------------------------------------

export function splitParagraphs(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map(normalizeSpace)
    .filter(Boolean);
}

// True if the token is an abbreviation or initial that should not end a sentence.
function isNonFinalAbbrev(token) {
  const t = token.replace(/^["'“‘(\[]+/, '').toLowerCase();
  if (ABBREVIATIONS.has(t)) return true;
  if (/^[a-z]\.$/i.test(t) && /[A-Z]/.test(token)) return true; // single capital initial
  return false;
}

export function splitSentences(paragraph) {
  const tokens = normalizeSpace(paragraph).split(' ').filter(Boolean);
  const out = [];
  let cur = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    cur.push(tok);
    const next = tokens[i + 1];
    if (!next) break;
    const endsSentence = /[.!?]["'”’)\]]*$/.test(tok);
    const nextStarts = /^["'“‘(\[]*[A-Z0-9]/.test(next);
    if (endsSentence && nextStarts && !isNonFinalAbbrev(tok)) {
      out.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

// ---------------------------------------------------------------------------
// Break scoring
// ---------------------------------------------------------------------------

// Mark break positions inside fixed phrases (index = break after token k).
function fixedPhraseMask(lower) {
  const mask = new Array(lower.length).fill(false);
  for (const phrase of FIXED_PHRASES) {
    for (let k = 0; k + phrase.length <= lower.length; k++) {
      let ok = true;
      for (let m = 0; m < phrase.length; m++) {
        if (lower[k + m] !== phrase[m]) { ok = false; break; }
      }
      // An internal punctuation mark means the phrase is not really contiguous.
      if (ok) {
        for (let m = 0; m < phrase.length - 1; m++) {
          if (!endsStrong(lower.raw[k + m])) mask[k + m] = true;
        }
      }
    }
  }
  return mask;
}

// Start-independent score for a break after token i. Returns {score, kind}
// where kind marks cues whose value depends on the preceding chunk length.
function baseScore(words, lower, mask, i) {
  const tok = words[i];
  const next = words[i + 1];
  const w = lower[i];
  const n1 = lower[i + 1];
  const n2 = lower[i + 2];

  if (isDashToken(next)) return { score: FORBID }; // keep dash with the preceding word
  if (endsStrong(tok)) return { score: 10 };
  if (/^[(\[—–]/.test(next)) return { score: 6 }; // opening paren/dash
  const quoteBonus = /^["“‘]/.test(next) ? 1 : 0; // quoted phrases are often nouns: weak cue
  if (mask[i]) return { score: FORBID };
  if (CANNOT_END.has(w)) return { score: FORBID };
  if (w === 'there' && BE_FORMS.has(n1)) return { score: FORBID }; // "there is"

  let score = quoteBonus;
  let kind = null;
  if (SOFT_END.has(w)) score -= 5;

  if (n1 === 'even') {
    if (n2 === 'if' || n2 === 'though') score += 8;
  } else if (n1 === 'so') {
    if (n2 === 'that') score += 8;
  } else if (n1 === 'as') {
    if (n2 === 'if' || n2 === 'though' || (n2 === 'soon' && lower[i + 3] === 'as')) score += 8;
    else if (n2 === 'well' && lower[i + 3] === 'as') score += 5;
    else if (AS_BLOCKERS.has(w) || /er$/.test(w)) score += 1;
    else score += 5;
  } else if (SUBORDINATORS.has(n1)) {
    score += 8;
  } else if (WH_WORDS.has(n1)) {
    score += 7;
  } else if (n1 === 'that') {
    if (['so', 'such', 'now'].includes(w)) score += 0;
    else score += THAT_HEADS.has(w) ? 7 : 5;
  } else if (n1 === 'but' || n1 === 'yet' || n1 === 'nor') {
    score += 8;
  } else if (n1 === 'and' || n1 === 'or') {
    kind = 'coord';
    score += 4;
  } else if (n1 === 'rather') {
    if (n2 === 'than') score += 4;
  } else if (PREPOSITIONS.has(n1)) {
    score += 4;
  } else if (n1 === 'of') {
    score += 1;
  } else if (n1 === 'to') {
    if (TO_GOVERNORS.has(w)) score += 0;
    else score += DETERMINERS.has(n2) ? 3 : 4;
  } else if (n1 === 'than') {
    kind = 'than';
  } else if (MAIN_VERBS.has(n1)) {
    kind = 'verb';
  } else if (/^[a-z]{3,}(ing|ed)$/.test(n1)) {
    kind = 'participle';
  }
  return { score, kind };
}

// Start-dependent adjustments (chunk before the break = words[start..i]).
function contextBonus(kind, lower, start, i) {
  const len = i - start + 1;
  switch (kind) {
    case 'coord':
      return len >= 4 ? 2 : 0;
    case 'than':
      return len >= 4 ? 3 : 0;
    case 'participle':
      return len >= 4 ? 2 : 0;
    case 'verb': {
      // Long subject, or a relative clause ("who studied this change") ending before the verb.
      const relative = WH_WORDS.has(lower[start]) || lower[start] === 'that';
      if (len < (relative ? 3 : 5)) return 0;
      // Ignore the first word: a chunk like "found that teachers in rural schools"
      // still behaves as a long subject before "were".
      for (let k = start + 1; k <= i; k++) if (MAIN_VERBS.has(lower[k])) return 0;
      return relative ? 7 : 5;
    }
    default:
      return 0;
  }
}

// Penalty for a chunk of L words given the level range.
function lengthPenalty(L, cfg, endsWithStrong) {
  if (L < cfg.min) return endsWithStrong ? 0 : (cfg.min - L) * 4;
  if (L <= cfg.max) return 0;
  const over = L - cfg.max;
  if (over <= 3) return over * 3;
  const extra = over - 3;
  return 9 + extra * 3 + extra * extra * 2; // grows quadratically
}

// ---------------------------------------------------------------------------
// Chunking
// ---------------------------------------------------------------------------

export function chunkSentence(sentence, level = 'standard') {
  const cfg = LEVELS[level] || LEVELS.standard;
  const words = normalizeSpace(sentence).split(' ').filter(Boolean);
  const n = words.length;
  if (n === 0) return [];
  if (n < cfg.min) return [words.join(' ')];

  const lower = words.map(bare);
  lower.raw = words;
  const mask = fixedPhraseMask(lower);
  const base = [];
  for (let i = 0; i < n - 1; i++) base.push(baseScore(words, lower, mask, i));

  // dp[j] = minimal cost of chunking words[0..j-1] with a break at j.
  const dp = new Array(n + 1).fill(Infinity);
  const back = new Array(n + 1).fill(-1);
  dp[0] = 0;
  for (let j = 1; j <= n; j++) {
    for (let i = 0; i < j; i++) {
      if (dp[i] === Infinity) continue;
      const last = j - 1; // last token of the chunk words[i..j-1]
      let cost = dp[i];
      if (j < n) {
        const b = base[last];
        const s = b.score <= FORBID ? FORBID : b.score + contextBonus(b.kind, lower, i, last);
        cost += cfg.breakCost - s;
        cost += lengthPenalty(j - i, cfg, endsStrong(words[last]));
      } else {
        cost += lengthPenalty(j - i, cfg, false);
      }
      if (cost < dp[j]) { dp[j] = cost; back[j] = i; }
    }
  }

  const chunks = [];
  for (let j = n; j > 0; j = back[j]) chunks.unshift(words.slice(back[j], j).join(' '));
  return chunks;
}

export function chunkText(text, level = 'standard') {
  return splitParagraphs(text)
    .map((p) => splitSentences(p).map((s) => chunkSentence(s, level).join(' / ')).join(' '))
    .join('\n\n');
}

// ---------------------------------------------------------------------------
// Parsing / serialization of slashed text
// ---------------------------------------------------------------------------

// Split a slashed paragraph into words with a boundary flag. A slash counts as a
// separator only when it touches whitespace or the string edge, so "and/or" stays.
function parseParagraphWords(para) {
  const words = [];
  const markPrev = () => { if (words.length) words[words.length - 1].slashAfter = true; };
  for (const raw of normalizeSpace(para).split(' ')) {
    if (!raw) continue;
    if (/^\/+$/.test(raw)) { markPrev(); continue; } // "/" or "//"
    const m = raw.match(/^(\/*)(.*?)(\/*)$/);
    if (m[1]) markPrev(); // "/word"
    words.push({ word: m[2], slashAfter: false });
    if (m[3]) markPrev(); // "word/"
  }
  if (words.length) words[words.length - 1].slashAfter = false;
  return words;
}

export function tokensWithBoundaries(slashedText) {
  return splitParagraphs(slashedText).map((para) => {
    const words = parseParagraphWords(para);
    const sentences = splitSentences(words.map((w) => w.word).join(' '));
    let idx = 0;
    const tokens = words.map((w) => ({ word: w.word, slashAfter: w.slashAfter, sentenceEnd: false }));
    for (const s of sentences) {
      idx += s.split(' ').length;
      const t = tokens[idx - 1];
      t.sentenceEnd = true;
      t.slashAfter = false; // no slash at sentence ends
    }
    return tokens;
  });
}

export function fromTokens(paragraphs) {
  return paragraphs
    .map((tokens) => {
      let out = '';
      tokens.forEach((t, k) => {
        out += t.word;
        if (k === tokens.length - 1) return;
        out += t.slashAfter && !t.sentenceEnd ? ' / ' : ' ';
      });
      return out;
    })
    .filter(Boolean)
    .join('\n\n');
}

export function parseSlashed(slashedText) {
  return tokensWithBoundaries(slashedText).map((tokens) => {
    const sentences = [];
    let chunks = [];
    let cur = [];
    for (const t of tokens) {
      cur.push(t.word);
      if (t.slashAfter || t.sentenceEnd) { chunks.push(cur.join(' ')); cur = []; }
      if (t.sentenceEnd) { sentences.push({ chunks }); chunks = []; }
    }
    if (cur.length) chunks.push(cur.join(' '));
    if (chunks.length) sentences.push({ chunks });
    return { sentences };
  });
}

export function stats(slashedText) {
  const lens = [];
  for (const p of parseSlashed(slashedText))
    for (const s of p.sentences) for (const c of s.chunks) lens.push(c.split(' ').length);
  const words = lens.reduce((a, b) => a + b, 0);
  return {
    chunks: lens.length,
    words,
    avgChunkLen: lens.length ? Math.round((words / lens.length) * 100) / 100 : 0,
    maxChunkLen: lens.length ? Math.max(...lens) : 0,
  };
}
