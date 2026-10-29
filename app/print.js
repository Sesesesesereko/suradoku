// Print / save-as-PDF layout. The browser's print dialog does the PDF ("PDFに保存"),
// so Japanese text prints with the system fonts and nothing extra is bundled.
import { tokensWithBoundaries } from './chunker.js';
import { majorBreaks } from './slsrc.js';
import { loadVocab, glossFor, namesIn } from './vocab.js';
import { cached as trCached } from './translate.js';
import { decorations, splitPunct, MARK_INFO } from './syntax.js';

let getState = () => ({});
export function initPrint(stateGetter) { getState = stateGetter; }

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DEFAULTS = { slash: 'on', gloss: false, ja: 'none', write: 'none', notes: false, size: 'm', title: '', marks: false, pos: false };
let lastOptions = { ...DEFAULTS };
let vocabReady = false;

function options() {
  const f = new FormData($('#printForm'));
  return {
    slash: f.get('pSlash') || 'on',          // on | clause | off
    gloss: f.get('pGloss') === 'on',
    ja: f.get('pJa') || 'none',              // none | sentence | chunk
    write: f.get('pWrite') || 'none',        // none | space | ruled
    notes: f.get('pNotes') === 'on',         // ruled memo lines after each paragraph
    size: f.get('pSize') || 'm',
    title: (f.get('pTitle') || '').toString(),
    marks: f.get('pMarks') === 'on',          // the 構文マーク types switched on in the reader
    pos: f.get('pPos') === 'on',              // 品詞 labels
  };
}

// Synchronous builder, so it can also run from a `beforeprint` handler (Ctrl+P).
function buildSync(o) {
  const st = getState();
  if (!st.slashed) return { html: '<p>先に手順5で区切りを作ってください。</p>', note: '', missing: 0 };
  const gloss = o.gloss && vocabReady;
  const paras = tokensWithBoundaries(st.slashed);
  const major = majorBreaks(paras);   // as in the reader (AI's major breaks for AI-slashed sentences)
  const names = namesIn(paras.flat().map(t => t.word));
  // 構文マーク / 品詞: only when the reader has analysed this exact text (st.sx.auto is for st.sx.key).
  const sx = st.sx, total = paras.flat().length;
  const sxReady = !!(sx?.auto && sx.auto.pos.length === total);
  const deco = o.marks && sxReady && sx.on.size ? decorations(sx.marks, sx.on, total) : null;
  const posL = o.pos && sxReady ? sx.auto.pos : null;
  let wi = 0, missing = 0;
  const out = [];
  for (const toks of paras) {
    let html = '', sentence = [], sentStart = true;
    const blocks = [];   // with sentence translations, each sentence is its own block followed by its Japanese
    let unitHtml = '', chunk = [];   // 区切りごとの訳: each chunk is a unit with its Japanese under it
    toks.forEach((t, ti) => {
      const g = gloss ? glossFor(t.word, { sentenceStart: sentStart, names }) : null;
      const dk = deco?.[wi];
      const [core, trail] = dk?.closes.length ? splitPunct(t.word) : [t.word, ''];
      let word = g ? `<ruby>${esc(core)}<rt>${esc(g.ja)}</rt></ruby>` : esc(core);
      if (st.fillSet?.has(wi)) word = `<span class="pfill">${word}</span>`;   // a word put into a blank (空欄補充)
      if (posL) word = `<span class="ppos" data-pos="${esc(posL[wi] || '')}">${word}</span>`;
      if (dk?.verb) word = `<b class="pverb${dk.verb.start === wi ? ' pvstart' : ''}">${word}</b>`;
      if (dk?.subj) word = `<span class="psubj">${word}</span>`;
      if (dk && (dk.opens.length || dk.closes.length)) word = '<span class="pnb">' + dk.opens.map(m => `<span class="psx">${MARK_INFO[m.type].open}</span>`).join('') + word
        + dk.closes.map(m => `<span class="psx">${MARK_INFO[m.type].close}</span>`).join('') + esc(trail) + '</span>';
      // the space after a word inside a long subject is underlined too
      const subjSpace = dk?.subj && deco[wi + 1]?.subj === dk.subj;
      sentence.push(t.word); sentStart = false;
      const showSlash = t.slashAfter && !t.sentenceEnd && (o.slash === 'on' || (o.slash === 'clause' && (major.has(wi) || /[,;:—–]$/.test(t.word))));
      wi++;
      const end = t.sentenceEnd || ti === toks.length - 1;
      if (o.ja === 'chunk') {
        // Same chunk text as the reader (words joined by spaces), so the cached translation matches.
        unitHtml += (chunk.length ? ' ' : '') + word; chunk.push(t.word);
        if (showSlash) unitHtml += ' <span class="pslash">/</span>';
        if (t.slashAfter || end) {
          const tr = trCached(chunk.join(' '));
          if (!tr) missing++;
          html += `${html ? ' ' : ''}<span class="pcu"><span class="pcu-en">${unitHtml}</span>${tr ? `<span class="pcu-ja" lang="ja">${esc(tr.ja)}</span>` : '<span class="pcu-ja blank" lang="ja"></span>'}</span>`;
          unitHtml = ''; chunk = [];
        }
        if (end) { sentence = []; sentStart = true; }
        return;
      }
      html += word;
      if (showSlash) html += ' <span class="pslash">/</span>';
      if (end && o.ja === 'sentence') {
        const tr = trCached(sentence.join(' '));
        if (!tr) missing++;
        blocks.push(`<p class="ppara">${html}</p><p class="pja" lang="ja">${tr ? esc(tr.ja) : '&nbsp;'}</p>`);
        html = '';
      }
      if (end) { sentence = []; sentStart = true; }
      if (ti < toks.length - 1 && html) html += subjSpace && !showSlash ? '<span class="psubj"> </span>' : ' ';
    });
    const body = o.ja === 'sentence' ? `<div class="ppend">${blocks.join('')}</div>` : `<p class="ppara">${html}</p>`;
    out.push(`${body}${o.notes ? '<div class="pnotes"></div>' : ''}`);
  }
  const head = o.title ? `<h1 class="ptitle">${esc(o.title)}</h1>` : '';
  const sxNote = (o.marks || o.pos) && !sxReady ? '構文マーク・品詞は、手順5でいずれかを表示してから印刷すると入ります。' : '';
  const note = sxNote + (!missing ? ''
    : o.ja === 'sentence' ? `訳のない文が ${missing} 文あります（空欄で印刷されます）。手順5の「全文訳」で訳を表示してから印刷すると入ります。`
    : o.ja === 'chunk' ? `訳のない区切りが ${missing} 個あります（下線の空欄で印刷され、手で書き込めます）。手順5の「区切りごとの訳」で訳を表示するか ✎ で書き込んでから印刷すると入ります。`
    : '');
  return { html: `${head}<div class="pbody pw-${o.write} ps-${o.size} pj-${o.ja}${posL ? ' ppos-on' : ''}${posL && gloss ? ' ppos-up' : ''}" lang="en">${out.join('')}</div>`, note, missing };
}

