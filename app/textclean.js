// Layout-aware text cleanup shared by the PDF text-layer path and the OCR path.
// A "line" is { text, bbox:{x0,y0,x1,y1}, conf, words:[{text,conf,bbox}] } in page pixels
// (y grows downward). Pure functions only, so they can be unit-tested in Node.

const JP = /[぀-ヿ㐀-鿿ｦ-ﾟ　-〿！-／：-＠]/;
const LETTER = /[A-Za-z]/g;
const MARGIN_NUM = /^[(（\[]?\d{1,3}[)）\]]?$/;
// Lines that start a glossary or question block on exam pages.
const GLOSSARY_HEAD = /^\s*(?:[(（]?注[)）:：]?|\*\s*\S|＊|語注|\[注\]|Notes?\s*:|Glossary)/;
// [C4] circled paragraph numbers ①–⑳ (and ㉑–㉟) that exam passages put at paragraph starts.
export const CIRCLED = /^[①-⑳㉑-㉟]/;
// [C5] English section instructions; tested with spaces removed so "fol lowing" still matches.
const INSTRUCTION = /^\S{0,4}?(?:Readthe(?:following|passage|text|article)|Answerthe(?:following|questions)|Choosethe|Listento)/i;
// [C6] multiple-choice item stems (English) that are questions regardless of how much body was seen.
const MC_STEM = /^\s*\d{1,2}(?:\s*[,，]\s*\d{1,2})*\s*[.．]\s.*(?:\bWhich of the following\b|\bbest fills? the gap\b|\bthe gaps?\b.*\bParagraph\b|\bmark ?sheet\b|\bPlace (?:three|two|four|the) )/i;
// [C7] byline / source line under a title: "Bill Thurman (2025)".
const BYLINE = /^[A-Z][A-Za-z.'’\- ]{1,40}\(\s*(?:1[89]|20)\d\d\s*\)$/;
const QUESTION_HEAD = /^\s*(?:設\s*問|問\s*[0-9０-９一二三四五六七八九十]|[0-9０-９]+\s*[.．]\s*\S*[぀-ヿ一-鿿])/;

export const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const quantile = (xs, q) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))];
};

export function hasJapanese(s) { return JP.test(s); }
// Mostly English despite a few Japanese characters ("food waste。", OCR specks): ≥3 Latin words and ≤2 Japanese chars.
export function mostlyEnglish(s) {
  const jp = (s.match(new RegExp(JP.source, 'g')) || []).length;
  const latinWords = (s.match(/[A-Za-z]{2,}/g) || []).length;
  // An English line whose only CJK character is full-width punctuation ("food waste。") stays English.
  const jpLetters = (s.replace(/[。、，．・（）「」]/g, '').match(new RegExp(JP.source, 'g')) || []).length;
  if (jpLetters === 0 && latinWords >= 1) return true;
  return jp <= 2 && latinWords >= 3 && letterRatio(s) >= 0.7;
}
export function letterRatio(s) {
  const t = s.replace(/\s/g, '');
  return t.length ? (t.match(LETTER) || []).length / t.length : 0;
}

// Estimate the main text column from lines that look like body prose.
export function bodyFrame(lines) {
  const prose = lines.filter(l => l.words.length >= 5 && !hasJapanese(l.text) && letterRatio(l.text) > 0.6);
  const use = prose.length >= 3 ? prose : lines;
  return {
    left: quantile(use.map(l => l.bbox.x0), 0.25),
    right: quantile(use.map(l => l.bbox.x1), 0.75),
    lineHeight: median(use.map(l => l.bbox.y1 - l.bbox.y0)) || 20,
  };
}

// Drop margin line numbers ("5", "10", "(15)") that OCR glues to the start/end of a line.
export function stripMarginNumbers(lines, frame = bodyFrame(lines)) {
  const tol = frame.lineHeight * 0.6;
  return lines.map(l => {
    if (l.words.length < 2) return l;
    const words = l.words.filter((w, i) => {
      if (!MARGIN_NUM.test(w.text)) return true;
      const edge = i === 0 || i === l.words.length - 1;
      const inMargin = w.bbox.x1 < frame.left + tol || w.bbox.x0 > frame.right - tol;
      const gap = i === 0 ? l.words[1].bbox.x0 - w.bbox.x1 : w.bbox.x0 - l.words[i - 1].bbox.x1;
      return !(edge && inMargin && gap > frame.lineHeight * 0.9);
    });
    if (words.length === l.words.length) return l;
    return { ...l, words, text: words.map(w => w.text).join(' '), bbox: unionBox(words.map(w => w.bbox)), strippedMargin: true };
  });
}

export function unionBox(boxes) {
  return boxes.reduce((a, b) => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) }));
}

