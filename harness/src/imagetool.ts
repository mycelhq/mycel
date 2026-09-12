// ═══ THE ASSET A GENERATED PAGE HAS NEVER HAD ═══
//
// Until this, every site and deck this product built shipped grey rectangles. Not by accident —
// `design-lint.ts` REFUSES external placeholder CDNs (`unsplash`, `placehold.co`, `picsum`) with
// "fragile, looks fake when it 404s", which is correct, and then offers `.ph-img` as the only
// alternative. So the linter was right and the cupboard was bare: an agent asked to make something
// look designed had a palette, a type scale, craft rules about composition — and nothing to put in
// the frame. It drew SVG by hand, which is what a person does when you take their camera away.
//
// ═══ WHY A CLI TOOL AND NOT AN MCP SERVER ═══
//
// open-design reaches image models through MCP: higgsfield, fal.ai, pollinations, registered as
// servers the agent calls. That is the right shape for a desktop app with a settings screen and a
// user who pastes API keys.
//
// It is the wrong shape here. Our MCP bridge exists to put GATED, credentialed actions in front of
// a model — every tool it mounts is an authenticated POST to the action proxy, and the approval
// gate is the point of it. Image generation is none of those things: it spends no money on the
// anonymous tier, touches no customer, writes no system of record, and needs no approval. Routing
// it through the gate would put a human in the loop of "draw a picture", which is how an approval
// queue becomes noise nobody reads.
//
// `mycel-build` and `mycel-insight` are already CLI tools written into the sandbox for exactly this
// reason — capability the agent reaches for with bash, no credential, no gate. This is the third.
//
// ═══ AND THE FIRST VERSION OF THIS FILE WAS WORSE THAN THE GREY BOX ═══
//
// It called a free, keyless endpoint. It worked first try and produced a muddy blob — exactly what
// an anonymous tier gives you. Shipping that to a client's homepage is not a capability, it is a
// downgrade with extra steps, and it contradicts every other refusal in this codebase: the
// grounding floor will not write ungrounded copy, `designSystemFilesFor` will not invent a colour,
// `mycel-insight` will not report evidence it does not have. A tool that always answers, badly, is
// the one thing none of them would do.
//
// REAL PROVIDERS OR NOTHING. FLUX via fal.ai, higgsfield, or an OpenAI-compatible image endpoint —
// each behind a key an operator supplies deliberately. With no key the tool is NOT INSTALLED and
// NOT DOCUMENTED, and the agent composes without photography, which is a thing good designers do
// on purpose and which the craft shelf already teaches.

/** Where the tool lands. Same directory as `mycel-build` and `mycel-insight`. */
export const IMAGE_TOOL_PATH = "/usr/local/bin/mycel-image";

/**
 * A real model behind a real key. There is deliberately no keyless entry — the free tiers are the
 * ones that produce the blob, and a fallback that silently degrades quality is worse than a tool
 * that is absent, because absent is visible and degraded is not.
 */
export interface ImageProvider {
  kind: "fal" | "higgsfield" | "openai" | "bedrock";
  /**
   * For a keyed provider, the provider's key. For `bedrock`, the run's PROXY NONCE.
   *
   * Bedrock is reached through the kernel, not from the sandbox, so what goes into the sandbox is a
   * short-lived, task-scoped nonce that only opens our own endpoint. See `imageToolScript`.
   */
  key: string;
  model?: string;
  /** Where the tool posts. Only `bedrock` sets it — the others have fixed provider endpoints. */
  baseUrl?: string;
}

/**
 * Which provider this deployment has, or undefined.
 *
 * Ordered by output quality for what this tool is actually for — a hero, a divider, a texture —
 * not by price. FLUX first: it is the best of these at abstract work and the least prone to
 * smearing letters into pseudo-type, which is the failure that makes an image unusable on a page.
 *
 * The OpenAI path needs its OWN key rather than reusing the agent's. The agent's key is usually a
 * text key, and quietly trying an image model on it is a 400 per call and a run that spends its
 * budget discovering that.
 */
