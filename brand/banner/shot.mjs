/**
 * Screenshot the banner with SOFTWARE WebGL.
 *
 * The gstack browser has no WebGL at all — `shader-field.tsx` documents exactly this — so the paper
 * shader threw "WebGL is not supported" and the page rendered a flat background that looked like a
 * design decision. SwiftShader is Chromium's software rasteriser: slower, and pixel-identical for
 * a still frame, which is all a PNG needs.
 */
import { chromium } from "/Users/islam/conductor/workspaces/agentic-stack-v1/conakry/cloud/node_modules/playwright/index.mjs";

const [, , url, out, w, h] = process.argv;
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({
  viewport: { width: +w, height: +h },
  // 2× so the grain and the type are retina-sharp; LinkedIn serves the image down.
  deviceScaleFactor: 2,
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
