// Deterministic outbound cadence. Given the facts on a Case, the next step is fixed —
// not a model judgment. Skills decide HOW to write; this decides WHETHER / WHICH touch.
// Pure: no I/O, no clock (today / days_since are passed in).

export default function nextTouch(args) {
  const stage = String(args.stage ?? "prospect");
  const hasReply = args.has_reply === true;
  const optOut = args.opt_out === true;
  const daysSince =
    args.days_since_last_touch === undefined || args.days_since_last_touch === null
      ? null
      : Number(args.days_since_last_touch);
  const touchCount = Number(args.touch_count ?? 0);

  if (optOut) {
    return {
      should_send: false,
      mark_closed: true,
      next_stage: "closed_lost",
      touch_number: touchCount,
      next_touch_after_days: null,
      reason: "opt-out — stop permanently",
    };
  }

  if (hasReply || stage === "replied" || stage === "booked") {
    return {
      should_send: false,
      mark_closed: false,
      next_stage: stage === "booked" ? "booked" : "replied",
      touch_number: touchCount,
      next_touch_after_days: null,
      reason: "inbound reply or booked — hand to a human, do not draft another touch",
    };
  }

  if (stage === "closed_lost") {
    return {
      should_send: false,
      mark_closed: true,
      next_stage: "closed_lost",
      touch_number: touchCount,
      next_touch_after_days: null,
      reason: "sequence already closed",
    };
  }

  // First touch: from prospect (or touch_1 with zero sends).
  if (stage === "prospect" || (stage === "touch_1" && touchCount < 1)) {
    return {
      should_send: true,
      mark_closed: false,
      next_stage: "touch_1",
      touch_number: 1,
      next_touch_after_days: 4,
      reason: "first touch due",
    };
  }

  // Touch 2: +4 days after touch 1.
  if (stage === "touch_1" || (stage === "touch_2" && touchCount < 2)) {
    if (daysSince !== null && daysSince < 4) {
      return {
        should_send: false,
        mark_closed: false,
        next_stage: "touch_1",
        touch_number: 1,
        next_touch_after_days: 4 - daysSince,
        reason: `wait ${4 - daysSince}d before touch 2`,
      };
    }
    return {
      should_send: true,
      mark_closed: false,
      next_stage: "touch_2",
      touch_number: 2,
      next_touch_after_days: 3,
      reason: "second touch due (+4d)",
    };
  }

  // Touch 3: ~+3 days after touch 2 (playbook: third touch ~+7 from start).
  if (stage === "touch_2" || (stage === "touch_3" && touchCount < 3)) {
    if (daysSince !== null && daysSince < 3) {
      return {
        should_send: false,
        mark_closed: false,
        next_stage: "touch_2",
        touch_number: 2,
        next_touch_after_days: 3 - daysSince,
        reason: `wait ${3 - daysSince}d before touch 3`,
      };
    }
    return {
      should_send: true,
      mark_closed: false,
      next_stage: "touch_3",
      touch_number: 3,
      next_touch_after_days: null,
      reason: "final touch due — clean close",
    };
  }

  // After touch 3 with no reply: close lost.
  if (stage === "touch_3") {
    if (daysSince !== null && daysSince < 3) {
      return {
        should_send: false,
        mark_closed: false,
        next_stage: "touch_3",
        touch_number: 3,
        next_touch_after_days: 3 - daysSince,
        reason: "final touch sent — waiting before close",
      };
    }
    return {
      should_send: false,
      mark_closed: true,
      next_stage: "closed_lost",
      touch_number: 3,
      next_touch_after_days: null,
      reason: "three touches exhausted — close lost",
    };
  }

  return {
    should_send: false,
    mark_closed: false,
    next_stage: stage,
    touch_number: touchCount,
    next_touch_after_days: null,
    reason: `no cadence rule for stage ${stage}`,
  };
}
