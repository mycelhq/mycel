import { test } from "node:test";
import assert from "node:assert/strict";
import { gradeDeliverables } from "../src/deliverable-grade";
import type { WedgeManifest } from "../src/wedge";

/**
 * `TOOLKIT_RE` is `/^[a-z0-9_-]{1,64}$/` — it checks the SHAPE of a toolkit string and nothing has
 * ever compared it to the catalogue. So `draft_service`, writing a manifest for a trade it has just
 * been told about, can emit `toolkit: "clio"`, and it validates, promotes and goes on the clock.
 * The client is then shown "Connect your clio" over a button that cannot complete, the ingredient
 * is never obtained, and every run of that service ends by writing down what it needed.
 *
 * Measured in production over 14 days: 1,924 artifacts that ask for inputs against 138 that are
 * work, all of it one wedge on a project with zero connections.
 */
const base = (connections: { toolkit: string; ask: string }[]): WedgeManifest =>
  ({
    wedge: "test-trade",
    title: "Test trade",
    task_types: { make_it: { deliverable_kind: "document" } },
    fulfillment: {
      client_connections: connections,
      intake_asks: [],
      deliverable_shapes: ["document"],
    },
  }) as unknown as WedgeManifest;

test("an integration that does not exist blocks the promote", () => {
  const g = gradeDeliverables(base([{ toolkit: "clio", ask: "Connect your Clio" }]), {
    knownToolkits: new Set(["xero", "quickbooks", "stripe"]),
  });
  const f = g.findings.find((x) => x.rule === "unknown-toolkit");
  assert.ok(f, "a service asking for an integration we do not have promoted clean");
  assert.equal(f.severity, "blocking", "a service that can never obtain its inputs is not a warning");
  assert.match(f.says, /clio/, "the finding does not name the integration, so it cannot be acted on");
  assert.match(f.fix, /intake ask|ask for the file/i, "the fix must offer the path that always works");
});

test("an integration that exists is silent", () => {
  const g = gradeDeliverables(base([{ toolkit: "xero", ask: "Connect your Xero" }]), {
    knownToolkits: new Set(["xero", "quickbooks"]),
  });
  assert.equal(g.findings.filter((x) => x.rule === "unknown-toolkit").length, 0);
});

test("case and whitespace do not decide whether a service ships", () => {
  const g = gradeDeliverables(base([{ toolkit: "  Xero ", ask: "Connect Xero" }]), {
    knownToolkits: new Set(["xero"]),
  });
  assert.equal(g.findings.filter((x) => x.rule === "unknown-toolkit").length, 0);
});

test("NOT CHECKING is not the same as finding nothing", () => {
  /**
   * The direction that matters. Omitting the catalogue means "could not check" and must raise
   * nothing — a blocking finding caused by Composio being unreachable would stop a founder
   * promoting a perfectly good service, for a reason on our side, that they could not diagnose.
   *
   * The tempting shortcut is to default the option to an empty set. That reads as "no integration
   * exists anywhere" and blocks every connection ask the moment the network blips, which is a worse
   * failure than the bug being caught and is why the resolver returns `undefined` rather than `[]`.
   */
  const g = gradeDeliverables(base([{ toolkit: "clio", ask: "Connect your Clio" }]), {});
  assert.equal(
    g.findings.filter((x) => x.rule === "unknown-toolkit").length,
    0,
    "an unreadable catalogue raised a finding — a founder is now blocked by our outage",
  );

  const empty = gradeDeliverables(base([{ toolkit: "clio", ask: "Connect your Clio" }]), {
    knownToolkits: new Set<string>(),
  });
  assert.equal(
    empty.findings.filter((x) => x.rule === "unknown-toolkit").length,
    1,
    "an EMPTY set is a real answer meaning nothing exists, and must still block — only `undefined` skips",
  );
});