/**
 * The Bedrock model this reaches for, and why it is not the obvious one.
 *
 * `amazon.nova-canvas-v1:0` is the model AWS puts first and it is END OF LIFE ON 30 SEPTEMBER 2026 —
 * weeks from now. AWS's own migration note points at Stability's Ultra, Core and SD3.5 Large as the
 * successors, so building on Canvas would have meant shipping something with a expiry date already
 * printed on it.
 *
 * Ultra rather than Core: what this tool is FOR is atmospheric and textural work behind a headline,
 * where lighting and material are the whole job and a cheap render reads as a stock photo. Core is
 * roughly half the price and the right choice for volume; this is one hero per site.
 *
 * It lives in us-west-2, which is why the region default is there and not in Ireland. eu-west-1
 * carries only the dying Canvas.
 *
 * ═══ AND IT IS THE FLOOR, NOT A GOOD MODEL. SAID PLAINLY. ═══
 *
 * Checked rather than assumed, September 2026: Stable Image Ultra does not appear on the image
 * arenas at all. The boards are GPT Image 2 by the largest first-to-second gap any of them has
 * recorded, then Google's Nano Banana Pro, then FLUX.2. Bedrock's image shelf is not in that
 * conversation, and pretending otherwise here would be the exact dishonesty this codebase spends
 * its comments avoiding.
 *
 * It stays because a free floor beats a grey box, and because `design-lint.ts` refuses placeholder
 * CDNs so the alternative really is nothing. For an abstract gradient behind a headline — no text,
 * no faces, no product — the gap to the frontier is much smaller than a leaderboard implies, and
 * that is the ONLY work this tool is permitted to do.
 *
 * For anything a client will look at closely, set `MYCEL_IMAGE_OPENAI_KEY` and get `gpt-image-2`.
 * `images_per_month` bounds what that can cost, which is what makes reaching for the better model a
 * decision about quality rather than a decision about risk.
 */
export const BEDROCK_IMAGE_MODEL = "stability.stable-image-ultra-v1:1";

export function imageProviderFromEnv(env: NodeJS.ProcessEnv = process.env): ImageProvider | undefined {
  const model = env.MYCEL_IMAGE_MODEL?.trim() || undefined;

  /**
   * ═══ A KEY SOMEBODY WENT AND BOUGHT IS A DELIBERATE CHOICE ═══
   *
   * The keyed providers come first because setting one is an act: an operator decided this
   * deployment should use that model and paid for it. Bedrock below is the FLOOR — what runs when
   * nobody has chosen anything — not a preference that overrules a decision already made.
   *
   * `gpt-image-2` leads the blind-preference boards by a margin they have not seen before: ~1512
   * Elo against ~1270 for second place. It is also, at the size this tool actually asks for, about
   * 0.8 cents — measured, not quoted. The $0.22 number attached to it elsewhere is the 2K/4K tier.
   */
  /**
   * `flux-2-pro`, not `flux/dev`.
   *
   * The old default was FLUX.1 [dev] — a distilled research release, a year and a major version out
   * of date, and chosen when this file's only job was to prove a picture could be fetched at all.
   * FLUX.2 [pro] is third on the 2026 image boards behind GPT Image 2 and Nano Banana Pro, which
   * makes it the best thing reachable here without an OpenAI image key.
   *
   * ~$0.03 per megapixel, so a 1536×864 hero is around four cents — the same order as the Bedrock
   * floor, for a model that is actually ranked. `images_per_month` bounds the rest.
   */
  /**
   * BEST FIRST, now that the best is actually reachable.
   *
   * fal used to lead this list because `gpt-image-2` needed a key nobody had set, so ordering by
   * quality would have meant ordering by a provider that was never configured. That is no longer
   * true: the deployment points `MYCEL_IMAGE_OPENAI_KEY` at the OpenAI secret it already holds.
   *
   * MEASURED, NOT ASSUMED. This key generated a 1024×1024 image at 196 output tokens — about 0.8
   * cents — and accepted 1536×864, the tool's own default, without complaint. The ~$0.22 figure
   * quoted around this file is the 2K/4K tier, and repeating it as the price of a hero would have
   * argued against the best model on the strength of a number four times too large.
   *
   * fal stays below it rather than being deleted. FLUX.2 is genuinely second best here and one
   * provider for anything is one outage away from grey boxes — but it is now the fallback it should
   * always have been rather than the default it became by accident.
   */
  const oai = env.MYCEL_IMAGE_OPENAI_KEY?.trim();
  if (oai) return { kind: "openai", key: oai, model: model ?? "gpt-image-2" };
  const fal = env.FAL_KEY?.trim() || env.MYCEL_FAL_KEY?.trim();
  if (fal) return { kind: "fal", key: fal, model: model ?? "fal-ai/flux-2-pro" };
  const hf = env.HIGGSFIELD_API_KEY?.trim();
  if (hf) return { kind: "higgsfield", key: hf, model };

  /**
   * ═══ AND BEDROCK IS THE FLOOR, BECAUSE IT NEEDS NO KEY AT ALL ═══
   *
   * Every entry above is a credential that has to be bought, stored, rotated and then handed to a
   * sandbox. Bedrock is reached with the kernel's own IAM role and billed to credits the business
   * already holds — and NOTHING SECRET ENTERS THE SANDBOX: the tool posts to the kernel with the
   * same short-lived proxy nonce the model proxy uses, and the kernel makes the AWS call.
   *
   * That is the real argument, not the money. An AWS credential inside an agent sandbox would reach
   * S3, ECS and everything else the role can touch; a scoped provider key is merely bad, and this
   * is neither.
   *
   * The REGION is named explicitly rather than inherited from wherever the task runs, because
   * Bedrock's image models are not everywhere — us-west-2 carries the Stability line, eu-west-1
   * carries only the dying Canvas, and eu-west-2, where this kernel runs, carries none at all.
   */
  const bedrockRegion = env.MYCEL_IMAGE_BEDROCK_REGION?.trim();
  if (bedrockRegion) return { kind: "bedrock", key: "", model: model ?? BEDROCK_IMAGE_MODEL };

  return undefined;
}

