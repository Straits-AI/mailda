// The `.client.js` sources are bundled as text (wrangler.jsonc `rules`), so an import of
// this module yields the file's contents as a string rather than a module namespace.
//
// The node test does not import it through TypeScript at all: it evaluates the same string, so what is
// tested is the bytes a browser is served rather than a second copy that could drift.
declare const source: string;
export default source;
