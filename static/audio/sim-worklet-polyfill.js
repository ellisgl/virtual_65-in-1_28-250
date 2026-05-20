/**
 * sim-worklet-polyfill.js — installed via AudioContext.audioWorklet.addModule()
 * BEFORE sim-rust-worklet.js.  Multiple modules added to the same AudioContext
 * share one WorkletGlobalScope, so the polyfills below land on the global
 * `globalThis` before the simulator worklet's static import of sim_wasm.js
 * evaluates.  Without these, wasm-bindgen's generated JS glue throws
 * "TextDecoder is not defined" at module-load time in browsers/versions whose
 * AudioWorkletGlobalScope doesn't expose those interfaces (older Chrome,
 * Safari before 15, embedded contexts).
 *
 * The polyfills are ASCII-correct minimal versions.  Every string crossing
 * the JS↔WASM boundary in this project is a component identifier
 * ('SPK1', 'T1:Lp1', 'KEY1', etc.), which fits in 7-bit ASCII.  Full UTF-8
 * isn't needed — keeping the impls tiny keeps the worklet quick to load.
 *
 * This file deliberately does NOT call registerProcessor.  Its only job is
 * to install globals; sim-rust-worklet.js handles the actual processor
 * registration.
 */

if (typeof globalThis.TextDecoder === 'undefined') {
    globalThis.TextDecoder = class TextDecoder {
        constructor() {}
        decode(buf) {
            const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
            // Chunked spread to avoid the call-stack limit on large buffers
            // (String.fromCharCode + spread blows at ~100k args in most engines).
            let out = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < bytes.length; i += CHUNK) {
                out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
            }
            return out;
        }
    };
}

if (typeof globalThis.TextEncoder === 'undefined') {
    globalThis.TextEncoder = class TextEncoder {
        encode(str) {
            const bytes = new Uint8Array(str.length);
            for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 0xff;
            return bytes;
        }
        encodeInto(str, dest) {
            // wasm-bindgen prefers encodeInto for zero-copy string passing.
            const len = Math.min(str.length, dest.length);
            for (let i = 0; i < len; i++) dest[i] = str.charCodeAt(i) & 0xff;
            return { read: len, written: len };
        }
    };
}
