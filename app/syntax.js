// syntax.js - 構文マーク (sentence-structure marks) and 品詞 (part-of-speech) labels.
// Pure ES module. Part-of-speech tags come from compromise (vendor/compromise, MIT), which the caller
// passes in as `nlp`, so this file runs the same in the browser and in node tests. Clause detection is a
// set of hand-written heuristics on top of the tags; it is deterministic and makes mistakes, so the UI
// presents every mark as a suggestion the learner can remove or add.
//
// Mark types (token spans, inclusive): rel { } 関係詞節, noun [ ] 名詞節, adv < > 副詞節,
// post ( ) 後置修飾の句, subj 長い主語 (underline), verb 主節の述語動詞 (V).

const S = (s) => new Set(s.split(/\s+/).filter(Boolean));

export const MARK_TYPES = ['rel', 'noun', 'adv', 'subj', 'verb', 'post'];
export const MARK_INFO = {
  rel: { name: '関係詞節', open: '{', close: '}' },
  noun: { name: '名詞節', open: '[', close: ']' },
  adv: { name: '副詞節', open: '＜', close: '＞' },
  subj: { name: '長い主語', open: '', close: '' },
  verb: { name: '述語動詞', open: '', close: '' },
  post: { name: '後置修飾', open: '(', close: ')' },
};

const MODALS = S('can could will would shall should may might must');
const BE_FIN = S('am is are was were');
const BE_ALL = S('am is are was were be been being');
const HAVE_FIN = S('have has had');
const DO_FIN = S('do does did');
const SUBJ_PRON = S('i we you they he she it');
const OBJ_PRON = S('me us him her them');
const PRONOUNS = S('i we you they he she it me us him her them myself yourself himself herself itself ourselves themselves this these those someone somebody anyone anybody everyone everybody nobody something anything everything nothing one others');
const POSSESSIVE = S('my your his her its our their');
const ARTICLES = S('a an the');
const DETS = S('such a an the this that these those my your his her its our their some any no every each another either neither several many much few all both');
const PREVERB_ADV = S('also often always never still usually sometimes even only just already rarely seldom hardly really actually generally certainly probably clearly merely simply then soon now once not gradually quickly slowly finally eventually increasingly largely mainly mostly long yet widely fully partly highly deeply greatly strongly');
const ADJ_ING = S('interesting surprising amazing boring exciting confusing disappointing encouraging frightening pleasing satisfying shocking tiring worrying annoying charming convincing demanding depressing embarrassing fascinating frustrating misleading promising rewarding striking touching willing outstanding challenging threatening relaxing refreshing alarming astonishing overwhelming puzzling terrifying thrilling missing loving caring entertaining appealing inviting');
const IRREG_PAST = S('went came saw took gave made said told found thought knew became began left felt kept brought bought wrote spoke ran sat stood grew fell drew drove ate chose rose threw wore won broke forgot understood held met paid sent spent built lost led meant heard taught caught sought fought');
const IRREG_SAME = S('put set cut hit let shut spread cost hurt read upset quit');
const LINKING = S('remain remains remained seem seems seemed become becomes became look looks looked appear appears appeared stay stays stayed feel feels felt get gets got grow grows grew');
const IRREG_PART = S('born done gone seen known shown grown thrown drawn given taken written broken chosen spoken forgotten hidden eaten fallen driven ridden risen worn torn sworn beaten bitten frozen stolen woken begun sung swum flown');
const S_IS = S('it he she that there what who here where this everything nothing everyone something someone');
const PREP_WORDS = S('inside outside beside besides beneath alongside amid amidst unlike like in on at for with from by into onto through during without within between among against toward towards across about despite under over beyond around behind upon via of near off out up down along throughout');
const STRONG_APPOS = S('fact possibility evidence news notion assumption hypothesis realization likelihood probability sign signs proof belief premise principle');
const COORD = S('and or but nor yet');
const CONN_START = S('and or but so yet however therefore thus moreover furthermore nevertheless instead indeed also then still meanwhile consequently');
const TIME_NOUNS = S('day days time times year years moment moments period age era decade decades century centuries morning evening night week weeks month months season occasion point hour hours minute summer winter spring autumn');
const TIME_ADV = S('yesterday today tomorrow tonight');
const APPOS_NOUNS = S('fact idea belief evidence notion possibility news hope view assumption claim conclusion sense feeling theory suggestion argument realization impression fear doubt thought proof sign signs chance likelihood probability rumor rumour principle hypothesis premise impression knowledge recognition awareness discovery finding findings statement message promise');
const WH_NOUN_VERBS = S('know knew known knows ask asked asks wonder wondered wonders remember remembered tell told tells explain explained explains decide decided understand understood show showed shown shows see saw seen sees discover discovered learn learned learnt forget forgot imagine imagined realize realized realise realised find found finds describe described determine determined predict predicted consider considered care matter matters depends depend depended question questioned doubt doubted guess guessed notice noticed reveal revealed reveals figure check checked choose chose investigate investigated examine examined');
const IF_NOUN_VERBS = S('know knew ask asked asks wonder wondered wonders see saw check checked decide decided doubt doubted tell told determine determined find found sure unsure');
const OMIT_THAT_VERBS = S('suspect suspected suspects assume assumed assumes predict predicted conclude concluded discover discovered learn learned show showed understand understood recognize recognized think thought thinks believe believed believes know knew knows say said says hope hoped hopes feel felt feels suppose supposed guess guessed realize realized realise realised wish wished mean meant notice noticed admit admitted claim claimed argue argued agree agreed insist insisted expect expected fear feared doubt sure afraid glad imagine imagined suggest suggested found find finds noticed decided decide');
const TELL_VERBS = S('tell told tells show showed shown shows convince convinced remind reminded inform informed assure assured warn warned teach taught promise promised ask asked give gave');
const TO_OBJ_VERBS = S('allow allowed allows ask asked asks tell told tells want wanted wants enable enabled enables encourage encouraged encourages force forced forces require required requires expect expected expects cause caused causes help helped helps lead led leads persuade persuaded permit permitted urge urged teach taught invite invited get got gets like would need needed needs advise advised remind reminded order ordered');
const CAUSATIVE = S('let lets make makes made help helps helped see saw sees hear heard hears watch watched watches have has had feel felt notice noticed');
const ING_OBJ_VERBS = S('spend spent spends waste wasted keep kept keeps find found finds see saw sees watch watched hear heard catch caught leave left imagine imagined');
const AS_BLOCKERS = S('as such same so more less twice known regarded seen defined described used thought considered treated viewed recognized recognised serve serves served act acts acted work works worked');
const CLAUSE_LIKE_START = S('there it');
const QUANT_OF = S('all most some many much none each both one few several any either neither half part');
const ALWAYS_ADV = S('because although though whereas unless whenever wherever');

