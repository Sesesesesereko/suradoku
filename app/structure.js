// structure.js - 構文図: one sentence laid out vertically so that parallel structures (並列) are obvious,
// in the style of a Japanese 参考書: each conjunct of a coordination on its own line, left-aligned, with the
// coordinator (and / or / but also ...) in a gutter column; clauses keep their bracket marks; S / V / O / C labels.
//
// Two sources build the same tree:
//   - 自動（簡易）: heuristics on top of syntax.js (compromise tags + clause marks), instant and offline.
//   - AI: the AI chosen in 「AIの設定」 (Claude via the `sample` capability of the claude.ai link version, or
//     Gemini with the learner's key: app/ai.js) returns a JSON tree after a click.
//     The tree is checked against the sentence (its leaves must give back exactly the sentence's words)
//     and cached per sentence in localStorage.
//
// Tree (internal, after normalization): node = { kind, role?, s?, e?, children? }
//   kind 'w'   : a leaf, words s..e (global word indices, inclusive)
//   kind 'cc'  : a coordinator leaf inside a 'par' (and, or, but also, both ...)
//   kind 'seq' : a plain group; 'rel' | 'noun' | 'adv' | 'post' : a clause / phrase with brackets
//   kind 'par' : a coordination; children are conjuncts and 'cc' leaves, in sentence order

