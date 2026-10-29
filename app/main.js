import './compat.js';   // must stay first: fills APIs pdf.js needs on iPhone/iPad (WebKit)
import * as pdfjs from '../vendor/pdfjs/pdf.min.mjs';
import {
  classifyLines, stripMarginNumbers, linesToText, joinPages, findMarkers, removeMarkers,
  suspiciousTokens, parseRanges, formatRanges, linesFromTextContent, linesFromTesseract, wordCount, hasJapanese,
  makeWordChecker, textLayerQuality, excludedText,
} from './textclean.js';
import { findBlanks, parseAnswerKey, matchAnswers, isChoiceSymbol, fillBlanks, undoFills, adjustFills, validFills, fillWordIndices, parseChoices, resolveChoice, solveBlanks } from './blanks.js';
import { chunkText, tokensWithBoundaries, fromTokens, stats } from './chunker.js';
import { PLAN, EVIDENCE } from './practice.js';
import { status as trStatus, ready as trReady, translate as trTranslate, cached as trCached, store as trStore, forget as trForget, setContextLookup } from './translate.js';
import { aiReady, aiActive, aiJson, aiName, aiWhyNot, aiBusyText, aiUsage, aiTimeoutText, aiUnavailableText, providerErrorText, onAiChange } from './ai.js';
import { loadVocab, glossFor, namesIn } from './vocab.js';
import { initPrint, wirePrint, openPrintDialog, refreshPrintPreviewIfOpen } from './print.js';
import { analyze as sxAnalyze, applyEdits, removeMark, addMark, decorations, splitPunct, MARK_TYPES, MARK_INFO, POS_NAMES } from './syntax.js';
import { initSxAi, refreshSxAi } from './sxai.js';
import { initSxSrc, refreshSxSrc, sentencesOf, sourceFor, mergeAi } from './sxsrc.js';
import { initStructure } from './structure.js';
import { initSlSrc, afterPropose as slSrcAfterPropose, majorBreaks } from './slsrc.js';

const $ = (s) => document.querySelector(s);
const abs = (p) => new URL(p, location.href).href;
pdfjs.GlobalWorkerOptions.workerSrc = abs('app/pdf-worker.mjs');   // compat.js + the unmodified pdf.js worker

// Set by the claude.ai link version, whose sandbox blocks printing, downloads and the Translator API.
const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link'; // set only in the claude.ai build
const OCR_B64 = LINK || document.querySelector('meta[name="readflow-ocr"]')?.content === 'b64';   // GitHub Pages build
const PREVIEW_W = 1100;            // preview bitmap width (px) used for review and line boxes
const LOW_CONF = 70;               // word confidence below this is highlighted
const state = { pdf: null, fileName: '', pages: [], selected: new Set(), active: null, cancel: false, worker: null, region: null, running: false, loadToken: 0, cancelReject: null,
  // 空欄補充: fills = answers put into the body ({id, label, raw, answer, start, end}, positions in #body),
  // blankDraft = what is typed / picked per blank id ({value, ai, pick, force}), questionText = lines left out
  // of the passage (choices are read from it), choicePaste = choices pasted by the learner.
  fills: [], bodyPrev: '', blankDraft: {}, questionText: '', choicePaste: '', blanks: [], choices: {}, fillSet: null };
// Test hook used for verification runs (works only with the dev server's --save option).
async function ocrAndSave(ranges, name) {
  setRanges(ranges); $('#body').value = ''; await runOcr();
  const payload = { file: state.fileName, ranges, settings: { dpi: $('#dpi').value, psm: $('#psm').value }, pages: exportPages(), body: await buildBody(true) };
  for (const p of state.pages.filter(p => p.status === 'done')) {
    const c = p.preview;
    await fetch(`/__save?name=${name}-p${p.num}.png`, { method: 'POST', body: c.toDataURL('image/png') }).catch(() => {});
  }
  const r = await fetch(`/__save?name=${name}.json`, { method: 'POST', body: JSON.stringify(payload, null, 1) });
  return r.status;
}
window.__readflow = { state, openUrl, runSelected: () => runOcr(), setRanges, exportPages, buildBody, ocrAndSave };

// ---------- Step 1: open ----------
const drop = $('#drop');
$('#choosePdf').onclick = (e) => { e.stopPropagation(); $('#pdfFile').click(); };
drop.onclick = () => $('#pdfFile').click();
drop.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#pdfFile').click(); } };
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
drop.ondragleave = () => drop.classList.remove('over');
drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) openFile(f); else setStatus($('#loadStatus'), 'ファイルを受け取れませんでした。「PDFを選ぶ」から選んでください。', true); };
$('#pdfFile').onchange = (e) => {
  const f = e.target.files?.[0]; e.target.value = '';
  if (f) openFile(f); else setStatus($('#loadStatus'), 'ファイルが選ばれませんでした。もう一度「PDFを選ぶ」を押してください。', true);
};

// Yes/no question shown in the page. Resolves true for the first button.
function ask(message, yes = 'はい', no = 'キャンセル') {
  return new Promise((resolve) => {
    const dlg = $('#askDlg');
    $('#askMsg').textContent = message; $('#askYes').textContent = yes; $('#askNo').textContent = no;
    const done = (v) => { dlg.close(); $('#askYes').onclick = $('#askNo').onclick = dlg.oncancel = null; resolve(v); };
    $('#askYes').onclick = () => done(true);
    $('#askNo').onclick = () => done(false);
    dlg.oncancel = (e) => { e.preventDefault(); done(false); };
    dlg.showModal(); $('#askNo').focus();
  });
}

function setStatus(el, msg, error = false) { el.textContent = msg; el.classList.toggle('error', error); }

// Stage 1 (selecting) and 2 (reading the bytes) are checked here; parsing is in openData.
async function openFile(file) {
  const st = $('#loadStatus');
  const named = /\.pdf$/i.test(file.name || ''), typed = file.type === 'application/pdf';
  if (!named && !typed && file.type) return setStatus(st, `PDFファイルを選んでください（選ばれたファイル: ${file.name || '名前なし'}）。`, true);
  if (file.size === 0) return setStatus(st, `「${file.name}」は空のファイル（0バイト）です。iCloudなどにある場合は、一度ダウンロードしてから選び直してください。`, true);
  if (file.size > 80 * 1024 * 1024) return setStatus(st, '80MBを超えるPDFは扱えません。必要なページだけのPDFにしてください。', true);
  setStatus(st, `「${file.name}」を読み込んでいます…`);
  let data;
  try {
    data = new Uint8Array(await readFileBytes(file));
  } catch (err) {
    console.error('PDF read failed:', err);
    return setStatus(st, `ファイルを読み込めませんでした（${err?.name || 'Error'}: ${err?.message || err}）。iCloudやほかのアプリにあるファイルは、一度「ファイル」アプリに保存してから選び直してください。`, true);
  }
  // A real PDF starts with "%PDF-" (within the first 1 KB). Catches renamed or non-PDF files early.
  const head = String.fromCharCode(...data.subarray(0, Math.min(1024, data.length)));
  if (!head.includes('%PDF-')) return setStatus(st, `「${file.name}」はPDFではないようです（中身がPDFの形式ではありません）。PDFファイルを選んでください。`, true);
  try { await openData(data, file.name || 'PDF'); }
  catch (err) { console.error('PDF open failed (unexpected):', err); setStatus(st, pdfOpenError(err), true); }
}
// file.arrayBuffer() is missing in some older iOS versions; FileReader works everywhere.
function readFileBytes(file) {
  if (typeof file.arrayBuffer === 'function') return file.arrayBuffer();
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error('FileReader failed'));
    r.readAsArrayBuffer(file);
  });
}
// Readable Japanese for errors thrown while pdf.js opens a document.
function pdfOpenError(err) {
  const name = err?.name || '', msg = err?.message || String(err);
  if (/Password/i.test(name) || /password/i.test(msg)) return 'パスワード付きPDFは開けません。パスワードを外したPDFを選んでください。';
  if (/empty|zero bytes/i.test(msg)) return 'PDFの中身が空です。ファイルを確認してください。';
  if (/InvalidPDF/i.test(name) || /Invalid PDF/i.test(msg)) return 'PDFを読み取れませんでした。ファイルが壊れているか、PDFの形式ではありません。別の方法で保存し直したPDFを試してください。';
  if (/MissingPDF/i.test(name)) return 'PDFが見つかりませんでした。';
  return `PDFを開けませんでした（${name ? name + ': ' : ''}${msg}）。ファイルが壊れていないか確認してください。`;
}
async function openUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  await openData(new Uint8Array(await res.arrayBuffer()), decodeURIComponent(url.split('/').pop()));
}

// A scanner's invisible OCR layer (text render mode 3 over one full-page image) or a layer whose
// glyph widths are bogus (~1 em per Latin letter). Such text is re-read with Tesseract by default:
// on the Keio 2026 sample the repaired layer still had 2–7% word errors, Tesseract 0–2%.
const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
async function scanOcrSignals(page, tc) {
  const vp = page.getViewport({ scale: 1 }), area = vp.width * vp.height;
  const { OPS } = pdfjs, ol = await page.getOperatorList();
  const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter(x => x != null));
  let ctm = [1, 0, 0, 1, 0, 0], mode = 0, glyphs = 0, invisible = 0, imgCover = 0;
  const stack = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], a = ol.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, mode]);
    else if (fn === OPS.restore) [ctm, mode] = stack.pop() || [ctm, mode];
    else if (fn === OPS.transform) ctm = mul(ctm, a);
    else if (fn === OPS.setTextRenderingMode) mode = a[0];
    else if (fn === OPS.showText || fn === OPS.showSpacedText) {
      const g = a[0].filter(x => x && typeof x === 'object' && x.unicode && x.unicode.trim()).length;
      glyphs += g; if ((mode & 3) === 3) invisible += g;
    } else if (IMG.has(fn)) imgCover = Math.max(imgCover, Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / area);
  }
  const lat = tc.items.filter(it => /^[A-Za-z]+$/.test(it.str) && it.transform[0] > 0);
  const per = lat.map(it => it.width / (it.str.length * Math.hypot(it.transform[0], it.transform[1]))).sort((x, y) => x - y);
  const wPerEm = per.length ? per[per.length >> 1] : 0;
  const scannerOcr = glyphs >= 20 && invisible / glyphs >= 0.9 && imgCover >= 0.8;
  const badGeometry = lat.length >= 50 && wPerEm > 0.85;
  return scannerOcr || badGeometry;
}
let wordChecker = null;
async function getWordChecker() {
  if (!wordChecker) { try { wordChecker = makeWordChecker(await loadVocab()); } catch { wordChecker = null; } }
  return wordChecker;
}

