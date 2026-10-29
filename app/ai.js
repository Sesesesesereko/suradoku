// ai.js - which AI the AI buttons use (訳・空欄・構文マーク・区切り・構文図・語の意味).
//   - Claude: the `sample` capability of the claude.ai link version, on the viewer's own account.
//   - Gemini: Google's Gemini API with the learner's own API key (Google AI Studio), called straight from
//     the browser. The key is kept only in this browser's localStorage (its own entry), sent only in the
//     x-goog-api-key header to generativelanguage.googleapis.com, never logged, never put in a URL or in
//     printed / exported content.
// On claude.ai the page runs in a frame whose Content-Security-Policy only allows connections to its own
// origin, so a request to Gemini is blocked there: fetch() rejects with a TypeError (usually together with a
// `securitypolicyviolation` event). That is reported as code 'blocked' with a message saying Gemini works
// when the app is opened outside claude.ai (the folder served locally, GitHub Pages, ...).
// Every feature calls aiJson(prompt, opts) (opts.modelTier 'quick' | 'default' | 'complex', opts.signal).

const LINK = document.querySelector('meta[name="readflow-env"]')?.content === 'link';
const SKEY = 'readflow:ai', KKEY = 'readflow:ai-gemini-key';
const API = 'https://generativelanguage.googleapis.com/v1beta/models/';
// Gemini 2.5 is no longer offered to new API keys (2026). 'gemini-flash-latest' is Google's alias that
// always points at the newest Flash, so it keeps working when versions change; fixed names are fallbacks.
export const GEMINI_FAST = 'gemini-flash-latest', GEMINI_PRO = 'gemini-3.1-pro-preview';
const FAST_FALLBACKS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];
const NAMES = { claude: 'Claude', gemini: 'Gemini' };
const BLOCKED = 'この場所（claude.ai上）からはGeminiに接続できません。アプリをclaude.ai以外で開いたときに使えます';