/**
 * `mycel-image "<prompt>" <out.png> [width] [height]`.
 *
 * Writes a real file and prints its path. Every failure exits non-zero and writes NOTHING: a
 * half-downloaded file in an `<img>` is worse than a missing one, because the page looks broken
 * rather than unfinished and the agent cannot tell which from an exit code.
 */
/**
 * `mycel-image "<prompt>" <out.png> [width] [height]`.
 *
 * ═══ EVERY PROVIDER GOES THROUGH THE KERNEL. NO CREDENTIAL EVER ENTERS A SANDBOX. ═══
 *
 * This used to have two shapes: Bedrock through the kernel, because an IAM role in a sandbox reaches
 * S3 and ECS — and the keyed providers called direct, on the reasoning that "a scoped provider key
 * is the only thing at risk".
 *
 * That reasoning failed the moment the deployment pointed `MYCEL_IMAGE_OPENAI_KEY` at the OpenAI
 * secret it already had. The key stopped being scoped: an agent could `printenv` a live org
 * credential, spend on it outside the per-org budget LiteLLM enforces, and walk straight past the
 * `images_per_month` ceiling by calling the provider itself. This file's own header had warned that
 * the OpenAI path "needs its OWN key rather than reusing the agent's" — the letter was satisfied
 * with a different variable name and the spirit was not.
 *
 * So there is one shape now, and it is the safe one. The sandbox holds a short-lived, task-scoped
 * nonce that opens exactly one endpoint of ours and dies with the run. The kernel holds the keys and
 * makes the call, which is also the only place the spend cap can be enforced rather than merely
 * hoped for.
 *
 * Every failure exits non-zero and writes NOTHING: a half-downloaded file in an `<img>` is worse
 * than a missing one, because the page looks broken rather than unfinished.
 */