// Footnote marks (*) that OCR often reads as ™ ® ° † ‡, and stray specks at line ends.
const KEEP_SHORT = /^(?:a|I|to|of|in|on|at|is|it|be|as|an|or|by|we|he|me|my|no|so|up|us|do|go|if|am|oh|ok)$/;
export function cleanOcrLine(l) {
  if (l.source !== 'ocr') return l;
  let words = l.words.map(w => ({ ...w, text: w.text.replace(/(?<=[A-Za-z])[*™®°†‡]+(?=[,.;:!?)"”’']*$)/, '').replace(/^[*™®]+(?=[A-Za-z])/, '') }));
  words = words.filter((w, i) => {
    const edge = i === 0 || i === words.length - 1;
    const core = w.text.replace(/[^A-Za-z]/g, '');
    if (edge && words.length > 1 && w.conf < 40 && core.length >= 1 && core.length <= 2 && !/[()（）{}]/.test(w.text) && !KEEP_SHORT.test(w.text.replace(/[^A-Za-z]/g, ''))) return false;
    // A lone letter after the sentence end at the line end is residue of an underline label ("conscious”. ow").
    if (i === words.length - 1 && i > 0 && /^[a-z]{1,2}$/.test(w.text) && !KEEP_SHORT.test(w.text) && /[.!?]["”’)]?$/.test(words[i - 1].text)) return false;
    return w.text.trim() !== '';
  });
  const text = words.map(w => w.text).join(' ');
  return text === l.text ? l : { ...l, words, text, cleaned: true };
}

// Suggest which lines belong to the reading passage. Returns lines with
// { include:boolean, reason:string } added; the user can override every choice.
export function classifyLines(lines, pageHeight) {
  let afterTail = null; // once a glossary/question header appears, the rest of the page is likely not passage
  let bodySeen = 0, garbleRun = 0;
  // The English OCR model turns Japanese into low-confidence noise, so "garbled" lines stand in for Japanese.
  const garbled = (l) => l.source === 'ocr' && ((l.conf ?? 100) < 55 || (letterRatio(l.text) < 0.75 && (l.conf ?? 100) < 75));
  return lines.map(cleanOcrLine).map((l, idx) => {
    const t = l.text.trim();
    const yMid = (l.bbox.y0 + l.bbox.y1) / 2;
    let include = true, reason = '';
    // "(1)", "2)", "(VID)", "15" alone on a line: underline numbers, line numbers, wavy-underline labels.
    const markerOnly = /^(?:[(（{\[]\s*\S{1,4}\s*[)）}\]]?|\S{1,4}[)）}\]]|\d{1,3})$/.test(t);
    const g = t && !markerOnly && garbled(l);
    garbleRun = g ? garbleRun + 1 : 0;
    if (!t) { include = false; reason = '空行'; }
    else if (afterTail) { include = false; reason = afterTail; }
    else if (pageHeight && yMid > pageHeight * 0.89 && (/[◇◆]|^[-–—]\s*\d{1,3}\s*[-–—]|^\d{1,3}$/.test(t) || (l.words.length <= 4 && letterRatio(t) < 0.6))) { include = false; reason = 'フッター'; }
    else if (markerOnly) { include = false; reason = '設問記号・行番号'; }
    else if (g) {
      include = false; reason = '読み取り不能（日本語・記号の可能性）';
      // Two garbled lines in a row after the passage usually start the glossary/questions block.
      if (garbleRun >= 2 && bodySeen >= 1) afterTail = '語注・設問の可能性';
    }
    // [C3] an English line with a stray "。" or speck is not a Japanese line.
    else if (hasJapanese(t) && (QUESTION_HEAD.test(t) || GLOSSARY_HEAD.test(t) || !mostlyEnglish(t))) {
      include = false;
      if (QUESTION_HEAD.test(t)) { reason = '設問'; afterTail = '設問以降'; }
      else if (GLOSSARY_HEAD.test(t)) { reason = '語注'; afterTail = '語注以降'; }
      else reason = '日本語';
    }
    else if (INSTRUCTION.test(t.replace(/\s+/g, ''))) { include = false; reason = '指示文'; if (/^\S{0,4}?Answerthe/i.test(t.replace(/\s+/g, ''))) afterTail = '設問以降'; }
    else if (MC_STEM.test(t)) { include = false; reason = '設問'; afterTail = '設問以降'; }
    else if (BYLINE.test(t) && l.words.length <= 6) { include = false; reason = '著者・出典'; }
    else if (GLOSSARY_HEAD.test(t) && idx > 0) { include = false; reason = '語注'; afterTail = '語注以降'; }
    else if (MARGIN_NUM.test(t) || /^[-–—\s]*\d{1,3}[-–—\s]*$/.test(t)) { include = false; reason = '行番号・ページ番号'; }
    else if (letterRatio(t) < 0.5) { include = false; reason = '記号・ノイズ'; }
    else if (pageHeight && (yMid < pageHeight * 0.06 || yMid > pageHeight * 0.95) && l.words.length <= 4 && letterRatio(t) < 0.6) { include = false; reason = 'ヘッダー・フッター'; }
    else if (/^\s*[(（]?\s*[A-Z]\s*[)）]?\s*$/.test(t)) { include = false; reason = '記号のみ'; }
    // A Roman-numeral or section label such as "I", "II", "[1]" alone on a line.
    else if (/^\s*[\[(（]?(?:[IVX]{1,4}|[0-9]{1,2})[\])）.]?\s*$/.test(t)) { include = false; reason = '見出し番号'; }
    // An English instruction line typical of exam pages.
    else if (/^\s*(?:Read the following|Answer the following|次の英文)/i.test(t)) { include = false; reason = '指示文'; }
    else if (/^\s*\d{1,2}\s*[.．]\s+(?:Explain|Translate|Choose|Answer|Write|Why|What|How|Which|Summari[sz]e)\b/.test(t) && bodySeen >= 3) { include = false; reason = '設問'; afterTail = '設問以降'; }
    if (include) bodySeen++;
    return { ...l, include, reason, lowConf: typeof l.conf === 'number' && l.conf < 70 };
  });
}

const KEEP_HYPHEN_PREFIX = /^(?:self|well|ill|non|anti|cross|long|short|high|low|full|half|semi|so|re|co|pre|post|ex|all|cost|time|world|mid|over|under|first|second|third|one|two|three|four|five|twenty|thirty|forty|fifty|ever|never|old|new|ill)$/i;

// Join a line-broken hyphenation: "inter-" + "esting" → "interesting".
// Keep the hyphen for compound prefixes ("self-" + "esteem") or if the hyphenated form is used elsewhere.
export function joinHyphen(left, right, wholeText = '') {
  const m = left.match(/([A-Za-z]+)[-‐‑]$/);
  const first = right.match(/^([a-z][A-Za-z]*)/);
  if (!m || !first) return null;
  const hyph = `${m[1]}-${first[1]}`, solid = m[1] + first[1];
  const keep = KEEP_HYPHEN_PREFIX.test(m[1]) || (wholeText && new RegExp(`\\b${escapeRe(hyph)}\\b`, 'i').test(wholeText.replace(/[-‐‑]\s*\n\s*/g, '~')));
  return { text: left.slice(0, -1) + (keep ? '-' : '') + right, kept: keep, word: keep ? hyph : solid };
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Turn included lines into paragraph text. Paragraph breaks come from first-line
// indentation, vertical gaps, or a short last line ending with sentence punctuation.
export function linesToText(lines, { frame } = {}) {
  const fromOcr = lines.some(l => l.source === 'ocr');
  const inc = lines.filter(l => l.include !== false && l.text.trim());
  if (!inc.length) return { text: '', notes: [] };
  frame = frame || bodyFrame(inc);
  const width = Math.max(1, frame.right - frame.left);
  const notes = [];
  const whole = inc.map(l => l.text).join('\n');
  // Typical top-to-top line step; exam pages are often double-spaced, so gaps are judged against it.
  const steps = inc.slice(1).map((l, i) => l.bbox.y0 - inc[i].bbox.y0).filter(d => d > 0);
  const step = median(steps) || frame.lineHeight * 1.5;
  let paras = [], cur = '', ocrParaStart = false;
  inc.forEach((l, i) => {
    let t = l.text.replace(/\s+/g, ' ').trim();
    const prev = inc[i - 1];
    const indent = l.bbox.x0 - frame.left > frame.lineHeight * 0.7 && l.bbox.x0 - frame.left < width * 0.3;
    const gap = !!prev && l.bbox.y0 - prev.bbox.y0 > step * 1.6;
    // [C9] OCR reads a circled paragraph number as junk ("(®", "@", "(3", "(B", "7"): drop it, start a paragraph.
    const pj = fromOcr && l.source === 'ocr' ? ocrParaNumber(t, !prev || gap || indent) : null;
    if (pj != null) { t = pj; notes.push({ type: 'para-number-dropped' }); if (!prev) ocrParaStart = true; }
    if (!prev) { cur = t; return; }
    const shortPrev = prev.bbox.x1 < frame.right - width * 0.12 && /[.!?]["”’)]?$/.test(cur);
    const circled = CIRCLED.test(t) || pj != null;
    const centered = (z) => z.bbox.x0 - frame.left > width * 0.12 && frame.right - z.bbox.x1 > width * 0.12;
    const newPara = circled || centered(l) || centered(prev) || indent || gap || (shortPrev && indent) || (shortPrev && /^[A-Z“"]/.test(t) && prev.bbox.x1 < frame.right - width * 0.25);
    // Numbered subheadings ("1. Redefine Success") stand as their own paragraph.
    const heading = (s) => /^\d{1,2}\.\s+[A-Z][^.!?:]*$/.test(s) && s.split(' ').length <= 8;
    if (newPara || heading(t) || heading(cur)) { paras.push(cur); cur = t; return; }
    const hy = joinHyphen(cur, t, whole);
    if (hy) { cur = hy.text; notes.push({ type: hy.kept ? 'hyphen-kept' : 'hyphen-joined', word: hy.word }); }
    else cur += ' ' + t;
  });
  paras.push(cur);
  // Common OCR confusion: a lone "1" read for the pronoun "I" before a verb.
  // "1" where prose needs "I": at a sentence start, after a quote, or between words, followed by a lowercase word
  // that does not suggest a number ("1 in 5", "1 of", "1 million").
  const ONE_AS_I = /(^|[.!?]["”’]?\s+|["“]\s*|[a-z,;:]\s)1(?= (?!(?:in|of|out|or|and|to|per|by|more|less|million|billion|hundred|thousand|percent|point|year|years|day|days|hour|hours|minute|minutes|time|times|page|pages|kg|km|cm|mm|m|g)\b)[a-z]{2,}\b)/g;
  const fixed = paras.map(normalizeText).map(p => !fromOcr ? p : p.replace(ONE_AS_I, (m, pre) => { notes.push({ type: 'one-to-I' }); return pre + 'I'; }));
  const first = inc[0];
  const startsPara = ocrParaStart || CIRCLED.test(first.text.trim()) || (first.bbox.x0 - frame.left > frame.lineHeight * 0.7 && first.bbox.x0 - frame.left < width * 0.3);
  return { text: fixed.join('\n\n'), notes, startsPara };
}

// [C9] A circled number as Tesseract's English model reads it, at the start of an OCR line and followed by a
// capitalised word. "@", "®", "©" are never prose; "(3", "(B", "7" count only where a paragraph break is
// already likely (first line of the page, vertical gap or indent). Returns the line without it, or null.
const OCR_PARA_STRONG = /^[(（]?[@®©○◎]{1,2}[)）]?$/;
const OCR_PARA_WEAK = /^(?:[(（][0-9B]|[0-9])$/;
export function ocrParaNumber(t, atBreak) {
  const m = t.match(/^(\S{1,3}) (?=[A-Z“"‘])/);
  if (!m) return null;
  return OCR_PARA_STRONG.test(m[1]) || (atBreak && OCR_PARA_WEAK.test(m[1])) ? t.slice(m[0].length) : null;
}

// Contractions whose apostrophe OCR dropped ("wasnt" → "wasn't").
const CONTRACTIONS = { isnt: "isn't", arent: "aren't", wasnt: "wasn't", werent: "weren't", dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", couldnt: "couldn't", wouldnt: "wouldn't", shouldnt: "shouldn't", hasnt: "hasn't", havent: "haven't", hadnt: "hadn't", mustnt: "mustn't", neednt: "needn't", youre: "you're", theyre: "they're", weve: "we've", theyve: "they've", youve: "you've", itll: "it'll", thats: "that's", whats: "what's", theres: "there's" };

// Character-level normalization that is safe for English prose.
export function normalizeText(s) {
  return s
    .replace(/­/g, '')
    .replace(/\b[A-Za-z]+\b/g, (w) => { const c = CONTRACTIONS[w.toLowerCase()]; return c ? (w[0] === w[0].toUpperCase() ? c[0].toUpperCase() + c.slice(1) : c) : w; })
    .replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl').replace(/ﬀ/g, 'ff').replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/(?<=[A-Za-z])。/g, '.')
    // Bracket gap markers "[ 15 ]" and OCR variants "[4J", "[ 6 J", "[I J", "[28 ]", "[ 18 |]", "[ 10 1", "[ 251" → "[ n ]".
    .replace(/\[\s+(\d{2})1(?=[\s,.;:]|$)/g, '[ $1 ]')
    .replace(/\[\s*(\d{1,2}|[Il])(?:\s*\|?\s*\]|\s*J(?![a-z])|\s+J|\s*\|(?=[\s,.;:]|$)|\s+[1l](?=[\s,.;:)]|$))\s*/g, (m, n) => `[ ${/^[Il]$/.test(n) ? '1' : n} ] `)
    .replace(/[`´]/g, "'").replace(/„/g, '“').replace(/¢/g, 'c')
    // Exam blanks first, before any space tightening: "(a )", "{( H )" → "( a )", "( H )".
    .replace(/[{\[]\s*(?=[(（])/g, '')
    .replace(/(^|\s)[(（{]\s*([A-Za-z]|[0-9]{1,2}|[IVX]{1,4})\s*[)）}]/g, '$1( $2 )')
    // Kana blanks (ア, イ, あ…) come out of the English model as junk such as "( -f )", "( VY )", "{ IT )".
    .replace(/(^|\s)[(（{]\s+[^\s(){}]{1,3}\s+[)）}]/g, (m, pre) => (/^\( [A-Za-z0-9] \)$/.test(m.trim()) ? m : `${pre}( ___ )`))
    .replace(/(^|\s)[(（{]\s*[^\sA-Za-z0-9(){}_]{1,3}\s*[)）}]/g, '$1( ___ )')
    // Keep curly quotes: they tell opening from closing, so spaces are tightened only on the inner side.
    .replace(/\s+([,.;:!?])(?=\s|$|["”’)])/g, '$1')
    .replace(/([“‘])\s+/g, '$1').replace(/\s+([”])/g, '$1')
    .replace(/\((?! [A-Za-z0-9_]{1,3} \))\s+/g, '(').replace(/(?<!\( [A-Za-z0-9_]{1,3})\s+\)/g, ')')
    // A stray hyphen inside a line ("to- Americans"), but not a suspended compound ("pre- and post-war").
    .replace(/\b([A-Za-z]+)- (?!(?:and|or|to)\b)(?=[A-Za-z])/g, '$1 ')
    // A stray period before a lowercase word ("also. extremely"), skipping abbreviations.
    .replace(/(^|\s)((?!(?:Mr|Mrs|Ms|Dr|St|Prof|vs|etc|No|Fig|cf|approx|Jr|Sr|Inc|Co|Ltd|Mt)\.)[A-Za-z]{2,})\. (?=[a-z])/g, '$1$2 ')
    // Thousands separator printed with a space: "12, 000" → "12,000".
    .replace(/\b(\d{1,3}), (\d{3})\b/g, '$1,$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Join page texts. If a page ends mid-sentence, its last paragraph continues on the next page.
// pageNums: pages that are not consecutive (6 then 8) are separate passages and never merged.
// startsPara[i] === false: the page's first line is not indented, so a paragraph continues across the break.
export function joinPages(pageTexts, pageNums = null, startsPara = null) {
  let out = '', prevNum = null;
  pageTexts.forEach((raw, i) => {
    const t = (raw || '').trim();
    if (!t) return;
    const num = pageNums ? pageNums[i] : null;
    const jump = pageNums && prevNum != null && num !== prevNum + 1;
    prevNum = num;
    if (!out) { out = t; return; }
    const endsSentence = /[.!?]["”’)]?$/.test(out) || /[:]$/.test(out);
    if (jump || (endsSentence && (!startsPara || startsPara[i] !== false))) { out += '\n\n' + t; return; }
    if (endsSentence) { out += ' ' + t; return; }
    const hy = joinHyphen(out, t, out + '\n' + t);
    out = hy ? hy.text : out + ' ' + t;
  });
  return out;
}

// The lines classifyLines (or the learner) left out of the passage — questions, choices, glossary, Japanese —
// one per line. Used only to find answer choices for blanks (blanks.js parseChoices); never read aloud.
export function excludedText(lines) {
  return (lines || []).filter(l => l.include === false && l.text?.trim()).map(l => l.text.replace(/\s+/g, ' ').trim()).join('\n');
}

// Exam markers that should not be read aloud: underline numbers "(1)", "( 2 )", blanks "( A )", "[ B ]".
// Kana blanks such as "( ニ )" come out of the English OCR as "( -f )", "( /\ )", "{ IT )", so any short padded token counts.
export const MARKER_RE = /(?:^|\s)(?:[(（\[［{]\s*(?:[0-9]{1,2}|[A-Z]{1,2}|[ivxIVX]{1,4}|[a-z])\s*[)）\]］}]|[(（{]\s+[^\s(){}]{1,3}\s+[)）}]|[(（{]\s*[^\sA-Za-z0-9(){}]{1,3}\s*[)）}])/g;
export function findMarkers(text) {
  const out = [];
  for (const m of text.matchAll(MARKER_RE)) out.push({ index: m.index, text: m[0].trim() });
  return out;
}
export function removeMarkers(text) {
  return text.replace(MARKER_RE, '').replace(/ {2,}/g, ' ').replace(/ ([,.;:!?])/g, '$1');
}

// Words that OCR often gets wrong or that need a human look.
export function suspiciousTokens(text) {
  const out = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text))) {
    const w = m[0];
    const core = w.replace(/^["'(“‘]+|["'),.;:!?”’]+$/g, '');
    let why = '';
    if (/[|]/.test(core) || /^[Il1]{2,}$/.test(core)) why = '縦線・I/l/1 の混同';
    else if (/[a-z][A-Z]/.test(core) && !/^(?:Mc|Mac|iP|eB)/.test(core)) why = '大文字小文字の混在';
    else if (/[A-Za-z][0-9]|[0-9][A-Za-z]/.test(core) && !/^\d+(?:st|nd|rd|th|s)$/.test(core)) why = '数字と文字の混在';
    else if (/[^\x20-\x7e–—]/.test(core)) why = '英語以外の文字';
    else if (/(.)\1\1/.test(core)) why = '同じ文字の連続';
    if (why) out.push({ index: m.index, word: w, why });
  }
  return out;
}

// Parse "4-6, 8-10" style page ranges (also accepts full-width digits, 〜, ～, 、).
export function parseRanges(input, maxPage) {
  const s = String(input).normalize('NFKC').replace(/[〜～~–—]/g, '-').replace(/[、，;]/g, ',').trim();
  if (!s) throw new Error('ページ範囲が空です');
  const pages = new Set();
  for (const part of s.split(',').map(p => p.trim()).filter(Boolean)) {
    const m = part.match(/^(\d+)\s*(?:-\s*(\d+))?$/);
    if (!m) throw new Error(`「${part}」を読み取れません。例: 4-6, 8-10`);
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b < a) throw new Error(`「${part}」の範囲が正しくありません`);
    if (b > maxPage) throw new Error(`${b}ページはありません（全${maxPage}ページ）`);
    for (let p = a; p <= b; p++) pages.add(p);
  }
  return [...pages].sort((x, y) => x - y);
}
export function formatRanges(pages) {
  const s = [...pages].sort((a, b) => a - b), out = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j;
  }
  return out.join(', ');
}

// Build line objects from pdf.js getTextContent() items (PDF user space → canvas pixels via viewport).
// Reading order comes from geometry, not from item order: items are grouped into lines by baseline
// and sorted by x. Word spaces come from horizontal gaps, not from hasEOL or item boundaries.
//
// Two kinds of text layer are handled:
//  - ordinary PDFs, where item widths are real advances: a space goes where the gap between one
//    item's right edge and the next item's left edge is wide enough;
//  - scanner/OCR text layers (invisible text over a page image), which often draw every glyph as
//    its own item in a font whose advance is a full em, so item widths overlap the next glyph and
//    say nothing. There, glyph start positions are all that is reliable: a space goes where the step
//    to the next glyph overshoots that glyph's typical width by a word space, and an optional word
//    test (isWord) settles the ambiguous gaps ("w ith" -> "with", "isthat" -> "is that").
// opts.isWord(lowercaseWord) -> boolean, e.g. makeWordChecker(vocabData); opts.stats receives the mode used.
export function linesFromTextContent(items, viewport, { isWord = null, stats = null } = {}) {
  const frags = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const [a, b, c, d, e, f] = it.transform;
    const size = (Math.hypot(c, d) || Math.hypot(a, b) || 10) * viewport.scale;
    const [x0, base] = viewport.convertToViewportPoint(e, f);
    const [xw] = viewport.convertToViewportPoint(e + (it.width || Math.hypot(a, b) * it.str.length * 0.5), f);
    frags.push({ str: it.str, x0: Math.min(x0, xw), x1: Math.max(x0, xw), base, size });
  }
  if (!frags.length) return [];

  // Item widths are unreliable when consecutive items on a baseline mostly overlap each other.
  let pairs = 0, overlaps = 0;
  for (let i = 1; i < frags.length; i++) {
    const p = frags[i - 1], q = frags[i];
    if (Math.abs(p.base - q.base) > p.size * 0.3 || q.x0 < p.x0) continue;
    pairs++;
    if (q.x0 < p.x1 - p.size * 0.25) overlaps++;
  }
  const pitchMode = pairs >= 10 && overlaps / pairs > 0.3;

  // Units: single glyphs (pitch mode) or whitespace-free pieces of items (normal mode).
  const units = [];
  for (const fr of frags) {
    const chars = [...fr.str], n = chars.length, adv = (fr.x1 - fr.x0) / Math.max(1, n);
    if (pitchMode) {
      // pdf.js merges glyphs into one item only when each sits one font advance after the previous,
      // so a multi-glyph item's glyphs start at multiples of width/length.
      chars.forEach((ch, k) => {
        if (ch.trim()) units.push({ idx: units.length, text: ch, x0: fr.x0 + k * adv, x1: fr.x0 + k * adv + fr.size * 0.5, base: fr.base, size: fr.size, spaceBefore: k > 0 && !chars[k - 1].trim() });
      });
    } else {
      let k = 0;
      for (const m of fr.str.matchAll(/\S+/g)) {
        const s = [...fr.str.slice(0, m.index)].length, len = [...m[0]].length;
        units.push({ idx: units.length, text: m[0], x0: fr.x0 + s * adv, x1: fr.x0 + (s + len) * adv, base: fr.base, size: fr.size, spaceBefore: k++ > 0 || /^\s/.test(fr.str) });
      }
    }
  }

  // Group by baseline (tolerance relative to font size), then order by x.
  units.sort((p, q) => p.base - q.base || p.x0 - q.x0);
  const rows = [];
  for (const u of units) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(u.base - r.base) <= Math.min(u.size, r.size) * 0.4) { r.units.push(u); r.base = (r.base * (r.units.length - 1) + u.base) / r.units.length; }
    else rows.push({ base: u.base, size: u.size, units: [u] });
  }
  rows.forEach(r => r.units.sort((p, q) => (Math.abs(p.x0 - q.x0) < Math.min(p.size, q.size) * 0.15 ? p.idx - q.idx : p.x0 - q.x0)));

  // Pitch mode: what matters is how far each step overshoots the glyph's own (typical) width.
  // Inside a word the overshoot is about 0; a word space adds ~0.25 em or more. The threshold is
  // the emptiest part of the page's overshoot histogram between 0.1 and 0.3 em.
  let thr = 0.19;
  if (pitchMode) {
    for (const r of rows) r.units.forEach((u, i) => {
      const nx = r.units[i + 1];
      u.step = nx ? (nx.x0 - u.x0) / u.size : Infinity;
      // A ligature box ("ti", "fi", "t.") puts two glyphs at almost one x: judge the gap after the
      // pair from the pair's start and combined width, not from the second glyph alone.
      let c0 = i, em = glyphEm(u.text);
      while (c0 > 0 && (r.units[c0].x0 - r.units[c0 - 1].x0) / u.size < 0.15) { c0--; em += glyphEm(r.units[c0].text); }
      u.res = nx ? (nx.x0 - r.units[c0].x0) / u.size - em : Infinity;
    });
    const W = 0.025, lo = 0.075, bins = new Array(10).fill(0);
    for (const r of rows) for (const u of r.units) { const k = Math.floor((u.res - lo) / W); if (k >= 0 && k < bins.length) bins[k]++; }
    if (bins.reduce((x, y) => x + y, 0) >= 40) {
      let best = -1, bestV = Infinity;
      for (let k = 1; k < bins.length - 1; k++) {
        const v = bins[k - 1] + bins[k] + bins[k + 1], c = lo + (k + 0.5) * W;
        if (v < bestV || (v === bestV && Math.abs(c - 0.19) < Math.abs(lo + (best + 0.5) * W - 0.19))) { best = k; bestV = v; }
      }
      thr = lo + (best + 0.5) * W;
    }
    for (const r of rows) for (const u of r.units) u.x1 = u.x0 + Math.min(u.step, glyphEm(u.text) + 0.05) * u.size;
  }
  if (stats) Object.assign(stats, { pitchMode, spaceThreshold: pitchMode ? +thr.toFixed(3) : null, items: frags.length });

  const lines = [];
  for (const r of rows) {
    // Tokens as lists of units.
    let toks = [];
    r.units.forEach((u, i) => {
      const prev = r.units[i - 1];
      let space = !prev || u.spaceBefore;
      if (prev && !space) space = pitchMode ? prev.res > thr : u.x0 - prev.x1 > Math.min(u.size, prev.size) * 0.15;
      if (space) toks.push([u]); else toks[toks.length - 1].push(u);
    });
    if (pitchMode && isWord) toks = repairTokens(toks, isWord, thr);
    const words = toks.map(us => ({
      text: us.map(u => u.text).join(''), conf: 100,
      bbox: { x0: us[0].x0, y0: Math.min(...us.map(u => r.base - u.size * 0.8)), x1: Math.max(...us.map(u => u.x1)), y1: Math.max(...us.map(u => r.base + u.size * 0.2)) },
    }));
    if (!words.length) continue;
    lines.push({ text: words.map(w => w.text).join(' '), bbox: unionBox(words.map(w => w.bbox)), conf: 100, words, source: 'text' });
  }
  return lines;
}

// Typical advance of a glyph in em (Times-Roman metrics); used only to judge gaps in pitch mode.
const GLYPH_EM = { a: .444, b: .5, c: .444, d: .5, e: .444, f: .333, g: .5, h: .5, i: .278, j: .278, k: .5, l: .278, m: .778, n: .5, o: .5, p: .5, q: .5, r: .333, s: .389, t: .278, u: .5, v: .5, w: .722, x: .5, y: .5, z: .444,
  A: .722, B: .667, C: .667, D: .722, E: .611, F: .556, G: .722, H: .722, I: .333, J: .389, K: .722, L: .611, M: .889, N: .722, O: .722, P: .556, Q: .722, R: .667, S: .556, T: .611, U: .722, V: .722, W: .944, X: .722, Y: .722, Z: .611,
  '.': .25, ',': .25, ';': .278, ':': .278, "'": .333, '’': .333, '‘': .333, '"': .444, '“': .444, '”': .444, '-': .333, '(': .333, ')': .333, '[': .333, ']': .333, '!': .333, '?': .444, '/': .278 };
const glyphEm = (ch) => GLYPH_EM[ch] ?? (/[0-9]/.test(ch) ? .5 : JP.test(ch) ? 1 : .5);

// Second opinion from a word list for pitch-mode lines, where gap sizes alone are ambiguous.
// Around every token that is not a word, the letters of it and its neighbours are re-cut so that
// every piece is a word: "ti me" → "time", "bye mpty" → "by empty", "isthat" → "is that".
// Cuts are cheap at existing spaces and at gaps that are at least a little wide; nothing changes
// unless every piece of the window becomes a known word.
function repairTokens(toks, isWord, thr) {
  const text = (us) => us.map(u => u.text).join('');
  const out = toks.slice();
  for (let i = 0; i < out.length; i++) {
    if (tokenKnown(text(out[i]), isWord)) continue;
    const joinL = i > 0 && /[A-Za-z]$/.test(text(out[i - 1])) && /^[A-Za-z]/.test(text(out[i]));
    const joinR = i + 1 < out.length && /[A-Za-z]$/.test(text(out[i])) && /^[A-Za-z]/.test(text(out[i + 1]));
    const wins = [[joinL ? i - 1 : i, joinR ? i + 1 : i], [joinL ? i - 1 : i, i], [i, joinR ? i + 1 : i], [i, i]];
    let best = null;
    for (const [a, b] of wins) {
      const r = resegment(out.slice(a, b + 1), isWord, thr);
      if (r && (!best || r.cost < best.cost)) best = { ...r, a, b };
    }
    if (!best) continue;
    out.splice(best.a, best.b - best.a + 1, ...best.toks);
    i = best.a + best.toks.length - 1;
  }
  return out;
}
function resegment(win, isWord, thr) {
  const us = win.flat();
  const s = us.map(u => u.text).join('');
  const m = s.match(/^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/);
  if (!m) return null;
  const lead = m[1].length, core = m[2], n = core.length;
  const spaceAt = new Set();                         // core positions with an existing space before them
  let k = 0;
  for (const t of win.slice(0, -1)) { k += t.length; spaceAt.add(k - lead); }
  // best[j]: cheapest cut of core[0..j) into words.
  const best = new Array(n + 1).fill(null);
  best[0] = { cost: 0, cuts: [] };
  for (let j = 1; j <= n; j++) for (let i = 0; i < j; i++) {
    if (!best[i]) continue;
    const piece = core.slice(i, j);
    if (!isWordForm(piece, isWord)) continue;
    let cost = best[i].cost + 0.05;
    if (i > 0 && !spaceAt.has(i)) { if (!(us[lead + i - 1].res > 0.04)) continue; cost += 0.4; }
    // Removing an existing space is cheap unless the gap is wide.
    for (const c of spaceAt) if (c > i && c < j) { if (us[lead + c - 1].res > thr + 0.35) cost = Infinity; cost += 0.3; }
    if (cost < (best[j]?.cost ?? Infinity)) best[j] = { cost, cuts: i > 0 ? [...best[i].cuts, i] : [] };
  }
  const seg = best[n];
  if (!seg || !isFinite(seg.cost)) return null;
  const toks = [];
  let from = 0;
  for (const c of seg.cuts) { toks.push(us.slice(from, lead + c)); from = lead + c; }
  toks.push(us.slice(from));
  return { cost: seg.cost, toks };
}
function tokenKnown(s, isWord) {
  const core = s.replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').replace(/['’]s$/i, '');
  if (!core) return true;
  return core.split(/[-'’]/).every(p => p && isWordForm(p, isWord));
}
function isWordForm(p, isWord) {
  if (p.length === 1) return /^[aAI]$/.test(p);
  return wordForms(p.toLowerCase()).some(isWord);
}

// Word test built from the vocab.js data ({ easy:Set, gloss:object, irregular?:object }).
export function makeWordChecker(vocab) {
  const has = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  return (k) => vocab.easy.has(k) || has(vocab.gloss, k) || has(vocab.irregular, k);
}

// Does a text layer read as English? Share of alphabetic tokens (3+ letters) that are dictionary
// words after simple lemmatisation. Pages with too few English tokens (Japanese pages, blank pages) are never "garbled".
// isWord: a function (see makeWordChecker) or the vocab data itself.
export function textLayerQuality(text, isWord, { minTokens = 20, threshold = 0.7 } = {}) {
  const toks = (String(text).match(/[A-Za-z]+/g) || []).filter(t => t.length >= 3 && !/^[A-Z]{2,}$/.test(t));
  if (!isWord) return { tokens: toks.length, known: 0, ratio: null, garbled: false };
  if (typeof isWord !== 'function') isWord = makeWordChecker(isWord);
  let known = 0;
  for (const t of toks) if (wordForms(t.toLowerCase()).some(isWord)) known++;
  const ratio = toks.length ? known / toks.length : null;
  return { tokens: toks.length, known, ratio, garbled: toks.length >= minTokens && ratio < threshold };
}
function wordForms(w) {
  const out = [w];
  const add = (s) => { if (s.length >= 2) out.push(s, s + 'e'); if (/([b-df-hj-np-tv-z])\1$/.test(s)) out.push(s.slice(0, -1)); };
  if (w.endsWith('ies') || w.endsWith('ied')) out.push(w.slice(0, -3) + 'y');
  if (w.endsWith('s')) out.push(w.slice(0, -1));
  if (w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.endsWith('ed')) add(w.slice(0, -2));
  if (w.endsWith('ing')) add(w.slice(0, -3));
  if (w.endsWith('ly')) { out.push(w.slice(0, -2)); if (w.endsWith('ily')) out.push(w.slice(0, -3) + 'y'); }
  if (w.endsWith('er')) add(w.slice(0, -2));
  if (w.endsWith('est')) add(w.slice(0, -3));
  if (w.endsWith('ness') || w.endsWith('ment')) out.push(w.slice(0, -4));
  return out;
}

// Build line objects from a Tesseract.js result (v5+ with output.blocks = true).
export function linesFromTesseract(data, scale = 1, offset = { x: 0, y: 0 }) {
  const lines = [];
  for (const block of data.blocks || []) for (const para of block.paragraphs || []) for (const line of para.lines || []) {
    const words = (line.words || []).map(w => ({ text: w.text, conf: w.confidence, bbox: sb(w.bbox) })).filter(w => w.text.trim());
    if (!words.length) continue;
    lines.push({ text: words.map(w => w.text).join(' '), conf: line.confidence, bbox: sb(line.bbox), words, source: 'ocr' });
  }
  return lines;
  function sb(b) { return { x0: b.x0 / scale + offset.x, y0: b.y0 / scale + offset.y, x1: b.x1 / scale + offset.x, y1: b.y1 / scale + offset.y }; }
}

export function wordCount(s) { return (s.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length; }
