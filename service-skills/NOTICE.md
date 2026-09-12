# Third-party skills vendored into the arsenal

Every `.md` under `service-skills/<domain>/` is a skill the kernel seeds into the
library at boot (`seedLibraryFromDisk`). Most are authored here. The ones below were
copied from third-party repositories. Each vendored file ends with an HTML comment
naming its upstream and licence.

Licence text was read from the repository itself, not inferred from a badge.

| Upstream | Licence | Vendored into |
|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | Apache-2.0 | `design/` (brandkit, design-brief, brand-extract, impeccable-design-polish, web-design-guidelines), `deliverables/` (data-report, faq-page, release-notes-one-pager, research-decision-room) |
| [anthropics/skills](https://github.com/anthropics/skills) | Apache-2.0 | `design/` (frontend-design, brand-guidelines, theme-factory, canvas-design, algorithmic-art), `deliverables/` (web-artifacts-builder, doc-coauthoring), `copywriting/internal-comms` |
| [coreyhaines31/marketingskills](https://github.com/coreyhaines31/marketingskills) | MIT | `digital-marketing/`, `gtm/`, `copywriting/`, `public-relations/`, `social-media-management/` |
| [jiannanya/snow-d3](https://github.com/jiannanya/snow-d3) | MIT | `deliverables/d3-visualization` |
| [meodai/skill.color-expert](https://github.com/meodai/skill.color-expert) | CC-BY-4.0 | `design/color-expert` — **attribution required**, keep the trailing credit comment in that file |

## Deliberately NOT vendored

**`docx`, `pdf`, `pptx`, `xlsx` from anthropics/skills.** Their README states these are
"source-available, not open source". They power Claude's own document capability and
carry no licence grant. We ship no copy and no stub advertising them; if the kernel
needs to produce those formats it must do it from its own code, not from that text.

**~120 company-brand design systems from open-design.** Apache-2.0 §6 grants no
trademark licence, and those systems encode third-party marks, brand colours, and
licensed typefaces (the Apple one specifies SF Pro). Only the 29 generic *style*
systems were taken, and they live in `packages/design-systems/`, not here.

**Catalogue stubs.** open-design ships ~14 one-kilobyte entries whose body is
"install the upstream bundle yourself". A stub advertises a capability the kernel does
not have, so the shaper picks a skill that then cannot do the work. Each was either
replaced with its real upstream body or deleted. Do not re-add a skill whose body does
not contain the actual instructions.
