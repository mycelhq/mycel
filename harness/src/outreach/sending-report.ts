// What a founder is told about their own sending, in their words.
//
// ═══ WHY THIS IS IN THE KERNEL AND NOT IN THE CONSOLE ═══
//
// The rule is that a founder never sees the guts of the platform. That rule survives exactly as long
// as somebody remembers it while writing a React component, which is to say not very long — and this
// is the worst area to forget it in, because the vocabulary underneath is genuinely alien. Nobody
// running a bookkeeping practice knows what a warm-up ramp is, what week 3 means, what a penalty of
// 2 is measured in, or why a "hard bounce" is different from a "soft" one. Shown any of those, they
// will either ignore the screen or ask us what it means, and both of those are the screen failing.
//
// So the translation happens here, once, and `sending-report.test.ts` asserts that nothing in the
// output contains our words. A second surface — a digest email, a mobile view, an alert — gets the
// same sentences for free and cannot invent worse ones.
//
// ═══ THE SHAPE: ONE ANSWER, THEN THE REASON, THEN THE ONE THING TO DO ═══
//
// A founder opening this screen is asking one question: "is my email working?" Everything else is
// support for that answer. So the report leads with a single sentence, and `do_this` is present only
// when there is genuinely something a person must do — an empty action list is the good outcome and
// must not be filled with advice to look busy.
import { RAMP, type InboxSnapshot, type RampVerdict, type Suppression } from "@mycel/deliverability";
import { REASON_SAID } from "@mycel/deliverability";
import { inboxHealth } from "./inbox-health";
import { recentSuppressions } from "./suppression";

export interface SendingReport {
  /** The whole answer in one sentence. Always present, including when nothing is set up. */
  headline: string;
  /** How many more this business can send today across every address it uses. */
  can_send_today: number;
  /** One entry per sending address, in the founder's words. */
  addresses: {
    address: string;
    /** "Ready", "Settling in", "Slowed down", "Paused", "Stopped". Five words, no numbers. */
    state: string;
    /** e.g. "12 of 25 sent today". */
    today: string;
    /** Why the number is what it is, in a sentence. */
    why: string;
  }[];
  /** People this business has stopped emailing, most recent first. */
  stopped: { who: string; why: string; when: string }[];
  /** Only when a person must act. Empty is the good outcome — never padded. */
  do_this: string[];
}

/**
 * The five states, and the sentence that goes with each.
 *
 * Deliberately five and not eight. `warming` and `active` are the same fact to a founder ("it works,
 * it is being careful"), and the distinction between them is ours. What a person needs to tell apart
 * is: fine / building up / we slowed it down / you paused it / this one is finished.
 */
function stateOf(snap: InboxSnapshot & { ramp: RampVerdict }): { state: string; why: string; act?: string } {
  if (snap.state === "burned") {
    return {
      state: "Stopped",
      why: "Too many people marked emails from this address as spam. Sending from it now would get your whole domain blocked.",
      act: `Stop using ${snap.address} and set up a different address for outreach. This one cannot be recovered by waiting.`,
    };
  }
  if (snap.state === "paused") {
    return { state: "Paused", why: "You paused this address, so nothing goes out from it.", act: `Turn ${snap.address} back on when you are ready.` };
  }
  if (snap.ramp.penalty > 0) {
    return {
      state: "Slowed down",
      why:
        "Someone marked one of your emails as spam, or an address you wrote to did not exist. We have slowed this address down for a while — that is how you avoid being blocked altogether.",
      act: "Check where these contacts came from. A list with bad addresses in it is what causes this.",
    };
  }
  if (snap.ramp.bounceRate > 0.05 || snap.ramp.complaintRate > 0.003) {
    return {
      state: "Slowed down",
      why: "Too many emails from this address are not arriving. We have slowed it down until that improves.",
      act: "Check where these contacts came from — this usually means the list has bad addresses in it.",
    };
  }
  if (snap.ramp.cap < RAMP[RAMP.length - 1]!) {
    return {
      state: "Settling in",
      why:
        "This is a newer address, so we send a small number each day and build up. New addresses that send a lot straight away end up in spam and stay there.",
    };
  }
  return { state: "Ready", why: "This address is established and sending normally." };
}

/** "3 days ago", "today". Never an ISO string on a screen. */
function when(iso: string, now: Date): string {
  const days = Math.floor((now.getTime() - Date.parse(iso)) / 86_400_000);
  if (!Number.isFinite(days) || days < 0) return "just now";
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

/**
 * Who we stopped emailing, described as a person would.
 *
 * The address is shown when we kept it and a description when we did not — "someone who asked to be
 * removed" is the honest rendering of a record we deliberately hold only as a hash, and it is also
 * the more useful sentence: the founder does not need to know WHO unsubscribed, only that somebody
 * did and that we are honouring it.
 */
function stoppedRow(s: Suppression, now: Date): { who: string; why: string; when: string } {
  return {
    who: s.email ?? "Someone who asked to be removed",
    why: REASON_SAID[s.reason],
    when: when(s.at, now),
  };
}

export async function sendingReport(projectId: string, now: Date = new Date()): Promise<SendingReport> {
  const [health, stopped] = await Promise.all([inboxHealth(projectId, now), recentSuppressions(projectId, 20)]);

  const addresses = health.map((h) => {
    const s = stateOf(h);
    return {
      address: h.address,
      state: s.state,
      today: `${h.sentToday} of ${h.ramp.cap} sent today`,
      why: s.why,
      act: s.act,
    };
  });
  const canSend = health.reduce((n, h) => n + Math.max(0, h.ramp.cap - h.sentToday), 0);

  /**
   * NOTHING SET UP IS NOT AN ERROR AND MUST NOT LOOK LIKE ONE.
   *
   * A founder who has not started outreach yet opening this screen should read a sentence that tells
   * them where they are, not an empty table or a red badge. An empty state that reads as a fault is
   * how somebody concludes the product is broken on their first visit.
   */
  if (!health.length) {
    return {
      headline: "You have not sent any outreach email yet.",
      can_send_today: 0,
      addresses: [],
      stopped: stopped.map((s) => stoppedRow(s, now)),
      do_this: [],
    };
  }

  const worst = addresses.find((a) => a.state === "Stopped") ?? addresses.find((a) => a.state === "Slowed down");
  const headline = worst
    ? worst.state === "Stopped"
      ? `${worst.address} can no longer be used for outreach.`
      : `Your sending has been slowed down, and you can send ${canSend} more ${canSend === 1 ? "email" : "emails"} today.`
    : canSend === 0
      ? "You have sent everything for today. More tomorrow morning."
      : `You can send ${canSend} more ${canSend === 1 ? "email" : "emails"} today.`;

  return {
    headline,
    can_send_today: canSend,
    addresses: addresses.map(({ act, ...rest }) => {
      void act;
      return rest;
    }),
    stopped: stopped.map((s) => stoppedRow(s, now)),
    // Deduplicated: three addresses with the same problem is one thing to do, not three.
    do_this: [...new Set(addresses.map((a) => a.act).filter((x): x is string => !!x))],
  };
}
