/**
 * Screenshot the banner with SOFTWARE WebGL.
 *
 * The gstack browser has no WebGL at all — `shader-field.tsx` documents exactly this — so the paper
 * shader threw "WebGL is not supported" and the page rendered a flat background that looked like a
 * design decision. SwiftShader is Chromium's software rasteriser: slower, and pixel-identical for
 * a still frame, which is all a PNG needs.
 */
/*
  RESOLVED, NOT HARDCODED. This was an absolute path into one machine's checkout
  (`/Users/.../conakry/cloud/node_modules/playwright`), in a repository that is Apache-2.0 and
  cloned by strangers — so for everyone but the author it threw ERR_MODULE_NOT_FOUND on line one.
  `MYCEL_PLAYWRIGHT` overrides for an unusual layout; otherwise it is an ordinary resolution.
*/
const { chromium } = await import(process.env.MYCEL_PLAYWRIGHT || "playwright").catch(() => {
  console.error(
    "playwright is not installed. `npm i -D playwright && npx playwright install chromium`,\n" +
      "or set MYCEL_PLAYWRIGHT to the path of an existing install.",
  );
  process.exit(2);
});

const [, , url, out, w, h] = process.argv;
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  /*
    2× so the grain and the type are retina-sharp; LinkedIn serves the image down.

    `MYCEL_DPR=1` for anything that does NOT get served down. The README hero came out at 4864px and
    6.7MB because it inherited the LinkedIn default — a seven-megabyte image above the fold on a repo
    page, which is the first thing a visitor waits for and the last thing they should have to.
  */
  deviceScaleFactor: +(process.env.MYCEL_DPR || 2),
});
const errs = [];
page.on("pageerror", (e) => errs.push(String(e.message)));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => document.title === "ready", { timeout: 15000 }).catch(() => {});
const canvas = await page.evaluate(() => {
  const c = document.querySelector("#shader canvas");
  return c ? `${c.width}x${c.height}` : "NO CANVAS";
});
await page.waitForTimeout(1200);
await page.locator("#stage").screenshot({ path: out });
console.log(`canvas ${canvas}${errs.length ? "  errors: " + errs.join(" | ") : ""}`);
await browser.close();
