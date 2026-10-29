// Fills in newer JavaScript features that the bundled pdf.js (6.x) calls without checking,
// for WebKit (iPhone/iPad Safari and Chrome on iOS) and older desktop browsers.
// Each piece installs only when the browser lacks it, so modern browsers are unaffected.
// Loaded first in the page (main.js) and in the pdf.js worker (pdf-worker.mjs).
//
// Root cause it fixes: PDFPageProxy.getTextContent() does `for await (const t of stream)` over a
// ReadableStream. WebKit has no ReadableStream async iteration, so every PDF failed on iOS with
// "undefined is not a function (near '...t of e...')".
const G = typeof globalThis !== 'undefined' ? globalThis : self;
const def = (obj, name, value) => {
  if (obj && typeof obj[name] !== 'function') {
    Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false });
  }
};

// ReadableStream async iteration (for await … of stream; stream.values())
if (G.ReadableStream && !G.ReadableStream.prototype[Symbol.asyncIterator]) {
  const values = function ({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const r = await reader.read();
          if (r.done) reader.releaseLock();
          return r;
        } catch (e) { reader.releaseLock(); throw e; }
      },
      async return(value) {
        if (!preventCancel) { try { await reader.cancel(value); } catch { /* already closed */ } }
        reader.releaseLock();
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  def(G.ReadableStream.prototype, 'values', values);
  Object.defineProperty(G.ReadableStream.prototype, Symbol.asyncIterator, { value: values, writable: true, configurable: true });
}

// Map / WeakMap upsert (getOrInsert, getOrInsertComputed)
for (const C of [G.Map, G.WeakMap]) {
  if (!C) continue;
  def(C.prototype, 'getOrInsert', function (key, value) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  def(C.prototype, 'getOrInsertComputed', function (key, fn) {
    if (!this.has(key)) this.set(key, fn(key));
    return this.get(key);
  });
}

// Math.sumPrecise (pdf.js sums integer lengths, where a plain sum is exact)
def(Math, 'sumPrecise', function (items) {
  let s = 0, c = 0;                       // Kahan summation for non-integers
  for (const x of items) { const y = +x - c; const t = s + y; c = (t - s) - y; s = t; }
  return s;
});

// Promise helpers
def(Promise, 'withResolvers', function () {
  let resolve, reject;
  const promise = new this((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
});
def(Promise, 'try', function (fn, ...args) {
  return new this((resolve) => resolve(fn(...args)));
});

// Uint8Array base64 / hex
if (G.Uint8Array) {
  const U = G.Uint8Array;
  def(U, 'fromBase64', function (str) {
    const bin = atob(String(str).replace(/[\s]/g, '').replace(/-/g, '+').replace(/_/g, '/'));
    const out = new U(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  });
  def(U, 'fromHex', function (str) {
    const s = String(str), out = new U(s.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  });
  def(U.prototype, 'toHex', function () {
    let s = '';
    for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
    return s;
  });
  def(U.prototype, 'toBase64', function () {
    let bin = '';
    for (let i = 0; i < this.length; i += 0x8000) bin += String.fromCharCode.apply(null, this.subarray(i, i + 0x8000));
    return btoa(bin);
  });
}

// Iterator helpers used by pdf.js (map/filter/toArray/some/every/find/forEach/reduce/flatMap/take/drop)
// on Map/Set/Array iterators. Installed on the shared iterator prototype when missing.
(() => {
  const IterProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));
  if (!IterProto || typeof IterProto.map === 'function') return;
  const wrap = (gen) => function (...a) { return gen.call(this, ...a); };
  def(IterProto, 'map', wrap(function* (fn) { let i = 0; for (const x of this) yield fn(x, i++); }));
  def(IterProto, 'filter', wrap(function* (fn) { let i = 0; for (const x of this) if (fn(x, i++)) yield x; }));
  def(IterProto, 'flatMap', wrap(function* (fn) { let i = 0; for (const x of this) yield* fn(x, i++); }));
  def(IterProto, 'take', wrap(function* (n) { if (n <= 0) return; let i = 0; for (const x of this) { yield x; if (++i >= n) return; } }));
  def(IterProto, 'drop', wrap(function* (n) { let i = 0; for (const x of this) if (i++ >= n) yield x; }));
  def(IterProto, 'toArray', function () { return [...this]; });
  def(IterProto, 'forEach', function (fn) { let i = 0; for (const x of this) fn(x, i++); });
  def(IterProto, 'some', function (fn) { let i = 0; for (const x of this) if (fn(x, i++)) return true; return false; });
  def(IterProto, 'every', function (fn) { let i = 0; for (const x of this) if (!fn(x, i++)) return false; return true; });
  def(IterProto, 'find', function (fn) { let i = 0; for (const x of this) if (fn(x, i++)) return x; return undefined; });
  def(IterProto, 'reduce', function (fn, ...init) {
    let i = 0, acc, first = !init.length;
    if (!first) acc = init[0];
    for (const x of this) { if (first) { acc = x; first = false; } else acc = fn(acc, x, i); i++; }
    if (first) throw new TypeError('Reduce of empty iterator with no initial value');
    return acc;
  });
})();
