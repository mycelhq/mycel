import { test } from "node:test";
import assert from "node:assert/strict";
import { hasLinkedInExecutor } from "../src/actions";
import { AUTO_APPROVABLE } from "../src/gtm/campaign";
import {
  DECLARED_UNWIRED,
  PUBLIC_BANNED,
  READ_LIVE,
  RECOVERY_LIVE,
  SEQUENCE_LIVE,
  WARMUP_GATED,
} from "../src/linkedin/verbs";
import {
  listPlaybooks,
  overlayPlaybooks,
  playbookKnowledgeName,
  playbookSaveMeta,
  safePlaybookName,
  skillFrontmatterTaskTypes,
} from "../src/playbooks";
import { api, makeApp } from "./helpers";

test("sequence live verbs are the campaign envelope, and only wired LinkedIn plus email", () => {
  assert.deepEqual([...SEQUENCE_LIVE], ["view_profile", "send_invite", "send_message", "send_email"]);
  for (const id of SEQUENCE_LIVE) {
    assert.equal(AUTO_APPROVABLE.has(id), true, `${id} must be auto-approvable`);
  }
  for (const id of SEQUENCE_LIVE) {
    if (id === "send_email") continue;
    assert.equal(hasLinkedInExecutor(id), true, `${id} is a sequence verb and must have an executor`);
  }
  for (const id of READ_LIVE) assert.equal(hasLinkedInExecutor(id), true, `${id} is a live read`);
  for (const id of RECOVERY_LIVE) assert.equal(hasLinkedInExecutor(id), true, `${id} is wired recovery`);
  for (const id of [...DECLARED_UNWIRED, ...PUBLIC_BANNED]) {
    assert.equal(hasLinkedInExecutor(id), false, `${id} stays out of the composer`);
    assert.equal(AUTO_APPROVABLE.has(id), false, `${id} must not ride a campaign envelope`);
  }
  // Warm-up engagement: has an executor (an explicit action can reach it), but is never a sequence
  // verb and never auto-approvable — it cannot ride a campaign envelope.
  for (const id of WARMUP_GATED) {
    assert.equal(hasLinkedInExecutor(id), true, `${id} is dispatchable`);
    assert.equal(SEQUENCE_LIVE.includes(id as (typeof SEQUENCE_LIVE)[number]), false, `${id} is not a sequence verb`);
    assert.equal(AUTO_APPROVABLE.has(id), false, `${id} must not ride a campaign envelope`);
  }
});

test("overlayPlaybooks: a live save replaces the shipped file on the next mount", () => {
  const disk = [{ name: "chase-politely.md", content: "shipped" }];
  const live = [
    {
      name: playbookKnowledgeName("chase-politely.md"),
      content: "how we actually chase",
      updated_at: "2026-08-01T00:00:00.000Z",
      metadata: { enabled: true, versions: [{ at: "2026-08-01T00:00:00.000Z", reason: "softer second reminder" }] },
    },
  ];
  const mounted = overlayPlaybooks(disk, live);
  assert.equal(mounted.length, 1);
  assert.equal(mounted[0]!.content, "how we actually chase");
});

test("overlayPlaybooks: turning a playbook off drops it rather than falling back to shipped", () => {
  const disk = [{ name: "chase-politely.md", content: "shipped" }];
  const live = [
    {
      name: playbookKnowledgeName("chase-politely.md"),
      content: "edited",
      updated_at: "2026-08-01T00:00:00.000Z",
      metadata: { enabled: false },
    },
  ];
  assert.deepEqual(overlayPlaybooks(disk, live), []);
});

test("overlayPlaybooks: a new name that was never on disk is how they add a playbook", () => {
  const disk = [{ name: "chase-politely.md", content: "shipped" }];
  const live = [
    {
      name: playbookKnowledgeName("how-we-open.md"),
      content: "first line is a question",
      updated_at: "2026-08-01T00:00:00.000Z",
      metadata: { enabled: true },
    },
  ];
  const mounted = overlayPlaybooks(disk, live);
  assert.equal(mounted.length, 2);
  assert.ok(mounted.some((s) => s.name === "how-we-open.md" && s.content.includes("question")));
});