async function openData(data, name) {
  const st = $('#loadStatus');
  const token = ++state.loadToken;            // a newer open makes every await below stale
  if (state.running) await cancelRun();
  if (state.worker) { await state.worker.terminate().catch(() => {}); state.worker = null; }
  state.task?.destroy();                       // pdf.js frees a document through its loading task
  Object.assign(state, { task: null, pdf: null, fileName: name, pages: [], selected: new Set(), active: null, region: null });
  $('#s2').hidden = true; $('#s3').hidden = true; $('#progressBox').hidden = true;
  $('#thumbs').textContent = ''; $('#pageLog').textContent = ''; $('#meterAll').style.width = '0';
  $('#ranges').value = ''; $('#rangeInfo').textContent = ''; $('#runOcr').disabled = true;
  setStatus(st, `「${name}」を読み込んでいます…`);
  let pdf, task;
  try {
    task = pdfjs.getDocument({
      data,
      wasmUrl: abs('vendor/pdfjs/wasm/'),
      cMapUrl: abs('vendor/pdfjs/cmaps/'), cMapPacked: true,
      standardFontDataUrl: abs('vendor/pdfjs/standard_fonts/'),
      iccUrl: abs('vendor/pdfjs/iccs/'),
    });
    pdf = await task.promise;
    if (token !== state.loadToken) { task.destroy(); return; }
    $('#s2').hidden = false;
    const thumbs = $('#thumbs');
    if (!pdf.numPages) throw Object.assign(new Error('ページがありません'), { name: 'InvalidPDFException' });
    const pages = [], pageErrors = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      setStatus(st, `ページを確認しています… ${n} / ${pdf.numPages}`);
      // Stage 3 (parsing) is per page: one unreadable page must not stop the whole PDF.
      let page = null, vp = null, raw = '', en = 0, bodyWords = 0, scanned = false, textError = null;
      try {
        page = await pdf.getPage(n);
        vp = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        raw = tc.items.map(i => i.str).join('');
        // Count words on rebuilt lines (items can be single glyphs), and only lines that would be kept
        // as passage text, so question pages are not preselected.
        if (raw.replace(/\s/g, '').length >= 20) {
          scanned = await scanOcrSignals(page, tc);
          const lines = linesFromTextContent(tc.items, vp, { isWord: await getWordChecker() });
          en = wordCount(lines.map(l => l.text).join(' ').replace(/[^\x00-\x7f]/g, ' '));
          bodyWords = wordCount(classifyLines(stripMarginNumbers(lines), vp.height).filter(l => l.include).map(l => l.text).join(' '));
        }
      } catch (err) {
        if (token !== state.loadToken) { task.destroy(); return; }
        console.error(`PDF page ${n}: text analysis failed`, err);
        textError = err; en = 0; bodyWords = 0; scanned = false;
        pageErrors.push(n);
        if (!page) {                                // the page itself could not be read: list it, but it cannot be selected
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'thumb'; b.disabled = true; b.dataset.n = n;
          b.innerHTML = `<span class="thumb-err">読み取れないページ</span><span>${n}</span><span class="tag">エラー: ${escapeHtml(err?.message || String(err)).slice(0, 80)}</span>`;
          thumbs.append(b);
          pages.push({ num: n, textWords: 0, bodyWords: 0, hasText: false, scanned: false, jp: false, status: 'error', lines: [], text: '', dirty: false, broken: true });
          continue;
        }
      }
      const p = { num: n, textWords: en, bodyWords, hasText: en >= 20, scanned, jp: hasJapanese(raw), status: 'idle', lines: [], text: '', dirty: false };
      // Stage 4 (display): a failed thumbnail shows a placeholder instead of stopping the load.
      let img = '';
      try {
        const tv = page.getViewport({ scale: 150 / vp.width });
        const c = document.createElement('canvas'); c.width = Math.ceil(tv.width); c.height = Math.ceil(tv.height);
        await page.render({ canvas: c, viewport: tv, intent: 'print' }).promise; // 'print' avoids requestAnimationFrame, which stalls in background tabs
        img = `<img alt="${n}ページ" src="${c.toDataURL('image/jpeg', .7)}">`;
      } catch (err) {
        console.error(`PDF page ${n}: thumbnail failed`, err);
        img = `<span class="thumb-err">${n}ページ（縮小画像を作れませんでした）</span>`;
      }
      try { page.cleanup(); } catch { /* ignore */ }
      if (token !== state.loadToken) { task.destroy(); return; }
      pages.push(p);
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'thumb'; b.dataset.n = n;
      b.setAttribute('aria-pressed', 'false');
      const tag = textError ? '文字データを読めませんでした → OCR' : !p.hasText ? '画像のみ → OCR' : p.scanned ? `スキャンの文字データ ${en}語 → OCR` : `文字データあり ${en}語`;
      b.innerHTML = `${img}<span>${n}</span><span class="tag ${p.hasText && !p.scanned ? 'text' : ''}">${tag}</span>`;
      b.onclick = () => { if (!state.pdf) return; state.selected.has(n) ? state.selected.delete(n) : state.selected.add(n); syncSelection(); };
      thumbs.append(b);
    }
    // Publish the document only once every page is known, so ranges and runs never see a half-loaded file.
    state.pdf = pdf; state.task = task; state.pages = pages;
    const textPages = pages.filter(p => p.hasText && !p.scanned).length, scanPages = pages.filter(p => p.hasText && p.scanned).length;
    setStatus(st, `${pdf.numPages}ページを読み込みました。文字データのあるページ: ${textPages}、スキャンに付いた文字データのページ: ${scanPages}、画像だけのページ: ${pdf.numPages - textPages - scanPages}。`
      + (scanPages ? ' スキャンに付いた文字データは語の区切りや文字の順番が崩れていることが多いため、標準ではこの端末でOCRし直します（OCRの設定で「スキャンの文字データも使う」を選ぶと速く読めます）。' : '')
      + (pageErrors.length ? ` ${pageErrors.join('・')}ページは文字データを読めなかったため、OCRで読み取ります${pages.some(p => p.broken) ? '（ページ自体を開けなかったものは選べません）' : ''}。` : ''));
    // Preselect pages with substantial English passage text (questions and Japanese excluded).
    pages.filter(p => p.bodyWords >= 80).forEach(p => state.selected.add(p.num));
    syncSelection();
    markStep(2);
    $('#s2').scrollIntoView();
  } catch (err) {
    if (token !== state.loadToken) return;
    console.error('PDF open failed:', err);
    try { task?.destroy(); } catch { /* ignore */ }
    $('#s2').hidden = true;
    setStatus(st, pdfOpenError(err), true);
  }
}

function setRanges(s) { $('#ranges').value = s; $('#ranges').dispatchEvent(new Event('input')); }
$('#ranges').oninput = () => {
  const v = $('#ranges').value;
  if (!state.pdf) return;
  try {
    const nums = v.trim() ? parseRanges(v, state.pdf.numPages) : [];
    const broken = nums.filter(n => state.pages[n - 1]?.broken);
    state.selected = new Set(nums.filter(n => !state.pages[n - 1]?.broken)); syncSelection(false);
    if (broken.length) { $('#rangeInfo').textContent += `（${broken.join('・')}ページは開けないため除きました）`; }
  }
  catch (e) { $('#rangeInfo').textContent = e.message; $('#rangeInfo').classList.add('err'); $('#runOcr').disabled = true; }
};
function syncSelection(writeInput = true) {
  const sel = [...state.selected].sort((a, b) => a - b);
  if (writeInput) $('#ranges').value = formatRanges(sel);
  document.querySelectorAll('.thumb').forEach(t => { const on = state.selected.has(+t.dataset.n); t.classList.toggle('sel', on); t.setAttribute('aria-pressed', on); });
  const ocr = sel.filter(n => !usesText(state.pages[n - 1])).length;
  $('#rangeInfo').classList.remove('err');
  $('#rangeInfo').textContent = sel.length ? `${sel.length}ページ選択（OCR ${ocr}ページ・目安 ${Math.ceil(ocr * 25 / 60)}分以内）` : '';
  $('#runOcr').disabled = !sel.length || state.running;
}
// auto: digital text as is, scanner OCR layers re-read with Tesseract; scantext: any text layer (fast); ocr: always OCR.
const usesText = (p) => p.hasText && ($('#mode').value === 'scantext' || ($('#mode').value === 'auto' && !p.scanned));
$('#mode').onchange = () => syncSelection();

// ---------- Step 2: extract / OCR ----------
$('#runOcr').onclick = () => runOcr();
$('#cancelOcr').onclick = () => cancelRun();
// Tesseract's terminate() never settles a pending recognize(), so every OCR wait is raced against this.
async function cancelRun() {
  state.cancel = true;
  setStatus($('#ocrStatus'), '中止しています…');
  state.cancelReject?.(new Error('cancelled'));
  if (state.worker) { const w = state.worker; state.worker = null; await w.terminate().catch(() => {}); }
}
function cancellable(promise) {
  return Promise.race([promise, new Promise((_, reject) => { state.cancelReject = reject; })]);
}

async function getWorker() {
  if (state.worker) return state.worker;
  if (!window.Tesseract) throw new Error('OCRライブラリ（vendor/tesseract）を読み込めませんでした。ローカルサーバーから開いているか確認してください。');
  const T = window.Tesseract;
  state.worker = await T.createWorker('eng', T.OEM.LSTM_ONLY, {
    // The link version starts the worker from a shim that serves the language data (see that file).
    // Hosts that bundle the English model as base64 text (claude.ai link version, GitHub Pages build)
    // start the worker from a shim that serves it (see that file).
    workerPath: abs(OCR_B64 ? 'app/tess-worker-link.js' : 'vendor/tesseract/worker.min.js'),
    workerBlobURL: !OCR_B64,
    corePath: abs('vendor/tesseract/core'),
    langPath: abs('vendor/tesseract/lang'),
    gzip: true,
    cacheMethod: 'none',
    logger: (m) => state.onProgress?.(m), // routed to the page currently being read
    errorHandler: (e) => console.error('tesseract', e),
  });
  return state.worker;
}

async function runOcr(pageNums) {
  if (state.running || !state.pdf) return 0;
  let nums = pageNums || [...state.selected].sort((a, b) => a - b);
  const edited = nums.filter(n => state.pages[n - 1]?.dirty);
  if (edited.length && !(await ask(`${edited.join(', ')}ページは手で直した本文があります。読み直すと修正が失われます。読み直しますか？`, '読み直す', 'そのページは飛ばす'))) nums = nums.filter(n => !edited.includes(n));
  if (!nums.length) return 0;
  const pdf = state.pdf;
  state.cancel = false; state.running = true;
  document.querySelectorAll('[data-retry]').forEach(b => { b.disabled = true; });
  $('#runOcr').disabled = true; $('#cancelOcr').hidden = false; $('#progressBox').hidden = false;
  const log = $('#pageLog'); const st = $('#ocrStatus');
  if (!pageNums) log.textContent = '';
  const dpi = +$('#dpi').value, psm = $('#psm').value, gray = $('#gray').checked;
  let current = 0, fraction = 0;
  const meter = () => { $('#meterAll').style.width = `${Math.round(((current + fraction) / nums.length) * 100)}%`; };
  const items = new Map();
  for (const n of nums) {
    let li = log.querySelector(`li[data-n="${n}"]`);
    if (!li) { li = document.createElement('li'); li.dataset.n = n; log.append(li); }
    li.innerHTML = `<span>${n}ページ</span><span class="badge">待機中</span>`;
    items.set(n, li);
  }
  let failed = 0;
  for (const n of nums) {
    if (state.cancel || pdf !== state.pdf) break;
    const p = state.pages[n - 1], li = items.get(n);
    const badge = (cls, txt) => { li.querySelector('.badge').className = `badge ${cls}`; li.querySelector('.badge').textContent = txt; };
    try {
      p.status = 'working'; p.error = '';
      fraction = 0; meter();
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const pvScale = PREVIEW_W / base.width;
      if (usesText(p)) {
        badge('', '文字データを抽出中');
        setStatus(st, `${n}ページ: PDFの文字データを抽出しています（OCRなし）`);
        const pv = page.getViewport({ scale: pvScale });
        const canvas = await renderPage(page, pv);
        p.preview = canvas; p.pw = canvas.width; p.ph = canvas.height;
        const tc = await page.getTextContent();
        p.lines = linesFromTextContent(tc.items, pv, { isWord: await getWordChecker() });
        p.source = 'text'; p.conf = 100; p.fromScan = p.scanned;
      } else {
        const scale = dpi / 72;
        const vp = page.getViewport({ scale });
        badge('', `${dpi}dpiで画像化中`);
        setStatus(st, `${n}ページ: ${dpi}dpi（${Math.round(vp.width)}×${Math.round(vp.height)}px）で画像化しています`);
        const canvas = await renderPage(page, vp);
        if (gray) toGray(canvas);
        const small = document.createElement('canvas');
        small.width = Math.round(base.width * pvScale); small.height = Math.round(base.height * pvScale);
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
        p.preview = small; p.pw = small.width; p.ph = small.height;
        state.onProgress = (m) => {
          if (m.status === 'recognizing text' && p.status === 'working') { fraction = m.progress || 0; badge('', `OCR中 ${Math.round(fraction * 100)}%`); setStatus(st, `${n}ページ: 英文を認識しています ${Math.round(fraction * 100)}%（${nums.indexOf(n) + 1} / ${nums.length}ページ目）`); meter(); }
          else if (/load|initializ/i.test(m.status)) setStatus(st, `OCRエンジンを準備しています（端末内）: ${m.status} ${m.progress != null ? Math.round(m.progress * 100) + '%' : ''}`);
        };
        const worker = await cancellable(getWorker());
        await worker.setParameters({ tessedit_pageseg_mode: psm, user_defined_dpi: String(dpi), preserve_interword_spaces: '0' });
        const t0 = performance.now();
        const { data } = await cancellable(worker.recognize(canvas, {}, { text: true, blocks: true }));
        p.ocrMs = Math.round(performance.now() - t0);
        p.lines = linesFromTesseract(data, scale / pvScale);
        p.conf = Math.round(data.confidence);
        p.source = 'ocr';
        canvas.width = canvas.height = 0;
      }
      page.cleanup();
      p.lines = classifyLines(stripMarginNumbers(p.lines), p.ph);
      rebuildPageText(p);
      p.status = 'done';
      const q = quality(p);
      badge(q.cls, `${p.source === 'text' ? '文字データ' : 'OCR'} ${q.label}`);
      li.insertAdjacentHTML('beforeend', `<span class="hint">${q.summary}</span>`);
    } catch (err) {
      if (state.cancel || pdf !== state.pdf) { p.status = p.text ? 'done' : 'idle'; badge('bad', '中止'); break; }
      console.error(err);
      failed++;
      p.status = 'error'; p.error = err.message || String(err);
      badge('bad', '失敗');
      li.insertAdjacentHTML('beforeend', `<span class="err">${escapeHtml(p.error)}</span> <button class="btn sm" data-retry="${n}">このページを再試行</button>`);
      li.querySelector('[data-retry]').onclick = (e) => { e.target.disabled = true; runOcr([n]); };
      if (/memory|allocation/i.test(p.error)) li.insertAdjacentHTML('beforeend', '<span class="hint">メモリ不足の可能性: 解像度を300dpi以下にして再試行してください。</span>');
      if (state.worker && /worker|core|wasm/i.test(p.error)) { await state.worker.terminate().catch(() => {}); state.worker = null; }
    }
    current++; fraction = 0; meter();
  }
  state.running = false; state.cancelReject = null;
  if (pdf !== state.pdf) return 0;           // a different PDF was opened meanwhile
  document.querySelectorAll('[data-retry]').forEach(b => { b.disabled = false; });
  const done = nums.filter(n => state.pages[n - 1].status === 'done').length;
  setStatus(st, state.cancel ? `中止しました（${done}ページ完了）。` : `読み取り完了: ${done}ページ${failed ? `、失敗 ${failed}ページ（再試行できます）` : ''}。次に手順3で原本と見比べてください。`, failed > 0);
  $('#cancelOcr').hidden = true; syncSelection(false);
  if (state.pages.some(p => p.status === 'done' && state.selected.has(p.num))) { showReview(); markStep(3); }
  return done;
}