export function imageToolScript(_p: ImageProvider): string {
  return [
    "#!/usr/bin/env bash",
    "# mycel-image — generate an image into this workspace, through the kernel.",
    "# Written by the kernel (imagetool.ts). Do not edit; it is overwritten every run.",
    "set -euo pipefail",
    'PROMPT="${1:-}"',
    'OUT="${2:-}"',
    'W="${3:-1536}"',
    'H="${4:-864}"',
    'if [ -z "$PROMPT" ] || [ -z "$OUT" ]; then',
    `  echo 'usage: mycel-image "<prompt>" <output.png> [width] [height]' >&2; exit 2`,
    "fi",
    'if [ -z "${MYCEL_IMAGE_URL:-}" ] || [ -z "${MYCEL_IMAGE_KEY:-}" ]; then',
    '  echo "mycel-image: image generation is not wired on this kernel." >&2; exit 3',
    "fi",
    'mkdir -p "$(dirname "$OUT")"',
    'TMP="$(mktemp)"; TMPJ="$(mktemp)"',
    // The prompt goes through argv into node and is JSON-encoded there, never interpolated into the
    // shell — the rule `verifyWorkspace` documents at length about the wrapper Daytona runs.
    `PAYLOAD="$(node -e 'const a=process.argv.slice(1);process.stdout.write(JSON.stringify({prompt:a[0],width:+a[1],height:+a[2]}))' "$PROMPT" "$W" "$H")"`,
    'if ! curl -sS -f --max-time 240 "$MYCEL_IMAGE_URL" \\',
    '     -H "authorization: Bearer $MYCEL_IMAGE_KEY" -H "content-type: application/json" \\',
    '     -d "$PAYLOAD" -o "$TMPJ"; then',
    '  rm -f "$TMP" "$TMPJ"; echo "mycel-image: the image service did not answer." >&2; exit 1',
    "fi",
    `if ! node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const b=d.image_base64;if(!b)process.exit(1);require("fs").writeFileSync(process.argv[2],Buffer.from(b,"base64"))' "$TMPJ" "$TMP"; then`,
    '  rm -f "$TMP" "$TMPJ"; echo "mycel-image: the service returned no image. Leave the frame empty." >&2; exit 1',
    "fi",
    'rm -f "$TMPJ"',
    'if [ ! -s "$TMP" ] || [ "$(wc -c < "$TMP")" -lt 1024 ]; then',
    '  rm -f "$TMP"; echo "mycel-image: the response was not an image. Leave the frame empty." >&2; exit 1',
    "fi",
    'mv "$TMP" "$OUT"',
    'echo "$OUT"',
  ].join("\n");
}

/**
 * What the agent is told about it.
 *
 * Leads with WHEN NOT TO, for the same reason `mycel-insight`'s doc leads with its refusal rule.
 * The expensive mistake with an image tool is not forgetting it exists — it is decorating. A
 * generated photograph in a monthly close report makes a document that was credible look like a
 * brochure, and the client notices before they read a number.
 */
/** The house style, as an image prompt needs it: named colours and a named look. */
export interface ImageArtDirection {
  /** The design system this business is on — `designSystemFor(kit.identity).id`. */
  system?: string;
  /** The brand's accent, verbatim from the kit. Any CSS colour form. */
  accent?: string;
  /** The brand's neutral/surface colour. */
  neutral?: string;
}

/**
 * The art direction lines, or none.
 *
 * ═══ THE INSTRUCTION THAT ASKED THE AGENT TO DO THE WIRING ═══
 *
 * This file used to say "The house style is in `brand/tokens.css`. Name its accent and surface
 * colours in the prompt." That is a correct instruction and it is not integration. It asks a model
 * to open a CSS file, find the right custom property among thirty, translate an `oklch(0.62 0.19
 * 256)` into words a diffusion model understands, and do it identically for every image in a set —
 * on every run, from scratch, with nothing checking that it did.
 *
 * What comes back when it does not is a generic stock image next to a carefully tokenised page,
 * which is the single most obvious way a generated artefact announces itself. The colours are the
 * cheapest part of art direction to get right and the most expensive to get wrong, because a hero
 * that clashes with the accent beside it reads as broken rather than as plain.
 *
 * So the kernel names them. It already resolves the design system and the brand kit to write
 * `brand/tokens.css` in the first place — every value here is one it is holding at that moment.
 *
 * IT STILL DOES NOT PROMPT FOR THE AGENT. Composition, subject and mood are the run's judgement and
 * belong to the artefact it is making. This supplies the two facts the run cannot invent correctly
 * and would otherwise have to go and read.
 */