// ---- settings (provider, model) and the key (separate entry) ----
function readSettings() {
  try { const v = JSON.parse(localStorage.getItem(SKEY) || 'null'); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
}
let settings = readSettings();
let memKey = '';            // used only when localStorage is blocked (this view only)
let geminiBlocked = false;  // learned from a call: this page cannot reach Gemini (CSP)
function saveSettings() { try { localStorage.setItem(SKEY, JSON.stringify(settings)); } catch { /* keep in memory */ } }
// A pasted key may carry full-width letters (Japanese input) or invisible characters (zero-width
// spaces, line breaks). Those make fetch() reject the header before anything is sent, so keep only
// the characters a Google API key can contain.
const cleanKey = (k) => String(k || '').normalize('NFKC').replace(/[^\x21-\x7E]/g, '');
function geminiKey() {
  try { const k = localStorage.getItem(KKEY); if (k) return cleanKey(k); } catch { /* blocked storage */ }
  return memKey;
}
function setGeminiKey(k) {
  k = cleanKey(k);
  memKey = '';
  try { if (k) localStorage.setItem(KKEY, k); else localStorage.removeItem(KKEY); }
  catch { memKey = k; }
}
export const hasGeminiKey = () => !!geminiKey();
// Default: Claude in the link version, Gemini elsewhere (Claude cannot be reached outside claude.ai).
export function aiProvider() {
  const p = settings.provider;
  return p === 'claude' || p === 'gemini' ? p : LINK ? 'claude' : 'gemini';
}
export const aiName = () => NAMES[aiProvider()];
function changed() { window.dispatchEvent(new CustomEvent('readflow:aichange', { detail: { provider: aiProvider() } })); }
export function onAiChange(fn) { window.addEventListener('readflow:aichange', () => fn()); }

// ---- Claude (moved here from translate.js; behaviour unchanged) ----
let sampler = null, claudeChecked = false;
export async function useClaude() {
  if (sampler) return true;
  try { sampler = window.claude?.use ? await window.claude.use('sample') : null; } catch { sampler = null; }
  claudeChecked = true;
  updateOpener();
  return !!sampler;
}
export function isClaude() { return !!sampler; }
export async function claudeJson(prompt, opts = {}) {
  if (!sampler && !(await useClaude())) throw Object.assign(new Error('unavailable'), { code: 'unavailable' });
  return sampler.json(prompt, opts);
}

// ---- availability ----
// aiReady(): can the AI buttons call the selected provider? (Claude: asks for the capability; Gemini: a key is
// saved and no call has been blocked yet. Real reachability of Gemini is learned on the first call / test.)
export async function aiReady() {
  if (aiProvider() === 'claude') return useClaude();
  return hasGeminiKey() && !geminiBlocked;
}
// aiActive(): synchronous "the AI backend is set up" (used by translation to choose AI over the on-device translator).
export function aiActive() { return aiProvider() === 'claude' ? !!sampler : hasGeminiKey(); }
// Why the AI buttons cannot be used ('' = usable, as far as known).
export function aiWhyNot() {
  if (aiProvider() === 'claude') {
    if (!LINK && !window.claude?.use) return 'Claude はリンク版（claude.ai で開いたとき）だけ使えます。上の「AIの設定」で Gemini を選び、APIキーを入れると使えます';
    if (claudeChecked && !sampler) return 'このブラウザから Claude を使えないため、AIは使えません（claude.ai にログインして開いてください）';
    return '';
  }
  if (!hasGeminiKey()) return 'AIを使うには、上の「AIの設定」で Gemini の APIキーを入れてください';
  if (geminiBlocked) return BLOCKED;
  return '';
}
export const aiUnavailableText = () => aiWhyNot() || `${aiName()} を使えません`;
export const aiUsage = () => aiProvider() === 'claude'
  ? 'あなたの Claude の利用枠を使います。最初に一度、許可の確認が出ます'
  : 'あなたの Gemini APIキーの利用枠を使います';
export const aiBusyText = (what = '問い合わせています') => `${aiName()}に${what}…（${aiUsage()}）`;
export const aiTimeoutText = () => `${aiName()}の応答に時間がかかりすぎました。もう一度押してください`;

// ---- one JSON request to the selected provider. Call only after a click. ----
export function aiJson(prompt, opts = {}) {
  return aiProvider() === 'gemini' ? geminiJson(prompt, opts) : claudeJson(prompt, opts);
}

// Error codes -> messages (same shape as before: unknown codes give the fallback text).
const FALLBACK = '翻訳に失敗しました。押し直してください';
export function providerErrorText(code) {
  const gem = {
    blocked: BLOCKED,
    network: `Geminiに接続できませんでした。ネット接続を確かめてから押し直してください。Claudeアプリの中で開いている場合は、Safariで開くと通ることがあります${lastNetDetail ? `（詳細: ${lastNetDetail}）` : ''}`,
    no_key: 'Gemini を使うには「AIの設定」で APIキーを入れてください',
    bad_key: `Gemini の APIキーが正しくないか、使えないキーです。「AIの設定」でキーを確かめてください${lastGoogleDetail ? `（Googleの返事: ${lastGoogleDetail}）` : ''}`,
    bad_model: 'Gemini のモデル名が見つかりません。「AIの設定」でモデルを確かめてください',
    bad_request: `Gemini がこの依頼を受け付けませんでした。「AIの設定」のモデルを確かめてください${lastGoogleDetail ? `（Googleの返事: ${lastGoogleDetail}）` : ''}`,
    rate_limited: 'Gemini の利用が混み合っているか、利用上限に達しました。少し待ってから押し直してください',
    upstream_error: `Gemini でエラーが起きました。少し待ってから押し直してください${lastGoogleDetail ? `（Googleの返事: ${lastGoogleDetail}）` : ''}`,
    refused: 'この部分は答えてもらえませんでした',
    invalid_json: 'AIの答えを読み取れませんでした。押し直してください',
  };
  const cla = {
    not_granted: 'Claudeの利用が許可されませんでした',
    sampling_disabled: 'このアカウントではClaudeを使えません',
    rate_limited: 'Claudeの利用が混み合っているか、利用上限に達しました。少し待ってから押し直してください',
    session_expired: 'claude.ai に再ログインしてください',
    refused: 'この部分は訳せませんでした',
    invalid_json: '翻訳結果を読み取れませんでした。押し直してください',
  };
  const geminiOnly = ['blocked', 'network', 'no_key', 'bad_key', 'bad_model', 'bad_request'];
  if (code === 'unavailable') return aiUnavailableText();
  if (geminiOnly.includes(code)) return gem[code];
  return (aiProvider() === 'gemini' ? gem : cla)[code] || FALLBACK;
}

// ---- Gemini ----
// Did the page's Content-Security-Policy block a request to Gemini? (The event is dispatched to the document.)
let cspHits = 0;
let lastNetDetail = '';
let lastGoogleDetail = '';   // Google's error status and message for the last refused request   // the browser's own words for the last failed connection (shown with the message)
document.addEventListener('securitypolicyviolation', (e) => {
  if (String(e.blockedURI || '').includes('generativelanguage.googleapis.com')) cspHits++;
});
const modelOk = (m) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(m);
export function geminiModel(tier) {
  const own = String(settings.modelOwn || '').trim().replace(/^models\//, '');
  const m = settings.model || 'auto';
  if (m === 'own' && modelOk(own)) return own;
  if (m === 'flash') return GEMINI_FAST;
  if (m === 'pro') return GEMINI_PRO;
  return tier === 'complex' ? GEMINI_PRO : GEMINI_FAST;
}
const err = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
export function parseJsonText(text) {
  const t = String(text || '').trim();
  try { return JSON.parse(t); } catch { /* try below */ }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* try below */ } }
  const a = t.search(/[[{]/), b = Math.max(t.lastIndexOf('}'), t.lastIndexOf(']'));
  if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch { /* fall through */ } }
  throw err('invalid_json');
}
// Tries the chosen model; when Google answers "no such model" (404), moves on to the next candidate
// (Pro -> Flash alias -> fixed Flash names), so a retired or not-yet-available model never blocks the feature.
let workingFast = '';     // the Flash name that last answered, tried first for the rest of this visit
export async function geminiJson(prompt, opts = {}) {
  const first = opts.model || geminiModel(opts.modelTier);
  const own = settings.model === 'own' && first === String(settings.modelOwn || '').trim().replace(/^models\//, '');
  const flash = [workingFast, GEMINI_FAST, ...FAST_FALLBACKS].filter(Boolean);
  const list = own ? [first] : [...new Set(first === GEMINI_PRO ? [GEMINI_PRO, ...flash] : [...flash, first])];
  let lastErr = null;
  for (const model of list) {
    try {
      const out = await geminiOnce(prompt, { ...opts, model });
      if (model !== GEMINI_PRO) workingFast = model;
      lastModel = model;
      return out;
    } catch (e) {
      if (e?.code !== 'bad_model') throw e;
      lastErr = e;
    }
  }
  throw lastErr || err('bad_model');
}
export let lastModel = '';
async function geminiOnce(prompt, opts = {}) {
  const key = geminiKey();
  if (!key) throw err('no_key');
  const model = opts.model || geminiModel(opts.modelTier);
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, opts.timeout || 170000);
  const outer = opts.signal;
  const onAbort = () => ctrl.abort();
  if (outer) { if (outer.aborted) ctrl.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  const hitsBefore = cspHits;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: String(prompt) }] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
  });
  const base = `${API}${encodeURIComponent(model)}:generateContent`;
  const common = { method: 'POST', body, signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' };
  try {
    let res;
    try {
      res = await fetch(base, { ...common, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key } });
    } catch (e) {
      if (ctrl.signal.aborted) throw err(timedOut ? 'timeout' : 'cancelled');
      // A CSP block rejects at once with a TypeError; the violation event may arrive a moment later.
      await new Promise(r => setTimeout(r, 60));
      if (cspHits > hitsBefore || LINK || /claudeusercontent\.com$|claude\.ai$/.test(location.hostname)) { geminiBlocked = true; changed(); throw err('blocked'); }
      // Some in-app browsers fail the CORS preflight that a custom header triggers. Retry once as a
      // "simple" request (key as the documented ?key= parameter, text/plain body: no preflight).
      try {
        res = await fetch(`${base}?key=${encodeURIComponent(key)}`, { ...common, headers: { 'Content-Type': 'text/plain;charset=UTF-8' } });
      } catch (e2) {
        if (ctrl.signal.aborted) throw err(timedOut ? 'timeout' : 'cancelled');
        lastNetDetail = `${e2?.name || e?.name || 'Error'}: ${String(e2?.message || e?.message || '').slice(0, 120)}`;
        throw err('network');
      }
    }
    lastNetDetail = '';
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (!res.ok) {
      const status = String(data?.error?.status || ''), msg = String(data?.error?.message || '');
      const reasons = JSON.stringify(data?.error?.details || '');
      const reason = (data?.error?.details || []).map(d => d?.reason).filter(Boolean)[0] || '';
      lastGoogleDetail = `${res.status}${status ? ' ' + status : ''}${reason ? ' / ' + reason : ''}${msg ? ': ' + msg.replace(/AIza[0-9A-Za-z_-]+/g, '…').slice(0, 160) : ''}`;
      if (res.status === 429 || res.status === 503 || status === 'RESOURCE_EXHAUSTED' || status === 'UNAVAILABLE') throw err('rate_limited', { status: res.status });
      if (res.status === 401 || res.status === 403 || /API_KEY_INVALID|API key/i.test(reasons + msg)) throw err('bad_key', { status: res.status });
      if (res.status === 404) throw err('bad_model', { status: res.status });
      if (res.status === 400) throw err('bad_request', { status: res.status });
      throw err('upstream_error', { status: res.status });
    }
    if (data?.promptFeedback?.blockReason) throw err('refused');
    const c = data?.candidates?.[0];
    if (!c) throw err('refused');
    const text = (c.content?.parts || []).filter(p => !p.thought).map(p => p.text || '').join('');
    if (!text.trim()) throw err(['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'OTHER'].includes(c.finishReason) ? 'refused' : 'invalid_json');
    return parseJsonText(text);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onAbort);
  }
}