test("listPlaybooks keeps shipped files and surfaces version reasons", () => {
  const disk = [{ name: "chase-politely.md", content: "shipped" }];
  const live = [
    {
      name: playbookKnowledgeName("chase-politely.md"),
      content: "edited",
      updated_at: "2026-08-02T00:00:00.000Z",
      metadata: {
        enabled: true,
        versions: [{ at: "2026-08-02T00:00:00.000Z", reason: "stop leading with the balance" }],
      },
    },
  ];
  const rows = listPlaybooks(disk, live);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.source, "yours");
  assert.equal(rows[0]!.versions[0]!.reason, "stop leading with the balance");
});

test("playbookSaveMeta appends the reason rather than replacing the history", () => {
  const first = playbookSaveMeta(undefined, {
    reason: "first edit",
    enabled: true,
    now: "2026-08-01T00:00:00.000Z",
  });
  const second = playbookSaveMeta(
    { id: "k", project_id: "p", wedge: "invoice-chaser", name: "playbooks/x.md", content: "x", kind: "document", source: "authored", created_at: "", updated_at: "", metadata: first },
    { reason: "second edit", enabled: true, now: "2026-08-02T00:00:00.000Z" },
  );
  assert.equal((second.versions as { reason: string }[]).map((v) => v.reason).join(","), "first edit,second edit");
});

test("safePlaybookName refuses path fragments", () => {
  assert.equal(safePlaybookName("../etc"), undefined);
  assert.equal(safePlaybookName("how we chase"), undefined);
  assert.equal(safePlaybookName("how-we-chase.md"), "how-we-chase.md");
  assert.equal(safePlaybookName("draft_campaign_copy"), "draft_campaign_copy.md");
});

test("GET/PUT playbooks: list shipped, save a version with a reason, next list shows it", async () => {
  const { app } = makeApp();
  const listed = await api(app, "wedges/invoice-chaser/playbooks");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.playbooks.some((p: { name: string }) => p.name === "chase-politely.md"));

  const saved = await api(app, "wedges/invoice-chaser/playbooks", {
    method: "PUT",
    body: JSON.stringify({
      name: "chase-politely.md",
      content: "Lead with the work, not the balance.",
      reason: "the old open sounded like a debt collector",
    }),
  });
  assert.ok(saved.status === 200 || saved.status === 201, `save status ${saved.status}: ${saved.text}`);

  const after = await api(app, "wedges/invoice-chaser/playbooks");
  const row = after.json.playbooks.find((p: { name: string }) => p.name === "chase-politely.md");
  assert.equal(row.source, "yours");
  assert.equal(row.content, "Lead with the work, not the balance.");
  assert.match(row.versions.at(-1).reason, /debt collector/);
  assert.ok(Array.isArray(after.json.jobs));
});

test("PUT playbooks refuses an empty reason", async () => {
  const { app } = makeApp();
  const r = await api(app, "wedges/invoice-chaser/playbooks", {
    method: "PUT",
    body: JSON.stringify({ name: "chase-politely.md", content: "x", reason: "  " }),
  });
  assert.equal(r.status, 400);
});

test("shipped frontmatter task_types keep a playbook off other jobs", () => {
  const disk = [
    {
      name: "find-people.md",
      content: "---\nname: find-people\ntask_types: [find_prospects]\n---\n# Find\n",
    },
  ];
  assert.deepEqual(skillFrontmatterTaskTypes(disk[0]!.content), ["find_prospects"]);
  assert.equal(overlayPlaybooks(disk, [], "find_prospects").length, 1);
  assert.equal(overlayPlaybooks(disk, [], "propose_reply").length, 0);
  assert.deepEqual(listPlaybooks(disk, [])[0]!.task_types, ["find_prospects"]);
});