async function renderPage(page, viewport) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: false });
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, viewport, intent: 'print', background: '#ffffff' }).promise;
  return canvas;
}
function toGray(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height), d = img.data;
  for (let i = 0; i < d.length; i += 4) { const y = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000; d[i] = d[i + 1] = d[i + 2] = y; }
  ctx.putImageData(img, 0, 0);
}

function quality(p) {
  const words = p.lines.filter(l => l.include).flatMap(l => l.words);
  if (p.source === 'text' && p.fromScan) {
    // Scanner OCR text in the PDF: characters mostly right, but word breaks often are not.
    const q = textLayerQuality(p.text, wordChecker);
    const pct = q.ratio == null ? null : Math.round(q.ratio * 100);
    return { cls: 'mid', label: '要確認', summary: `${wordCount(p.text)}語。スキャンに付いた文字データを補正して使用（辞書にある語 ${pct ?? '-'}%）。語の区切りの誤りが残りやすいので、原本と見比べてください。正確さが必要なら「OCRの設定」で自動に戻して読み直してください`, low: 0 };
  }
  if (p.source === 'text') return { cls: 'good', label: '抽出済み', summary: `${wordCount(p.text)}語。文字データをそのまま使用（認識誤りなし。ただし改行・記号の崩れは確認）`, low: 0 };
  const low = words.filter(w => w.conf < LOW_CONF).length;
  const mean = words.length ? Math.round(words.reduce((s, w) => s + w.conf, 0) / words.length) : 0;
  const ratio = words.length ? low / words.length : 1;
  const cls = !words.length ? 'bad' : ratio < 0.03 && mean >= 88 ? 'good' : ratio < 0.1 && mean >= 75 ? 'mid' : 'bad';
  const label = { good: '良好', mid: '要確認', bad: '要注意' }[cls];
  const excluded = p.lines.filter(l => !l.include).length;
  return { cls, label, low, mean, summary: `本文候補 ${words.length}語・平均信頼度 ${mean}%・低信頼の語 ${low}（${Math.round(ratio * 100)}%）・除外候補 ${excluded}行・${(p.ocrMs / 1000).toFixed(1)}秒` };
}

// ---------- Step 3: review ----------
function showReview() {
  $('#s3').hidden = false;
  const tabs = $('#pageTabs'); tabs.textContent = '';
  const done = state.pages.filter(p => p.status === 'done' && state.selected.has(p.num));
  for (const p of done) {
    const b = document.createElement('button');
    b.role = 'tab'; b.dataset.n = p.num;
    b.innerHTML = `${p.num}ページ<span class="dot ${quality(p).cls}"></span>`;
    b.onclick = () => selectPage(p.num);
    tabs.append(b);
  }
  if (done.length) selectPage(state.active && done.some(p => p.num === state.active) ? state.active : done[0].num);
}

function selectPage(n) {
  state.active = n; state.region = null;
  $('#regionExclude').disabled = $('#regionInclude').disabled = true;
  document.querySelectorAll('#pageTabs button').forEach(b => b.setAttribute('aria-selected', +b.dataset.n === n));
  const p = state.pages[n - 1];
  const q = quality(p);
  $('#quality').innerHTML = `<span class="badge ${q.cls}">${p.source === 'text' ? '文字データ' : 'OCR'} ${q.label}</span><span>${q.summary}</span>`;
  renderLines(p); drawPreview(p);
  $('#pageText').value = p.text;
  updatePageInfo(p);
}

function renderLines(p) {
  const box = $('#lines'); box.textContent = '';
  p.lines.forEach((l, i) => {
    const row = document.createElement('div');
    row.className = `line${l.include ? '' : ' off'}`; row.dataset.i = i;
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = l.include;
    cb.setAttribute('aria-label', `${i + 1}行目を本文に含める`);
    cb.onchange = async () => { if (!(await okToRebuild(p))) { cb.checked = l.include; return; } l.include = cb.checked; l.reason = cb.checked ? '' : '手動'; changed(p); };
    const txt = document.createElement('span'); txt.className = 'txt';
    txt.innerHTML = l.words.map(w => (w.conf < LOW_CONF && p.source === 'ocr') ? `<span class="low" title="信頼度 ${Math.round(w.conf)}%">${escapeHtml(w.text)}</span>` : escapeHtml(w.text)).join(' ');
    const right = document.createElement('span');
    right.innerHTML = `<span class="why">${escapeHtml(l.reason || '')}</span> `;
    const cut = document.createElement('button'); cut.className = 'cut'; cut.textContent = 'ここから下を外す';
    cut.onclick = async () => { if (!(await okToRebuild(p))) return; p.lines.forEach((x, j) => { if (j >= i) { x.include = false; x.reason = '手動（以下）'; } }); changed(p); };
    right.append(cut);
    txt.onmouseenter = () => drawPreview(p, i);
    row.append(cb, txt, right); box.append(row);
  });
}
// Line-selection changes rebuild the page text, so ask first when it was edited by hand.
async function okToRebuild(p) {
  if (!p.dirty) return true;
  if (!(await ask('このページの本文を手で直した内容は、行の選択から作り直すと失われます。作り直しますか？', '作り直す'))) return false;
  p.dirty = false;
  return true;
}
function changed(p) {
  rebuildPageText(p); renderLines(p); drawPreview(p); $('#pageText').value = p.text; updatePageInfo(p);
  const q = quality(p); $('#quality').innerHTML = `<span class="badge ${q.cls}">${p.source === 'text' ? '文字データ' : 'OCR'} ${q.label}</span><span>${q.summary}</span>`;
}
function rebuildPageText(p) { const r = linesToText(p.lines); p.text = r.text; p.notes = r.notes; p.startsPara = r.startsPara; p.dirty = false; }
$('#rebuildPage').onclick = async () => { const p = state.pages[state.active - 1]; if (!p || !(await okToRebuild(p))) return; changed(p); };
$('#pageText').oninput = () => { const p = state.pages[state.active - 1]; p.text = $('#pageText').value; p.dirty = true; updatePageInfo(p); };

function updatePageInfo(p) {
  const hy = (p.notes || []).filter(n => n.type.startsWith('hyphen'));
  $('#pageTextInfo').textContent = `${wordCount(p.text)}語${p.dirty ? '・手修正あり' : ''}${hy.length ? `・行末ハイフンを ${hy.length}か所つないだ（${hy.map(h => h.word).join(', ')}）` : ''}`;
  const sus = suspiciousTokens(p.text);
  const low = p.source === 'ocr' ? p.lines.filter(l => l.include).flatMap(l => l.words.filter(w => w.conf < LOW_CONF)) : [];
  const box = $('#suspects'); box.textContent = '';
  if (!sus.length && !low.length) { box.innerHTML = '<span class="hint">自動チェックで気になる語はありません。それでも原本と1行ずつ見比べてください。</span>'; return; }
  box.append('要確認の語（クリックで本文と原本の位置を表示）: ');
  const seen = new Set();
  for (const w of low) {
    const b = document.createElement('button'); b.textContent = w.text; b.title = `信頼度 ${Math.round(w.conf)}%`;
    b.onclick = () => { selectInText(w.text); drawPreview(p, -1, w.bbox); };
    box.append(b);
  }
  for (const s of sus) {
    if (seen.has(s.word)) continue; seen.add(s.word);
    const b = document.createElement('button'); b.textContent = s.word; b.title = s.why;
    b.onclick = () => selectInText(s.word, s.index);
    box.append(b);
  }
}
function selectInText(word, at) {
  const ta = $('#pageText');
  let i = at ?? ta.value.indexOf(word, (ta.selectionEnd || 0));
  if (i < 0) i = ta.value.indexOf(word);
  if (i < 0) return;
  ta.focus(); ta.setSelectionRange(i, i + word.length);
  const before = ta.value.slice(0, i).split('\n').length;
  ta.scrollTop = Math.max(0, (before - 3) * 24);
}

