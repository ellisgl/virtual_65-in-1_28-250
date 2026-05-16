// src/worklet.d.ts
/// <reference lib="webworker" />

/**
 * Vite bundled-worker URL import.
 * `import url from './something.ts?worker&url'` resolves to a string containing
 * the URL of the bundled worker/worklet file (all TypeScript + imports compiled).
 * Used for AudioWorklet.addModule() which needs a URL, not a Worker constructor.
 */
declare module '*?worker&url' {
    const url: string;
    export default url;
}