const isPre = (toks, k) => PREVERB_ADV.has(toks[k].b) || toks[k].b === 'longer' && toks[k - 1]?.b === 'no' || toks[k].b === 'no' && toks[k + 1]?.b === 'longer';
const bare = (t) => (t || '').toLowerCase().replace(/^[\s"'“”‘’(\[{]+/, '').replace(/[\s"'“”‘’)\]}.,;:!?—–-]+$/, '');
const endsComma = (t) => /,["'”’)\]]*$/.test(t);
const endsSemi = (t) => /[;:]["'”’)\]]*$/.test(t) || /[—–]$/.test(t) || /--$/.test(t);
const isDash = (t) => /^(—|–|--|-)$/.test(t);

// ---------------------------------------------------------------------------
// Tagging: whitespace tokens -> per-token tag info (via compromise)
// ---------------------------------------------------------------------------

let lexCache = null;
function lexOf(nlp) {
  if (lexCache?.nlp === nlp) return lexCache;
  const w = nlp.world?.();
  lexCache = { nlp, lex: w?.model?.one?.lexicon || {}, sw: w?.model?.two?.switches || {} };
  return lexCache;
}

// words: whitespace tokens of one paragraph. Returns one info object per token.
export function tagWords(nlp, words) {
  const text = words.join(' ');
  const starts = []; let p = 0;
  for (const w of words) { starts.push(p); p += w.length + 1; }
  // every field is created here so all tokens share one object shape (much faster in V8)
  const toks = words.map((w) => ({ word: w, b: bare(w), terms: [], tags: new Set(), lex: '', sw: '',
    comma: false, semi: false, end: false, modal: false, beFin: false, haveFin: false, doFin: false, neg: false, pron: false, det: false,
    noun: false, adj: false, adv: false, prep: false, verbish: false, past: false, part: false, ing: false, pres: false, adjPart: false,
    base: false, plural: false, repaired: false, inGroup: false, fin: false, grp: null, grpLast: false, poss: false }));
  const { lex, sw } = lexOf(nlp);
  const doc = nlp(text);
  let cursor = 0, k = 0;
  for (const sent of doc.docs) for (const term of sent) {
    let at = cursor;
    if (term.text) {
      const f = text.indexOf(term.text, cursor);
      if (f >= 0 && f - cursor < 40) at = f;
      cursor = at + term.text.length;
    }
    while (k + 1 < starts.length && starts[k + 1] <= at) k++;
    const tags = [...term.tags];
    toks[k].terms.push({ text: term.text, tags: new Set(tags) });
    for (const t of tags) toks[k].tags.add(t);
  }
  for (const t of toks) {
    t.lex = Object.hasOwn(lex, t.b) && typeof lex[t.b] === 'string' ? lex[t.b] : '';
    t.sw = Object.hasOwn(sw, t.b) && typeof sw[t.b] === 'string' ? sw[t.b] : '';
    if (!t.terms.length) t.terms.push({ text: t.word, tags: new Set() });
  }
  return toks;
}

// ---------------------------------------------------------------------------
// Token features and repairs
// ---------------------------------------------------------------------------

function features(toks) {
  for (const t of toks) {
    const g = t.tags, b = t.b;
    t.comma = endsComma(t.word);
    t.semi = endsSemi(t.word) || isDash(t.word);
    t.end = /[.!?]["'”’)\]]*$/.test(t.word);
    t.modal = MODALS.has(b) || g.has('Modal') || /'(ll|d)$/.test(b);
    t.beFin = BE_FIN.has(b) || /'(re|m)$/.test(b) && g.has('Copula') || /'s$/.test(b) && g.has('Copula') && S_IS.has(b.slice(0, -2));
    t.haveFin = HAVE_FIN.has(b) || /'ve$/.test(b);
    t.doFin = DO_FIN.has(b) || /^(don't|doesn't|didn't)$/.test(b);
    t.neg = g.has('Negative') || b === 'not' || b === 'never';
    t.pron = PRONOUNS.has(b) || (g.has('Pronoun') && !POSSESSIVE.has(b));
    t.det = DETS.has(b) || g.has('Determiner');
    t.noun = !t.pron && !t.det && (g.has('Noun') || g.has('Value') || (g.has('Date') && !TIME_ADV.has(b)));
    t.adj = g.has('Adjective');
    t.adv = g.has('Adverb') || t.neg || TIME_ADV.has(b);
    t.prep = (g.has('Preposition') || PREP_WORDS.has(b)) && !/^wh/.test(b) && b !== 'that' && !g.has('Verb');
    t.verbish = g.has('Verb') || t.modal || BE_ALL.has(b) || t.haveFin || t.doFin;
    t.past = g.has('PastTense') || /Past/.test(t.sw) && (g.has('Adjective') || g.has('Verb'));
    t.part = g.has('Participle') || g.has('PastParticiple') || IRREG_PART.has(b);
    if (IRREG_PART.has(b) && !t.verbish) t.adjPart = true;
    t.ing = /ing$/.test(b) && (g.has('Gerund') || /Gerund/.test(t.sw) || t.lex === 'Gerund' || g.has('Verb'));
    t.pres = g.has('PresentTense') && !g.has('Infinitive') || g.has('Verb') && /[^s]s$/.test(b) && !g.has('Gerund') && !g.has('PastTense') && !g.has('Plural');
    t.adjPart = g.has('Adjective') && (/Past/.test(t.sw) || /Gerund/.test(t.sw) && !ADJ_ING.has(b) || /(ed|en)$/.test(b) && b.length > 4);
    t.base = g.has('Infinitive') || (g.has('PresentTense') && !/s$/.test(b));
    if (/('s|s')$/.test(b) && !t.beFin && !S_IS.has(b.slice(0, -2))) { t.poss = true; }
    t.plural = g.has('Plural') || ['they', 'we', 'you', 'i', 'these', 'those', 'people'].includes(b);
    // irregular past forms the tagger sometimes reads as base forms ("until the fever went down")
    if (IRREG_PAST.has(b) && g.has('Verb') && !t.past) { t.past = true; t.base = false; t.pres = false; }
    // "unsolved", "unknown": adjectives, not past verbs
    if (/^un.{3,}(ed|en|wn)$/.test(b)) { t.past = false; t.adjPart = true; t.verbish = false; t.adj = true; }
  }
  const n = toks.length;
  const prevNonAdv = (k) => { let j = k - 1; while (j >= 0 && (toks[j].adv || isPre(toks, j)) && !toks[j].comma) j--; return j; };
  for (let k = 0; k < n - 1; k++) {
    const t = toks[k], nx = toks[k + 1];
    if (t.lex === 'Demonym' && nx.noun && !t.comma) { t.noun = false; t.adj = true; }
    if (PREP_WORDS.has(t.b) && (nx.det || POSSESSIVE.has(nx.b) || nx.poss) && !t.comma) { t.prep = true; t.verbish = false; t.noun = false; t.adv = false; }
  }
  let whoSeen = false, finSeen = false;
  for (let k = 0; k < n; k++) {
    const t = toks[k], nx = toks[k + 1];
    if (k > 0 && (toks[k - 1].b === 'who' || toks[k - 1].b === 'which')) whoSeen = true;
    if (k > 0 && (toks[k - 1].modal || toks[k - 1].beFin || toks[k - 1].pres && toks[k - 1].verbish || toks[k - 1].past && toks[k - 1].verbish)) finSeen = true;
    // "still", "only" ... tagged Adjective right before a verb are adverbs.
    if (PREVERB_ADV.has(t.b) && nx && (nx.verbish || /Verb/.test(nx.sw))) { t.adv = true; t.adj = false; }
    const j = prevNonAdv(k), pv = toks[j];
    // Noun|Verb words tagged Noun after a plural subject / pronoun / modal / "to": verbs.
    const baseForm = !/s$/.test(t.b) || /ss$/.test(t.b);
    if (!t.verbish && (/Verb/.test(t.sw) || /PresentTense|Infinitive/.test(t.lex) || !t.lex && !t.sw && /[^s]s$/.test(t.b) && !t.tags.has('ProperNoun') && ['this', 'he', 'she', 'it', 'one', 'everyone', 'everything', 'nobody', 'nothing'].includes(pv?.b)) && pv && (!pv.comma || !baseForm && (whoSeen || !finSeen))) {
      if (baseForm && (SUBJ_PRON.has(pv.b) && pv.b !== 'it' || (pv.noun && pv.plural && !toks[j - 1]?.prep) || pv.modal || pv.doFin || ['who', 'which', 'that'].includes(pv.b) && j > 0 && (toks[j - 1].noun || toks[j - 1].pron))) {
        t.verbish = true; t.base = true; t.noun = false; t.repaired = true;
      } else if (!baseForm && (['he', 'she', 'it', 'who', 'which', 'that', 'this', 'one', 'everyone', 'everything', 'nobody', 'nothing', 'someone', 'something'].includes(pv.b) || (pv.noun && !pv.plural && pv.b !== 'it'))
        && (nx ? (nx.det || nx.pron || nx.b === 'that' || nx.adv || nx.prep || nx.adj || nx.b === 'to' || nx.tags.has('Particle') || nx.verbish && relWordBack(toks, j, 3)) : t.end)) {
        t.verbish = true; t.pres = true; t.noun = false; t.repaired = true;
      }
    }
    // "that the report describes remain": an unknown -s word closing an object-gap relative clause
    if (!t.verbish && t.noun && t.plural && /[^s]s$/.test(t.b) && pv && pv.noun && !pv.plural && toks[j - 1]?.det && ['that', 'which'].includes(toks[j - 2]?.b) && nx && nx.verbish) {
      t.verbish = true; t.pres = true; t.noun = false; t.repaired = true;
    }
    // "shapes thought": the noun 'thought' right after an active verb
    if (t.b === 'thought' && pv && (pv.det || pv.adj || pv.prep || pv.verbish && !BE_ALL.has(pv.b) && !HAVE_FIN.has(pv.b) && !pv.modal && !pv.doFin && j === k - 1 && !SUBJ_PRON.has(toks[j - 1]?.b))) { t.verbish = false; t.past = false; t.noun = true; }
    // "that foreigners find": an -s word tagged as a verb between a determiner/relative and a verb is a plural noun
    if (t.verbish && t.pres && !t.modal && !t.beFin && !t.haveFin && !t.doFin && pv && (pv.det || ['that', 'which', 'whose'].includes(pv.b)) && nx && nx.verbish && (nx.base || nx.tags.has('Infinitive')) && /s$/.test(t.b) && !/ss$/.test(t.b)) {
      t.verbish = false; t.pres = false; t.noun = true; t.plural = true;
    }
    // "that sleep strengthens memory": a Noun|Verb base word right before an -s verb is the subject
    if (t.verbish && t.base && !t.modal && /Noun/.test(t.sw) && nx && nx.pres && nx.verbish && pv && ['that', 'which', 'the', 'a', 'an'].includes(pv.b)) {
      t.verbish = false; t.base = false; t.noun = true;
    }
    // -ing words tagged as nouns after a noun ("those working in") act as participles.
    if (/ing$/.test(t.b) && t.b.length > 4 && !t.verbish && pv && (pv.noun || ['those', 'people', 'anyone', 'someone', 'everyone'].includes(pv.b)) && nx && (nx.prep || nx.det || nx.adv)) { t.ing = true; t.verbish = true; t.noun = false; }
  }
}

// Finite-verb heads and verb groups. Sets t.fin (head) and t.grp = [start, end] on the head.
function verbGroups(toks) {
  const n = toks.length;
  const skipAdvBack = (k) => { let j = k - 1; while (j >= 0 && (toks[j].adv || isPre(toks, j)) && !toks[j].comma) j--; return j; };
  const laterFinite = (k) => {
    if (toks[k].comma) return false;
    for (let j = k + 1; j < n; j++) {
      const t = toks[j];
      if (t.semi || SUB_WORDS.has(t.b) && t.b !== 'that') return false;
      if ((t.haveFin || t.beFin) && toks[j - 1].b === 'to') continue;
      if (t.modal || t.beFin || t.haveFin || t.doFin || (t.pres && t.verbish) || (t.past && t.verbish && !toks[j - 1].noun && !BE_ALL.has(toks[j - 1].b) && !HAVE_FIN.has(toks[j - 1].b))) return true;
      if (t.past && t.verbish && toks[j - 1].noun && toks[j + 1] && (toks[j + 1].det || toks[j + 1].pron)) return true;
      if (t.comma && !inParenthetical(toks, j)) return false;
    }
    return false;
  };
  for (let k = 0; k < n; k++) {
    const t = toks[k];
    if (t.inGroup) continue;
    const j = skipAdvBack(k), pv = toks[j], ppv = toks[j - 1];
    let fin = false;
    if (t.b === 'to' || !t.verbish) fin = false;
    else if (t.modal || t.beFin || t.doFin) fin = !(pv && pv.b === 'to');
    else if (t.haveFin) fin = !(pv && (pv.b === 'to' || pv.modal));
    else if (t.past && !t.ing) {
      const adjectival = /-/.test(t.b) || !!(toks[k - 1]?.adv && /ly$/.test(toks[k - 1].b) && (toks[k - 2]?.det || POSSESSIVE.has(toks[k - 2]?.b))) || !!(pv && j === k - 1 && (pv.det && pv.b !== 'that' && pv.b !== 'which' || POSSESSIVE.has(pv.b) || pv.prep || pv.adj && !pv.verbish && !pv.adjPart));
      fin = !adjectival;
      if (pv && (BE_ALL.has(pv.b) || HAVE_FIN.has(pv.b) || pv.b === 'get' || pv.b === 'got' || LINKING.has(pv.b) && j === k - 1)) fin = false;
      // Reduced relative / participle phrase: "the method used in the study was ..."
      const nx = toks[k + 1];
      if (fin && pv && (pv.noun || pv.pron && !SUBJ_PRON.has(pv.b)) && !pv.comma && (!nx || nx.prep || nx.b === 'by' || nx.adv || nx.b === 'to' || nx.comma || t.comma || t.end) && laterFinite(k)) fin = false;
      if (fin && pv && pv.noun && !pv.comma && nx && (nx.prep || nx.b === 'by' || nx.b === 'to' || t.end) && t.part) fin = !laterFinite(k) && !t.end ? fin : false;
      // ... but "after the meeting ended," / "who the police arrested in" need this verb.
      if (!fin && !BE_ALL.has(pv?.b) && !HAVE_FIN.has(pv?.b) && openerBefore(toks, k) && !adjectival) fin = true;
      // ', carefully stripped of ...' after the main verb: a participle phrase
      if (fin && nx && (nx.prep || nx.b === 'by') && (toks[k - 1]?.comma || toks[k - 2]?.comma && toks[k - 1].adv || toks[k - 1]?.adv && toks[k - 2]?.b === 'but') && toks.slice(0, k).some((x) => x.fin)) fin = false;
      if (fin && k === 0 && /^(given|considering|compared|assuming|provided|granted|judging)$/.test(t.b)) fin = false;
      // Sentence-initial participle construction: "Compared with ..., X is"
      if (fin && (k === 0 || toks[k - 1].comma && !pv?.noun) && nx && (nx.prep || nx.b === 'by')) fin = false;
      if (fin && pv && pv.comma && !pv.pron && nx && (nx.prep || nx.b === 'by') && (!pv.noun || laterFiniteAfterComma(toks, k))) fin = false;
    } else if (t.pres && !t.ing && /Plural/.test(t.sw) && pv && (pv.adj || pv.noun) && !pv.comma && recentFin(toks, j, 3)) {
      fin = false;   // 'can recognize human faces': an object noun, not a verb
    } else if (t.pres && !t.ing && pv && j === k - 1 && (BE_ALL.has(pv.b) || LINKING.has(pv.b))) {
      fin = false;   // 'have been carnivores'
    } else if (t.pres && !t.ing) {
      const demPron = pv && /^(this|that|these|those)$/.test(pv.b) && j === k - 1 && toks[k + 1] && (toks[k + 1].det || toks[k + 1].prep || toks[k + 1].pron || toks[k + 1].adv || POSSESSIVE.has(toks[k + 1].b));
      fin = !/-/.test(t.b) && (demPron || !(pv && (pv.det && pv.b !== 'that' && pv.b !== 'which' || pv.poss || pv.b === 'to' || POSSESSIVE.has(pv.b) || pv.adj && !pv.adv && !(pv.b === 'other' && toks[j - 1]?.b === 'each'))));
    } else if (t.base && !t.ing && !t.part) {
      fin = false;
      if (toks[k - 1]?.comma && pv?.noun && !toks.slice(0, k).some((x) => x.fin) && toks.slice(0, k).some((x) => x.noun && x.plural && !x.comma) && toks[k + 1] && (toks[k + 1].det || toks[k + 1].adj || toks[k + 1].noun) && (/Verb/.test(t.sw) || t.lex === 'Infinitive')) fin = true;
      else if (!pv || k === 0 || toks[k - 1].semi || toks[k - 1].comma && !pv.noun && !pv.pron) fin = !t.comma && (!pv || (k === 0 && t.b !== 'please') || toks[k - 1].semi); // imperative
      else if (pv.b === 'to' || pv.modal || pv.doFin || OBJ_PRON.has(pv.b)) fin = false;
      else if (/^[A-Z]/.test(pv.word) && pv.noun && !toks[j - 1]?.det && !finSinceComma(toks, k)) fin = true;   // 'Japanese tend to'
      else if (SUBJ_PRON.has(pv.b) && pv.b !== 'it' && pv.b !== 'he' && pv.b !== 'she') fin = true;
      else if (pv.noun && pv.plural || ['these', 'those', 'people', 'others', 'many', 'some', 'few', 'both', 'all'].includes(pv.b)) {
        fin = true;
        for (let q = j - 1; q >= Math.max(0, j - 4); q--) if (CAUSATIVE.has(toks[q].b) && toks[q].verbish) { fin = false; break; }
        if (ppv && ppv.prep && toks[j].noun && j - 1 >= 0) {
          // "people in cities live" is still finite; "made the children play" is not.
        }
      } else if (['who', 'which', 'that'].includes(pv.b)) fin = true;
      // "Students who sleep well perform better": a base verb after a finished relative clause
      else if ((pv.verbish && !pv.modal && !pv.doFin && !CAUSATIVE.has(pv.b) || pv.noun) && (relBefore(toks, k) || postBefore(toks, k)) && !toks[k - 1].comma) fin = true;
    }
    if (!fin) continue;
    // Extend the verb group.
    let last = k, prevV = t;
    let q = k + 1;
    if (t.comma || t.end) q = n;
    while (q < n) {
      const u = toks[q];
      if (u.neg || (PREVERB_ADV.has(u.b) || u.adv) && !u.comma) {
        // adverbs inside a group only when a verb follows
        let r = q + 1; while (r < n && r <= q + 2 && (toks[r].neg || toks[r].adv || PREVERB_ADV.has(toks[r].b))) r++;
        // after an adverb only real verb forms count ("was so tired": "tired" stays outside)
        if (r < n && !toks[r].modal && fitsAfter(prevV, toks[r]) && (toks[r].verbish || !BE_ALL.has(prevV.b)) && !toks[q].comma) { q = r; continue; }
        break;
      }
      if (fitsAfter(prevV, u)) { last = q; prevV = u; if (u.comma || u.end) break; q++; continue; }
      // have to / has to / had to / used to / ought to + base verb
      if (u.b === 'to' && last === k && ['have', 'has', 'had', 'used', 'ought'].includes(t.b) && toks[q + 1]?.verbish && (toks[q + 1].base || toks[q + 1].lex === 'Infinitive')) { last = q + 1; break; }
      break;
    }
    for (let r = k; r <= last; r++) toks[r].inGroup = true;
    t.fin = true; t.grp = [k, last];
    k = last;
  }
}
function recentFin(toks, j, dist) {
  for (let q = j; q >= Math.max(0, j - dist); q--) { if (toks[q].fin) return true; if (SUB_WORDS.has(toks[q].b) || toks[q].comma) return false; }
  return false;
}
// a later finite verb after the comma that closes a participle phrase (', named after X, is big')
function laterFiniteAfterComma(toks, k) {
  let q = k + 1; while (q < toks.length && !toks[q].comma && !toks[q].semi && !toks[q].end) q++;
  if (!toks[q]?.comma) return false;
  for (let r = q + 1; r < Math.min(toks.length, q + 4); r++) if (toks[r].modal || toks[r].beFin || toks[r].haveFin || toks[r].doFin || toks[r].pres && toks[r].verbish || toks[r].past && toks[r].verbish) return true;
  return false;
}
// a comma inside a parenthetical like ', in a 1748 account,' (followed by more words before a verb)
function inParenthetical(toks, j) { return false; }
function finSinceComma(toks, k) { for (let q = k - 1; q >= 0; q--) { if (toks[q].comma || toks[q].semi) return false; if (toks[q].fin) return true; } return false; }
function relWordBack(toks, j, dist) {
  for (let q = j; q >= Math.max(0, j - dist); q--) if (['that', 'which', 'who', 'whom'].includes(toks[q].b)) return true;
  return false;
}
const SUB_WORDS = S('after before when while because if as since until till once although though unless whereas where who whom which that how why what whether');
// A subordinator within the last few tokens with no finite verb after it.
function openerBefore(toks, k) {
  for (let q = k - 1; q >= Math.max(0, k - 6); q--) {
    if (toks[q].fin || toks[q].semi) return false;
    if (SUB_WORDS.has(toks[q].b) && q < k - 1) return true;
  }
  return false;
}
// A participle right after a plural noun earlier in the sentence ("The scientists working on it believe").
function postBefore(toks, k) {
  for (let q = k - 1; q >= 1; q--) {
    if (toks[q].fin || toks[q].semi || toks[q].comma) return false;
    if ((toks[q].ing || toks[q].past || toks[q].part) && toks[q].verbish && toks[q - 1].noun && toks[q - 1].plural) return true;
  }
  return false;
}
// A relative pronoun after a plural noun earlier in the sentence, whose clause already has a verb.
function relBefore(toks, k) {
  let sawFin = false;
  for (let q = k - 1; q >= 1; q--) {
    if (toks[q].fin) sawFin = true;
    if (['who', 'which', 'that'].includes(toks[q].b) && sawFin) return toks[q - 1].plural && toks[q - 1].noun || ['those', 'people'].includes(toks[q - 1].b);
    if (sawFin && SUBJ_PRON.has(toks[q].b) && toks[q - 1].noun && toks[q - 1].plural && toks[q + 1]?.fin) return true;
    if (toks[q].semi) return false;
  }
  return false;
}
// Can verb token u continue a group whose previous verb is v?
function fitsAfter(v, u) {
  if (u.b === 'to' || u.comma && false) return false;
  if (!u.verbish && !u.adjPart) return false;
  if (u.modal || BE_FIN.has(u.b)) return false;
  if (v.modal || v.doFin || /^(don't|doesn't|didn't|can't|won't|cannot|couldn't|wouldn't|shouldn't)$/.test(v.b)) return u.verbish && !u.ing && (u.base || u.b === 'be' || u.b === 'have' || u.lex === 'Infinitive' || /Verb/.test(u.sw) || !u.part && !u.noun);
  if (HAVE_FIN.has(v.b) || v.b === 'have' || v.b === 'having' || /'ve$/.test(v.b)) return u.past || u.part || u.b === 'been' || IRREG_SAME.has(u.b) || u.adjPart && !/ing$/.test(u.b);
  if (ADJ_ING.has(u.b)) return false;
  if (BE_ALL.has(v.b) || /'(s|re|m)$/.test(v.b)) return u.verbish && (u.ing || u.part || (u.past && !u.base) || IRREG_SAME.has(u.b)) || u.b === 'being' || u.adjPart;
  return false;
}

// ---------------------------------------------------------------------------
// Clause openers
// ---------------------------------------------------------------------------

function subjectish(t) { return t && (t.pron && !OBJ_PRON.has(t.b) || t.det || t.noun || t.adj || CLAUSE_LIKE_START.has(t.b) || /^[A-Z]/.test(t.word.replace(/^["“‘(]+/, ''))); }
// A subject and a finite verb follow (before punctuation that ends the clause).
function clauseAhead(toks, i, maxLen = 9) {
  if (!subjectish(toks[i]) || toks[i]?.fin) return false;
  for (let j = i; j < toks.length && j < i + maxLen; j++) {
    if (j > i && toks[j].fin) return true;
    if (toks[j].fin && j === i) return false;
    if (toks[j].comma || toks[j].semi || toks[j].end) return toks[j].fin === true && j > i;
  }
  return false;
}
function finAhead(toks, i, maxLen = 8) {
  for (let j = i; j < toks.length && j < i + maxLen; j++) {
    if (toks[j].fin) return true;
    if (toks[j].semi || toks[j].end && j > i) return false;
  }
  return false;
}

// Returns {type, start} for a clause opened at token i, or null.
function opener(toks, i, ctx) {
  const t = toks[i], b = t.b, p = toks[i - 1], pp = toks[i - 2], nx = toks[i + 1];
  const pb = p?.b || '';
  const pComma = !!p?.comma;
  const segStart = i === 0 || p.semi || ctx.segStart === i;
  const isQuestion = ctx.question;
  const nounBefore = p && !pComma && (p.noun || ['those', 'one', 'anyone', 'someone', 'everyone', 'anything', 'something', 'everything', 'nothing', 'all', 'people', 'others', 'few', 'many', 'some'].includes(pb));
  const prepBefore = p && !pComma && (p.prep || ['of', 'in', 'on', 'at', 'for', 'with', 'from', 'by', 'to', 'about', 'under', 'through', 'into', 'during', 'without', 'within', 'among', 'between', 'upon', 'over', 'against', 'towards', 'toward', 'beyond', 'behind'].includes(pb));
  const verbBefore = p && !pComma && (p.verbish || p.inGroup);
  const startAtPrep = () => {
    let s = i - 1;
    if (toks[s - 1] && QUANT_OF.has(toks[s - 1].b) && pb === 'of') s--;
    else if (toks[s - 1]?.det && toks[s - 2] && QUANT_OF.has(toks[s - 2].b)) s -= 0;
    return s;
  };
  const noMatter = pb === 'matter' && pp?.b === 'no';
  if (noMatter && /^(what|how|who|where|when|which|whether)$/.test(b)) return { type: 'adv', start: i - 2 };

  switch (b) {
    case 'who': case 'whom': case 'whose': {
      if (segStart && isQuestion) return null;
      if (prepBefore && b === 'whom') return { type: 'rel', start: startAtPrep() };
      if (nounBefore || pComma && (toks[i - 1].noun || toks[i - 1].pron || /^[A-Z]/.test(toks[i - 1].word))) return { type: 'rel', start: i };
      if (b === 'whose' && p && (p.noun || pComma)) return { type: 'rel', start: i };
      return { type: 'noun', start: i };
    }
    case 'which': {
      if (segStart && isQuestion) return null;
      if (prepBefore && i >= 2 && toks[i - 2].verbish && !toks[i - 2].noun && nx?.noun && !nx.det) return { type: 'noun', start: i };   // 'depends on which culture'
      if (prepBefore && i >= 2 && (toks[i - 2].noun || toks[i - 2].pron || toks[i - 2].comma || QUANT_OF.has(toks[i - 2].b))) return { type: 'rel', start: startAtPrep() };
      if (nounBefore || pComma) return { type: 'rel', start: i };
      if (prepBefore) return { type: 'rel', start: startAtPrep() };
      return { type: 'noun', start: i };
    }
    case 'that': {
      if (!nx || t.comma || t.end || nx.end && nx.b.length < 3) return null;
      if (pb === 'so' && !(pp && (pp.adj || pp.adv))) return { type: 'adv', start: i - 1 };      // so that
      if (pb === 'now' || pb === 'given' || pb === 'provided' || pb === 'providing' || pb === 'except' || pb === 'considering' || pb === 'seeing') return { type: 'adv', start: i - 1 };
      if (pb === 'in' && pp && !pp.noun && !pp.det) return { type: 'adv', start: i - 1 };
      if (pb === 'order' && pp?.b === 'in') return { type: 'adv', start: i - 2 };
      // so + adj + that / such + noun + that (result clause)
      for (let q = i - 1; q >= Math.max(0, i - 5); q--) {
        if (toks[q].semi || toks[q].comma && q < i - 1) break;
        if ((toks[q].b === 'so' && q < i - 1 && (toks[q + 1].adj || toks[q + 1].adv || QUANT_OF.has(toks[q + 1].b))) || (toks[q].b === 'such' && q < i - 1)) return { type: 'adv', start: i };
      }
      if (nx.fin && !nounBefore) return null;            // "that is", "think that was"
      if (segStart) {
        // "That he lied is obvious" (two finite verbs) vs "That book is mine"
        let fins = 0;
        for (let q = i + 1; q < toks.length; q++) { if (toks[q].fin) fins++; if (toks[q].comma || toks[q].semi || toks[q].end) break; }
        if (nx.noun && !nx.det && toks[i + 2] && SUBJ_PRON.has(toks[i + 2].b)) return null;   // 'That feeling we get ...'
        return fins >= 2 && (nx.pron || nx.det || nx.noun) ? { type: 'noun', start: i } : null;
      }
      if (prepBefore) return null;                        // "at that time"
      // "told us that", "told the students that": the object of a telling verb, then a noun clause
      if (p && (OBJ_PRON.has(pb) && pp && TELL_VERBS.has(pp.b) || nounBefore && tellBefore(toks, i - 1))) return { type: 'noun', start: i };
      if (nounBefore) {
        if (STRONG_APPOS.has(pb) && clauseAhead(toks, i + 1, 10) && !nx.fin) return { type: 'noun', start: i };
        if (APPOS_NOUNS.has(pb) && clauseAhead(toks, i + 1) && !nx.fin) {
          // complete clause after a content noun: 同格. A gap right after the verb ("the idea that he proposed") stays relative.
          const end = clauseEndGuess(toks, i + 1);
          const fi = firstFin(toks, i + 1);
          if (fi < 0 || fi >= end || hasComplementAfter(toks, fi, end)) return { type: 'noun', start: i };
        }
        return { type: 'rel', start: i };
      }
      if (verbBefore || p?.adj || COORD.has(pb) || p?.adv || pComma && toks[i - 2]?.verbish) {
        if (nx.noun && !nx.det && !finAhead(toks, i + 1, 11)) return null;   // "like that book."
        return { type: 'noun', start: i };
      }
      if (p && p.noun) return { type: 'rel', start: i };
      return null;
    }
    case 'what': case 'whatever': case 'whoever': case 'whichever': {
      if (b === 'what' && (nx?.b === 'if' || segStart && isQuestion)) return null;
      if (b === 'what' && nx && (nx.b === 'a' || nx.b === 'an') && segStart) return null;  // exclamation
      if (b !== 'what' && segStart && ctx.commaLater) return { type: 'adv', start: i };
      return { type: 'noun', start: i };
    }
    case 'how': case 'why': {
      if (segStart && isQuestion) return null;
      if (b === 'why' && nounBefore && (pb === 'reason' || pb === 'reasons')) return { type: 'rel', start: i };
      if (b === 'how' && nx && (nx.b === 'ever' || nx.b === 'about' && nx.end)) return null;
      return { type: 'noun', start: i };
    }
    case 'where': case 'when': case 'whenever': case 'wherever': {
      if (segStart && isQuestion) return null;
      if (b === 'whenever' || b === 'wherever') return { type: 'adv', start: i };
      if (nounBefore && !p.pron) {
        if (b === 'where' || TIME_NOUNS.has(pb)) return { type: 'rel', start: i };
        return { type: 'adv', start: i };
      }
      if (pComma) {
        const pt = toks[i - 1];
        if (b === 'where' && (pt.noun || /^[A-Z]/.test(pt.word))) return { type: 'rel', start: i };
        if (b === 'when' && TIME_NOUNS.has(pt.b)) return { type: 'rel', start: i };
        return { type: 'adv', start: i };
      }
      if (p && (WH_NOUN_VERBS.has(pb) || p.beFin && !segStart && b === 'where' || p.beFin && b === 'when' && toks[i - 2]?.pron && ['this', 'that', 'it'].includes(toks[i - 2].b))) return { type: 'noun', start: i };
      if (prepBefore && !['since', 'until', 'till'].includes(pb)) return { type: 'noun', start: i };
      return { type: 'adv', start: i };
    }
    case 'whether': {
      if (segStart && ctx.commaLater && /\bor\b/.test(ctx.text)) return { type: 'adv', start: i };
      return { type: 'noun', start: i };
    }
    case 'if': {
      if (pb === 'as' || pb === 'even') return { type: 'adv', start: i - 1 };
      if (pb === 'what' || pb === 'only' && pp?.b !== 'if') return pb === 'only' ? { type: 'adv', start: i - 1 } : null;
      if (p && !pComma && IF_NOUN_VERBS.has(pb) || (p && p.inGroup && IF_NOUN_VERBS.has(pb))) return { type: 'noun', start: i };
      if (p && OBJ_PRON.has(pb) && pp && IF_NOUN_VERBS.has(pp.b)) return { type: 'noun', start: i };
      return { type: 'adv', start: i };
    }
    case 'though': {
      if (pb === 'as' || pb === 'even') return { type: 'adv', start: i - 1 };
      if (t.comma || t.end || nx?.end) return null;        // ", though."
      return { type: 'adv', start: i };
    }
    case 'because': {
      if (nx?.b === 'of') return null;
      return { type: 'adv', start: i };
    }
    case 'although': case 'whereas': case 'unless': return { type: 'adv', start: i };
    case 'while': {
      if (pb === 'a' || pb === 'the' || pb === 'little' || pb === 'worth') return null;
      if (nx && (nx.ing || nx.part)) return { type: 'adv', start: i };
      return { type: 'adv', start: i };
    }
    case 'once': case 'since': case 'until': case 'till': case 'before': case 'after': {
      if (b === 'once' && (t.comma || segStart && nx?.comma)) return null;
      if (nx && (nx.noun && /^\d/.test(nx.b) || nx.b === 'then' || nx.b === 'that' && b !== 'once')) return null;
      if (clauseAhead(toks, i + 1)) return { type: 'adv', start: i };
      return null;
    }
    case 'as': {
      if (nx?.b === 'soon' && toks[i + 2]?.b === 'as') return clauseAhead(toks, i + 3) ? { type: 'adv', start: i } : null;
      if (nx?.b === 'long' && toks[i + 2]?.b === 'as') return clauseAhead(toks, i + 3) ? { type: 'adv', start: i } : null;
      if (nx?.b === 'if' || nx?.b === 'though') return null;   // handled at if / though
      if ((pb === 'soon' || pb === 'long') && pp?.b === 'as') return null;
      if (AS_BLOCKERS.has(pb) || /er$/.test(pb) && pb.length > 3 || pb === 'well' || pb === 'just' && false) return null;
      // "as large as": comparative
      for (let q = i + 1; q < Math.min(toks.length, i + 4); q++) if (toks[q].b === 'as') return null;
      if (clauseAhead(toks, i + 1, 8)) return { type: 'adv', start: i };
      return null;
    }
    case 'so': {
      if (nx?.b === 'that' && !(p && (p.adj || p.adv))) return null;   // handled at "that"
      return null;
    }
    case 'even': return null;
    default: return null;
  }
}
// noun at index k is the object of tell / show / remind ... ("told the students")
const TELL_THAT = S('tell told tells remind reminded reminds inform informed informs assure assured assures warn warned warns convince convinced convinces persuade persuaded notify notified teach taught');
function tellBefore(toks, k) {
  if (/^(story|stories|truth|joke|jokes|lie|lies|secret|secrets|lesson|lessons|tale|tales|way|news|fact|facts|rule|rules|word|words)$/.test(toks[k].b)) return false;
  for (let q = k - 1; q >= Math.max(0, k - 3); q--) {
    if (TELL_THAT.has(toks[q].b) && toks[q].verbish) return true;
    if (!(toks[q].det || toks[q].adj || toks[q].noun)) return false;
  }
  return false;
}
function firstFin(toks, i) { for (let j = i; j < toks.length; j++) { if (toks[j].fin) return j; if (toks[j].semi) return -1; } return -1; }
function clauseEndGuess(toks, i) { for (let j = i; j < toks.length; j++) if (toks[j].comma || toks[j].semi || toks[j].end) return j; return toks.length - 1; }
function hasComplementAfter(toks, fi, end) {
  const g = toks[fi].grp || [fi, fi];
  if (g[1] >= end) return toks[g[1]].beFin || false;
  const nx = toks[g[1] + 1];
  return !!nx && (nx.det || nx.noun || nx.adj || nx.pron || nx.b === 'to' || toks[g[0]].beFin || toks[g[1]].beFin);
}

// Contact clause (omitted relative pronoun): noun + subject pronoun + finite verb.
function contactClause(toks, i, ctx) {
  const t = toks[i], p = toks[i - 1];
  const properSubj = /^[A-Z]/.test(t.word) && t.noun && !t.det && i > 1;
  if (!p || p.comma || p.semi || !p.noun || p.pron || !(SUBJ_PRON.has(t.b) || properSubj)) return false;
  if (properSubj && /^[A-Z]/.test(p.word)) return false;   // a multi-word name
  if (/^[A-Z]/.test(p.word) && i - 1 === 0) return false;
  let j = i + 1; while (j < toks.length && (toks[j].adv || PREVERB_ADV.has(toks[j].b))) j++;
  if (!toks[j]?.fin) return false;
  // "told the man he was wrong": a noun clause, not a relative.
  for (let q = i - 2; q >= Math.max(0, i - 4); q--) if (TELL_VERBS.has(toks[q].b) && toks[q].verbish) return false;
  if (TIME_NOUNS.has(p.b) && !ctx.parentHasVerb && !laterFinAfterGroup(toks, j)) return false;
  if (!ctx.parentHasVerb && !laterFinAfterGroup(toks, j)) return false;
  return true;
}
function laterFinAfterGroup(toks, j) {
  const g = toks[j].grp || [j, j];
  for (let q = g[1] + 1; q < toks.length; q++) { if (toks[q].semi) return false; if (toks[q].fin) return true; }
  return false;
}
// Omitted "that": think / believe / said + subject + finite verb.
function omittedThat(toks, i) {
  const t = toks[i], p = toks[i - 1];
  if (!p || p.comma || !OMIT_THAT_VERBS.has(p.b) || !(p.verbish || p.adj)) return false;
  if (t.noun && t.plural && !t.det && (toks[i + 1]?.fin || toks[i + 2]?.fin && toks[i + 1].adv)) return true;   // 'believe humans are'
  if (!(SUBJ_PRON.has(t.b) || t.det && t.b !== 'that' || CLAUSE_LIKE_START.has(t.b) || /^[A-Z]/.test(t.word) && t.noun)) return false;
  if (t.b === 'it' || t.b === 'there') { if (!toks[i + 1]?.fin) return false; return true; }
  // subject NP then finite verb within a few tokens
  for (let j = i + 1; j < toks.length && j <= i + 5; j++) {
    if (toks[j].fin) return !toks[j - 1].prep;
    if (toks[j].comma || toks[j].semi || toks[j].end || toks[j].verbish && !toks[j].fin) return false;
    if (!(toks[j].noun || toks[j].adj || toks[j].det || toks[j].adv)) return false;
  }
  return false;
}
// Post-modifying participle / to-infinitive phrase after a noun.
function postPhrase(toks, i) {
  const t = toks[i], p = toks[i - 1];
  if (!p || p.comma) return false;
  const nounLike = p.noun && !p.pron || ['those', 'people', 'anyone', 'someone', 'everyone', 'something', 'anything', 'nothing', 'everything'].includes(p.b);
  if (!nounLike) return false;
  const verbBeforeNoun = () => { for (let q = i - 2; q >= Math.max(0, i - 4); q--) { if (toks[q].verbish) return toks[q]; if (toks[q].comma) break; } return null; };
  if (t.b === 'to') {
    const nx = toks[i + 1];
    if (/^(which|what|whose)$/.test(toks[i - 2]?.b || '')) return false;   // [which book to read]
    if (!nx || !(nx.base || nx.lex === 'Infinitive' || /Verb/.test(nx.sw)) || nx.noun && !/Verb/.test(nx.sw) || nx.det) return false;
    if (BE_ALL.has(p.b)) return false;
    const v = verbBeforeNoun();
    if (v && TO_OBJ_VERBS.has(v.b)) return false;
    if (/^(order|addition|regard|relation|response|contrast|comparison|time|ability|able)$/.test(p.b) && toks[i - 2]?.b === 'in') return false;
    if (['able', 'unable', 'likely', 'used'].includes(p.b)) return false;
    return true;
  }
  if (t.inGroup || t.fin) return false;
  if (t.ing && t.verbish) {
    const v = verbBeforeNoun();
    if (v && ING_OBJ_VERBS.has(v.b)) return false;
    return true;
  }
  if ((t.past || t.part || t.adjPart && /Past/.test(t.sw)) && (t.verbish || t.adjPart) && !t.fin) {
    const nx = toks[i + 1];
    return !nx || nx.prep || nx.b === 'by' || nx.adv || nx.b === 'to' || t.comma || t.end || nx.det && false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Sentence analysis: a stack of open clauses, closed by verbs, commas and conjunctions
// ---------------------------------------------------------------------------

// toks: tagged tokens of ONE sentence (features + verbGroups already applied). Returns marks with local indices.
export function analyzeSentence(toks) {
  const n = toks.length;
  const marks = [];
  if (!n) return marks;
  const text = toks.map((t) => t.word).join(' ');
  const question = /\?["'”’)]*$/.test(toks[n - 1].word);
  const main = { type: 'main', start: 0, hasVerb: false, segStart: 0, verbs: [] };
  const stack = [main];
  const closed = [];   // closed clauses (for subject detection)
  const mainVerbs = []; // [{grp, segStart}]
  const top = () => stack[stack.length - 1];
  const close = (c, end) => {
    if (c.type === 'main') return;
    let e = Math.max(c.start, end);
    marks.push({ type: c.type, start: c.start, end: e });
    closed.push({ type: c.type, start: c.start, end: e, fronted: c.fronted });
  };
  const closeTo = (end, keepMain = true) => { while (stack.length > 1) close(stack.pop(), end); };
  const depthOpenAt = () => stack.length;
  const commaLaterFrom = (i) => { for (let q = i; q < n; q++) if (toks[q].comma) return true; return false; };

  const newMainSegment = (i) => { main.hasVerb = false; main.segStart = i; };

  for (let i = 0; i < n; i++) {
    const t = toks[i];
    // Openers (skip tokens that belong to a multi-word opener already opened)
    const ctx = { segStart: main.segStart, question, commaLater: commaLaterFrom(i), text, parentHasVerb: top().hasVerb };
    let op = null;
    // "not [how fast you read] but [how well ...]": a conjunction before a parallel clause closes the finished one
    if (COORD.has(t.b) && stack.length > 1 && top().hasVerb && top().type === 'noun' && /^(that|what|how|why|who|whether|where|when|which|if)$/.test(toks[i + 1]?.b || '')) close(stack.pop(), i - 1);
    if (!t.inGroup || t.b === 'that') op = opener(toks, i, ctx);
    if (!op && contactClause(toks, i, ctx)) op = { type: 'rel', start: i };
    if (!op && omittedThat(toks, i)) op = { type: 'noun', start: i };
    if (op) {
      // A clause opened right after the previous one finished its verb inside a post phrase: close the post phrase.
      while (top().type === 'post' && top().hasVerb && !(op.type === 'rel' && toks[i - 1]?.noun)) close(stack.pop(), op.start - 1);
      const fronted = top() === main && !main.hasVerb && (op.start === main.segStart || op.start === main.segStart + 1 && (toks[main.segStart].adv || PREVERB_ADV.has(toks[main.segStart].b) || CONN_START.has(toks[main.segStart].b)) || toks[op.start - 1]?.comma && !nounAtDepth(toks, main.segStart, op.start - 1, closed));
      stack.push({ type: op.type, start: op.start, hasVerb: false, fronted, afterComma: !!toks[op.start - 1]?.comma, opener: i });
    } else if (postPhrase(toks, i)) {
      while (top().type === 'post' && top().hasVerb) close(stack.pop(), i - 1);
      stack.push({ type: 'post', start: i, hasVerb: true, fronted: false, afterComma: false, opener: i });
    }

    if (t.fin) {
      const [h, g] = t.grp;
      for (;;) {
        const c = top();
        if (!c.hasVerb) {
          c.hasVerb = true; c.grp = [h, g];
          if (c === main) { mainVerbs.push({ grp: [h, g], segStart: main.segStart }); main.grp = [h, g]; }
          break;
        }
        // coordinated verb: "... and found"
        let q = h - 1; while (q >= 0 && (toks[q].adv || PREVERB_ADV.has(toks[q].b)) && !toks[q].comma) q--;
        const coordinated = q >= 0 && COORD.has(toks[q].b) && q > c.start;
        if (coordinated && c !== main) {
          // "explained [why it had failed] and suggested": the verb's form matches the main verb, not the clause's
          const sig = (gr) => gr ? `${gr[1] - gr[0]}:${toks[gr[0]].past ? 'p' : toks[gr[0]].pres ? 's' : 'b'}` : '';
          if (main.hasVerb && main.grp && c.grp && sig([h, g]) === sig(main.grp) && sig([h, g]) !== sig(c.grp) && c.type !== 'post') {
            closeTo(q - 1);
            mainVerbs.push({ grp: [h, g], segStart: main.segStart });
          }
          break;
        }
        if (c === main) {
          if (coordinated || (q >= 0 && toks[q].comma) || subjectBefore(toks, h, main)) mainVerbs.push({ grp: [h, g], segStart: coordinated ? q + 1 : main.segStart });
          break;
        }
        // 'than we have been': a comparative clause stays inside the current one
        if (h >= 2 && SUBJ_PRON.has(toks[h - 1].b) && (toks[h - 2].b === 'than' || toks[h - 2].b === 'as')) break;
        // the verb belongs to an enclosing clause: close this one
        let end = h - 1;
        while (end > c.start && (isPre(toks, end) && !toks[end].comma)) end--;
        if (c.fronted && c.type === 'adv' && !toks[end].comma) {
          if (SUBJ_PRON.has(toks[end].b) || toks[end].b === 'there') end--;
          else {
            let r = end; while (r > c.start + 1 && (toks[r].noun || toks[r].adj) && !toks[r - 1].fin) r--;
            if (toks[r].det && r > c.start + 1) end = r - 1;
          }
        }
        close(stack.pop(), end);
      }
      i = g; // skip the rest of the group
    }

    const cur = toks[i];
    if (cur.semi && i < n - 1) { closeTo(i); newMainSegment(i + 1); continue; }
    if (cur.comma && stack.length > 1) {
      // Close finished clauses at a comma when what follows starts something new.
      const nx = toks[i + 1], nx2 = toks[i + 2];
      const newThing = !nx || COORD.has(nx.b) && (clauseAhead(toks, i + 2) || nx2?.fin) || CONN_START.has(nx.b) || nx.ing || nx.past && !nx.fin || clauseAhead(toks, i + 1) || nx.fin
        || ['which', 'who', 'whom', 'whose', 'where', 'when', 'because', 'although', 'though', 'while', 'whereas', 'if', 'unless', 'since', 'as', 'so', 'but', 'and', 'or', 'not', 'including', 'such', 'even', 'especially', 'particularly', 'for', 'in', 'on', 'at', 'by', 'with', 'from'].includes(nx.b);
      while (stack.length > 1) {
        const c = top();
        if (!c.hasVerb) break;
        if (c.fronted || c.afterComma || c.type === 'post' || newThing) { close(stack.pop(), i); continue; }
        break;
      }
      if (nx && COORD.has(nx.b) && (clauseAhead(toks, i + 2)) && main.hasVerb) { closeTo(i); newMainSegment(i + 2); }
    } else if (cur.comma && main.hasVerb) {
      const nx = toks[i + 1];
      if (nx && COORD.has(nx.b) && clauseAhead(toks, i + 2)) newMainSegment(i + 2);
    }
    // "and" + new subject + verb without a comma, at main level
    if (!cur.comma && COORD.has(cur.b) && stack.length === 1 && main.hasVerb && clauseAhead(toks, i + 1)) newMainSegment(i + 1);
  }
  closeTo(n - 1);

  // Main verbs and long subjects
  const seenSeg = new Set();
  for (const mv of mainVerbs) {
    marks.push({ type: 'verb', start: mv.grp[0], end: mv.grp[1] });
    if (seenSeg.has(mv.segStart)) continue;
    seenSeg.add(mv.segStart);
    const sj = findSubject(toks, mv.segStart, mv.grp[0], closed);
    if (sj && qualifies(toks, sj, closed, marks)) marks.push({ type: 'subj', start: sj[0], end: sj[1] });
  }
  // de-duplicate and drop empty/degenerate spans
  const key = (m) => `${m.type}:${m.start}-${m.end}`;
  const seen = new Set();
  return marks.filter((m) => m.start <= m.end && !seen.has(key(m)) && seen.add(key(m)))
    .sort((a, b) => a.start - b.start || b.end - a.end);
}

function subjectBefore(toks, h, main) {
  const p = toks[h - 1];
  return p && (SUBJ_PRON.has(p.b) || p.noun) && h - 1 > main.segStart && COORD.has(toks[h - 2]?.b);
}
function inClosed(k, closed) { return closed.some((c) => c.start <= k && k <= c.end); }
function nounAtDepth(toks, a, b, closed) {
  for (let k = a; k <= b; k++) if (!inClosed(k, closed) && (toks[k].noun || toks[k].pron)) return true;
  return false;
}
function findSubject(toks, segStart, h, closed) {
  if (h <= segStart) return null;
  const cands = [segStart];
  for (let k = segStart; k < h; k++) {
    if (toks[k].comma && !inClosed(k, closed.filter((c) => !(c.end === k))) && introductory(toks, segStart, k, closed)) cands.push(k + 1);
  }
  for (const c of closed) if (c.fronted && c.end < h && c.end >= segStart) cands.push(c.end + 1);
  const uniq = [...new Set(cands)].filter((c) => c < h).sort((a, b) => b - a);
  for (const c of uniq) {
    let s = c, e = h - 1;
    while (s <= e && (CONN_START.has(toks[s].b) && !toks[s].noun || toks[s].adv && s < e && !toks[s].noun)) s++;
    while (e >= s && (toks[e].adv || isPre(toks, e)) && !inClosed(e, closed) && !toks[e].noun) e--;
    if (s > e) continue;
    // skip a leading prepositional phrase without a comma: "In 2010 the company moved"
    if (toks[s].prep && toks[s].b !== 'of') {
      let r = s + 1; while (r <= e && !(toks[r].det || toks[r].pron) ) r++;
      if (r <= e && r > s + 1) s = r; else continue;
    }
    // the subject must contain a noun or pronoun outside nested clauses, or be a clause itself
    let ok = false;
    for (let k = s; k <= e; k++) if (!inClosed(k, closed) && (toks[k].noun || toks[k].pron || toks[k].det && k === e)) { ok = true; break; }
    if (!ok && closed.some((cl) => cl.start === s && cl.end >= e - 1 && cl.type === 'noun')) ok = true;
    if (!ok) continue;
    if (toks[e].comma && e > s && !inClosed(e, closed.filter((x) => x.end !== e))) {
      // trailing comma that closes a parenthetical stays; an introductory comma would have moved s
    }
    return [s, e];
  }
  return null;
}
// Is toks[a..b] an introductory element (so the subject starts after it)?
function introductory(toks, a, b, closed) {
  const t = toks[a];
  if (closed.some((c) => c.start === a && c.end >= b - 1)) return true;           // fronted clause
  if (t.prep || t.adv || CONN_START.has(t.b) || SUB_WORDS.has(t.b) || t.b === 'to' || t.ing || t.past && t.verbish || t.adjPart || TIME_NOUNS.has(t.b) || /^d/.test(t.b)) return true;
  if (a === b) return true;                                                          // 'However,'
  // a time phrase such as 'Two million years ago,'
  if (toks[b].b === 'ago' || toks[b].b === 'later' || toks[b].b === 'today') return true;
  // 'Then, around 12,000 years ago,' : earlier commas already made later candidates
  return false;
}
function qualifies(toks, [s, e], closed, marks) {
  if (e - s + 1 >= 4) return true;
  if (closed.some((c) => c.start >= s && c.end <= e)) return true;
  for (let k = s + 1; k <= e; k++) if (toks[k].prep || toks[k].b === 'of') return true;
  return false;
}

// ---------------------------------------------------------------------------
// Part-of-speech labels
// ---------------------------------------------------------------------------

export const POS_NAMES = { 名: '名詞', 動: '動詞', 助動: '助動詞', 形: '形容詞', 副: '副詞', 前: '前置詞', 接: '接続詞', 代: '代名詞', 冠: '冠詞', 関代: '関係代名詞', 関副: '関係副詞', 疑: '疑問詞', 不: '不定詞のto', 数: '数詞', 間: '間投詞' };

function termPos(tags, b, t, k, toks) {
  if (ARTICLES.has(b)) return '冠';
  if (tags.has('Modal')) return '助動';
  if (tags.has('Auxiliary') || (t.inGroup && !t.grpLast && (BE_ALL.has(b) || HAVE_FIN.has(b) || DO_FIN.has(b)))) return '助動';
  if (tags.has('Negative')) return '副';
  if (tags.has('Verb') || tags.has('Copula') || t.verbish && !t.noun && !t.adj) return '動';
  if (POSSESSIVE.has(b)) return '代';
  if (tags.has('Pronoun') || PRONOUNS.has(b) && !t.det) return '代';
  if (tags.has('Determiner') || DETS.has(b)) return /^(this|that|these|those)$/.test(b) && !(toks[k + 1] && (toks[k + 1].noun || toks[k + 1].adj)) ? '代' : '形';
  if (tags.has('Value') || /^\d/.test(b)) return '数';
  if (tags.has('Adjective') || tags.has('Comparative') || tags.has('Superlative')) return '形';
  if (tags.has('Adverb') || tags.has('Particle')) return '副';
  if (tags.has('Preposition')) return '前';
  if (tags.has('Conjunction')) return '接';
  if (tags.has('QuestionWord')) return '疑';
  if (tags.has('Expression')) return '間';
  if (tags.has('Noun') || tags.has('Date')) return '名';
  return '';
}

function posLabels(toks, marks) {
  const opens = new Map();
  for (const m of marks) if (m.type === 'rel' || m.type === 'noun' || m.type === 'adv') {
    // label the clause's opener word
    for (let k = m.start; k <= Math.min(m.end, m.start + 3); k++) {
      if (/^(who|whom|whose|which|that|what|whatever|whoever|where|when|why|how|whether|if|because|although|though|while|whereas|unless|since|until|till|before|after|once|as|so|even|now)$/.test(toks[k].b)) { if (!opens.has(k)) opens.set(k, m.type); break; }
    }
  }
  for (const m of marks) if (m.type === 'verb') toks[m.end].grpLast = true;
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.grp) toks[t.grp[1]].grpLast = true;
  }
  return toks.map((t, k) => {
    const b = t.b;
    const kind = opens.get(k);
    if (kind === 'rel') return /^(where|when|why)$/.test(b) ? '関副' : '関代';
    if (kind === 'noun') return b === 'that' || b === 'whether' || b === 'if' ? '接' : b === 'what' || b === 'whatever' || b === 'whoever' ? '関代' : '疑';
    if (kind === 'adv') return '接';
    if (b === 'to' && toks[k + 1] && toks[k + 1].verbish && (toks[k + 1].base || toks[k + 1].lex === 'Infinitive')) return '不';
    if (b === 'to') return '前';
    if (t.prep && !t.verbish && PREP_WORDS.has(b)) return '前';
    if (b === 'that' && toks[k + 1] && !toks[k + 1].noun) return t.det ? '代' : '接';
    if (t.fin || t.inGroup) {
      if (t.inGroup && !t.grpLast && (MODALS.has(b) || BE_ALL.has(b) || HAVE_FIN.has(b) || DO_FIN.has(b) || t.modal)) return '助動';
      if (t.adv || t.neg) return '副';
    }
    const labs = [];
    for (const term of t.terms) {
      if (!term.text && !term.tags.size) continue;
      const l = termPos(term.tags, labs.length ? '' : b, t, k, toks);
      if (l && labs[labs.length - 1] !== l) labs.push(l);
    }
    if (t.repaired) return '動';
    if (t.verbish && t.ing && !t.fin && !t.inGroup && labs[0] === '名') return '動';
    return labs.slice(0, 2).join('・');
  });
}

// ---------------------------------------------------------------------------
// Whole text
// ---------------------------------------------------------------------------

// paragraphs: [[{word, sentenceEnd}]] as from chunker.tokensWithBoundaries(). Word indices are global
// (running over all paragraphs), matching the reader's data-i numbering.
export function analyze(nlp, paragraphs) {
  const out = { marks: [], pos: [] };
  let base = 0;
  for (const para of paragraphs) {
    const words = para.map((t) => t.word);
    if (!words.length) continue;
    const toks = tagWords(nlp, words);
    let s = 0;
    for (let k = 0; k < para.length; k++) {
      if (para[k].sentenceEnd || k === para.length - 1) {
        const sent = toks.slice(s, k + 1);
        features(sent);
        verbGroups(sent);
        const marks = analyzeSentence(sent);
        for (const m of marks) out.marks.push({ type: m.type, start: m.start + s + base, end: m.end + s + base });
        out.pos.push(...posLabels(sent, marks));
        s = k + 1;
      }
    }
    base += para.length;
  }
  return out;
}

// Convenience for tests: one sentence string -> marks with token indices.
export function analyzeString(nlp, sentence) {
  const words = sentence.split(/\s+/).filter(Boolean);
  const r = analyze(nlp, [words.map((w, i) => ({ word: w, sentenceEnd: i === words.length - 1 }))]);
  return { words, ...r };
}

// ---------------------------------------------------------------------------
// User corrections
// ---------------------------------------------------------------------------

export const markId = (m) => `${m.type}:${m.start}-${m.end}`;
// edits: { removed: [id], added: [{type,start,end}] }. Added marks win over removals of the same id.
export function applyEdits(marks, edits) {
  if (!edits) return marks.map((m) => ({ ...m, auto: true }));
  const removed = new Set(edits.removed || []);
  const out = marks.filter((m) => !removed.has(markId(m))).map((m) => ({ ...m, auto: true }));
  const have = new Set(out.map(markId));
  for (const a of edits.added || []) if (MARK_TYPES.includes(a.type) && a.start <= a.end && !have.has(markId(a))) { out.push({ type: a.type, start: a.start, end: a.end, auto: false }); have.add(markId(a)); }
  return out.sort((a, b) => a.start - b.start || b.end - a.end);
}
export function removeMark(edits, m) {
  const e = { removed: [...(edits?.removed || [])], added: [...(edits?.added || [])] };
  const id = markId(m);
  const ai = e.added.findIndex((a) => markId(a) === id);
  if (ai >= 0) e.added.splice(ai, 1); else if (!e.removed.includes(id)) e.removed.push(id);
  return e;
}
export function addMark(edits, m) {
  const e = { removed: [...(edits?.removed || [])], added: [...(edits?.added || [])] };
  const id = markId(m);
  const ri = e.removed.indexOf(id);
  if (ri >= 0) e.removed.splice(ri, 1); else if (!e.added.some((a) => markId(a) === id)) e.added.push({ type: m.type, start: m.start, end: m.end });
  return e;
}

// Per-word decorations for rendering: opens/closes (bracket characters, outermost first), and word classes.
export function decorations(marks, enabled, count) {
  const deco = Array.from({ length: count }, () => ({ opens: [], closes: [], subj: null, verb: null }));
  const on = (t) => enabled.has(t);
  const spans = marks.filter((m) => on(m.type) && m.start < count);
  // wider spans open first and close last
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  for (const m of spans) {
    const end = Math.min(m.end, count - 1);
    if (m.type === 'subj' || m.type === 'verb') {
      for (let k = m.start; k <= end; k++) deco[k][m.type] = m;
      continue;
    }
    deco[m.start].opens.push(m);
    deco[end].closes.unshift(m);
  }
  return deco;
}

// Debug helper (tests only): token flags after tagging, repairs and verb grouping.
export function debugTokens(nlp, sentence) {
  const toks = tagWords(nlp, sentence.split(/\s+/).filter(Boolean));
  features(toks); verbGroups(toks);
  const F = ['noun', 'pron', 'det', 'adj', 'adv', 'prep', 'verbish', 'past', 'part', 'ing', 'pres', 'base', 'plural', 'adjPart', 'fin', 'inGroup', 'repaired', 'poss'];
  return toks.map((t, i) => `${i} ${t.word} [${[...t.tags].join(',')}] lex=${t.lex} sw=${t.sw} :: ${F.filter((f) => t[f]).join(' ')}`);
}

// "temples." -> ["temples", "."]; closing brackets are drawn between the two.
export function splitPunct(word) {
  let i = word.length;
  while (i > 1 && /[.,;:!?"'”’)\]—–]/.test(word[i - 1])) i--;
  return [word.slice(0, i), word.slice(i)];
}