// ---- 「AIの設定」 dialog ----
const $ = (s) => document.querySelector(s);
function setStatus(text, bad = false) {
  const s = $('#aiStatus'); if (!s) return;
  s.textContent = text; s.classList.toggle('err', bad);
}
function syncForm() {
  const dlg = $('#aiDlg'); if (!dlg) return;
  const p = aiProvider();
  dlg.querySelectorAll('input[name="aiProv"]').forEach(r => { r.checked = r.value === p; });
  $('#aiGemini').hidden = p !== 'gemini';
  $('#aiModel').value = ['auto', 'flash', 'pro', 'own'].includes(settings.model) ? settings.model : 'auto';
  $('#aiModelOwn').value = settings.modelOwn || '';
  $('#aiModelOwnWrap').hidden = $('#aiModel').value !== 'own';
  $('#aiClearKey').disabled = !hasGeminiKey();
  $('#aiClearKey').hidden = $('#aiSave').hidden = p !== 'gemini' && !hasGeminiKey();
  const k = geminiKey();
  $('#aiKeyState').textContent = k ? `保存済みのキー: ${k.slice(0, 4)}…（${k.length}文字）。入れ直すと置き換えます。` : 'キーはまだ保存されていません。';
  $('#aiEnvNote').textContent = LINK
    ? 'いまは claude.ai 上（リンク版）で開いています。ここからは Gemini に接続できないことがあります（「接続テスト」で確かめられます）。Gemini は、このアプリを claude.ai 以外（フォルダ版・自分のサイトなど）で開いたときに使えます。'
    : 'Claude は claude.ai で開いたリンク版だけで使えます。ここでは Gemini を使ってください。';
  updateOpener();
}
function updateOpener() {
  const n = document.querySelector('#aiOpenName'); if (!n) return;
  n.textContent = aiName() + (aiWhyNot() ? '（未設定）' : '');
}
// Saves what is in the form. The key field is saved only when something was typed (キーを消す removes it).
function saveForm() {
  const prov = document.querySelector('input[name="aiProv"]:checked')?.value;
  if (prov === 'claude' || prov === 'gemini') settings.provider = prov;
  settings.model = $('#aiModel').value;
  const own = $('#aiModelOwn').value.trim().replace(/^models\//, '');
  settings.modelOwn = own;
  saveSettings();
  const typed = $('#aiKey').value.trim();
  if (typed) { setGeminiKey(typed); $('#aiKey').value = ''; }
  geminiBlocked = false;
  syncForm(); changed();
  if (settings.model === 'own' && !modelOk(own)) { setStatus('モデル名を入れてください（例: gemini-flash-latest）。それまでは「おまかせ」と同じモデルを使います。', true); return false; }
  return true;
}
async function testConnection() {
  if (!saveForm()) return;
  const btn = $('#aiTest'); btn.disabled = true;
  try {
    if (aiProvider() === 'claude') {
      setStatus('Claude を確かめています…');
      setStatus((await useClaude()) ? 'Claude を使えます（実際に送るのは、各AIボタンを押したときです）。' : `${aiWhyNot()}。`, !sampler);
      return;
    }
    if (!hasGeminiKey()) { setStatus('APIキーを入れてから押してください。', true); return; }
    setStatus('Gemini に接続しています…');
    const out = await geminiJson('Reply with ONLY this JSON object: {"ok": true}', { modelTier: 'quick', timeout: 45000 });
    setStatus(out && typeof out === 'object' ? `接続できました（モデル: ${lastModel}）。AIボタンは Gemini を使います。` : '接続できましたが、答えの形が想定と違いました。', !(out && typeof out === 'object'));
  } catch (e) {
    const code = e?.code || '';
    setStatus(code === 'timeout' ? '応答がありませんでした。少し待ってから押し直してください。' : `${providerErrorText(code)}。`, true);
  } finally { btn.disabled = false; updateOpener(); }
}
function initDialog() {
  const dlg = $('#aiDlg'), open = $('#aiOpen');
  if (!dlg || !open) return;
  open.onclick = () => { syncForm(); setStatus(''); $('#aiKey').value = ''; dlg.showModal?.() ?? dlg.setAttribute('open', ''); };
  dlg.querySelectorAll('input[name="aiProv"]').forEach(r => r.onchange = () => { saveForm(); setStatus(`AIの提供元を ${aiName()} にしました。`); });
  $('#aiModel').onchange = () => { $('#aiModelOwnWrap').hidden = $('#aiModel').value !== 'own'; if ($('#aiModel').value !== 'own') saveForm(); };
  $('#aiModelOwn').onchange = () => saveForm();
  $('#aiKey').onkeydown = (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); $('#aiSave').click(); } };
  $('#aiSave').onclick = () => { const typed = !!$('#aiKey').value.trim(); if (saveForm()) setStatus(typed ? 'キーを保存しました。「接続テスト」で確かめられます。' : '保存しました。'); };
  $('#aiTest').onclick = testConnection;
  $('#aiClearKey').onclick = () => { setGeminiKey(''); $('#aiKey').value = ''; geminiBlocked = false; syncForm(); changed(); setStatus('この端末に保存していたキーを消しました。'); };
  $('#aiClose').onclick = () => dlg.close?.();
  updateOpener();
  // The link version learns whether Claude is reachable when a feature asks; keep the label current.
  onAiChange(updateOpener);
}
initDialog();
window.__ai = { aiProvider, aiName, aiWhyNot, aiReady, aiJson, geminiModel };   // test hook (never exposes the key)
