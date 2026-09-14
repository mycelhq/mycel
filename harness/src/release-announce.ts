/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * TELLING THE CLIENT THAT THE WORK IS FINISHED
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * MEASURED IN PRODUCTION, 14 September. Every deliverable ever released, across every tenant, and
 * the number of outbound messages that reached that client within a day of the release:
 *
 *     Ridgeline — April AI visibility      09 Sep    told: 0
 *     Fairmont Dental — listings audit     07 Sep    told: 0
 *     Willow & Pine — pricing page copy    06 Sep    told: 0
 *     ... fifteen of fifteen, told: 0
 *
 * Not one. The founder presses Release, the deliverable moves to `with_client`, and nothing happens
 * anywhere a client can see. They find out if they happen to open the portal.
 *
 * That is the answer to why `THE-BAR.md` gate 1 reads **0 of 8 deliverables accepted**. It was read
 * as a quality problem for weeks. Nobody was told there was anything to accept.
 *
 * ═══ WHY THIS SENDS WITHOUT AN APPROVAL ═══
 *
 * "A human on every send" is the rule and this does not break it. RELEASING IS THE SEND. A founder
 * who has read the draft and pressed the button that moves it to the client has made exactly the
 * decision the gate exists to capture; raising an approval afterwards would ask them to authorise
 * the thing they just asked for, and a gate that fires on a decision already taken is the kind that
 * teaches people to click through gates.
 *
 * The precedent is `invoices.routes.ts`, which mails an invoice on the same argument through the
 * same two calls — `planSendEmail` then `executeAction` — and this deliberately mirrors it rather
 * than inventing a second way to reach a customer.
 *
 * ═══ A REFUSAL IS AN ANSWER, AND IT GOES BACK TO THE FOUNDER ═══
 *
 * No address on the client, no mailbox connected, two connected and no rule for which: each is a
 * fact the founder can act on in under a minute, and each used to be indistinguishable from success
 * because the release simply returned `ok`. So this returns a sentence, the route puts it in the
 * release response, and the founder is told at the moment they are looking at the thing.
 *
 * Never throws, and never blocks the release. The work IS with the client — it is in their portal,
 * it is the truth of the record — and failing the transition because an email bounced would trade
 * the delivery for the notification.
 */
import type { Client } from "./contract";

/** What this needs from the rest of the kernel. Injected, so the announcement is testable alone. */
export interface AnnounceDeps {
  /** The client's own row. `handles` is where the address lives. */
  getClient(id: string): Promise<Client | undefined>;
  /** A one-time portal link. Returned once; only the hash is stored. */
  mintLink(args: { project_id: string; client_id: string }): { token: string };
  /**
   * Where that token is exchanged. Absent when the tenant has no portal address yet, which is a
   * real state — a business can be delivering work before its portal domain is live.
   */
  portalBase(projectId: string): string | undefined;
  /** `planSendEmail` + `executeAction`, exactly as the invoice send uses them. */
  send(args: {
    project_id: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<{ ok: boolean; detail?: string }>;
}

export interface Announced {
  sent: boolean;
  /** The founder's sentence. Present on every outcome, including success. */
  detail: string;
  to?: string;
}

/**
 * The message itself.
 *
 * SHORT ON PURPOSE. The founder's instruction for this whole surface was "minimize text" — the work
 * is the thing, and an email that explains the work competes with it. Four lines: what it is, that
 * it is ready, where to open it, and what we want back.
 *
 * IT ASKS FOR THE DECISION. "Accept it or tell us what to change" is the entire loop stated in one
 * clause, and it is why this is not a notification. A message that says "your report is ready" gets
 * read; a message that says what to do next gets answered, and gate 1 is measured in answers.
 *
 * NO ATTACHMENT. The file lives behind the link, where the portal can show the work, take the
 * decision and keep the version history next to what they said last time. An attachment is a copy
 * that immediately starts drifting from the record, and the record is what gets invoiced against.
 */
export function announcementText(args: { title: string; summary?: string; url?: string }): {
  subject: string;
  text: string;
} {
  const lines = [`${args.title} is ready.`];
  if (args.summary?.trim()) lines.push("", args.summary.trim());
  if (args.url) lines.push("", `Open it here: ${args.url}`, "", "Accept it, or tell us what to change.");
  else lines.push("", "Accept it, or tell us what to change.");
  return { subject: args.title, text: lines.join("\n") };
}

/** The first handle containing `@` — the same read `clientEmailHandle` does, for the same reason. */
const addressOf = (client: Client): string | undefined =>
  (client.handles ?? []).find((h) => typeof h === "string" && h.includes("@"));

export async function announceRelease(
  deps: AnnounceDeps,
  d: { project_id: string; client_id: string; title: string },
  version: { summary?: string },
): Promise<Announced> {
  const client = await deps.getClient(d.client_id).catch(() => undefined);
  if (!client) return { sent: false, detail: "this work has no client on it, so nobody was told it is ready" };

  const to = addressOf(client);
  if (!to) {
    /*
      The commonest one, and the most fixable. `clients.routes.ts` treats an address as the thing that
      makes a portal possible at all, so this sentence names the remedy rather than the condition.
    */
    return { sent: false, detail: `${client.display_name ?? "this client"} has no email address on file, so they have not been told it is ready` };
  }

  const base = deps.portalBase(d.project_id);
  /*
    A LINK IS OPTIONAL AND THE MESSAGE IS NOT. A tenant whose portal address is not live yet still
    has a client who needs to know the work is done — sending "it is ready, reply and tell us" is
    strictly better than silence, and it is the state a business is in on its first week.
  */
  const url = base ? `${base.replace(/\/+$/, "")}/portal/enter?token=${deps.mintLink({ project_id: d.project_id, client_id: d.client_id }).token}` : undefined;

  const { subject, text } = announcementText({ title: d.title, summary: version.summary, url });
  const res = await deps.send({ project_id: d.project_id, to, subject, text }).catch((e) => ({
    ok: false,
    detail: e instanceof Error ? e.message : String(e),
  }));

  return res.ok
    ? { sent: true, to, detail: `sent to ${to}` }
    : { sent: false, to, detail: res.detail ?? "the send failed with no reason given" };
}