export function artDirectionLines(art?: ImageArtDirection): string[] {
  const accent = art?.accent?.trim();
  const neutral = art?.neutral?.trim();
  const system = art?.system?.trim();
  if (!accent && !neutral && !system) return [];

  const lines = ["", "### The house style, for every image you make here", ""];
  if (system) {
    lines.push(
      `This business is on the **${system}** design system. Its rules are in \`brand/\` — the look you` +
        " compose has to be the same look, not a neighbouring one.",
      "",
    );
  }
  if (accent || neutral) {
    lines.push("Name these in the prompt, as colours, every time:");
    if (accent) lines.push(`- accent — \`${accent}\``);
    if (neutral) lines.push(`- surface — \`${neutral}\``);
    lines.push(
      "",
      "A generated image that ignores the palette is the clearest sign a page was assembled rather",
      "than designed: the hero fights the buttons beside it and the whole artefact reads as broken",
      "rather than as plain.",
      "",
    );
  }
  lines.push(
    "One treatment across the whole artefact. Two images in different styles read worse than none —",
    "a set that does not match is the clearest sign nobody art-directed the page.",
  );
  return lines;
}

export function imageToolDoc(p: ImageProvider, art?: ImageArtDirection): string[] {
  return [
    "",
    "## Images — `mycel-image`",
    "",
    "`mycel-image \"<prompt>\" <path.png> [width] [height]` writes a real image into this workspace",
    `and prints its path. It runs on ${p.model ?? p.kind}, and every call costs the business money.`,
    "",
    "### When NOT to use it, which is most of the time",
    "",
    "- **Never in a report, a statement, an invoice or anything with figures in it.** A generated",
    "  photograph makes a credible document look like a brochure, and the reader discounts the",
    "  numbers before reading them. Charts, tables and whitespace are the illustration there.",
    "- **Never as a portrait of a real person, a logo, or a screenshot of a product.** All three are",
    "  claims about something that exists. An invented one is a lie the client will eventually",
    "  hold against whoever sent it.",
    "- **Never with text in the image.** These models still smear letters, and a hero with mangled",
    "  type is the clearest sign a page was generated. Put text in HTML, over the image.",
    "- **Never to fill a frame you were going to leave empty anyway.** A considered blank beats a",
    "  stock-looking fill, and the craft shelf has composition that does not need photography.",
    "",
    "### Where it earns its place",
    "",
    "A marketing site with a hero that would otherwise be a grey box. A deck that needs a section",
    "divider. Abstract or textural work — gradients, materials, atmospheric backgrounds — where",
    "nothing is being asserted about the world.",
    "",
    "### Making it match the rest of the artefact",
    "",
    /**
     * The FILE always, the VALUES when we have them.
     *
     * `artDirectionLines` names the accent and the system when the kernel knows them, which is the
     * integration. This line stays regardless, because a deployment with no brand kit still writes
     * `brand/` into the workspace and the agent still has to match it — dropping the pointer when
     * there is nothing to name would leave those runs with no house style at all, which is a
     * regression wearing an improvement's clothes.
     */
    "The house style is in `brand/tokens.css`, and it is authoritative: an image that does not sit",
    "inside it is a wrong answer, not a stylistic difference.",
    ...artDirectionLines(art),
    "",
    "Keep the aspect ratio consistent across a set, and ask for the same treatment in every prompt.",
    "",
    "If the tool exits non-zero, the service did not answer. Leave the frame empty and carry on —",
    "a broken `<img>` looks worse than a considered blank.",
  ];
}

// ── generation, server-side ─────────────────────────────────────────────────────────────────────

