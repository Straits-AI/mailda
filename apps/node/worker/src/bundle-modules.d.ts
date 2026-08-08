// esbuild's output for the React application, bundled as text by wrangler's Text rule so `ui.ts` can
// serve it verbatim (ADR 30).
//
// A wildcard declaration rather than a file beside the artifact, because the artifact is generated and
// gitignored — a `.d.ts` next to it would be ignored with it, and a fresh clone would not typecheck until
// somebody had run a build. This way the type is committed and the bytes are not.
declare module "*.bundle.client.js" {
  const source: string;
  export default source;
}