export async function buildPrintHtml(o = options()) {
  if (o.gloss && !vocabReady) { try { await loadVocab(); vocabReady = true; } catch { /* print without glosses */ } }
  return buildSync(o);
}

let previewSeq = 0;
export async function refreshPrintPreviewIfOpen() {
  if (!$('#printDlg')?.open) return;
  const seq = ++previewSeq;
  const o = options();
  const r = await buildPrintHtml(o);
  if (seq !== previewSeq) return;            // a newer change is already being drawn
  lastOptions = o;
  $('#printPreview').innerHTML = r.html;
  $('#printNote').textContent = r.note;
}

let titleFor = null;
export function openPrintDialog() {
  const st = getState();
  const f = $('#printForm');
  // Suggest the PDF's name as the title, and refresh it when another PDF was opened.
  if (titleFor !== st.fileName) { f.elements.pTitle.value = (st.fileName || '').replace(/\.pdf$/i, ''); titleFor = st.fileName; }
  // 構文マーク / 品詞 follow what the reader shows when the dialog opens.
  f.elements.pMarks.checked = !!st.sx?.on.size; f.elements.pMarks.disabled = !st.sx?.on.size;
  f.elements.pPos.checked = st.sx?.pos === 'all';
  $('#printDlg').showModal();
  refreshPrintPreviewIfOpen();
}

export function wirePrint() {
  const f = $('#printForm');
  f.addEventListener('input', refreshPrintPreviewIfOpen);
  f.addEventListener('change', refreshPrintPreviewIfOpen);
  f.addEventListener('submit', (e) => e.preventDefault());   // Enter in the title must not close the dialog
  $('#printClose').onclick = () => $('#printDlg').close();
  $('#printGo').onclick = async () => {
    const o = options();
    const r = await buildPrintHtml(o);
    lastOptions = o;
    $('#printArea').innerHTML = r.html;
    $('#printDlg').close();
    document.body.classList.add('printing');
    // Let layout settle, then open the browser print dialog (choose "PDFに保存" to make a PDF).
    requestAnimationFrame(() => setTimeout(() => window.print(), 50));
  };
  // Ctrl+P or the browser menu: print the passage with the last used settings, not the whole app.
  window.addEventListener('beforeprint', () => {
    if (document.body.classList.contains('printing')) return;
    if (!getState().slashed) return;
    $('#printArea').innerHTML = buildSync(lastOptions).html;
    document.body.classList.add('printing');
  });
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing'); $('#printArea').textContent = ''; });
}
