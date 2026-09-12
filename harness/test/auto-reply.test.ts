import { test } from "node:test";
import assert from "node:assert/strict";
import { readAutoReply } from "../src/outreach/auto-reply";

/**
 * An inbound message does three things: it is filed, it STARTS A RUN, and if the thread is one we
 * chased an invoice on it STANDS THE CHASE DOWN. All three are right for a client writing back and
 * all three are wrong for an out-of-office — the client is on holiday, the machine answers, the
 * chase stops, and nobody finds out until the money is a month older.
 *
 * `readDsn` already catches the bounce version of this and its note records what it cost. This is
 * the same failure with a live mailbox behind it.
 */
test("a no-reply sender is never a person", () => {
  for (const from of [
    "no-reply@acme.example",
    "noreply@acme.example",
    "do-not-reply@acme.example",
    "donotreply@acme.example",
    "MAILER-DAEMON@acme.example",
    "notifications@acme.example",
    "bounce@acme.example",
    "auto_reply@acme.example",
    "no-reply+invoice-4821@acme.example",
  ]) {
    const v = readAutoReply({ from_handle: from });
    assert.ok(v, `${from} was treated as a client writing in`);
    assert.equal(v.because, "sender");
  }
});

test("the DOMAIN is not the signal — only the local part", () => {
  /**
   * `noreply.acme.com` is somebody's mail host and `jane@noreply-solutions.example` is a person at a
   * company with an unfortunate name. Matching the domain would silence both.
   */
  for (const from of ["jane@noreply.acme.example", "sam@noreply-solutions.example", "ops@notifications.acme.example"]) {
    assert.equal(readAutoReply({ from_handle: from }), undefined, `${from} was silenced by its domain`);
  }
});

test("an autoresponder announces itself in the subject, in several languages", () => {
  for (const subject of [
    "Automatic reply: Your March invoice",
    "Auto-Reply: out of contact",
    "Out of Office: back on the 14th",
    "Out of the office until Monday",
    "Réponse automatique : facture de mars",
    "Abwesenheitsnotiz: Ich bin bis Montag nicht im Büro",
    "Automatisch antwoord: afwezig",
    "RE: Automatic reply: your message",
  ]) {
    const v = readAutoReply({ from_handle: "jane@acme.example", subject });
    assert.ok(v, `"${subject}" was treated as a person writing in`);
    assert.equal(v.because, "subject");
  }
});

test("a person writing ABOUT being out of office is a person", () => {
  /**
   * The failure that matters. A false negative costs one wasted run and a chase that pauses a few
   * days early; a false positive is a real client writing in and the business never noticing. So the
   * subject is matched only at the START, and the body is never read at all — "I am out of the
   * office next week, can we move it?" is a client asking for something.
   */
  for (const subject of [
    "Re: out of office cover for August",
    "Question about your out of office policy",
    "Invoice 4821 — I'll be out of the office, can we push it?",
    "Re: March close",
  ]) {
    assert.equal(
      readAutoReply({ from_handle: "jane@acme.example", subject }),
      undefined,
      `"${subject}" was silenced — a real client just went unheard`,
    );
  }
  assert.equal(readAutoReply({ from_handle: "jane@acme.example", subject: "Re: the file" }), undefined);
});

test("an explicit machine marker survives a Re: prefix; ordinary prose does not get one", () => {
  /**
   * The distinction the first version missed. "Automatic reply" is a phrase only software writes, so
   * a forwarded one still counts. "Out of office" is ordinary English, so it counts only at the
   * absolute start and only when what follows is a colon, the end, or a word an autoresponder uses
   * next — otherwise "Re: out of office cover for August" silences a client asking who is covering.
   */
  assert.ok(readAutoReply({ from_handle: "j@a.example", subject: "RE: Automatic reply: your message" }));
  assert.equal(readAutoReply({ from_handle: "j@a.example", subject: "Re: Out of office" }), undefined);

  // The shapes a real autoresponder actually sends.
  for (const s of ["Out of office", "Out of office: back Monday", "Out of the office until 14 Sept", "On holiday - returning 2 Oct"]) {
    assert.ok(readAutoReply({ from_handle: "j@a.example", subject: s }), `"${s}" was missed`);
  }
});

test("nothing is inferred from an empty message", () => {
  assert.equal(readAutoReply({}), undefined);
  assert.equal(readAutoReply({ from_handle: "", subject: "" }), undefined);
  assert.equal(readAutoReply({ from_handle: "@" }), undefined);
});
