// The one ask a business has earned right now, and marking it done.
//
// ═══ IT IS A READ ON HOME, NOT AN EMAIL ═══
//
// The obvious delivery for "ask them at the good moment" is a message. It is the wrong one, twice
// over: an email is the channel a founder has already trained themselves to ignore from software,
// and at the moment worth asking about they are usually IN the product — that is what made it a
// good moment.
//
// So this is a read. Home calls it, gets at most one ask, and renders it where they already are. If
// they never come back, they never see it, which is the correct outcome — somebody who has stopped
// opening the product is not somebody to ask for a referral by email.
//
// ═══ AND MARKING IT SENT IS THE FOUNDER'S ACT, NOT THE RENDER'S ═══
//
// `POST .../done` is called when they act on it or dismiss it — not when it is displayed. A card
// shown on a screen they scrolled past is not an ask that happened, and burning the once-ever flag
// on a render would spend the moment on nothing.
import type { Context, Hono } from "hono";
import { getDomainStore } from "./domain";
import { askCopy, dueAsk, listAsks, listMilestones, markAskSent, type AskKind } from "./milestones";

export function mountMilestoneRoutes(
  app: Hono,
  deps: {
    accessible: (c: Context) => Set<string>;
    writeProjectId: (c: Context) => string | undefined;
    inScope: (set: Set<string>, pid?: string) => boolean;
  },
): void {
  const { accessible, writeProjectId, inScope } = deps;

  app.get("/v1/growth/ask", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(accessible(c), projectId)) return c.json({ ask: null });
    const domain = getDomainStore();
    const [milestones, sent] = await Promise.all([
      listMilestones(domain, projectId).catch(() => []),
      listAsks(domain, projectId).catch(() => []),
    ]);
    const due = dueAsk({ milestones, sent });
    // `null` rather than a 404. Nothing to ask is the ordinary case by a wide margin, and a caller
    // that has to catch an error to learn "no" is a caller that will stop calling.
    return c.json({ ask: due ? { ...askCopy(due), milestone_at: due.milestone.at } : null });
  });

  app.post("/v1/growth/ask/:kind/done", async (c) => {
    const projectId = writeProjectId(c);
    if (!projectId || !inScope(accessible(c), projectId)) return c.json({ error: "no such project" }, 404);
    const kind = c.req.param("kind") as AskKind;
    if (kind !== "referral" && kind !== "satisfaction") return c.json({ error: "unknown ask" }, 400);
    await markAskSent(getDomainStore(), { project_id: projectId, kind });
    return c.json({ ok: true });
  });
}
