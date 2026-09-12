// From a proposal that passed its gate, to an envelope the founder can send.
//
// This is the seam between the two halves of a close: the model wrote the engagement and
// `ship_checks` verified it; from here nothing a model said is trusted again. The scope, the price
// and the term are read out of the CHECKED output, rendered by a template that cannot show a
// different number, and sealed.
//
// ═══ IT OPENS A DRAFT, ALWAYS ═══
//
// `createEnvelope` leaves the envelope in `draft`: invisible to the client, unsignable by anyone.
// The founder reads the proposal and presses send. A run that could put a contract in front of a
// customer on its own would be the single place in this product where a machine reaches a client
// unattended, and every gate in the kernel exists so that is never true.
//
// ═══ THE SIGNERS ARE READ, NOT WRITTEN ═══
//
// The client's address comes from the client record; the provider's from the business's own brand
// kit and owner. Neither is taken from the model's output. A signer list a model can influence is a
// signer list that can be pointed somewhere else, and it would be the highest-value field in the
// system to get wrong.
import { randomUUID } from "node:crypto";
import type { BrandKit } from "./brandkit";
import type { Client, EventType, Task } from "./contract";
import { getDomainStore } from "./domain";
import { businessDisplayName } from "./business-shape";
import { render } from "./render";
import type { ProposalDocumentInput } from "./render/proposal";
import { createEnvelope } from "./signing";
import { getArtifactBackend } from "./artifacts";
import type { Store } from "./store";

/** The proposal as the output schema declares it, after the gate has passed it. */
interface ParsedProposal {
  headline?: string;
  scope?: { what?: string; said?: string }[];
  out_of_scope?: string[];
  price_minor?: number;
  currency?: string;
  cadence?: "one_off" | "monthly" | "quarterly";
  term_months?: number;
  starts?: string;
  assumptions?: string[];
  from_client?: string[];
}

