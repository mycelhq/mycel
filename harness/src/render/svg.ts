// Scene → SVG. The cheap half: the scene already IS SVG, so this is serialisation, not layout.
import { cssFamily, fontFor } from "./fonts";
import type { Scene } from "./scene";

/** Attribute-safe. Every string in a scene came from a tenant's data — a client's company name is
 *  user input and this is the boundary where it becomes markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const n = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

export function toSvg(scene: Scene): string {
  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${scene.width}" height="${scene.height}" viewBox="0 0 ${scene.width} ${scene.height}">`,
    `<title>${esc(scene.title)}</title>`,
    `<rect x="0" y="0" width="${scene.width}" height="${scene.height}" fill="${esc(scene.background)}"/>`,
  ];
  for (const node of scene.nodes) {
    if (node.t === "rect") {
      out.push(
        `<rect x="${n(node.x)}" y="${n(node.y)}" width="${n(node.w)}" height="${n(node.h)}" fill="${esc(node.fill)}"${node.rx ? ` rx="${n(node.rx)}"` : ""}/>`,
      );
    } else if (node.t === "line") {
      out.push(
        `<line x1="${n(node.x1)}" y1="${n(node.y1)}" x2="${n(node.x2)}" y2="${n(node.y2)}" stroke="${esc(node.stroke)}" stroke-width="${n(node.width)}"/>`,
      );
    } else if (node.t === "text") {
      const font = fontFor(node.family, node.weight);
      const weight = node.weight === "bold" ? ` font-weight="bold"` : "";
      const tracking = node.tracking ? ` letter-spacing="${n(node.tracking)}"` : "";
      out.push(
        `<text x="${n(node.x)}" y="${n(node.y)}" font-family="${cssFamily(font)}" font-size="${n(node.size)}"${weight} fill="${esc(node.fill)}" text-anchor="${node.anchor}"${tracking}>${esc(node.text)}</text>`,
      );
    } else {
      out.push(
        `<image x="${n(node.x)}" y="${n(node.y)}" width="${n(node.w)}" height="${n(node.h)}" href="data:${esc(node.mime)};base64,${node.data}" preserveAspectRatio="xMinYMid meet"/>`,
      );
    }
  }
  out.push(`</svg>`);
  return out.join("\n");
}