/**
 * Make the image. Runs in the KERNEL, never in a sandbox.
 *
 * This is where the provider keys live and it is the only place they live. `imageToolScript` posts
 * to `/v1/internal/image` with a task-scoped nonce; the route resolves the provider and calls this.
 * A run therefore cannot read a credential out of its own environment, cannot reach a provider
 * directly, and cannot spend around `images_per_month` by calling the API itself.
 *
 * Returns base64 or undefined. Throws only on a transport failure, so the route can tell "the
 * provider refused" from "the provider was unreachable" and say the honest one.
 */
export async function generateImage(
  p: ImageProvider,
  a: { prompt: string; width?: number; height?: number },
): Promise<string | undefined> {
  const W = Number.isFinite(a.width) && (a.width as number) > 0 ? Math.round(a.width as number) : 1536;
  const H = Number.isFinite(a.height) && (a.height as number) > 0 ? Math.round(a.height as number) : 864;

  if (p.kind === "bedrock") {
    /**
     * Stability takes an ASPECT RATIO, not pixels, and refuses anything outside its nine with a
     * validation error a run cannot act on. The tool's interface stays in pixels because that is
     * what somebody laying out a page thinks in; mapping to the nearest ratio is arithmetic and
     * ours to do.
     */
    const RATIOS: [string, number][] = [
      ["21:9", 21 / 9], ["16:9", 16 / 9], ["3:2", 3 / 2], ["5:4", 5 / 4], ["1:1", 1],
      ["4:5", 4 / 5], ["2:3", 2 / 3], ["9:16", 9 / 16], ["9:21", 9 / 21],
    ];
    const want = W / H;
    const aspect = RATIOS.reduce((best, r) =>
      Math.abs(Math.log(r[1] / want)) < Math.abs(Math.log(best[1] / want)) ? r : best)[0];

    const { BedrockRuntimeClient, InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({ region: process.env.MYCEL_IMAGE_BEDROCK_REGION?.trim() });
    const out = await client.send(new InvokeModelCommand({
      modelId: p.model ?? BEDROCK_IMAGE_MODEL,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ prompt: a.prompt, aspect_ratio: aspect, output_format: "png" }),
    }));
    const parsed = JSON.parse(new TextDecoder().decode(out.body)) as {
      images?: string[]; finish_reasons?: (string | null)[];
    };
    // A filtered generation still answers 200, with the reason here. Without this check a moderated
    // request reads as a success and whatever came back is written into a founder's page.
    if (parsed.finish_reasons?.[0]) return undefined;
    return parsed.images?.[0];
  }

  const req =
    p.kind === "fal"
      ? {
          url: `https://fal.run/${p.model ?? "fal-ai/flux-2-pro"}`,
          headers: { authorization: `Key ${p.key}`, "content-type": "application/json" },
          body: JSON.stringify({ prompt: a.prompt, image_size: { width: W, height: H }, num_images: 1, enable_safety_checker: true }),
        }
      : p.kind === "higgsfield"
        ? {
            url: "https://platform.higgsfield.ai/v1/images/generations",
            headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" },
            body: JSON.stringify({ prompt: a.prompt, width: W, height: H }),
          }
        : {
            url: "https://api.openai.com/v1/images/generations",
            headers: { authorization: `Bearer ${p.key}`, "content-type": "application/json" },
            body: JSON.stringify({ model: p.model ?? "gpt-image-2", prompt: a.prompt, size: `${W}x${H}`, n: 1 }),
          };

  // Bounded, like every other outbound call in this kernel. An image provider that accepts the
  // socket and goes quiet would otherwise hold a run open on undici's 300s default.
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) return undefined;
  const d = (await res.json()) as {
    images?: { url?: string }[];
    data?: { url?: string; b64_json?: string }[];
  };

  // OpenAI answers with base64 for gpt-image-2 — verified against the live API — and with a url for
  // older models. fal and higgsfield answer with a url. Both shapes handled, because discovering
  // which at run time costs a run.
  const b64 = d.data?.[0]?.b64_json;
  if (b64) return b64;
  const url = d.data?.[0]?.url ?? d.images?.[0]?.url;
  if (!url) return undefined;
  const img = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!img.ok) return undefined;
  return Buffer.from(await img.arrayBuffer()).toString("base64");
}
