// OCR worker entry for the claude.ai link version. That host does not serve .gz files, so the
// English model is published as base64 text; this shim answers Tesseract's request for
// eng.traineddata.gz from that text, then loads the unmodified Tesseract.js worker.
const base = new URL('../vendor/tesseract/', self.location.href);
const realFetch = self.fetch.bind(self);
self.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  if (/\/eng\.traineddata\.gz(?:$|\?)/.test(url)) {
    const res = await realFetch(new URL('lang/eng.traineddata.gz.b64.txt', base));
    if (!res.ok) return res;
    const bin = atob((await res.text()).trim());
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }
  return realFetch(input, init);
};
importScripts(new URL('worker.min.js', base).href);
