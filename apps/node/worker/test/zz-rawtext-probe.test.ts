import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "../src/render/body.ts";

const cases: Record<string, string> = {
  xmp_link_preconnect:
    '<p>Hello</p><xmp><link rel="preconnect" href="https://m42-alice.tracker.example"></xmp>',
  xmp_img: '<xmp><img src="https://tracker.example/x.gif"></xmp>',
  XMP_upper: '<XMP><img src="https://tracker.example/x.gif"></XMP>',
  xmp_unterminated: '<xmp><img src="https://tracker.example/x.gif">',
  noembed_img: '<noembed><img src="https://tracker.example/x.gif"></noembed>',
  noframes_img: '<noframes><img src="https://tracker.example/x.gif"></noframes>',
  plaintext_img: '<p>hi</p><plaintext><img src="https://tracker.example/x.gif">',
  nested_noembed: '<noembed><noembed><img src="https://tracker.example/x.gif"></noembed></noembed>',
  inside_keep: '<div><p>hi</p><xmp><img src="https://tracker.example/x.gif"></xmp></div>',
  xmp_style: '<xmp><style>body{background:url(https://tracker.example/b.png)}</style></xmp>',
  xmp_iframe: '<xmp><iframe src="https://tracker.example/f"></iframe></xmp>',
  xmp_meta: '<xmp><meta http-equiv="refresh" content="0;url=https://tracker.example/r"></xmp>',
  xmp_svg: '<xmp><svg><image href="https://tracker.example/s.png"></svg></xmp>',
  xmp_body_bg: '<xmp><body background="https://tracker.example/bg.png"></xmp>',
  noscript_img: '<noscript><img src="https://tracker.example/x.gif"></noscript>',
  textarea_img: '<textarea><img src="https://tracker.example/x.gif"></textarea>',
  title_img: '<title><img src="https://tracker.example/x.gif"></title>',
  bare_link_preconnect: '<link rel="preconnect" href="https://m42-alice.tracker.example">',
};

describe("rawtext-probe", () => {
  for (const [name, input] of Object.entries(cases)) {
    it(name, async () => {
      const r = await sanitizeHtml(input);
      console.log(`\n### ${name}\n  IN : ${input}\n  OUT: ${r.html}\n  blockedRemote=${r.blockedRemote}`);
      expect(true).toBe(true);
    });
  }
});
