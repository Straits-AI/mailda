import { describe, expect, it } from "vitest";

import themeScript from "../src/client/theme.client.js";
import { frameStylesheet, themeCss } from "../src/theme.ts";
import { clientAsset } from "../src/ui.ts";

/**
 * What the Worker serves for the look of every page: the shell's sheet, the body frame's sheet, and the
 * module that applies the viewer's theme.
 *
 * The node tests read `SHELL_CSS` and `frameStylesheet()` as values; this reads the responses, because the
 * failure worth catching here is a wiring one. The `/app/theme.js` entry is the sharpest: the page's first
 * script (`src/client/app.client.js`) imports it statically, so without it the module graph fails and no page
 * boots at all, not even the sign-in.
 */

describe("the served stylesheets and theme module", () => {
  it("serves the shell's sheet beginning with the theme blocks", async () => {
    const response = clientAsset("/app/app.css");
    expect(response?.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect((await response!.text()).startsWith(themeCss())).toBe(true);
  });

  it("serves the body frame's sheet as CSS, byte for byte", async () => {
    // A frame refuses a stylesheet whose type is not CSS, and then renders the sender's markup in browser
    // defaults: black on white inside a dark reader.
    const response = clientAsset("/app/frame.css");
    expect(response, "/app/frame.css is not served").not.toBeNull();
    expect(response!.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(response!.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await response!.text()).toBe(frameStylesheet());
  });

  it("serves the theme module as JavaScript, byte for byte", async () => {
    const response = clientAsset("/app/theme.js");
    expect(response, "/app/theme.js is not served, so app.js cannot import it and no page boots").not.toBeNull();
    expect(response!.status).toBe(200);
    expect(response!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(await response!.text()).toBe(themeScript);
  });
});