import { tokensWithBoundaries } from './chunker.js';
import { analyze as sxAnalyze, MARK_INFO } from './syntax.js';
import { hashText } from './translate.js';
import { aiReady, aiJson, aiWhyNot, aiName, aiBusyText, aiTimeoutText, aiUnavailableText, providerErrorText, onAiChange, isClaude } from './ai.js';

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const bare = (t) => (t || '').toLowerCase().replace(/^[\s"'“”‘’(\[{]+/, '').replace(/[\s"'“”‘’)\]}.,;:!?—–-]+$/, '');
const endsComma = (t) => /,["'”’)\]]*$/.test(t);
const endsSemi = (t) => /[;:]["'”’)\]]*$/.test(t) || /^(—|–|--)$/.test(t) || /[—–]$/.test(t);
const keyOf = (s) => s.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
const ROLES = ['S', 'V', 'O', 'C', 'M', 'O1', 'O2'];
const CLAUSE = ['rel', 'noun', 'adv', 'post'];
const KIND_NAME = { rel: '関係詞節', noun: '名詞節', adv: '副詞節', post: '後置修飾', par: '並列' };
const ROLE_NAME = { S: '主語', V: '動詞', O: '目的語', C: '補語', M: '修飾語' };

// ---------------------------------------------------------------------------
// Rule-based tree (自動（簡易）)
// ---------------------------------------------------------------------------

const COORD = new Set(['and', 'or', 'but', 'nor']);
const CONN = new Set(['however', 'therefore', 'thus', 'moreover', 'furthermore', 'nevertheless', 'instead', 'indeed', 'also', 'then', 'still', 'meanwhile', 'consequently', 'so', 'yet', 'and', 'but', 'or', 'first', 'finally', 'besides']);

// ctx: { words, pos, marks } with global indices; [a, b]: one sentence.
export function ruleTree(ctx, a, b) {
  const { words, pos } = ctx;
  const p0 = (i) => (pos[i] || '').split('・')[0];
  const isVerb = (i) => /^(動|助動)$/.test(p0(i));
  const npish = (i) => ['名', '形', '冠', '代', '数'].includes(p0(i)) || /('s|s')$/.test(bare(words[i])) || bare(words[i]) === 'of' && i > a && i < b;
  const subjPron = (i) => /^(i|we|you|they|he|she|it|this|these|those|there)$/.test(bare(words[i]));

  // Units: clause marks + S / V marks that nest properly inside the sentence.
  const cand = [];
  for (const m of ctx.marks) {
    if (m.start < a || m.end > b || m.start > m.end) continue;
    if (CLAUSE.includes(m.type)) { if (!(m.start === a && m.end === b)) cand.push({ s: m.start, e: m.end, kind: m.type }); }
    else if (m.type === 'subj') cand.push({ s: m.start, e: m.end, kind: 'seq', role: 'S' });
    else if (m.type === 'verb') cand.push({ s: m.start, e: m.end, kind: 'seq', role: 'V' });
  }
  cand.sort((x, y) => x.s - y.s || (y.e - y.s) - (x.e - x.s) || (x.role ? 1 : 0) - (y.role ? 1 : 0));
  const kept = [];
  for (const u of cand) {
    if (kept.some(k => k.s === u.s && k.e === u.e)) continue;
    if (kept.every(k => u.e < k.s || u.s > k.e || (u.s >= k.s && u.e <= k.e) || (k.s >= u.s && k.e <= u.e))) kept.push({ ...u, children: [] });
  }
  const root = { s: a, e: b, kind: 'seq', children: [] };
  const place = (parent, u) => {
    const inner = parent.children.find(c => u.s >= c.s && u.e <= c.e);
    if (inner) place(inner, u); else parent.children.push(u);
  };
  for (const u of kept) place(root, u);
  const sortAll = (n) => { n.children.sort((x, y) => x.s - y.s); n.children.forEach(sortAll); };
  sortAll(root);

  // A subject guess when no long-subject mark: the words before the first main verb, after introductory parts.
  if (!root.children.some(u => u.role === 'S')) {
    const vi = root.children.findIndex(u => u.role === 'V');
    if (vi >= 0) {
      const v = root.children[vi];
      let s = a;
      for (;;) {
        const u = root.children.find(c => c.s === s && c.e < v.s && !c.role);
        if (u && u.kind === 'adv' && endsComma(words[u.e])) { s = u.e + 1; continue; }
        if (u && u.kind === 'adv' && u.e + 1 < v.s && !npish(u.e + 1)) { s = u.e + 1; continue; }
        // "However," / "In 2010," / "Then, around ... ago,"
        let c = s; while (c < v.s && !endsComma(words[c]) && c - s < 6) c++;
        if (c < v.s - 0 && endsComma(words[c]) && !root.children.some(u2 => u2.s <= c && u2.e >= c && u2.s > s)) { const first = bare(words[s]); if (CONN.has(first) || /^(前|副)$/.test(p0(s)) || c === s) { s = c + 1; continue; } }
        break;
      }
      const e = v.s - 1;
      const crosses = root.children.some(u => u.s <= e && u.e > e || u.s < s && u.e >= s);
      if (s <= e && !crosses && (npish(s) || subjPron(s) || /ing$/.test(bare(words[s])) || root.children.some(u => u.s === s && u.kind === 'noun'))) {
        const S = { s, e, kind: 'seq', role: 'S', children: root.children.filter(u => u.s >= s && u.e <= e) };
        root.children = root.children.filter(u => !(u.s >= s && u.e <= e));
        root.children.push(S); sortAll(root);
      }
    }
  }

  // A that-/relative clause that a comma cut short, followed by more verbs of the same clause:
  // "found [that children ... develop X], understand Y, and enjoy Z" -> the clause runs to the end of the list.
  {
    const kids = root.children;
    const vIdx = kids.findIndex(u => u.role === 'V');
    for (const u of kids) {
      if (!(u.kind === 'noun' || u.kind === 'rel') || !endsComma(words[u.e]) || vIdx < 0 || kids[vIdx].s > u.s) continue;
      let k = u.e + 1, ok = false, end = -1;
      const next = kids.find(x => x.s === k);
      if (next && next.role !== 'V' || k > b || !isVerb(k)) continue;
      for (; k <= b; k++) {
        if (endsSemi(words[k])) break;
        if (COORD.has(bare(words[k])) && k + 1 <= b && isVerb(k + 1) && (endsComma(words[k - 1]) || k > u.e + 1)) ok = true;
      }
      if (!ok) continue;
      end = k > b ? b : k;
      u.e = end;
      u.children = [...u.children, ...kids.filter(x => x !== u && x.s > u.s && x.e <= end).filter(x => x.role !== 'V')];
      root.children = kids.filter(x => !(x !== u && x.s > u.s && x.e <= end));
      sortAll(u);
      break;
    }
  }

  // ---- coordination on a list of atoms (a word or a unit at one level) ----
  const atomsOf = (n) => {
    const out = []; let k = n.s;
    for (const u of n.children) { while (k < u.s) { out.push({ s: k, e: k }); k++; } out.push({ s: u.s, e: u.e, unit: u }); k = u.e + 1; }
    while (k <= n.e) { out.push({ s: k, e: k }); k++; }
    return out;
  };
  const W = (at) => at.unit ? '' : bare(words[at.s]);
  const catOf = (at) => {
    const u = at.unit;
    if (u) {
      if (u.role === 'V') return 'v';
      if (u.role === 'S') return 'np';
      if (u.kind === 'noun') return bare(words[u.s]) === 'that' ? 'that' : 'wh';
      return u.kind;            // rel / adv / post
    }
    const i = at.s, w = bare(words[i]), p = p0(i);
    if (w === 'to' && p === '不') return 'to';
    if (w === 'that' && i > a && COORD.has(bare(words[i - 1]))) return 'that';
    if (p === '前' || w === 'of') return 'pp';
    if (/ing$/.test(w) && w.length > 4 && (p === '動' || (pos[i] || '').includes('動'))) return 'ing';
    if (isVerb(i)) return 'v';
    if (p === '副') return 'adv';
    if (npish(i) || subjPron(i)) return 'np';
    return '';
  };
  const commaAt = (at) => endsComma(words[at.e]);
  const verbAtom = (at) => at.unit ? at.unit.role === 'V' : isVerb(at.s);
  const npAtom = (at) => !at.unit && npish(at.s) || at.unit?.role === 'S';
  const npRunStart = (atoms, from) => {   // walk back over a noun phrase
    let k = from;
    if (!npAtom(atoms[k])) return -1;
    while (k - 1 >= 0 && !commaAt(atoms[k - 1]) && (npAtom(atoms[k - 1]) || W(atoms[k - 1]) === 'of' || p0(atoms[k - 1].s) === '副' && !atoms[k - 1].unit && p0(atoms[k].s) === '形')) k--;
    while (k < from && W(atoms[k]) === 'of') k++;
    return k;
  };
  const findStartBack = (atoms, cat, from) => {
    if (from < 0) return -1;
    if (cat === 'np' || cat === 'adj') return npRunStart(atoms, from);
    for (let k = from; k >= 0; k--) {
      const at = atoms[k];
      if (!at.unit && endsSemi(words[at.e]) && k !== from) return -1;
      if (catOf(at) !== cat) continue;
      if (cat === 'v') {   // the start of the verb group ("can help", "often went")
        let s = k;
        while (s - 1 >= 0 && !atoms[s - 1].unit && (/^(助動)$/.test(p0(atoms[s - 1].s)) || p0(atoms[s - 1].s) === '副' && !commaAt(atoms[s - 1]))) s--;
        return s;
      }
      return k;
    }
    return -1;
  };
  const npRunEnd = (atoms, from) => {
    let k = from;
    if (!npAtom(atoms[k])) return -1;
    while (k + 1 < atoms.length && !commaAt(atoms[k]) && (npAtom(atoms[k + 1]) || W(atoms[k + 1]) === 'of' && atoms[k + 2] && npAtom(atoms[k + 2]))) k++;
    return k;
  };
  const hasVerb = (atoms, s, e) => { for (let k = s; k <= e; k++) if (verbAtom(atoms[k])) return true; return false; };

  const findPar = (atoms, ci) => {
    const w = W(atoms[ci]);
    let ccLen = 1;
    if (w === 'as') { if (W(atoms[ci + 1] || {}) === 'well' && W(atoms[ci + 2] || {}) === 'as') ccLen = 3; else return null; }
    else if (!COORD.has(w)) return null;
    if (w === 'but' && W(atoms[ci + 1] || {}) === 'also') ccLen = 2;
    const rs = ci + ccLen, le = ci - 1;
    if (rs >= atoms.length || le < 0) return null;
    let rcat = catOf(atoms[rs]);
    if (!rcat) return null;
    // A whole clause after the coordinator ("..., and she stayed"): both sides have their own verb.
    if (W(atoms[rs]) === 'that' && !atoms[rs].unit && catOf(atoms[findStartBack(atoms, 'that', le)] || {}) === 'that') rcat = 'that';
    const rnpEnd = rcat === 'np' ? npRunEnd(atoms, rs) : -1;
    let afterNp = rnpEnd + 1;
    while (atoms[afterNp] && !atoms[afterNp].unit && p0(atoms[afterNp].s) === '副' && !commaAt(atoms[afterNp])) afterNp++;
    if (rcat === 'np' && rnpEnd >= 0 && atoms[afterNp] && verbAtom(atoms[afterNp]) && hasVerb(atoms, 0, le)) rcat = 'cl';
    // correlatives: both A and B / either A or B / neither A nor B / not only A but (also) B / not A but B
    for (let k = le; k >= 0 && k >= le - 14; k--) {
      const at = atoms[k], wk = W(at);
      if (k < le && (COORD.has(wk) || !at.unit && endsSemi(words[at.e]))) break;
      let c0 = -1;
      if ((wk === 'both' && w === 'and') || (wk === 'either' && w === 'or') || (wk === 'neither' && w === 'nor')) c0 = k;
      else if (w === 'but' && wk === 'only' && W(atoms[k - 1] || {}) === 'not') c0 = k - 1;
      else if (w === 'but' && wk === 'not' && le - k <= 4 && k > 0) c0 = k;
      if (c0 < 0 || k === le) continue;
      let R2 = rs;
      if (rcat === 'cl' || rcat === 'that' || rcat === 'v' || rcat === 'to' || rcat === 'ing' || rcat === 'pp') { while (R2 + 1 < atoms.length && !(!atoms[R2].unit && endsSemi(words[atoms[R2].e]))) R2++; }
      else if (rnpEnd >= 0) R2 = rnpEnd;
      return { L: c0, R: R2, rows: [{ cc: [c0, k], s: k + 1, e: le }, { cc: [ci, rs - 1], s: rs, e: R2 }] };
    }
    if (rcat === 'cl') {
      if (w !== 'and' && w !== 'but' && w !== 'or') return null;
      let L = 0;
      while (L < le && (commaAt(atoms[L]) && CONN.has(W(atoms[L])))) L++;
      return { L, R: atoms.length - 1, rows: [{ cc: [], s: L, e: le }, { cc: [ci, rs - 1], s: rs, e: atoms.length - 1 }] };
    }
    // the last conjunct
    let R;
    if (rcat === 'np' || rcat === 'adj') R = rnpEnd >= 0 ? rnpEnd : rs;
    else if (rcat === 'adv') R = rs;
    else { R = rs; while (R + 1 < atoms.length && !(atoms[R].unit ? false : endsSemi(words[atoms[R].e]))) R++; }
    // earlier conjuncts: "X, Y, and Z" (each item begins right after a comma, with the same kind of word)
    const rows = [];
    let pos = ci, firstEnd = le;
    for (;;) {
      let j = -1;
      for (let k = pos - 2; k >= 0; k--) if (commaAt(atoms[k])) { j = k; break; }
      if (j < 0 || catOf(atoms[j + 1]) !== rcat) break;
      const itemEnd = pos === ci ? le : pos - 1;
      if (['np', 'adj', 'adv', 'pp'].includes(rcat) && hasVerb(atoms, j + 1, itemEnd)) break;
      // the item must contain no coordinator of its own
      let inner = false; for (let k = j + 1; k <= itemEnd; k++) if (COORD.has(W(atoms[k]))) inner = true;
      if (inner) break;
      rows.unshift({ cc: [], s: j + 1, e: itemEnd });
      pos = j + 1; firstEnd = j;
    }
    const L = findStartBack(atoms, rcat, firstEnd);
    if (L < 0 || L > firstEnd) return null;
    if (['np', 'adj', 'adv', 'pp'].includes(rcat) && hasVerb(atoms, L, firstEnd)) return null;
    for (let k = L; k <= firstEnd; k++) if (COORD.has(W(atoms[k])) && k !== L) return null;
    rows.unshift({ cc: [], s: L, e: firstEnd });
    rows.push({ cc: [ci, rs - 1], s: rs, e: R, wrap: rcat === 'that' ? 'noun' : '' });
    return { L, R, rows };
  };

  const leaf = (s, e) => ({ kind: 'w', s, e });
  const buildSeq = (atoms) => {
    for (let ci = 0; ci < atoms.length; ci++) {
      if (atoms[ci].unit) continue;
      const par = findPar(atoms, ci);
      if (!par) continue;
      const out = [...buildSeq(atoms.slice(0, par.L))];
      const kids = [];
      for (const r of par.rows) {
        if (r.cc.length) kids.push({ kind: 'cc', s: atoms[r.cc[0]].s, e: atoms[r.cc[1]].e });
        const inner = buildSeq(atoms.slice(r.s, r.e + 1));
        kids.push(r.wrap ? { kind: 'seq', children: [{ kind: r.wrap, children: inner }] } : { kind: 'seq', children: inner });
      }
      out.push({ kind: 'par', children: kids });
      out.push(...buildSeq(atoms.slice(par.R + 1)));
      return out;
    }
    const out = [];
    for (const at of atoms) {
      if (at.unit) { out.push(unitNode(at.unit)); continue; }
      const last = out[out.length - 1];
      if (last?.kind === 'w' && last.e === at.s - 1 && !last.fixed) last.e = at.e; else out.push(leaf(at.s, at.e));
    }
    return out;
  };
  const unitNode = (u) => ({ kind: u.kind, role: u.role, children: buildSeq(atomsOf(u)) });
  return { kind: 'seq', children: buildSeq(atomsOf(root)) };
}

// ---------------------------------------------------------------------------
// AI tree: normalization and validation against the sentence
// ---------------------------------------------------------------------------

// Raw JSON from Claude -> internal tree with word ranges. Throws {code:'mismatch', at} when the leaves
// do not give back the sentence's words. words: the sentence's words; base: global index of words[0].
export function alignTree(raw, words, base = 0) {
  let count = 0;
  const leaves = [];
  const norm = (n, depth) => {
    if (++count > 600 || depth > 14) throw Object.assign(new Error('too deep'), { code: 'shape' });
    if (typeof n === 'string') n = { text: n };
    if (!n || typeof n !== 'object' || Array.isArray(n)) throw Object.assign(new Error('bad node'), { code: 'shape' });
    let kind = String(n.kind || n.type || '').toLowerCase();
    let role = typeof n.role === 'string' ? n.role.toUpperCase().replace(/[′'’]/g, '') : '';
    if (role === 'CC' || n.cc === true) { kind = 'cc'; role = ''; }
    if (!ROLES.includes(role)) role = '';
    if (Array.isArray(n.children) && n.children.length) {
      if (!['par', 'seq', ...CLAUSE].includes(kind)) kind = 'seq';
      return { kind, role: role || undefined, children: n.children.map(c => norm(c, depth + 1)) };
    }
    const text = typeof n.text === 'string' ? n.text : '';
    const node = { kind: kind === 'cc' ? 'cc' : 'w', role: role || undefined, text };
    leaves.push(node);
    return node;
  };
  const tree = norm(raw, 0);
  // Character-level alignment on letters/digits only, so spacing, quotes and punctuation never matter.
  const wordKeys = words.map(keyOf);
  const full = wordKeys.join('');
  const owner = [];           // char position in `full` -> word index
  wordKeys.forEach((k, i) => { for (let c = 0; c < k.length; c++) owner.push(i); });
  let at = 0;
  for (const lf of leaves) {
    const k = keyOf(lf.text);
    if (full.slice(at, at + k.length) !== k) {
      throw Object.assign(new Error('mismatch'), { code: 'mismatch', at: owner[at] ?? words.length - 1, got: lf.text });
    }
    lf.c0 = at; lf.c1 = at + k.length; at += k.length;
  }
  if (at !== full.length) throw Object.assign(new Error('incomplete'), { code: 'mismatch', at: owner[at] ?? words.length - 1, got: '' });
  // A word belongs to the leaf that holds its first letter; punctuation-only words join the previous leaf.
  let wi = 0;
  const firstChar = []; { let c = 0; for (const k of wordKeys) { firstChar.push(k.length ? c : -1); c += k.length; } }
  for (const lf of leaves) {
    const mine = [];
    while (wi < words.length && (firstChar[wi] === -1 ? mine.length || lf === leaves[0] : firstChar[wi] >= lf.c0 && firstChar[wi] < lf.c1)) { mine.push(wi); wi++; }
    if (mine.length) { lf.s = base + mine[0]; lf.e = base + mine[mine.length - 1]; }
  }
  while (wi < words.length) {   // trailing punctuation-only words
    const last = [...leaves].reverse().find(l => l.s != null);
    if (last) last.e = base + wi; wi++;
  }
  // prune empty leaves / groups
  const prune = (n) => {
    if (!n.children) return n.s != null ? n : null;
    n.children = n.children.map(prune).filter(Boolean);
    if (!n.children.length) return null;
    if (n.kind === 'par' && n.children.filter(c => c.kind !== 'cc').length < 2) n.kind = 'seq';
    return n;
  };
  const out = prune(tree);
  if (!out) throw Object.assign(new Error('empty'), { code: 'shape' });
  for (const lf of leaves) { delete lf.text; delete lf.c0; delete lf.c1; }
  return out.children ? out : { kind: 'seq', children: [out] };
}

const countPar = (n) => (n.kind === 'par' ? 1 : 0) + (n.children || []).reduce((s, c) => s + countPar(c), 0);

// ---------------------------------------------------------------------------
// Rendering (HTML/CSS: nested blocks; conjuncts stacked under each other)
// ---------------------------------------------------------------------------

export function renderTree(tree, words) {
  const text = (n) => words.slice(n.s, n.e + 1).join(' ');
  const hasBlock = (n) => n.kind === 'par' || (n.children || []).some(hasBlock);
  const prime = (role, depth) => role + (depth > 0 && role !== 'M' ? '′' : '');
  const roleTitle = (r) => `${r}＝${ROLE_NAME[r.replace(/\d/, '')] || ''}`;
  // Returns { el, block }
  const render = (n, depth) => {
    if (n.kind === 'w' || n.kind === 'cc') {
      const t = el('span', n.kind === 'cc' ? 'sd-cc' : 'sd-t', text(n));
      if (n.role) return { el: roleWrap(t, n.role, depth), block: false };
      return { el: t, block: false };
    }
    const inClause = CLAUSE.includes(n.kind);
    const childDepth = depth + (inClause ? 1 : 0);
    if (n.kind === 'par') return { el: renderPar(n, childDepth), block: true };
    const kids = n.children.map(c => render(c, childDepth));
    const block = kids.some(k => k.block);
    let body = block ? layout(kids) : inlineJoin(kids);
    if (inClause) {
      const info = MARK_INFO[n.kind];
      const open = el('span', `sd-br sd-br-${n.kind}`, info.open), close = el('span', `sd-br sd-br-${n.kind}`, info.close);
      open.title = close.title = KIND_NAME[n.kind];
      if (block) {
        const wrap = el('div', `sd-clause sd-k-${n.kind}`);
        wrap.append(open, body, close);
        body = wrap;
      } else {
        const wrap = el('span', `sd-iclause sd-k-${n.kind}`);
        wrap.append(open, body, close);
        body = wrap;
      }
    }
    if (n.role) {
      if (block) {
        const wrap = el('div', 'sd-rowrole');
        const lab = el('span', 'sd-rl', prime(n.role, depth)); lab.title = roleTitle(n.role);
        wrap.append(lab, body);
        return { el: wrap, block: true };
      }
      return { el: roleWrap(body, n.role, depth), block: false };
    }
    return { el: body, block };
  };
  const roleWrap = (inner, role, depth) => {
    const s = el('span', 'sd-role'); s.dataset.r = prime(role, depth); s.title = roleTitle(role);
    s.append(inner); return s;
  };
  const inlineJoin = (kids) => {
    const s = el('span', 'sd-in');
    kids.forEach((k, i) => { if (i) s.append(' '); s.append(k.el); });
    return s;
  };
  // [inline prefix] [column: first block, then the rest laid out the same way]
  const layout = (kids) => {
    const p = kids.findIndex(k => k.block);
    if (p < 0) return inlineJoin(kids);
    const row = el('div', 'sd-row');
    if (p > 0) {
      const pre = inlineJoin(kids.slice(0, p)); pre.classList.add('sd-pre'); row.append(pre);
      // A long lead-in goes on its own line and the stacked part is indented under it.
      if (pre.textContent.length > 26) row.classList.add('sd-drop');
    }
    const col = el('div', 'sd-col');
    col.append(kids[p].el);
    const rest = kids.slice(p + 1);
    if (rest.length) { const r = layout(rest); if (!r.classList.contains('sd-row')) r.classList.add('sd-line'); col.append(r); }
    row.append(col);
    return row;
  };
  const renderPar = (n, depth) => {
    const g = el('div', 'sd-par');
    g.setAttribute('role', 'group'); g.setAttribute('aria-label', '並列');
    let pend = [];
    const rows = [];
    for (const c of n.children) {
      if (c.kind === 'cc') { pend.push(text(c)); continue; }
      rows.push({ cc: pend.join(' '), node: c }); pend = [];
    }
    if (pend.length && rows.length) rows[rows.length - 1].tail = pend.join(' ');
    rows.forEach((r, i) => {
      const gut = el('div', 'sd-gut');
      if (r.cc) gut.append(el('span', 'sd-cc', r.cc));
      else if (i === 0) gut.append(el('span', 'sd-plab', '並列'));
      const cell = el('div', 'sd-conj');
      const k = render(r.node, depth);
      cell.append(k.el);
      if (r.tail) cell.append(' ', el('span', 'sd-cc', r.tail));
      g.append(gut, cell);
    });
    return g;
  };
  const r = render(tree, 0);
  const box = el('div', 'sd-fig');
  box.append(r.el);
  return box;
}

// ---------------------------------------------------------------------------
// AI request
// ---------------------------------------------------------------------------

const SCHEMA = `Node = one of
  {"text": "<words copied exactly from the sentence>", "role"?: R}
  {"kind": "cc", "text": "<coordinator: and / or / but / nor / but also / as well as / both / either / neither / not only ...>"}
  {"kind": "seq" | "par" | "rel" | "noun" | "adv" | "post", "role"?: R, "children": [Node, ...]}
R = "S" | "V" | "O" | "C" | "M"`;
const RULES = [
  'Rules:',
  '- Reading every "text" of the tree depth-first, left to right, must give back the sentence EXACTLY, word for word with its punctuation. Never add, drop, reorder, correct or translate words.',
  '- Use a "par" node for EVERY coordination: A and B / A, B(,) and C / both A and B / either A or B / neither A nor B / not only A but (also) B / not A but B / A as well as B / A but B. Its children are the conjuncts (usually "seq" nodes, each one whole conjunct) and the coordinator words as {"kind":"cc"} nodes exactly where they occur (the first half of a correlative such as "both" / "not only" comes before the first conjunct). A comma stays at the end of the text it follows.',
  '- Conjuncts must be grammatically parallel (same function). Choose the parallel units a teacher would point out: that-clauses, verbs/verb phrases sharing one subject, objects of one verb, -ing forms, to-infinitives, prepositional phrases, whole clauses. Words shared by all conjuncts (the subject, a shared verb, "the", a preposition before all of them) stay outside the "par".',
  '- "rel" = relative clause, "noun" = noun clause (that / wh- / whether / if), "adv" = adverbial clause (when, because, although, if ...), "post" = participle or to-infinitive phrase modifying the noun before it. The opener word (who, that, because ...) is inside the node.',
  '- role: mark the main clause\'s S, V, O, C (and M only for an important adverbial). Inside subordinate clauses you may mark S, V, O, C too. V is the verb group only (e.g. "can help", "has been shown").',
  '- Keep leaves as phrases, not single words, unless a role or a coordinator needs a split. Nest only as deep as needed.',
  '- explanation_ja: 2 to 4 short Japanese sentences for a Japanese high-school student: the sentence pattern (S V O など) and, above all, what is parallel with what and what the parallel parts share (例:「and は develop / understand / enjoy の3つの動詞をつなぎ、主語はどれも children」). Plain text, no markdown.',
];
function promptOne(sentence, context) {
  return [
    'You make a 構文図 (sentence-structure diagram) of one English sentence for Japanese high-school students reading entrance-exam passages. The app lays each conjunct of a coordination on its own line, so finding the parallel structures correctly matters most.',
    '', SCHEMA, '', ...RULES, '',
    'Reply with ONLY this JSON: {"tree": Node, "explanation_ja": "..."}',
    '', context && context !== sentence ? `Context paragraph (for meaning only):\n${context}\n` : '',
    `Sentence:\n${sentence}`,
  ].join('\n');
}
function promptMany(sentences, context) {
  return [
    'You make 構文図 (sentence-structure diagrams) of English sentences for Japanese high-school students reading entrance-exam passages. The app lays each conjunct of a coordination on its own line, so finding the parallel structures correctly matters most.',
    '', SCHEMA, '', ...RULES, '',
    `Reply with ONLY this JSON: {"items": [{"tree": Node, "explanation_ja": "..."}, ...]} with exactly ${sentences.length} items, one per sentence, in the same order.`,
    '', context ? `Context (for meaning only):\n${context}\n` : '',
    'Sentences (JSON array):', JSON.stringify(sentences),
  ].join('\n');
}

const CACHE = 'readflow:sd:', CACHE_IX = 'readflow:sd-index', CACHE_MAX = 400;
const memo = new Map();
function cacheGet(sentence) {
  const k = hashText(sentence);
  if (memo.has(k)) return memo.get(k);
  try { const v = JSON.parse(localStorage.getItem(CACHE + k) || 'null'); if (v) memo.set(k, v); return v; } catch { return null; }
}
function cachePut(sentence, v) {
  const k = hashText(sentence);
  memo.set(k, v);
  try {
    localStorage.setItem(CACHE + k, JSON.stringify(v));
    const ix = JSON.parse(localStorage.getItem(CACHE_IX) || '[]').filter(x => x !== k); ix.push(k);
    while (ix.length > CACHE_MAX) localStorage.removeItem(CACHE + ix.shift());
    localStorage.setItem(CACHE_IX, JSON.stringify(ix));
  } catch { /* storage full or blocked: keep in memory */ }
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

let nlpPromise = null;
const loadNlp = () => (nlpPromise ||= import('../vendor/compromise/compromise-two.mjs').then(m => m.default));
function wordsHash(words) {    // same as main.js, so state.sx (with the learner's corrections) can be reused
  const plain = words.join(' ');
  let h = 2166136261;
  for (let i = 0; i < plain.length; i++) { h ^= plain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${plain.length}`;
}

export function initStructure({ getState, link }) {
  const host = $('#sdPanel'), toggle = $('#sdToggle');
  if (!host || !toggle) return;
  // aiState: 'unknown' (not checked yet) | 'checking' | 'yes' | 'no' (aiWhy says why). Re-checked when 「AIの設定」 changes.
  const ui = { open: false, all: false, idx: 0, src: {}, busy: false, aiState: 'unknown', analysis: null, msg: '' };
  try { const v = JSON.parse(localStorage.getItem('readflow:sd') || 'null'); if (v) { ui.all = !!v.all; } } catch { /* ignore */ }
  const saveUi = () => { try { localStorage.setItem('readflow:sd', JSON.stringify({ all: ui.all })); } catch { /* ignore */ } };

  host.innerHTML = `
    <div class="row wrap sd-tools">
      <div class="seg" role="radiogroup" aria-label="構文図の範囲">
        <button role="radio" data-sdall="0">1文ずつ</button>
        <button role="radio" data-sdall="1">全文の構文図</button>
      </div>
      <span class="sd-nav">
        <button type="button" class="btn sm" id="sdPrev" aria-label="前の文">◀ 前の文</button>
        <select id="sdPick" aria-label="文を選ぶ"></select>
        <button type="button" class="btn sm" id="sdNext" aria-label="次の文">次の文 ▶</button>
      </span>
    </div>
    <div class="row wrap sd-tools">
      <div class="seg" role="radiogroup" aria-label="構文図の作り方" id="sdSrc" hidden>
        <button role="radio" data-sdsrc="ai">AI</button>
        <button role="radio" data-sdsrc="rule">自動（簡易）</button>
      </div>
      <button type="button" class="btn" id="sdAi">AIで構文図を作る</button>
      <span class="hint sd-why" id="sdWhy"></span>
    </div>
    <p class="sd-legend" aria-label="記号の意味"><span><b>S</b> 主語</span><span><b>V</b> 動詞</span><span><b>O</b> 目的語</span><span><b>C</b> 補語</span><span><b>M</b> 修飾語</span><span><b>′</b> 節の中</span><span><i class="sd-legpar"></i>並列（縦にそろえた部分）</span><span><b>[ ]</b> 名詞節</span><span><b>{ }</b> 関係詞節</span><span><b>＜＞</b> 副詞節</span><span><b>( )</b> 後置修飾</span></p>
    <p class="hint" id="sdInfo" role="status" aria-live="polite"></p>
    <div class="sd-out" id="sdOut" lang="en"></div>`;
  const out = $('#sdOut', host), info = $('#sdInfo', host), pick = $('#sdPick', host), aiBtn = $('#sdAi', host), why = $('#sdWhy', host);

  const sentencesOf = () => {
    const st = getState();
    if (!st.slashed) return { paras: [], words: [], sents: [] };
    const paras = tokensWithBoundaries(st.slashed);
    const words = paras.flat().map(t => t.word);
    const sents = []; let g = 0;
    paras.forEach((ts, pi) => {
      let s = g;
      ts.forEach((t, k) => { if (t.sentenceEnd || k === ts.length - 1) { sents.push({ a: s, b: g, para: pi, text: words.slice(s, g + 1).join(' ') }); s = g + 1; } g++; });
    });
    return { paras, words, sents };
  };
  // Clause marks and parts of speech: the reader's own (with the learner's corrections) when they match, else our own run.
  const analysisFor = async (paras, words) => {
    const key = wordsHash(words), sx = getState().sx;
    if (sx?.auto && sx.key === key) return { marks: sx.marks, pos: sx.auto.pos };
    if (ui.analysis?.key === key) return ui.analysis;
    const nlp = await loadNlp();
    const r = sxAnalyze(nlp, paras);
    ui.analysis = { key, marks: r.marks, pos: r.pos };
    return ui.analysis;
  };

  const figureFor = (data, ctx, i) => {
    const s = data.sents[i];
    const cached = cacheGet(s.text);
    let tree = null, src = 'rule', ja = '';
    const want = ui.src[s.text] || (cached ? 'ai' : 'rule');
    if (cached && want === 'ai') {
      try { tree = alignTree(cached.tree, data.words.slice(s.a, s.b + 1), s.a); src = 'ai'; ja = cached.ja || ''; } catch { tree = null; }
    }
    if (!tree) tree = ruleTree({ words: data.words, ...ctx }, s.a, s.b);
    const fig = el('figure', 'sd-item');
    const cap = el('figcaption', 'sd-cap');
    cap.append(el('span', 'sd-no', String(i + 1)), el('span', `sd-tag${src === 'ai' ? ' ai' : ''}`, src === 'ai' ? 'AI' : '自動（簡易）'));
    const n = countPar(tree);
    if (n) cap.append(el('span', 'sd-npar', `並列 ${n}か所`));
    fig.append(cap);
    const box = el('div', 'sd-box');
    box.append(renderTree(tree, data.words));
    fig.append(box);
    if (ja) fig.append(el('p', 'sd-exp', ja));
    return { fig, src, cached: !!cached, pars: n };
  };

  let renderToken = 0;
  const render = async () => {
    if (!ui.open) return;
    const my = ++renderToken;
    const data = sentencesOf();
    host.querySelectorAll('[data-sdall]').forEach(b => b.setAttribute('aria-checked', String(+b.dataset.sdall === +ui.all)));
    if (!data.sents.length) { out.textContent = ''; info.textContent = '先に④で「区切りを提案する」を押してください。'; return; }
    ui.idx = Math.max(0, Math.min(ui.idx, data.sents.length - 1));
    // sentence picker
    const opts = data.sents.map((s, i) => `${i + 1}. ${s.text.length > 46 ? s.text.slice(0, 44) + '…' : s.text}`);
    if (pick.options.length !== opts.length || [...pick.options].some((o, i) => o.textContent !== opts[i])) {
      pick.textContent = '';
      opts.forEach((t, i) => { const o = el('option', '', t); o.value = i; pick.append(o); });
    }
    pick.value = ui.idx;
    $('.sd-nav', host).hidden = ui.all;
    $('#sdPrev', host).disabled = ui.idx === 0; $('#sdNext', host).disabled = ui.idx >= data.sents.length - 1;
    let ctx;
    try { ctx = await analysisFor(data.paras, data.words); }
    catch (e) { console.error(e); info.textContent = `構文解析のプログラム（vendor/compromise）を読み込めませんでした（${e.message || e}）。`; return; }
    if (my !== renderToken) return;
    out.textContent = '';
    const list = ui.all ? data.sents.map((_, i) => i) : [ui.idx];
    let ai = 0, rule = 0, pars = 0, cur = null;
    for (const i of list) {
      const f = figureFor(data, ctx, i);
      out.append(f.fig); f.src === 'ai' ? ai++ : rule++; pars += f.pars;
      if (!ui.all) cur = { f, s: data.sents[i] };
    }
    out.classList.toggle('sd-all', ui.all);
    // source switch (1文ずつ, when an AI tree exists)
    const srcSeg = $('#sdSrc', host);
    srcSeg.hidden = ui.all || !cur?.f.cached;
    if (cur) srcSeg.querySelectorAll('[data-sdsrc]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.sdsrc === cur.f.src)));
    updateAiButton(data);
    const base = ui.all
      ? `${list.length}文・並列 ${pars}か所（AI ${ai}文・自動 ${rule}文）。`
      : '本文の文をタップすると、その文の図になります。';
    const note = rule ? '「自動（簡易）」はプログラムの推定で、並列の範囲や S・V を取り違えることがあります。' : 'AIの図も誤ることがあります。おかしいところは先生や解説で確かめてください。';
    info.textContent = ui.msg || `${base}${note}`;
  };

  const updateAiButton = (data) => {
    const todo = data ? (ui.all ? data.sents.filter(s => !cacheGet(s.text)).length : (cacheGet(data.sents[ui.idx]?.text || '') ? 0 : 1)) : 1;
    aiBtn.textContent = ui.all ? (todo ? `全文をAIで作る（残り${todo}文）` : '全文をAIで作り直す') : (todo ? 'AIで構文図を作る' : 'AIで作り直す');
    if (ui.aiState === 'off') { aiBtn.hidden = true; why.textContent = ''; return; }
    aiBtn.hidden = false;
    aiBtn.disabled = ui.busy || ui.aiState === 'no';
    why.textContent = ui.aiState === 'no' ? (ui.aiWhy || `${aiWhyNot() || aiUnavailableText()}。自動（簡易）の図は使えます。`) : '';
  };

  const openPanel = async (open) => {
    ui.open = open;
    host.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.textContent = open ? '構文図を閉じる' : '構文図（並列を縦にそろえる）';
    if (!open) return;
    if (ui.aiState === 'unknown') {
      ui.aiState = 'checking';
      ui.aiState = (await aiReady()) ? 'yes' : 'no';
      ui.aiWhy = '';
    }
    render();
  };
  toggle.onclick = () => openPanel(!ui.open);
  // 「AIの設定」 changed (provider / key) or a call learned that the provider cannot be reached: check again.
  onAiChange(() => { if (ui.busy) return; ui.aiState = 'unknown'; ui.aiWhy = ''; if (ui.open) openPanel(true); });
  host.querySelectorAll('[data-sdall]').forEach(b => b.onclick = () => { ui.all = b.dataset.sdall === '1'; ui.msg = ''; saveUi(); render(); });
  host.querySelectorAll('[data-sdsrc]').forEach(b => b.onclick = () => {
    const s = sentencesOf().sents[ui.idx]; if (!s) return;
    ui.src[s.text] = b.dataset.sdsrc; ui.msg = ''; render();
  });
  const go = (d) => { ui.idx += d; ui.msg = ''; render(); };
  $('#sdPrev', host).onclick = () => go(-1);
  $('#sdNext', host).onclick = () => go(1);
  pick.onchange = () => { ui.idx = +pick.value; ui.msg = ''; render(); };

  // Tapping a word in the reader shows that sentence (1文ずつ). Never stops the reader's own handlers.
  $('#reader')?.addEventListener('click', (e) => {
    if (!ui.open || ui.all) return;
    const s = e.target.closest?.('.sent');
    if (!s || s.dataset.s == null) return;
    if (+s.dataset.s !== ui.idx) { ui.idx = +s.dataset.s; ui.msg = ''; render(); }
  });
  // Follow the reader: it is rebuilt whenever the text or slashes change.
  let timer = 0;
  new MutationObserver(() => { if (!ui.open) return; clearTimeout(timer); timer = setTimeout(render, 120); }).observe($('#reader'), { childList: true });

  // ---- AI ----
  const errText = (e) => {
    const code = e?.code;
    if (code === 'mismatch') return `AIの図が原文と一致しませんでした（${e.where ? `「${e.where}」のあたり` : '語の抜けや言い換え'}）。もう一度押してください`;
    if (code === 'shape' || code === 'invalid_json') return 'AIの答えを構文図として読み取れませんでした。もう一度押してください';
    if (code === 'timeout') return aiTimeoutText();
    if (code === 'unavailable') return aiUnavailableText();
    if (code === 'refused') return 'この文の構文図は作れませんでした';
    const known = providerErrorText(code), fallback = providerErrorText('');
    return known !== fallback ? known : '構文図を作れませんでした。もう一度押してください';
  };
  const askClaude = (prompt) => {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 150000);
    return Promise.race([
      aiJson(prompt, { modelTier: 'complex', signal: ctrl.signal }),
      new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })))),
    ]).finally(() => clearTimeout(t));
  };
  const accept = (data, s, item) => {
    if (!item || typeof item !== 'object' || !item.tree) throw Object.assign(new Error('shape'), { code: 'shape' });
    const sw = data.words.slice(s.a, s.b + 1);
    try { alignTree(item.tree, sw, s.a); }
    catch (e) { if (e.code === 'mismatch') e.where = sw.slice(Math.max(0, e.at - 1), e.at + 2).join(' '); throw e; }
    cachePut(s.text, { tree: item.tree, ja: typeof item.explanation_ja === 'string' ? item.explanation_ja.trim().slice(0, 600) : '', at: Date.now() });
    delete ui.src[s.text];
  };
  aiBtn.onclick = async () => {
    if (ui.busy) return;
    const data = sentencesOf();
    if (!data.sents.length) return;
    ui.busy = true; aiBtn.disabled = true; ui.msg = '';
    const paraText = (s) => data.sents.filter(x => x.para === s.para).map(x => x.text).join(' ');
    try {
      if (!(await aiReady())) { ui.aiState = 'no'; throw Object.assign(new Error('unavailable'), { code: 'unavailable' }); }
      ui.aiState = 'yes';
      if (!ui.all) {
        const s = data.sents[ui.idx];
        info.textContent = aiBusyText('構文図を頼んでいます');
        const r = await askClaude(promptOne(s.text, paraText(s)));
        accept(data, s, r);
        ui.msg = 'AIの構文図を表示しました。AIも誤ることがあります。';
      } else {
        // All sentences: the ones without an AI tree (or all when every one has one), a few per call.
        let todo = data.sents.filter(s => !cacheGet(s.text));
        if (!todo.length) todo = data.sents.slice();
        let done = 0, failed = 0, lastErr = null;
        for (let k = 0; k < todo.length; k += 5) {
          const part = todo.slice(k, k + 5);
          info.textContent = `${aiName()}に構文図を頼んでいます… ${done} / ${todo.length} 文`;
          try {
            const r = await askClaude(promptMany(part.map(s => s.text), [...new Set(part.map(paraText))].join('\n\n')));
            const items = Array.isArray(r?.items) ? r.items : Array.isArray(r) ? r : null;
            if (!items || items.length !== part.length) throw Object.assign(new Error('shape'), { code: 'shape' });
            part.forEach((s, i) => { try { accept(data, s, items[i]); done++; } catch (e) { failed++; lastErr = e; } });
          } catch (e) {
            failed += part.length; lastErr = e;
            if (!['shape', 'invalid_json', 'mismatch', 'upstream_error', 'timeout'].includes(e?.code)) break;   // rate limit, consent, ...: stop
          }
          if (ui.open && ui.all) await render();
        }
        ui.msg = `AIの構文図: ${done}文${failed ? `（${failed}文は作れませんでした: ${errText(lastErr)}）` : ''}。AIも誤ることがあります。`;
      }
    } catch (e) {
      if (!e?.code) console.error(e);   // coded failures (mismatch, rate_limited ...) are shown to the learner
      ui.msg = errText(e) + '。';
      if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed', 'blocked', 'no_key'].includes(e?.code)) { ui.aiState = 'no'; ui.aiWhy = errText(e) + '。自動（簡易）の図は使えます。'; }
    } finally {
      ui.busy = false;
      await render();
      setTimeout(() => { ui.msg = ''; }, 0);   // the message stays on screen until the next action re-renders
    }
  };

  // test hook
  window.__structure = { ui, render, ruleTree, alignTree, isClaude };
}
