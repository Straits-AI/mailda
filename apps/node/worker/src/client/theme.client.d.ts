// The `.client.js` sources are bundled as text (wrangler.jsonc `rules`), so an import of
// this module yields the file's contents as a string rather than a module namespace.
//
// `ui.ts` serves that string as `/app/theme.js`, which both the framework-free script and the React shell
// import; the types a caller needs are in `app/types/theme.d.ts`.
declare const source: string;
export default source;
