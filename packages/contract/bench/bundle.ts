import { build } from "esbuild";

/** Bundle cost of each validator path, minified — 9 Workers pay this at cold start. */
async function sizeOf(label: string, contents: string): Promise<number> {
  const result = await build({
    stdin: { contents, resolveDir: import.meta.dirname, loader: "ts" },
    bundle: true, minify: true, format: "esm", platform: "browser",
    write: false, logLevel: "silent",
  });
  const bytes = result.outputFiles[0]!.contents.byteLength;
  console.log(`MEASURE bundle ${label.padEnd(28)} ${(bytes / 1024).toFixed(1)} KiB`);
  return bytes;
}

const zod = await sizeOf("zod + schema", `
  import { sendMailInput } from "../src/send-mail.ts";
  export default { fetch: (r: Request) => new Response(String(sendMailInput.safeParse({}).success)) };
`);
const ajv = await sizeOf("ajv2020 + formats", `
  import Ajv from "ajv/dist/2020.js";
  import addFormats from "ajv-formats";
  const a = new Ajv({ strict: false }); addFormats(a);
  const v = a.compile({ type: "object" });
  export default { fetch: (r: Request) => new Response(String(v({}))) };
`);
console.log(`MEASURE bundle delta (ajv - zod)     ${((ajv - zod) / 1024).toFixed(1)} KiB`);