/** A date a person recognises, from the clock rather than from anything the model said. */
const today = (): string => {
  const d = new Date();
  const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`;
};

/**
 * ═══ WHO THE PAPER IS ADDRESSED TO — AND WHY IT IS NOT ALWAYS A CLIENT ALREADY ═══
 *
 * This function exists because `if (!task.client_id) return undefined` sat at the top of the one
 * below, and it made the entire signing half of the product unreachable.
 *
 * The argument against it is one sentence: A PROPOSAL IS FOR SOMEBODY WHO IS NOT A CLIENT YET.
 * `draft_engagement` runs against a PROSPECT case — the person who replied on LinkedIn and took a
 * call — and a prospect case has no `client_id` on it, correctly, because nothing has been agreed.
 * The convert step in the console that mints the client row runs at WIN, which is after signature,
 * which is after the envelope this function was supposed to open. Every part of the chain was
 * written and every part was correct; they were ordered so that the first one could never fire.
 *
 * So the counterparty is RESOLVED rather than required, cheapest first:
 *
 *   1. the run's own `client_id` — a proposal for an existing client (an expansion, a renewal)
 *   2. the case's `client_id` — the prospect was already converted by some other path
 *   3. minted from the case — the ordinary path, and the one that was impossible before
 *
 * ── MINTING A CLIENT HERE IS AN HONEST RECORD, NOT A SHORTCUT ──
 *
 * A signature needs a signer, a signer needs a name and an address, and both live on the client
 * record. Putting a priced document in front of somebody makes them a commercial counterparty
 * whether or not they sign it — that is what every CRM means by an account, and it is why the
 * account exists before the deal closes rather than after. `stage: "proposed"` in metadata says
 * which it is, so a clients list can tell somebody who was sent a proposal from somebody who signed
 * one, and the win path can still find this row by handle instead of creating a second.
 *
 * ── AND IT IS WRITTEN BACK ONTO THE CASE ──
 *
 * Not for this run — for the next one. `wrapFulfillmentDeliverable` bails when the case has no
 * client, invoices hang off the client, and the portal scopes by it. A client minted here and left
 * unattached would make the envelope openable and leave every stage after the signature exactly as
 * stuck as before.
 */
async function counterparty(
  task: Task,
  domain: ReturnType<typeof getDomainStore>,
  emit: (event: EventType, data?: Record<string, unknown>) => Promise<void>,
): Promise<Client | undefined> {
  const known = task.client_id ? await domain.getClient(task.client_id).catch(() => undefined) : undefined;
  if (known) return known;
  if (!task.case_id) return undefined;

  const kase = await domain.getCase(task.case_id).catch(() => undefined);
  if (!kase) return undefined;
  if (kase.client_id) {
    const onCase = await domain.getClient(kase.client_id).catch(() => undefined);
    if (onCase) return onCase;
  }

  const data = (kase.data ?? {}) as Record<string, unknown>;
  const email = ["contact_email", "email"]
    .map((k) => (typeof data[k] === "string" ? (data[k] as string).trim() : ""))
    .find((v) => v.includes("@"));
  if (!email) {
    // The same sentence the client-with-no-address path gives, for the same reason: a proposal that
    // did not become signable must say what it was short of. Without an address there is no signer,
    // and inventing one would put a contract in front of a mailbox nobody chose.
    await emit("progress", {
      note:
        `The proposal is ready, but there is no email address for ${kase.title || "this prospect"} — ` +
        `add one to the engagement and it can be sent for signature.`,
    });
    return undefined;
  }

  // By handle before creating: the inbound path, the convert path and this one all key a person on
  // their address, and three doors minting three rows for one human is how a founder ends up with a
  // clients list they do not recognise and an invoice against the wrong one.
  const existing = await domain.findClientByHandle(email).catch(() => undefined);
  if (existing) {
    if (!kase.client_id) await domain.updateCase(kase.id, { client_id: existing.id }).catch(() => undefined);
    return existing;
  }

  const name = (typeof data.name === "string" && data.name.trim()) || kase.title || email;
  const created = await domain
    .createClient({
      project_id: task.project_id,
      display_name: name,
      handles: [email],
      metadata: {
        stage: "proposed",
        source: "proposal",
        case_id: kase.id,
        ...(typeof data.profile_id === "string" ? { profile_id: data.profile_id } : {}),
      },
    })
    .catch((e) => {
      console.error("[mycel] could not open a client record for the proposal:", e);
      return undefined;
    });
  if (!created) return undefined;
  await domain.updateCase(kase.id, { client_id: created.id }).catch(() => undefined);
  return created;
}

export async function openProposalEnvelope(args: {
  task: Task;
  parsed: unknown;
  store: Store;
  /** Undefined when the project has no kit yet — there is then nothing to put on the paper. */
  kit: BrandKit | undefined;
  emit: (event: EventType, data?: Record<string, unknown>) => Promise<void>;
}): Promise<string | undefined> {
  const { task, store, kit, emit } = args;
  if (!kit) return undefined;
  const out = args.parsed as { proposal?: ParsedProposal; decision?: string } | undefined;
  const p = out?.proposal;
  // `not_yet` produces no proposal, which is the honest answer to a call that settled nothing. There
  // is nothing to open and nothing to say about it — the founder reads the reason on the task.
  if (!p || out?.decision === "not_yet") return undefined;
  if (!task.project_id) return undefined;

  const scope = (p.scope ?? []).filter((s): s is { what: string; said?: string } => typeof s.what === "string" && !!s.what.trim());
  if (!scope.length || typeof p.price_minor !== "number") return undefined;

  const domain = getDomainStore();
  const client = await counterparty(task, domain, emit);
  if (!client) return undefined;

  // The client's address, from the client record. `handles` is where an email lives; the first one
  // that looks like an address is the one we already correspond with.
  const clientEmail = (client.handles ?? []).find((h) => typeof h === "string" && h.includes("@"));
  if (!clientEmail) {
    // Said out loud rather than swallowed. A founder whose proposal did not become signable needs
    // to know it was for want of an address, not to discover it when nothing arrives.
    await emit("progress", {
      note: `The proposal is ready, but ${client.display_name ?? "this client"} has no email address on file — add one and it can be sent for signature.`,
    });
    return undefined;
  }

  /**
   * ═══ WHO THE BUSINESS IS, ON A DOCUMENT THAT NEEDS A COUNTERSIGNATURE ═══
   *
   * `kit.display_name` is EMPTY for a project that has not configured a brand, on purpose and with a
   * good argument behind it: an empty masthead reads as unbranded, and a wrong one — "default", or
   * "Invoice" — reads as a mistake on the first line of the first thing a client opens.
   *
   * That argument is about RENDERING and it does not carry to a SIGNER. A signature is checked
   * against the name on the document, so an empty one produces a contract the provider can never
   * countersign — and because the client signs first, they discover it by being bound to a document
   * their supplier cannot complete. `createEnvelope` now refuses that outright; this is the branch
   * that keeps it from happening in the first place.
   *
   * Three sources, most-deliberate first, and the middle one is the fix that matters:
   *
   *   1. `kit.display_name` — the founder set it in Brand, explicitly, for documents.
   *   2. THE BUSINESS SHAPE — what they typed on the first screen of onboarding when asked what
   *      their business is called. The first version of this fallback skipped straight to the
   *      project name and refused a founder who had told us "Halden Freight Recruitment" twenty
   *      minutes earlier, because the only code that could read the shape was the GTM composer.
   *      That is why `readBusinessShape` is now its own module.
   *   3. The project's name, and only when it is real. `isPlaceholderName` catches the bootstrap
   *      `"default"`, which must never appear on a contract as a party.
   */
  const providerName = await businessDisplayName(store, task.project_id, kit.display_name);
  if (!providerName) {
    // The same posture as the missing client address below: named, not swallowed. A founder whose
    // proposal did not become signable needs to know which one field it was short of.
    await emit("progress", {
      note:
        "The proposal is ready, but this business has no name on file, and a contract needs one for " +
        "the signature to be checked against — set it in Brand and it can be sent for signature.",
    });
    return undefined;
  }

  const input: ProposalDocumentInput = {
    client: client.display_name ?? "our client",
    headline: p.headline ?? "Proposed engagement",
    scope,
    ...(p.out_of_scope?.length ? { out_of_scope: p.out_of_scope } : {}),
    price_minor: p.price_minor,
    // THE BUSINESS'S CURRENCY, not a constant. The model may name one if the call settled it in
    // something else — a UK agency billing a US client in dollars is ordinary — but the fallback is
    // what this business bills in rather than what this file was written in.
    currency: (p.currency ?? kit.currency).toUpperCase(),
    ...(p.cadence ? { cadence: p.cadence } : {}),
    ...(p.term_months ? { term_months: p.term_months } : {}),
    ...(p.starts ? { starts: p.starts } : {}),
    ...(p.assumptions?.length ? { assumptions: p.assumptions } : {}),
    ...(p.from_client?.length ? { from_client: p.from_client } : {}),
    ...(task.case_id ? { reference: `Reference ${task.case_id}` } : {}),
    prepared_on: today(),
  };

  const doc = render("proposal", input, kit, "pdf");
  const backend = await getArtifactBackend();
  const artifact = await store.addArtifact({
    task_id: task.id,
    name: doc.name,
    content_type: doc.content_type,
    content: backend.inline ? doc.content : "",
    encoding: doc.encoding,
    size_bytes: doc.size_bytes,
    source: "agent",
    client_id: client.id,
  });
  if (!backend.inline) await backend.put(artifact.id, doc.content);

  /**
   * ═══ THE AGREED TERMS, ONTO THE CASE, BEFORE ANYBODY SIGNS ═══
   *
   * The proposal has already been through its gate: a price in minor units, a currency, a cadence
   * and a term, each checked. Two minutes later somebody signs it, and at that moment the kernel has
   * to know what was agreed in order to start the work and raise the first invoice — and the only
   * place it lived was inside a rendered PDF.
   *
   * Written HERE rather than read out of the envelope on execution, for the reason `deal-lessons.ts`
   * gives about revisions: an envelope can be revised, and the terms that matter are the ones on the
   * paper that was signed. Writing them at draft time and letting a revision overwrite them keeps
   * one answer to "what did we agree", on the object the rest of the product already reads.
   *
   * A `monthly` or `quarterly` cadence becomes a RETAINER line with a real recurrence, because that
   * is what it is — and a retainer line without one bills like a one-off, which is the exact bug the
   * `recurrence` field was added for.
   */
  const perPeriod = p.cadence === "monthly" || p.cadence === "quarterly";
  await domain
    .updateCase(task.case_id ?? "", {
      data: {
        ...((await domain.getCase(task.case_id ?? "").catch(() => undefined))?.data ?? {}),
        agreed_terms: {
          price_minor: p.price_minor,
          currency: input.currency,
          ...(p.cadence ? { cadence: p.cadence } : {}),
          ...(p.term_months ? { term_months: p.term_months } : {}),
          ...(p.starts ? { starts: p.starts } : {}),
          headline: input.headline,
        },
        money_plan: {
          currency: input.currency,
          lines: [
            {
              id: randomUUID(),
              label: input.headline,
              amount_minor: p.price_minor,
              kind: perPeriod ? "retainer" : "deposit",
              status: "planned",
              ...(perPeriod
                ? {
                    recurrence: {
                      every: "month",
                      interval: p.cadence === "quarterly" ? 3 : 1,
                      // The start date from the proposal when it is a real one, else today. Never a
                      // string the model wrote free-hand: a bad anchor moves every future period.
                      anchor: /^\d{4}-\d{2}-\d{2}$/.test(String(p.starts ?? ""))
                        ? String(p.starts)
                        : new Date().toISOString().slice(0, 10),
                      state: "active",
                    },
                  }
                : {}),
            },
          ],
        },
      },
    })
    .catch((e) => console.error("[mycel] could not record the agreed terms on the case:", e));

  const env = await createEnvelope({
    project_id: task.project_id,
    client_id: client.id,
    ...(task.case_id ? { case_id: task.case_id } : {}),
    title: `${input.headline} — ${input.client}`,
    document: { artifact_id: artifact.id, filename: doc.name, sha256: "", size_bytes: doc.size_bytes },
    signers: [
      // THE CLIENT FIRST. Ordering is commercial rather than legal: a business that countersigns
      // first has agreed to terms the client can still change, and its signature is then evidence
      // of nothing.
      { role: "client", name: client.display_name ?? clientEmail, email: clientEmail, order: 1 },
      {
        role: "provider",
        name: providerName,
        email: kit.support_email ?? `hello@${providerName.toLowerCase().replace(/[^a-z0-9]+/g, "")}.invalid`,
        order: 2,
      },
    ],
    // THE SAME NUMBERS THE PAGE SHOWS, carried on the envelope so the negotiation is readable
    // afterwards. See `Envelope.terms` — without them "you proposed twelve months and signed six" is
    // a question that needs a PDF parser to answer.
    terms: {
      price_minor: input.price_minor,
      currency: input.currency,
      ...(input.cadence ? { cadence: input.cadence } : {}),
      ...(input.term_months ? { term_months: input.term_months } : {}),
    },
    // What signing this MEANS, declared now rather than decided later. The thing that starts the
    // work reads it off the signed record instead of off a task input somebody could have edited in
    // between.
    on_execute: { kind: "start_engagement", note: input.headline },
  });

  await emit("artifact.created", {
    artifact_id: artifact.id,
    name: artifact.name,
    content_type: artifact.content_type,
    url: `/v1/artifacts/${artifact.id}`,
  });
  await emit("progress", {
    note: `The proposal is ready to send for signature. Nothing has gone to ${input.client} yet.`,
  });
  return env.id;
}
