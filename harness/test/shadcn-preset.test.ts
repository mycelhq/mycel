import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeBrandKitConfig, resolveBrandKit } from "../src/brandkit";
import {
  DEFAULT_SHADCN_PRESET,
  decodeShadcnPreset,
  encodeShadcnPreset,
  fontFamilyKind,
  PRESET_STYLES,
  STYLE_TRAITS,
} from "../src/shadcn-preset";

describe("shadcn preset encode/decode", () => {
  it("round-trips the default preset", () => {
    const code = encodeShadcnPreset(DEFAULT_SHADCN_PRESET);
    assert.equal(code[0], "b");
    const decoded = decodeShadcnPreset(code);
    assert.ok(decoded);
    assert.equal(decoded!.style, DEFAULT_SHADCN_PRESET.style);
    assert.equal(decoded!.baseColor, DEFAULT_SHADCN_PRESET.baseColor);
    assert.equal(decoded!.theme, DEFAULT_SHADCN_PRESET.theme);
    assert.equal(decoded!.font, DEFAULT_SHADCN_PRESET.font);
    assert.equal(decoded!.radius, DEFAULT_SHADCN_PRESET.radius);
  });

  it("forces none radius for lyra/sera on normalize", () => {
    const { config } = normalizeBrandKitConfig({
      site: { preset: { style: "lyra", radius: "large", theme: "blue", baseColor: "zinc" } },
    });
    assert.equal(config.site?.preset?.style, "lyra");
    assert.equal(config.site?.preset?.radius, "none");
    assert.equal(config.site?.preset?.theme, "blue");
    assert.ok(config.site?.preset?.code?.startsWith("b"));
  });

  it("every create style has traits so the preview is not Lyra-only", () => {
    for (const style of PRESET_STYLES) {
      assert.ok(STYLE_TRAITS[style], style);
      assert.ok("radius" in STYLE_TRAITS[style]);
      assert.ok("shadow" in STYLE_TRAITS[style]);
    }
    assert.equal(STYLE_TRAITS.lyra.radius, "none");
    assert.equal(STYLE_TRAITS.sera.radius, "none");
    assert.equal(STYLE_TRAITS.maia.radius, "large");
  });

  it("resolveBrandKit fills preset + derives type from fonts", () => {
    const kit = resolveBrandKit(
      {
        site: {
          preset: {
            style: "nova",
            baseColor: "neutral",
            theme: "emerald",
            font: "lora",
            fontHeading: "playfair-display",
            radius: "small",
          },
        },
      },
      "Acme",
    );
    assert.equal(kit.site.preset.theme, "emerald");
    assert.equal(kit.site.preset.font, "lora");
    assert.equal(kit.type.heading, "serif");
    assert.equal(kit.type.body, "serif");
    assert.equal(fontFamilyKind("playfair-display"), "serif");
    assert.ok(kit.site.preset.code.startsWith("b"));
  });

  it("unconfigured kit still resolves a default preset", () => {
    const kit = resolveBrandKit(undefined, "Hartley Bookkeeping");
    assert.equal(kit.site.preset.style, "nova");
    assert.equal(kit.site.hero_shape, "stack");
    assert.ok(kit.site.preset.code);
  });
});

describe("visual identity storage", () => {
  const identity = {
    archetype: "editorial",
    rationale: "A brand studio selling taste; the site itself is the portfolio.",
    layout: { hero_shape: "lede", signature_motif: "oversized numbered index down the left rail" },
    sections: [{ kind: "hero", intent: "state the one outcome" }],
    avoid: ["the full-bleed hero video", "'we craft experiences'"],
  };

  it("normalizeBrandKitConfig accepts an identity and stamps approved_at", () => {
    const { config, problems } = normalizeBrandKitConfig({ identity });
    assert.equal(problems.length, 0);
    assert.equal(config.identity?.archetype, "editorial");
    assert.ok(config.identity?.approved_at, "approved_at is stamped at the write");
  });

  it("resolveBrandKit carries the identity through to the build's read", () => {
    const { config } = normalizeBrandKitConfig({ identity });
    const kit = resolveBrandKit(config, "Northstar Studio");
    assert.equal(kit.identity?.archetype, "editorial");
    assert.equal(kit.identity?.layout?.signature_motif, "oversized numbered index down the left rail");
  });

  it("an unconfigured kit has no identity — the honest 'not designed yet' state", () => {
    const kit = resolveBrandKit(undefined, "Hartley Bookkeeping");
    assert.equal(kit.identity, undefined);
  });

  it("null identity clears it; a non-object or oversized one is refused", () => {
    const cleared = normalizeBrandKitConfig({ identity: null });
    assert.equal(cleared.config.identity, undefined);
    assert.equal(cleared.problems.length, 0);

    const notObject = normalizeBrandKitConfig({ identity: "editorial" });
    assert.ok(notObject.problems.some((p) => p.field === "identity"));

    const huge = normalizeBrandKitConfig({ identity: { rationale: "x".repeat(13000) } });
    assert.ok(huge.problems.some((p) => p.field === "identity"));
  });
});

describe("archetype drives the look when the brand is unconfigured", () => {
  it("an editorial identity with no preset gets a serif heading and a non-green accent", () => {
    const kit = resolveBrandKit({ identity: { archetype: "editorial" } }, "Northstar Studio");
    assert.equal(kit.type.heading, "serif", "editorial leads with a serif display");
    assert.equal(kit.site.preset.fontHeading, "playfair-display");
    assert.notEqual(kit.accent, "#16a34a", "not the house green");
  });

  it("a configured preset always wins over the archetype", () => {
    const kit = resolveBrandKit(
      { identity: { archetype: "editorial" }, site: { preset: { font: "geist", fontHeading: "geist-mono" } } },
      "Northstar Studio",
    );
    assert.equal(kit.site.preset.fontHeading, "geist-mono", "the founder's choice, not the archetype's");
  });

  it("a configured accent wins over the archetype's", () => {
    const kit = resolveBrandKit({ identity: { archetype: "editorial" }, accent: "#ff0000" }, "X");
    assert.equal(kit.accent, "#ff0000");
  });

  it("no identity and no config still resolves the house default", () => {
    const kit = resolveBrandKit(undefined, "Hartley Bookkeeping");
    assert.equal(kit.accent, "#16a34a");
    assert.equal(kit.site.preset.font, "inter");
  });
});