// Preview with line boxes and drag-to-select region.
const pv = $('#pv');
function drawPreview(p, hi = -1, wordBox = null) {
  {
    pv.width = p.pw; pv.height = p.ph;
    const ctx = pv.getContext('2d');
    ctx.drawImage(p.preview, 0, 0);
    p.lines.forEach((l, i) => {
      const b = l.bbox;
      if (!l.include) { ctx.fillStyle = 'rgba(200,50,60,.16)'; ctx.fillRect(b.x0 - 2, b.y0 - 1, b.x1 - b.x0 + 4, b.y1 - b.y0 + 2); }
      ctx.strokeStyle = i === hi ? '#2d6cdf' : l.include ? 'rgba(47,125,91,.55)' : 'rgba(200,50,60,.55)';
      ctx.lineWidth = i === hi ? 3 : 1;
      ctx.strokeRect(b.x0 - 2, b.y0 - 1, b.x1 - b.x0 + 4, b.y1 - b.y0 + 2);
      if ($('#showLow').checked && p.source === 'ocr' && l.include) for (const w of l.words) if (w.conf < LOW_CONF) { ctx.fillStyle = 'rgba(246,226,122,.55)'; ctx.fillRect(w.bbox.x0, w.bbox.y0, w.bbox.x1 - w.bbox.x0, w.bbox.y1 - w.bbox.y0); }
    });
    if (wordBox) { ctx.strokeStyle = '#2d6cdf'; ctx.lineWidth = 3; ctx.strokeRect(wordBox.x0 - 4, wordBox.y0 - 4, wordBox.x1 - wordBox.x0 + 8, wordBox.y1 - wordBox.y0 + 8); const sc = $('#preview'); sc.scrollTop = wordBox.y0 * (pv.clientWidth / pv.width) - 120; }
    if (state.region) { const r = state.region; ctx.setLineDash([8, 6]); ctx.strokeStyle = '#2d6cdf'; ctx.lineWidth = 2; ctx.strokeRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); ctx.setLineDash([]); }
  }
}
$('#zoom').oninput = () => { pv.style.width = `${$('#zoom').value}%`; };
$('#showLow').onchange = () => { const p = state.pages[state.active - 1]; if (p) drawPreview(p); };
let dragStart = null;
const toCanvas = (e) => { const r = pv.getBoundingClientRect(); return { x: (e.clientX - r.left) * pv.width / r.width, y: (e.clientY - r.top) * pv.height / r.height }; };
pv.onpointerdown = (e) => { dragStart = toCanvas(e); pv.setPointerCapture(e.pointerId); };
pv.onpointermove = (e) => {
  if (!dragStart) return;
  const c = toCanvas(e);
  state.region = { x0: Math.min(dragStart.x, c.x), y0: Math.min(dragStart.y, c.y), x1: Math.max(dragStart.x, c.x), y1: Math.max(dragStart.y, c.y) };
  drawPreview(state.pages[state.active - 1]);
};
pv.onpointerup = async (e) => {
  if (!dragStart) return;
  const p = state.pages[state.active - 1];
  const c = toCanvas(e);
  if (Math.abs(c.x - dragStart.x) < 6 && Math.abs(c.y - dragStart.y) < 6) {
    // A click toggles the line under the pointer.
    state.region = null;
    const i = p.lines.findIndex(l => c.x >= l.bbox.x0 - 4 && c.x <= l.bbox.x1 + 4 && c.y >= l.bbox.y0 - 3 && c.y <= l.bbox.y1 + 3);
    if (i >= 0 && await okToRebuild(p)) { p.lines[i].include = !p.lines[i].include; p.lines[i].reason = p.lines[i].include ? '' : '手動'; changed(p); document.querySelector(`.line[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' }); }
  }
  dragStart = null;
  $('#regionExclude').disabled = $('#regionInclude').disabled = !state.region;
};
pv.onpointercancel = () => { dragStart = null; };
// Touch screens: a finger drag on the preview scrolls (mobile.css: touch-action pan) unless 「範囲を選ぶ」 is on,
// which sets touch-action:none on the canvas so the drag draws the range. A tap toggles a line either way.
$('#regionMode').onclick = () => {
  const on = $('#regionMode').getAttribute('aria-pressed') !== 'true';
  $('#regionMode').setAttribute('aria-pressed', on);
  pv.classList.toggle('selecting', on);
};
async function applyRegion(include) {
  const p = state.pages[state.active - 1], r = state.region; if (!p || !r || !(await okToRebuild(p))) return;
  p.lines.forEach(l => { const cx = (l.bbox.x0 + l.bbox.x1) / 2, cy = (l.bbox.y0 + l.bbox.y1) / 2; if (cx >= r.x0 && cx <= r.x1 && cy >= r.y0 && cy <= r.y1) { l.include = include; l.reason = include ? '' : '手動（範囲）'; } });
  state.region = null; $('#regionExclude').disabled = $('#regionInclude').disabled = true;
  changed(p);
}
$('#regionExclude').onclick = () => applyRegion(false);
$('#regionInclude').onclick = () => applyRegion(true);

// ---------- Step 4: body ----------
$('#toBody').onclick = async () => { if (await buildBody()) $('#s4').scrollIntoView(); };
async function buildBody(force = false) {
  const pages = state.pages.filter(p => p.status === 'done' && state.selected.has(p.num));
  const body = joinPages(pages.map(p => p.text), pages.map(p => p.num), pages.map(p => p.startsPara));
  if (!force && $('#body').value.trim() && $('#body').value !== body && !(await ask('手順4の本文を、ページごとの確認結果で置き換えますか？', '置き換える'))) return;
  // Lines left out of the passage (questions, choices) are kept only to find answer choices for blanks.
  state.questionText = pages.map(p => excludedText(p.lines)).filter(Boolean).join('\n');
  $('#body').value = body; bodyChanged(); markStep(4);
  return body;
}
$('#body').oninput = bodyChanged;
function bodyChanged() {
  const t = $('#body').value;
  state.fills = adjustFills(state.bodyPrev || '', t, state.fills);   // edits move (or drop) the filled answers
  state.bodyPrev = t;
  renderBlanks();
  const m = findMarkers(t);
  const jp = hasJapanese(t);
  $('#bodyInfo').textContent = `${wordCount(t)}語・${t.split(/\n\s*\n/).filter(s => s.trim()).length}段落${jp ? '・日本語が残っています' : ''}`;
  $('#bodyInfo').classList.toggle('err', jp);
  $('#dropMarkers').hidden = !m.length;
  $('#markers').innerHTML = m.length ? `設問用の記号 ${m.length}個: ` + m.map(x => `<mark>${escapeHtml(x.text)}</mark>`).join(' ') + '（空所記号は答えの語に書き換えると読みやすくなります）' : '';
  save();
}
$('#dropMarkers').onclick = () => { $('#body').value = removeMarkers($('#body').value); bodyChanged(); };

// allowAi: with 区切りの作り方 AI (app/slsrc.js), Claude may be asked (only from the 「区切りを提案する」 click);
// otherwise only AI slashes already stored for these words and this level are used.
async function proposeSlashes({ scroll = true, confirm = '手で直した区切りを、新しく提案する区切りで置き換えますか？', allowAi = false } = {}) {
  const t = $('#body').value.trim();
  if (wordCount(t) < 5) { $('#bodyInfo').textContent = '英文を5語以上入れてください。'; $('#bodyInfo').classList.add('err'); return false; }
  if (state.slashed && state.slashEdited && !(await ask(confirm, '置き換える'))) return false;
  state.slashed = chunkText(t, $('#level').value); state.slashEdited = false;
  closeSlashEditor();
  $('#s5').hidden = false; renderReader(); renderLog(); markStep(5); save();
  if (scroll) $('#s5').scrollIntoView();
  slSrcAfterPropose({ allowCall: allowAi });    // 区切りの作り方 AI: stored / new AI slashes on top
  return true;
}
$('#makeSlash').onclick = () => proposeSlashes({ allowAi: true });
// Used by app/slsrc.js to put new slashes on screen (the words never change).
function setSlashed(text, edited) {
  state.slashed = text; state.slashEdited = !!edited;
  closeSlashEditor(); renderReader(); renderLog(); save();
}

// ---------- 空欄補充 (fill in the blanks) ----------
// Answers go into the body text itself, so slashes, 構文マーク and translations are rebuilt from the
// completed sentences exactly as after a hand edit. The filled words are remembered (state.fills) so the
// reader and the print can mark them and 「元に戻す」 can put the original blanks back.
const draftOf = (id) => state.blankDraft[id] || (state.blankDraft[id] = { value: '' });
function currentChoices(blanks) {
  return { ...parseChoices(state.questionText, blanks), ...parseChoices(state.choicePaste, blanks) };
}
// A typed choice key ("b", "ウ", "3") becomes the choice's text; a key with no known choices is flagged.
function answerFor(b, d) {
  let v = (d?.value || '').trim();
  if (!v) return { v: '' };
  const c = resolveChoice(state.choices[b.label], v);
  if (c) return { v: c.text, choice: c };
  if (isChoiceSymbol(v) && !d.force) return { v, flag: true };
  return { v };
}
function renderBlanks() {
  const t = $('#body').value;
  const blanks = state.blanks = findBlanks(t);
  const choices = state.choices = currentChoices(blanks);
  $('#blanks').hidden = !blanks.length && !state.fills.length;
  const withChoices = blanks.filter(b => choices[b.label]?.length).length;
  $('#blankCount').textContent = `${blanks.length}か所${withChoices ? `（選択肢あり ${withChoices}）` : ''}${state.fills.length ? `・入れた語 ${state.fills.length}` : ''}`;
  const focus = document.activeElement?.closest?.('#blankList') ? { id: document.activeElement.dataset.id, key: document.activeElement.dataset.key ?? null, input: document.activeElement.tagName === 'INPUT' } : null;
  const list = $('#blankList'); list.textContent = '';
  for (const b of blanks) list.append(blankRow(b, choices[b.label]));
  if (focus) {
    const sel = focus.input ? `input[data-id="${CSS.escape(focus.id)}"]` : `button[data-id="${CSS.escape(focus.id)}"][data-key="${CSS.escape(focus.key ?? '')}"]`;
    list.querySelector(sel)?.focus();
  }
  $('#blankFill').disabled = !blanks.length;
  $('#blankBulkApply').disabled = !blanks.length;
  $('#blankUndo').hidden = !state.fills.length;
  $('#blankAi').hidden = !blanks.length;
  $('#blankAi').textContent = `${aiName()}で空欄を解く`; $('#blankAi').title = aiWhyNot();
  $('#blankAiNote').hidden = !blanks.some(b => state.blankDraft[b.id]?.ai);
  $('#blankFilled').textContent = state.fills.length ? `入れた語（⑤と印刷では点線の下線で示します）: ${state.fills.map(f => `${f.label} → ${f.answer}`).join('、 ')}` : '';
}
function blankRow(b, choices) {
  const d = draftOf(b.id);
  const li = document.createElement('li'); li.className = 'bl-item'; li.dataset.id = b.id;
  const lab = document.createElement('span'); lab.className = 'bl-label'; lab.textContent = b.label;
  const ctx = document.createElement('span'); ctx.className = 'bl-ctx'; ctx.lang = 'en';
  const mk = document.createElement('mark'); mk.textContent = b.raw;
  ctx.append(b.before, mk, b.after);
  const input = document.createElement('input'); input.type = 'text'; input.className = 'bl-input'; input.dataset.id = b.id;
  input.lang = 'en'; input.autocomplete = 'off'; input.spellcheck = false; input.value = d.value || '';
  input.setAttribute('aria-label', `空欄 ${b.label} に入れる語`);
  const tag = document.createElement('span'); tag.className = 'bl-tag';
  const warn = document.createElement('span'); warn.className = 'bl-warn';
  const force = document.createElement('button'); force.type = 'button'; force.className = 'btn sm'; force.textContent = 'この語のまま入れる';
  const row = document.createElement('span'); row.className = 'bl-answer'; row.append(input, tag);
  li.append(lab, ctx, row);
  let group = null;
  if (choices?.length) {
    group = document.createElement('span'); group.className = 'bl-choices'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', `空欄 ${b.label} の選択肢`);
    for (const c of choices) {
      const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'bl-ch'; btn.dataset.id = b.id; btn.dataset.key = c.key;
      if (c.key) { const k = document.createElement('span'); k.className = 'bl-key'; k.textContent = c.key; btn.append(k, ' '); }
      btn.append(c.text);
      btn.onclick = () => {
        const on = draftOf(b.id).value === c.text && !draftOf(b.id).ai;
        state.blankDraft[b.id] = on ? { value: '' } : { value: c.text, pick: c.key };
        refresh(); save();
      };
      group.append(btn);
    }
    li.append(group);
  }
  li.append(warn);
  const refresh = () => {
    const cur = draftOf(b.id), a = answerFor(b, cur);
    input.value = cur.value || '';
    input.classList.toggle('ai', !!cur.ai);
    tag.textContent = cur.ai ? `AI候補${cur.pick ? `（${cur.pick}）` : ''}` : a.choice && a.choice.text !== cur.value ? `→ ${a.choice.text}` : '';
    tag.classList.toggle('ai', !!cur.ai);
    group?.querySelectorAll('.bl-ch').forEach(btn => {
      const c = choices.find(x => x.key === btn.dataset.key);
      const picked = !!a.v && a.v === c?.text;
      btn.setAttribute('aria-pressed', String(picked && !cur.ai));
      btn.classList.toggle('ai-pick', picked && !!cur.ai);
    });
    warn.textContent = '';
    if (a.flag) { warn.append('選択肢の記号ではなく語を入力してください（選択肢が見つかっていません）。'); warn.append(force); }
    $('#blankAiNote').hidden = !state.blanks.some(x => state.blankDraft[x.id]?.ai);
  };
  force.onclick = () => { draftOf(b.id).force = true; refresh(); save(); };
  input.oninput = () => { state.blankDraft[b.id] = { value: input.value }; refresh(); save(); };
  refresh();
  return li;
}
// After the body changed by a fill or an undo, rebuild the slashes when they are already shown.
async function afterBlankChange() {
  if (!state.slashed) return;
  await proposeSlashes({ scroll: false, confirm: '空欄の語に合わせて区切りを作り直します。手で直した区切りは自動提案に置き換わります。よろしいですか？' });
}
function setBody(text, fills) {
  state.fills = fills; state.bodyPrev = text;
  $('#body').value = text; bodyChanged();
}
$('#blankFill').onclick = async () => {
  const t = $('#body').value, blanks = findBlanks(t);
  state.blanks = blanks;
  const answers = {}, flagged = [];
  for (const b of blanks) {
    const a = answerFor(b, state.blankDraft[b.id]);
    if (!a.v) continue;
    if (a.flag) { flagged.push(b.label); continue; }
    answers[b.id] = a.v;
  }
  if (!Object.keys(answers).length) {
    $('#blankInfo').textContent = flagged.length ? `選択肢の記号ではなく語を入力してください（${flagged.join(', ')}）。` : '入れる語がありません。各空欄の欄に語を入力するか、選択肢を選んでください。';
    return;
  }
  const r = fillBlanks(t, answers, { blanks, fills: state.fills });
  // Unlabeled blanks are numbered in order (空欄1, 空欄2…), so carry the drafts of the blanks left over to their new ids.
  const left = blanks.filter(b => !(b.id in answers)), next = findBlanks(r.text), draft = {};
  if (left.length === next.length) left.forEach((b, i) => { if (state.blankDraft[b.id]) draft[next[i].id] = state.blankDraft[b.id]; });
  state.blankDraft = draft;
  setBody(r.text, r.fills);
  $('#blankInfo').textContent = `${r.filled}か所に語を入れました。${flagged.length ? `選択肢の記号のままの空欄（${flagged.join(', ')}）は入れていません。` : ''}${state.slashed ? '区切りを作り直します。' : '「区切りを提案する」で⑤に進めます。'}`;
  await afterBlankChange();
};
$('#blankUndo').onclick = async () => {
  const t = $('#body').value;
  const before = findBlanks(t);
  const u = undoFills(t, state.fills);
  // The restored blanks get back the answers that were in them, the others keep their drafts.
  const seq = [...state.fills.map(f => ({ pos: f.start, d: { value: f.answer } })), ...before.map(b => ({ pos: b.start, d: state.blankDraft[b.id] }))].sort((a, b) => a.pos - b.pos);
  const next = findBlanks(u.text), draft = {};
  if (seq.length === next.length) next.forEach((b, i) => { if (seq[i].d) draft[b.id] = seq[i].d; });
  state.blankDraft = draft;
  setBody(u.text, []);
  $('#blankInfo').textContent = `${u.restored}か所を元の空欄に戻しました。${u.failed ? `${u.failed}か所は入れた後に書き換えられていたため戻せませんでした。` : ''}`;
  await afterBlankChange();
};
$('#blankBulkApply').onclick = () => {
  state.choicePaste = $('#choiceBulk').value;
  const blanks = findBlanks($('#body').value);
  state.choices = currentChoices(blanks);
  const key = parseAnswerKey($('#blankBulk').value);
  const { answers, unmatched } = matchAnswers(blanks, key);
  for (const [id, a] of Object.entries(answers)) {
    const b = blanks.find(x => x.id === id), c = resolveChoice(state.choices[b.label], a);
    state.blankDraft[id] = c ? { value: c.text, pick: c.key } : { value: a };
  }
  renderBlanks(); save();
  const n = Object.keys(answers).length;
  $('#blankInfo').textContent = !$('#blankBulk').value.trim() ? '選択肢を反映しました。'
    : `${n}個の答えを反映しました。${unmatched.length ? `本文に見つからない番号: ${unmatched.join(', ')}。` : ''}${n ? '「空欄に入れる」で本文に入ります。' : ''}`;
};
$('#choiceBulk').oninput = () => { state.choicePaste = $('#choiceBulk').value; renderBlanks(); save(); };
function blankErrorText(code) {
  if (code === 'timeout') return aiTimeoutText();
  if (code === 'invalid_json') return '一部の空欄の答えを読み取れませんでした。もう一度押してください';
  if (code === 'unavailable') return aiUnavailableText();
  const known = providerErrorText(code), fallback = providerErrorText('');
  return known !== fallback && code !== 'refused' ? known : code === 'refused' ? 'この部分は解けませんでした' : '空欄を解けませんでした。もう一度押してください';
}
// Ask the selected AI (Claude / Gemini: app/ai.js) for each paragraph with blanks, after the learner clicks.
// The answers are shown as AI候補 in the inputs; nothing goes into the text until 「空欄に入れる」 is pressed.
$('#blankAi').onclick = async () => {
  const btn = $('#blankAi'), info = $('#blankInfo');
  const t = $('#body').value, blanks = findBlanks(t);
  if (!blanks.length) return;
  btn.disabled = true;
  info.textContent = aiBusyText();
  try {
    if (!(await aiReady())) { info.textContent = blankErrorText('unavailable') + '。'; return; }
    const choices = currentChoices(blanks);
    const ask = (prompt) => {
      const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 90000);
      return Promise.race([
        aiJson(prompt, { modelTier: 'default', signal: ctrl.signal }),
        new Promise((_, reject) => ctrl.signal.addEventListener('abort', () => reject(Object.assign(new Error('timeout'), { code: 'timeout' })))),
      ]).finally(() => clearTimeout(timer));
    };
    const r = await solveBlanks(ask, t, { blanks, choices, onProgress: (d, n) => { info.textContent = `${aiName()}に問い合わせています… ${d} / ${n} 段落`; } });
    // Show the answers only for blanks that are still the same (the text may have been edited meanwhile),
    // and never over an answer the learner typed or picked.
    const now = findBlanks($('#body').value);
    let shown = 0;
    for (const [id, ans] of Object.entries(r.answers)) {
      const b = now.find(x => x.id === id); if (!b) continue;
      const cur = state.blankDraft[id];
      if (cur?.value && !cur.ai) continue;
      state.blankDraft[id] = { value: ans, ai: true, pick: r.picks[id] || null }; shown++;
    }
    renderBlanks(); save();
    const err = r.failed[0] ? blankErrorText(r.failed[0].code) : '';
    info.textContent = `${shown ? `AI候補を ${shown}か所に表示しました。確かめてから「空欄に入れる」を押してください。` : 'AI候補は出ませんでした。'}${err ? ` ${err}。` : ''}`;
  } catch (e) {
    console.error(e);
    info.textContent = blankErrorText(e?.code) + '。';
  } finally { btn.disabled = false; }
};

// ---------- Step 5: reader ----------
function renderReader() {
  const reader = $('#reader');
  const paras = tokensWithBoundaries(state.slashed);
  // Boundaries that the coarse level would also keep (clause-level) stay visible in the "大きな区切りだけ" view
  // (for sentences with AI slashes, the breaks the AI called major: app/slsrc.js).
  const major = majorBreaks(paras);
  const ja = state.ja || 'none';
  const names = ja === 'gloss' ? namesIn(paras.flat().map(t => t.word)) : null;
  const sx = sxPrepare(paras);       // 構文マーク / 品詞 for this render (null while the analysis is loading or off)
  // Words that came from 空欄補充: marked only while the reader's words are exactly the body's words.
  state.fillSet = null;
  if (state.fills.length) {
    const { words, marked } = fillWordIndices($('#body').value, state.fills);
    const rw = paras.flat();
    if (marked.size && words.length === rw.length && words.every((w, i) => w === rw[i].word)) state.fillSet = marked;
  }
  reader.textContent = '';
  reader.dataset.ja = ja;
  state.sentences = []; state.chunks = []; state.ctx = new Map();
  let wi = 0, gi = 0;
  paras.forEach((toks) => {
    const p = document.createElement('p');
    const paraText = toks.map(t => t.word).join(' ');
    let sent = null, sentWords = [], chunkWords = [];
    let unit = null, unitEn = null;   // "区切りごとの訳": English chunk on top, its Japanese right under it
    const openSentence = () => {
      sent = document.createElement('span'); sent.className = 'sent'; sent.dataset.s = state.sentences.length;
      sentWords = []; p.append(sent);
    };
    const openUnit = () => {
      unit = document.createElement('span'); unit.className = 'cu'; unit.dataset.c = state.chunks.length;
      unitEn = document.createElement('span'); unitEn.className = 'cu-en';
      unit.append(unitEn); sent.append(unit);
    };
    const closeChunk = () => {
      if (!chunkWords.length) return;
      const text = chunkWords.join(' ');
      state.chunks.push(text); state.ctx.set(text, paraText); chunkWords = [];
      if (unit) { unit.append(translationBox(text, { compact: true })); unit = unitEn = null; }
    };
    const closeSentence = () => {
      closeChunk();
      const text = sentWords.join(' ');
      state.sentences.push(text); state.ctx.set(text, paraText);
      if (ja === 'full') p.append(sentenceTranslationEl(text));
      sent = null;
    };
    toks.forEach((t, ti) => {
      if (!sent) openSentence();
      if (ja === 'chunk' && !unit) openUnit();
      const gloss = ja === 'gloss' ? glossFor(t.word, { sentenceStart: !sentWords.length, names }) : null;
      const w = document.createElement(gloss ? 'ruby' : 'span');
      const k = wi, dk = sx?.deco[k];
      w.className = 'w'; w.dataset.i = wi++; w.dataset.c = state.chunks.length; w.dataset.word = t.word;
      if (state.fillSet?.has(k)) { w.classList.add('w-fill'); w.title = '空欄に入れた語'; }
      // Clause brackets sit outside the word; a closing bracket goes before trailing punctuation ("temples}.").
      const [core, trail] = dk?.closes.length ? splitPunct(t.word) : [t.word, ''];
      // A word with brackets is wrapped so a bracket never wraps onto a line by itself.
      const hold = dk && (dk.opens.length || dk.closes.length) ? document.createElement('span') : null;
      if (hold) hold.className = 'sx-nb';
      if (dk) {
        for (const m of dk.opens) hold.append(sxBracket(m, true));
        if (dk.subj) w.classList.add('sx-subj');
        if (dk.verb) { w.classList.add('sx-verb'); if (dk.verb.start === k) w.classList.add('sx-vstart'); }
        if (sx.pos) { w.dataset.pos = sx.pos[k] || ''; }
        if (state.sx.sel && k >= state.sx.sel[0] && k <= state.sx.sel[1]) w.classList.add('sx-sel');
      }
      w.append(core);
      if (ja === 'tap' && !chunkWords.length) { w.tabIndex = 0; w.setAttribute('role', 'button'); w.setAttribute('aria-label', `「${t.word}」から始まる区切りの訳を表示`); }
      if (gloss) { const rt = document.createElement('rt'); rt.textContent = gloss.ja; rt.title = `${gloss.lemma}${gloss.level ? `（${gloss.level}）` : ''}`; w.append(rt); }
      if (hold) {
        hold.append(w);
        for (const m of dk.closes) hold.append(sxBracket(m, false));
        if (trail) hold.append(trail);
        (unitEn || sent).append(hold);
      } else (unitEn || sent).append(w);
      sentWords.push(t.word); chunkWords.push(t.word);
      const last = ti === toks.length - 1;
      if (t.sentenceEnd || last) { closeSentence(); if (!last) p.append(' '); return; }
      const g = document.createElement('span');
      const myGap = gi++;
      g.className = `gap${t.slashAfter ? ' on' : ''}${major.has(wi - 1) || /[,;:—–]$/.test(t.word) ? ' major' : ''}`; g.textContent = t.slashAfter ? '/' : ''; // empty when off, so copying the text gives no stray slashes
      g.setAttribute('role', 'button'); g.tabIndex = 0;
      g.setAttribute('aria-label', t.slashAfter ? `「${t.word}」の後の区切りを外す` : `「${t.word}」の後に区切りを入れる`);
      const toggle = () => { t.slashAfter = !t.slashAfter; state.slashed = fromTokens(paras); state.slashEdited = true; renderReader(); save(); reader.querySelectorAll('.gap')[myGap]?.focus(); };
      g.onclick = toggle; g.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
      // The gap sits before the word space; it is zero-width when off. In a chunk unit, the slash
      // stays at the end of the English line and the space goes between units.
      if (unit && t.slashAfter) { unitEn.append(g); closeChunk(); sent.append(' '); }
      else { (unitEn || sent).append(g, sxSpace(sx, k)); if (t.slashAfter) closeChunk(); }
    });
    reader.append(p);
  });
  const s = stats(state.slashed);
  $('#slashInfo').textContent = `${s.words}語・${s.chunks}区切り・1区切り平均 ${s.avgChunkLen.toFixed(1)}語（最長 ${s.maxChunkLen}語）${state.slashEdited ? '・手で調整済み' : ''}`;
  if (ja === 'full') translateAllSentences();
  if (ja === 'chunk') translateAllChunks();
  sxUpdateUi(sx);
  if (ja === 'gloss') $('#jaInfo').textContent = `難しい語（英検準1級程度以上の目安）${reader.querySelectorAll('ruby.w').length}語に意味を表示中。辞書の最初の意味なので、文脈に合わないことがあります。`;
  document.dispatchEvent(new Event('reader:rendered'));   // tts.js re-applies the reading highlight and わかりにくい marks
}

document.querySelectorAll('.seg[data-group=show] button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.seg[data-group=show] button').forEach(x => x.setAttribute('aria-checked', x === b));
  $('#reader').classList.toggle('faint', b.dataset.show === 'faint');
  $('#reader').classList.toggle('off', b.dataset.show === 'off');
  $('#reader').classList.toggle('clause', b.dataset.show === 'clause');
  state.show = b.dataset.show;
});
$('#perLine').onchange = () => $('#reader').classList.toggle('perline', $('#perLine').checked);
function closeSlashEditor() { $('#slashEdit').hidden = true; $('#reader').hidden = false; $('#editSlash').textContent = 'テキストで編集'; }
$('#editSlash').onclick = () => {
  const ta = $('#slashEdit');
  if (ta.hidden) { ta.value = state.slashed; ta.hidden = false; $('#reader').hidden = true; $('#editSlash').textContent = '編集を反映'; ta.focus(); }
  else { state.slashed = ta.value; state.slashEdited = true; closeSlashEditor(); renderReader(); renderLog(); save(); }
};
// Copy inside the tap itself (iOS needs the gesture). Sandboxed frames may block the Clipboard API and its rejection
// arrives after the gesture, so the synchronous route goes first: a selected read-only textarea (no keyboard) and
// execCommand('copy'); the Clipboard API (also called before any await) is the fallback.
function copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.readOnly = true; ta.setAttribute('aria-hidden', 'true');
  ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
  document.body.append(ta);
  ta.focus({ preventScroll: true }); ta.setSelectionRange(0, text.length);
  let ok = false; try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  $('#copySlash').focus({ preventScroll: true });
  return ok;
}
$('#copySlash').onclick = async () => {
  let ok = copyFallback(state.slashed);
  if (!ok) { try { await navigator.clipboard.writeText(state.slashed); ok = true; } catch { ok = false; } }
  $('#copySlash').textContent = ok ? 'コピーしました' : 'コピーできません';
  setTimeout(() => $('#copySlash').textContent = 'コピー', 1500);
};
$('#saveTxt').onclick = () => {
  const plain = state.slashed.replace(/\s+\/+\s*|\s*\/+\s+/g, ' ');
  const blob = new Blob([`【区切りあり】\n${state.slashed}\n\n【区切りなし】\n${plain}\n`], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
  a.download = `${(state.fileName || 'スラ読オン読').replace(/\.pdf$/i, '')}_音読.txt`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
};

// Text-to-speech model reading (再生・一時停止・再開・止める) and the わかりにくい marks live in tts.js; it
// follows the reader through the 'reader:rendered' event dispatched at the end of renderReader().

// ---------- 構文マーク (sentence-structure marks) and 品詞 (parts of speech) ----------
// The analysis (syntax.js on top of the vendored compromise tagger) runs only when a mark type or the
// part-of-speech display is switched on. Marks are keyed by global word index (the reader's data-i), so
// moving slashes keeps them; a change to the words themselves starts a fresh analysis. The learner's
// corrections are stored per passage in localStorage (readflow:marks:<hash>), like the practice log.
// マークの作り方 (app/sxsrc.js): src 'auto' = the rule-based marks (auto.marks), 'ai' = marks Claude re-made for
// the whole passage (ai = { marks, failed: [sentence index], ... }; failed sentences keep the rule-based marks).
// The learner's corrections are kept per source: readflow:marks:<hash> (自動) and readflow:marks:ai:<hash> (AI).
state.sx = { on: new Set(), pos: 'off', edit: false, key: '', auto: null, edits: null, marks: [], sel: null, anchor: null, loading: null, ms: 0, src: 'auto', ai: null, sents: [] };
let nlpPromise = null;
const loadNlp = () => (nlpPromise ||= import('../vendor/compromise/compromise-two.mjs').then(m => m.default));
const sxNeeded = () => state.sx.on.size > 0 || state.sx.pos !== 'off';
function wordsHash(words) {
  const plain = words.join(' ');
  let h = 2166136261;
  for (let i = 0; i < plain.length; i++) { h ^= plain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${plain.length}`;
}
function loadSxSettings() {
  try {
    const v = JSON.parse(localStorage.getItem('readflow:sx') || 'null');
    if (v) { state.sx.on = new Set((v.on || []).filter(t => MARK_TYPES.includes(t))); state.sx.pos = ['off', 'tap', 'all'].includes(v.pos) ? v.pos : 'off'; }
  } catch { /* ignore */ }
  document.querySelectorAll('[data-sx]').forEach(cb => { cb.checked = state.sx.on.has(cb.dataset.sx); });
  $('#posMode').value = state.sx.pos;
}
function saveSxSettings() { try { localStorage.setItem('readflow:sx', JSON.stringify({ on: [...state.sx.on], pos: state.sx.pos })); } catch { /* ignore */ } }
const editsKey = (key, src) => `readflow:marks:${src === 'ai' ? 'ai:' : ''}${key}`;
function loadEdits(key, src) { try { return JSON.parse(localStorage.getItem(editsKey(key, src)) || 'null'); } catch { return null; } }
function saveEdits() {
  const e = state.sx.edits, k = editsKey(state.sx.key, state.sx.src);
  try { if (e && (e.removed.length || e.added.length)) localStorage.setItem(k, JSON.stringify(e)); else localStorage.removeItem(k); } catch { /* ignore */ }
}
// Called at the start of renderReader. Returns the per-word decorations, or null (off / still loading).
function sxPrepare(paras) {
  if (!sxNeeded() || !state.slashed) return null;
  const words = paras.flat().map(t => t.word);
  const key = wordsHash(words);
  if (state.sx.key !== key || !state.sx.auto) { sxLoad(paras, key); return null; }
  return { deco: decorations(state.sx.marks, state.sx.on, words.length), pos: state.sx.pos !== 'off' ? state.sx.auto.pos : null, count: words.length };
}
function sxLoad(paras, key) {
  if (state.sx.loading === key) return;
  state.sx.loading = key;
  $('#sxNote').hidden = false; $('#sxLegend').textContent = ''; $('#sxInfo').textContent = '構文を解析しています…';
  loadNlp().then((nlp) => {
    if (state.sx.loading !== key) return;
    const t0 = performance.now();
    const auto = sxAnalyze(nlp, paras);
    const sents = sentencesOf(paras), { src, ai } = sourceFor(key, sents);   // the choice stored for this passage
    Object.assign(state.sx, { key, auto, sents, src, ai, ms: Math.round(performance.now() - t0), edits: loadEdits(key, src), sel: null, anchor: null, loading: null });
    state.sx.marks = applyEdits(sxBase(), state.sx.edits);
    renderReader(); refreshPrintPreviewIfOpen();
  }).catch((err) => {
    console.error(err); state.sx.loading = null;
    $('#sxInfo').textContent = `構文マークのプログラム（vendor/compromise）を読み込めませんでした（${err.message || err}）。`;
  });
}
function sxBracket(m, open) {
  const b = document.createElement('span');
  b.className = `sx sx-${m.type}${m.auto ? '' : ' sx-mine'}`;
  b.textContent = open ? MARK_INFO[m.type].open : MARK_INFO[m.type].close;
  b.dataset.mark = `${m.type}:${m.start}-${m.end}`;
  if (state.sx.edit) { b.setAttribute('role', 'button'); b.tabIndex = 0; b.setAttribute('aria-label', `${MARK_INFO[m.type].name}のマークを外す`); }
  else b.setAttribute('aria-hidden', 'true');
  return b;
}
// The space after word k: underlined too when the long subject continues to the next word.
function sxSpace(sx, k) {
  const a = sx?.deco[k]?.subj;
  if (!a || sx.deco[k + 1]?.subj !== a) return ' ';
  const sp = document.createElement('span'); sp.className = 'sx-subj sx-sp'; sp.textContent = ' ';
  return sp;
}
const SX_KEYS = { rel: '{ } 関係詞節', noun: '[ ] 名詞節', adv: '＜＞ 副詞節', subj: '下線 長い主語', verb: 'V 主節の述語動詞', post: '( ) 後置修飾の句（分詞・不定詞）' };
const POS_KEYS = ['名', '代', '動', '助動', '形', '副', '前', '接', '冠', '関代', '関副', '疑', '不', '数'];
function sxUpdateUi(sx) {
  const reader = $('#reader');
  reader.classList.toggle('sx-pos-all', !!sx?.pos && state.sx.pos === 'all');
  reader.classList.toggle('sx-pos-tap', !!sx?.pos && state.sx.pos === 'tap');
  reader.classList.toggle('sx-editing', state.sx.edit && !!sx);
  $('#sxEdit').hidden = !state.sx.on.size || !state.slashed;
  $('#sxEdit').setAttribute('aria-pressed', state.sx.edit);
  $('#sxEdit').textContent = state.sx.edit ? 'マークの修正を終える' : 'マークを直す';
  $('#sxTools').hidden = !state.sx.edit || !state.sx.on.size;
  const show = sxNeeded() && !!state.slashed;
  $('#sxNote').hidden = !show;
  $('#sxReset').textContent = state.sx.src === 'ai' ? 'AIのマークに戻す' : '自動のマークに戻す';
  refreshSxSrc();                    // マークの作り方 自動 / AI (app/sxsrc.js)
  refreshSxAi();                     // 「この文だけAIに聞く」 panel (app/sxai.js)
  if (!show || !sx) return;          // still loading: sxLoad shows its own message
  const types = MARK_TYPES.filter(t => state.sx.on.has(t));
  $('#sxLegend').innerHTML = types.map(t => `<span class="sxkey">${escapeHtml(SX_KEYS[t])}</span>`).join('')
    + (state.sx.pos !== 'off' ? `<span class="sxkey">品詞: ${POS_KEYS.map(k => `${k}＝${POS_NAMES[k]}`).join('、')}</span>` : '');
  const auto = state.sx.marks.filter(m => m.auto && state.sx.on.has(m.type)).length;
  const mine = state.sx.marks.filter(m => !m.auto).length, removed = state.sx.edits?.removed?.length || 0;
  const ai = state.sx.src === 'ai' && state.sx.ai;
  if (ai) $('#sxLegend').insertAdjacentHTML('afterbegin', '<span class="sxkey sxkey-ai">AIが作ったマーク</span>');
  $('#sxInfo').textContent = (types.length && ai
    ? `AIが作ったマークです。AIも間違うことがあります。${state.sx.pos !== 'off' ? '品詞はプログラムが自動で付けた目安です。' : ''}「マークを直す」で外したり付けたりでき、直した内容はこの端末に保存されます（自動のマークの修正とは別に保存）。AI ${auto} か所${mine || removed ? `・自分で付けた ${mine}・外した ${removed}` : ''}。`
    : types.length
    ? `マーク${state.sx.pos !== 'off' ? '・品詞' : ''}はプログラムが自動で付けた目安で、誤りがあります（括弧の範囲や種類の取り違えなど）。同格の that 節は [ ]、so ～ that の that 節は ＜＞ で示します。「マークを直す」で外したり付けたりでき、直した内容はこの端末に保存されます。自動 ${auto} か所${mine || removed ? `・自分で付けた ${mine}・外した ${removed}` : ''}。`
    : '品詞はプログラムが自動で付けた目安で、誤りがあります。')
    + (state.sx.pos === 'tap' ? ' 語をタップするとその語の品詞が出ます。' : '');
}
// The marks the edits apply to: rule-based, or the AI's (with rule-based marks for sentences the AI did not make).
function sxBase() { return state.sx.src === 'ai' && state.sx.ai ? mergeAi(state.sx.auto.marks, state.sx.ai, state.sx.sents) : state.sx.auto.marks; }
function sxSetEdits(e) {
  state.sx.edits = e; state.sx.marks = applyEdits(sxBase(), e);
  saveEdits(); renderReader(); refreshPrintPreviewIfOpen();
}
// New AI marks arrived (or were reset): recompute with the current edits.
function sxRebase() {
  if (!state.sx.auto) { if (state.slashed) renderReader(); return; }
  state.sx.marks = applyEdits(sxBase(), state.sx.edits);
  renderReader(); refreshPrintPreviewIfOpen();
}
// Switch 自動 / AI for the passage on screen. The edits of each source are separate.
function sxUseSource(src, ai) {
  const key = currentPassage().key;
  if (state.sx.key === key) Object.assign(state.sx, { src: src === 'ai' && ai ? 'ai' : 'auto', ai, edits: loadEdits(key, src === 'ai' && ai ? 'ai' : 'auto'), sel: null, anchor: null });
  // else: the analysis of these words is still loading; sxLoad reads the stored choice when it is done.
  if (state.slashed) sxRebase(); else sxUpdateUi(null);
}
function currentPassage() {
  const paras = tokensWithBoundaries(state.slashed || '');
  return { key: wordsHash(paras.flat().map(t => t.word)), sents: sentencesOf(paras) };
}
initSxAi({ state, renderReader, sxSetEdits, saveSxSettings });
initSxSrc({ state, renderReader, rebase: sxRebase, useSource: sxUseSource, sxSetEdits, saveSxSettings, currentPassage, ask });
initSlSrc({ state, setSlashed, ask, wordsHash, level: () => $('#level').value });   // 区切りの作り方 自動 / AI (app/slsrc.js)
document.querySelectorAll('[data-sx]').forEach(cb => cb.onchange = () => {
  cb.checked ? state.sx.on.add(cb.dataset.sx) : state.sx.on.delete(cb.dataset.sx);
  if (!state.sx.on.size) state.sx.edit = false;
  saveSxSettings(); if (state.slashed) renderReader(); else sxUpdateUi(null);
});
$('#posMode').onchange = () => { state.sx.pos = $('#posMode').value; saveSxSettings(); if (state.slashed) renderReader(); else sxUpdateUi(null); };
$('#sxEdit').onclick = () => { state.sx.edit = !state.sx.edit; state.sx.sel = state.sx.anchor = null; renderReader(); };
// Selecting words for a new mark: two clicks (first and last word), or a drag selection.
function sxSelectedRange() {
  const sel = getSelection();
  if (sel && !sel.isCollapsed && sel.rangeCount) {
    const r = sel.getRangeAt(0);
    const ws = [...$('#reader').querySelectorAll('.w')].filter(w => r.intersectsNode(w)).map(w => +w.dataset.i);
    if (ws.length) return [Math.min(...ws), Math.max(...ws)];
  }
  return state.sx.sel;
}
document.querySelectorAll('[data-sxadd]').forEach(b => {
  b.onpointerdown = (e) => e.preventDefault();          // keep a drag selection alive
  b.onclick = () => {
    const r = sxSelectedRange();
    if (!r || !state.sx.auto) { $('#sxInfo').textContent = '先に、マークを付ける最初の語と最後の語をクリックしてください（ドラッグで選んでもかまいません）。'; return; }
    const type = b.dataset.sxadd;
    if (!state.sx.on.has(type)) { state.sx.on.add(type); document.querySelector(`[data-sx="${type}"]`).checked = true; saveSxSettings(); }
    state.sx.sel = state.sx.anchor = null; getSelection()?.removeAllRanges();
    sxSetEdits(addMark(state.sx.edits, { type, start: r[0], end: r[1] }));
  };
});
$('#sxDrop').onpointerdown = (e) => e.preventDefault();
$('#sxDrop').onclick = () => {
  const r = sxSelectedRange();
  if (!r || !state.sx.auto) { $('#sxInfo').textContent = '下線やVを外したい語をクリックしてから押してください。'; return; }
  let e = state.sx.edits;
  for (const m of state.sx.marks) if ((m.type === 'subj' || m.type === 'verb') && state.sx.on.has(m.type) && m.start <= r[1] && m.end >= r[0]) e = removeMark(e, m);
  state.sx.sel = state.sx.anchor = null; getSelection()?.removeAllRanges();
  sxSetEdits(e);
};
$('#sxReset').onclick = async () => {
  const ai = state.sx.src === 'ai';
  if (!state.sx.auto || !(await ask(`この英文で手で直したマークをすべて取り消して、${ai ? 'AIが作ったマーク' : '自動のマーク'}に戻しますか？`, ai ? 'AIのマークに戻す' : '自動に戻す'))) return;
  state.sx.sel = state.sx.anchor = null;
  sxSetEdits(null);
};
// Reader clicks for 品詞 tap mode and for correcting marks (captured before the translation tap handler).
$('#reader').addEventListener('click', (e) => {
  if (state.sx.pos === 'tap' && !state.sx.edit) {
    const w = e.target.closest('.w');
    if (w && w.dataset.pos !== undefined) {
      const was = w.classList.contains('pos-show');
      $('#reader').querySelectorAll('.w.pos-show').forEach(x => x.classList.remove('pos-show'));
      if (!was) { w.classList.add('pos-show'); w.title = w.dataset.pos.split('・').map(p => POS_NAMES[p] || p).join('・'); }
    }
  }
  if (!state.sx.edit || !state.sx.auto) return;
  const br = e.target.closest('.sx');
  if (br) {
    e.stopImmediatePropagation();
    const m = state.sx.marks.find(x => `${x.type}:${x.start}-${x.end}` === br.dataset.mark);
    if (m) sxSetEdits(removeMark(state.sx.edits, m));
    return;
  }
  const w = e.target.closest('.w');
  if (!w || e.target.closest('.gap, .ja-pop, .cu-ja')) return;
  if (!getSelection()?.isCollapsed) return;               // a drag selection is used by the buttons
  e.stopImmediatePropagation();
  const i = +w.dataset.i;
  if (state.sx.anchor == null) { state.sx.anchor = i; state.sx.sel = [i, i]; }
  else { state.sx.sel = [Math.min(state.sx.anchor, i), Math.max(state.sx.anchor, i)]; state.sx.anchor = null; }
  renderReader();
}, true);
$('#reader').addEventListener('keydown', (e) => {
  if (!state.sx.edit || (e.key !== 'Enter' && e.key !== ' ')) return;
  const br = e.target.closest?.('.sx'); if (!br) return;
  e.preventDefault(); e.stopImmediatePropagation(); br.click();
}, true);

// ---------- Japanese support: glosses, tap-to-translate chunks, full translation ----------
// Translation uses the browser's on-device Translator (see translate.js); nothing is sent out.
function jaStatusText(st) {
  return {
    available: '端末内翻訳（ブラウザ内蔵の翻訳AI）を使います。英文は外部に送信しません。',
    downloadable: '端末内翻訳を使うには、最初に一度だけ英語→日本語の翻訳データをダウンロードします（ネット接続が必要。以後はオフラインで動きます）。',
    downloading: '翻訳データをダウンロード中です…',
    unavailable: 'このブラウザでは端末内翻訳を使えません。Windows/Mac版の Chrome 138 以降、または Edge 148 以降で開いてください。訳は「✎」で自分で書き込めます。',
    link: `機械翻訳ができません：${aiWhyNot() || aiUnavailableText()}。訳は「✎」で自分で書き込めます。`,
    'claude-ready': `訳は ${aiName()} が作ります（${aiUsage()}）。送るのは訳す英文の段落だけで、PDFは送りません。「${aiName()}で訳を作る」を押すと始まります。`,
    claude: `${aiName()} で翻訳します（段落ごとにまとめて送り、前後の文脈に合わせて訳します）。送るのは英文の段落だけで、PDFは送りません。`,
    unsupported: 'このブラウザには端末内翻訳の機能がありません。Windows/Mac版の Chrome 138 以降、または Edge 148 以降で開いてください。訳は「✎」で自分で書き込めます。',
  }[st] || '';
}
async function refreshJaStatus() {
  // The selected AI (Claude in the link version, or Gemini with the learner's key) translates when it is set up;
  // otherwise the browser's on-device translator (not in the link version).
  if (await aiReady()) state.trStatus = state.claudeArmed ? 'available' : 'claude-ready';
  else if (LINK) state.trStatus = 'link';
  else state.trStatus = await trStatus();
  $('#jaInfo').textContent = jaStatusText(state.trStatus === 'available' && aiActive() ? 'claude' : state.trStatus);
  $('#trPrepare').textContent = aiActive() ? `${aiName()}で訳を作る` : '翻訳データを準備';
  $('#trPrepare').hidden = !['downloadable', 'downloading', 'claude-ready'].includes(state.trStatus);
  return state.trStatus;
}
// Call only from a click: downloading the language pack needs user activation.
async function prepareTranslator() {
  if (['unavailable', 'unsupported', 'link'].includes(state.trStatus)) return false;
  if (aiActive()) {
    // Calls to the AI start only after the viewer asks for them (never on page load).
    state.claudeArmed = true; state.trStatus = 'available'; $('#trPrepare').hidden = true;
    $('#jaInfo').textContent = jaStatusText('claude');
    return true;
  }
  try {
    $('#jaInfo').textContent = '翻訳データを準備しています…（初回は数分かかることがあります）';
    await trReady((p) => { $('#jaInfo').textContent = `翻訳データをダウンロード中… ${Math.round((p || 0) * 100)}%`; });
    state.trStatus = 'available'; $('#trPrepare').hidden = true;
    $('#jaInfo').textContent = jaStatusText('available');
    return true;
  } catch (e) {
    $('#jaInfo').textContent = e.name === 'NotAllowedError'
      ? '翻訳データの準備には画面のクリックが必要です。「翻訳データを準備」を押してください。'
      : e.name === 'StallError'
        ? '翻訳データのダウンロードが1分以上進みませんでした。ネット接続を確認して「翻訳データを準備」を押し直すか、時間をおいて試してください。その間も訳は「✎」で自分で書き込めます。'
        : `翻訳を準備できませんでした（${e.name || ''} ${e.message || e}）。訳は「✎」で自分で書き込めます。`;
    $('#trPrepare').hidden = false;
    return false;
  }
}
// Re-render so boxes that were waiting for the language pack start translating.
$('#trPrepare').onclick = async () => { if (await prepareTranslator() && (state.ja === 'full' || state.ja === 'chunk') && state.slashed) renderReader(); };

// opts.decorate(box) adds mode-specific extras (tap bubble: chunk id + 「文全体の訳」); it is
// re-applied when the box is rebuilt after an edit. opts.compact is the small line under each
// chunk in 「区切りごとの訳」 (Enter saves, Esc cancels).
function translationBox(text, opts = {}) {
  const { inline = false, decorate = null, compact = false } = opts;
  const box = document.createElement(inline || compact ? 'span' : 'div');
  box.className = compact ? 'cu-ja' : inline ? 'ja-sent' : 'ja-pop';
  box.lang = 'ja';
  const out = document.createElement('span'); out.className = 'ja-text';
  const edit = document.createElement('button'); edit.type = 'button'; edit.className = 'ja-edit'; edit.textContent = '✎'; edit.title = '訳を直す・自分で書く';
  edit.setAttribute('aria-label', compact ? `「${text}」の訳を書く・直す` : '訳を直す・自分で書く');
  box.append(out, edit);
  const none = compact ? '（✎で訳を書く）' : '（訳なし）';
  const show = (v) => { if (!out.isConnected && box.isConnected) return; out.textContent = v ? v.ja : none; out.classList.toggle('mine', !!v?.edited); box.dataset.ok = v ? '1' : ''; };
  const rebuild = () => { const nb = translationBox(text, opts); box.replaceWith(nb); nb.querySelector('.ja-edit')?.focus(); refreshPrintPreviewIfOpen(); };
  edit.onclick = (e) => {
    e.stopPropagation();
    const cur = trCached(text)?.ja || '';
    const ta = document.createElement('textarea'); ta.className = 'ja-input'; ta.value = cur; ta.rows = 2; ta.lang = 'ja';
    ta.setAttribute('aria-label', compact ? `「${text}」の訳を入力` : '訳を入力');
    const ok = document.createElement('button'); ok.type = 'button'; ok.className = 'btn sm'; ok.textContent = '保存';
    const reset = document.createElement('button'); reset.type = 'button'; reset.className = 'btn sm'; reset.textContent = '機械翻訳に戻す';
    const buttons = [ok];
    if (!compact || state.trStatus === 'available') buttons.push(reset);
    if (compact) {
      const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'btn sm'; cancel.textContent = 'やめる';
      cancel.onclick = (ev) => { ev.stopPropagation(); rebuild(); };
      buttons.push(cancel);
      box.classList.add('editing');
      ta.rows = 1; ta.placeholder = '訳（空で保存すると消えます）';
      // Enter saves (but not while the IME is still converting); Shift+Enter makes a new line.
      ta.onkeydown = (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); ok.click(); }
        else if (ev.key === 'Escape') { ev.preventDefault(); rebuild(); }
      };
    }
    box.replaceChildren(ta, ...buttons); ta.focus();
    ta.onclick = (ev) => ev.stopPropagation();
    ok.onclick = (ev) => { ev.stopPropagation(); const v = ta.value.trim(); if (v) trStore(text, v, true); else trForget(text); rebuild(); };
    reset.onclick = (ev) => { ev.stopPropagation(); trForget(text); rebuild(); };
  };
  const hit = trCached(text);
  if (hit) show(hit);
  else if (state.trStatus === 'available') {
    out.textContent = '翻訳中…';
    trTranslate(text).then(show).catch(err => { if (!box.querySelector('.ja-input')) out.textContent = compact ? '（翻訳できませんでした。✎で書けます）' : `翻訳できませんでした（${err.message || err}）`; });
  } else out.textContent = compact ? '（✎で訳を書く）'
    : state.trStatus === 'claude-ready' ? `（「${aiName()}で訳を作る」を押すと表示されます）` : state.trStatus === 'downloadable' || state.trStatus === 'downloading' ? '（「翻訳データを準備」を押すと表示されます）' : '（訳なし：✎で書き込めます）';
  decorate?.(box);
  return box;
}
function sentenceTranslationEl(text) { return translationBox(text, { inline: true }); }

// Full mode: each sentence box queues its own translation; this only reports progress
// (translate.js shares one request per text, so nothing is translated twice).
let fullRun = 0;
async function translateAllSentences() {
  const id = ++fullRun;
  if (state.trStatus !== 'available') return;
  const todo = state.sentences.filter(s => !trCached(s));
  if (!todo.length) return;
  let done = 0, failed = 0;
  await Promise.all(todo.map(s => trTranslate(s).catch(() => { failed++; }).finally(() => {
    if (id === fullRun && state.ja === 'full') $('#jaInfo').textContent = `全文訳: ${++done} / ${todo.length} 文（${aiActive() ? `${aiName()}で翻訳` : '端末内で翻訳'}）`;
  })));
  if (id === fullRun && state.ja === 'full') $('#jaInfo').textContent = failed
    ? `${failed} 文を翻訳できませんでした。「全文訳」を押し直すと再試行します。訳は ✎ で書き込めます。`
    : `全文訳を表示中（${aiActive() ? `${aiName()}による翻訳` : '端末内の機械翻訳'}。誤訳があれば ✎ で直せます）`;
}

// 「区切りごとの訳」: like full mode, each unit queues its own chunk; this reports progress.
// Translations are keyed by the chunk text, so moving a slash only re-translates changed chunks.
let chunkRun = 0;
const chunkNote = () => aiActive() ? '段落全体を手がかりに区切りごとに訳しています。誤訳があれば各区切りの ✎ で直せます。' : '区切りだけを訳すため文の前後関係が使えず、機械翻訳が不自然になることがあります。各区切りの ✎ で直せます。';
async function translateAllChunks() {
  const id = ++chunkRun;
  const live = () => id === chunkRun && state.ja === 'chunk';
  const st = state.trStatus;
  if (st === 'downloadable' || st === 'downloading') {           // 「翻訳データを準備」 stays visible
    $('#jaInfo').textContent = `${jaStatusText(st)} 準備すると各区切りを機械翻訳します。準備しなくても、各区切りの下の ✎ で自分の訳を書き込めます。`;
    return;
  }
  if (st !== 'available') {
    $('#jaInfo').textContent = `${jaStatusText(st)} 区切りごとの訳は、各区切りの下の ✎ を押して自分で書き込めます（書いた訳はこの端末に保存され、次に開いたときも表示されます）。`;
    return;
  }
  const all = [...new Set(state.chunks)];
  const todo = all.filter(c => !trCached(c));
  let done = all.length - todo.length, failed = 0;
  const report = () => { if (live()) $('#jaInfo').textContent = `区切りごとの訳: ${done} / ${all.length}（${aiActive() ? `${aiName()}で翻訳中` : '端末内で翻訳中'}）。${chunkNote()}`; };
  if (todo.length) {
    report();
    await Promise.all(todo.map(c => trTranslate(c).catch(() => { failed++; }).finally(() => { done++; report(); })));
  }
  if (live()) $('#jaInfo').textContent = failed
    ? `${failed} 個の区切りを翻訳できませんでした。「区切りごとの訳」を押し直すと再試行します。訳は ✎ で書き込めます。`
    : `区切りごとの訳を表示中（${aiActive() ? `${aiName()}による翻訳` : '端末内の機械翻訳'}）。${chunkNote()}`;
}

// Tap (or Enter on) a word in "タップで区切りの訳" mode: translate the chunk it belongs to.
async function showChunk(w) {
  const c = +w.dataset.c, chunk = state.chunks[c]; if (chunk == null) return;
  $('#reader').querySelectorAll('.w.tapped').forEach(x => x.classList.remove('tapped'));
  const pop = $('#reader').querySelector('.ja-pop');
  const same = pop && pop.dataset.c === String(c);
  pop?.remove();
  if (same) return;                                     // a second tap closes it
  const words = [...$('#reader').querySelectorAll(`.w[data-c="${c}"]`)];
  words.forEach(x => x.classList.add('tapped'));
  const sent = words[0].closest('.sent'), sIdx = +sent.dataset.s;
  if (state.trStatus === 'downloadable' || state.trStatus === 'downloading' || state.trStatus === 'claude-ready') {
    // Show the bubble at once; this tap is also the user activation the download needs.
    const wait = document.createElement('div'); wait.className = 'ja-pop'; wait.dataset.c = c; wait.lang = 'ja';
    wait.textContent = '翻訳データを準備しています…（画面上の案内をご覧ください）';
    sent.after(wait);
    await prepareTranslator();
    if (!wait.isConnected) return;                      // closed or replaced meanwhile
    wait.remove();
  }
  const decorate = (box) => {
    box.dataset.c = c;
    const whole = document.createElement('button'); whole.type = 'button'; whole.className = 'ja-more'; whole.textContent = '文全体の訳';
    whole.onclick = (ev) => { ev.stopPropagation(); whole.replaceWith(translationBox(state.sentences[sIdx], { inline: true })); };
    box.append(whole);
  };
  sent.after(translationBox(chunk, { decorate }));      // the bubble sits right after its sentence
}
$('#reader').addEventListener('click', (e) => {
  // With 「語をタップで意味」 on (app/wordtap.js sets state.wordTap), a word tap opens its popover, which offers
  // 「この区切りの訳」 and sends 'wordtap:chunk' back here.
  if (state.ja !== 'tap' || state.wordTap || e.target.closest('.ja-pop, .gap')) return;
  const w = e.target.closest('.w'); if (w) showChunk(w);
});
document.addEventListener('wordtap:chunk', (e) => { if (state.ja === 'tap' && e.detail?.isConnected) showChunk(e.detail); });
$('#reader').addEventListener('keydown', (e) => {
  if (state.ja !== 'tap' || (e.key !== 'Enter' && e.key !== ' ')) return;
  const w = e.target.closest?.('.w'); if (!w) return;
  e.preventDefault(); showChunk(w);
});

async function setJaMode(mode) {
  document.querySelectorAll('.seg-ja button').forEach(x => x.setAttribute('aria-checked', x.dataset.ja === mode));
  state.ja = mode;
  try { localStorage.setItem('readflow:ja', mode); } catch { /* ignore */ }
  $('#jaInfo').textContent = ''; $('#trPrepare').hidden = true;
  if (mode === 'gloss') {
    try { await loadVocab(); } catch (err) { if (state.ja === mode) $('#jaInfo').textContent = err.message; return; }
  }
  if (mode === 'tap' || mode === 'full' || mode === 'chunk') {
    await refreshJaStatus();
    if (state.ja !== mode) { $('#trPrepare').hidden = true; return; }   // switched away meanwhile
    if (mode === 'tap') $('#jaInfo').textContent = `${jaStatusText(state.trStatus)} 英文の語をタップ（またはTabで移動してEnter）すると、その区切りの訳が出ます。`;
  }
  if (state.ja === mode && state.slashed) renderReader();
}
document.querySelectorAll('.seg-ja button').forEach(b => b.onclick = () => setJaMode(b.dataset.ja));

// Practice plan, timer and self-check log.
$('#plan').innerHTML = PLAN.map((s, i) => `<li><b>${s.title}</b>${s.body}${s.reps ? `<span class="reps">${Array.from({ length: s.reps }, (_, k) => `<input type="checkbox" aria-label="${s.title} ${k + 1}回目">`).join('')}</span>` : ''}</li>`).join('');
$('#evidence').innerHTML = EVIDENCE;
let t0 = 0, tick = null, elapsed = 0;
$('#timerBtn').onclick = () => {
  if (!tick) { t0 = performance.now(); tick = setInterval(() => { elapsed = (performance.now() - t0) / 1000; $('#timerOut').textContent = fmt(elapsed); }, 200); $('#timerBtn').textContent = '読み終えた'; $('#selfCheck').hidden = true; }
  else { clearInterval(tick); tick = null; elapsed = (performance.now() - t0) / 1000; $('#timerOut').textContent = fmt(elapsed); $('#timerBtn').textContent = 'もう一度計測'; $('#selfCheck').hidden = false; }
};
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
$('#selfCheck').onsubmit = (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const words = wordCount(state.slashed || '');
  const rec = { at: new Date().toISOString(), show: state.show || 'on', wpm: elapsed > 5 ? Math.round(words / (elapsed / 60)) : null, mean: +f.get('mean') || null, acc: +f.get('acc') || null, pros: +f.get('pros') || null, gist: $('#gist').value };
  const log = loadLog(); log.push(rec); storeLog(log); renderLog(); e.target.reset(); e.target.hidden = true;
};
// One log per passage: keyed on a hash of the words, so moving slashes keeps the history.
const logKey = () => {
  const plain = (state.slashed || '').replace(/\s+\/+\s*|\s*\/+\s+/g, ' ').replace(/\s+/g, ' ').trim();
  let h = 2166136261;
  for (let i = 0; i < plain.length; i++) { h ^= plain.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `readflow:log:${(h >>> 0).toString(36)}:${plain.length}`;
};
function loadLog() { try { return JSON.parse(localStorage.getItem(logKey()) || '[]'); } catch { return []; } }
function storeLog(l) { try { localStorage.setItem(logKey(), JSON.stringify(l)); } catch { /* storage unavailable */ } }
function renderLog() {
  const l = loadLog(); const showName = { on: '区切りあり', clause: '大きな区切り', faint: '薄く', off: 'なし' };
  $('#log tbody').innerHTML = l.slice(-8).map(r => `<tr><td>${new Date(r.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td><td>${showName[r.show] || ''}</td><td>${r.wpm == null ? '-' : (r.mean && r.mean <= 2 ? `<s title="意味が取れていないため参考外">${r.wpm}</s>` : r.wpm)}</td><td>${r.mean ?? '-'}</td><td>${r.acc ?? '-'}</td><td>${r.pros ?? '-'}</td></tr>`).join('');
  const last = l[l.length - 1];
  let adv = '';
  if (last) {
    if ((last.mean || 0) <= 2) adv = '意味が取れていません。速さは気にせず、区切りありの表示に戻して、わからない語・構文を確認してから読み直しましょう。';
    else if ((last.acc || 0) <= 2) adv = '読み間違いが多めです。お手本を聞き、つかえた区切りだけを数回読んでから全体を読みましょう。';
    else if ((last.pros || 0) <= 2) adv = 'まとまりで読む練習を続けましょう。区切りで短く間をとり、文末では声を下げます。';
    else if (last.show === 'on' || last.show === 'clause') adv = '意味・正確さ・まとまりが安定しています。表示を「大きな区切りだけ」→「なし」に切り替えて仕上げましょう。';
    else adv = 'よい状態です。数日あけて同じ英文を読み直すと定着を確かめられます。';
  }
  $('#advice').textContent = adv;
}

// ---------- misc ----------
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function markStep(n) {
  document.querySelectorAll('.steps a').forEach(a => { const s = +a.dataset.step; a.classList.toggle('done', s < n); a.classList.toggle('current', s === n); });
}
function save() {
  try {
    localStorage.setItem('readflow:last', JSON.stringify({ body: $('#body').value, slashed: state.slashed || '', edited: !!state.slashEdited,
      fills: state.fills, blankDraft: state.blankDraft, questionText: state.questionText, choicePaste: state.choicePaste }));
  } catch { /* ignore */ }
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('readflow:last') || 'null');
    if (!s) return;
    // The body and its filled answers first (the reader marks the filled words), then the slashes, then
    // bodyChanged() — which saves, so everything it saves must already be restored.
    const body = s.body || '';
    state.fills = validFills(body, s.fills);
    state.blankDraft = s.blankDraft && typeof s.blankDraft === 'object' ? s.blankDraft : {};
    state.questionText = typeof s.questionText === 'string' ? s.questionText : '';
    state.choicePaste = typeof s.choicePaste === 'string' ? s.choicePaste : '';
    $('#choiceBulk').value = state.choicePaste;
    $('#body').value = body; state.bodyPrev = body;
    if (s.slashed) { state.slashed = s.slashed; state.slashEdited = s.edited; $('#s5').hidden = false; renderReader(); }
    if (body) bodyChanged();
  } catch { /* ignore */ }
}
function exportPages() {
  return state.pages.filter(p => p.status === 'done').map(p => ({ num: p.num, source: p.source, conf: p.conf, ocrMs: p.ocrMs, quality: quality(p), text: p.text,
    lines: p.lines.map(l => ({ text: l.text, include: l.include, reason: l.reason, conf: Math.round(l.conf ?? 100), bbox: l.bbox, low: l.words.filter(w => w.conf < LOW_CONF).map(w => `${w.text}(${Math.round(w.conf)})`) })) }));
}
const PRIVACY_FILE = $('#privacy').innerHTML;
// The header note names the AI that receives text (Claude / Gemini, chosen in 「AIの設定」: app/ai.js).
function updatePrivacy() {
  const n = aiName();
  if (LINK) {
    $('#privacy').innerHTML = `<strong>PDFはこのブラウザの中だけで処理します。</strong>外部のOCRサービスには送信しません。OCRのプログラムと英語データはこのページと一緒に読み込まれます。日本語訳は ${n} が作ります（あなたの ${n} の利用枠を使い、訳す英文の段落だけを送ります）。「${n}で空欄を解く」を押したときは、空欄のある段落とその選択肢を送ります。リンク版では印刷・PDFと.txt保存は使えません（ファイル版では使えます）。`;
  } else {
    $('#privacy').innerHTML = PRIVACY_FILE + (aiActive() ? ` <strong>いまは「AIの設定」で ${n} を選んでいるため、日本語訳とAIの機能（空欄・構文マーク・区切り・構文図・語の意味）は ${n} を使います。</strong>ボタンを押したときだけ、その英文を ${n} に送ります（PDFは送りません）。` : '');
  }
}
if (LINK) { $('#printBtn').hidden = true; $('#saveTxt').hidden = true; }
updatePrivacy();
// 「AIの設定」 changed: translation waits for 「〜で訳を作る」 again, and the labels name the new provider.
onAiChange(() => {
  state.claudeArmed = false;
  updatePrivacy();
  $('#blankAi').textContent = `${aiName()}で空欄を解く`; $('#blankAi').title = aiWhyNot();
  if (['tap', 'full', 'chunk'].includes(state.ja)) setJaMode(state.ja);
});
setContextLookup((t) => state.ctx?.get(t) || '');
initPrint(() => state);
wirePrint();
initStructure({ getState: () => state, link: LINK });   // 構文図 (app/structure.js)
$('#printBtn').onclick = () => openPrintDialog();
markStep(1);
(async () => {
  let mode = 'none';
  try { mode = localStorage.getItem('readflow:ja') || 'none'; } catch { /* ignore */ }
  if (!['none', 'gloss', 'tap', 'chunk', 'full'].includes(mode)) mode = 'none';
  loadSxSettings();             // before the first render (setJaMode / restore), which starts the analysis when marks are on
  await setJaMode(mode);       // loads the dictionary / checks the translator before the first render
  restore();
})();
renderLog();
const q = new URLSearchParams(location.search).get('pdf');
if (q && q.startsWith('/samples/')) openUrl(q).catch(e => setStatus($('#loadStatus'), `読み込めませんでした: ${e.message}`, true));
