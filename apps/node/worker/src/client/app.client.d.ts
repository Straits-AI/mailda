// The `.client.js` sources are bundled as text (wrangler.jsonc `rules`), so an import of
// this module yields the file's contents as a string rather than a module namespace.
declare const source: string;
export default source;
