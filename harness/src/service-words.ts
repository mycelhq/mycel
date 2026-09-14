/**
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 * THE TWO REFUSALS A FOUNDER CAN ACTUALLY READ
 * ═════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `wedge` is our word. `no-vocabulary-of-ours.test.ts` in the console states the rule and where the
 * line is: not "avoid jargon" — a bookkeeper knows what a VAT return is — but *a word a founder did
 * not name, cannot change, and cannot act on*. `wedge` exists because of how we built this, not
 * because of how the business works.
 *
 * The console has been clean for a while. The KERNEL was not, and its sentences reach the same
 * screens: `refusalFrom` in the console shows a kernel refusal verbatim, on purpose and for a good
 * reason — a plan refusal rendered as "try again in a moment" is a retry instruction for a decision.
 * So the moment a founder typed a brief for a service that was not installed, they read
 * `unknown wedge: books-keeper`.
 *
 * Two sentences, 25 call sites, one place to write them.
 *
 * ═══ WHAT IS DELIBERATELY NOT HERE ═══
 *
 * `"wedge and task_type are required"` and its siblings stay exactly as they are. Those name JSON
 * FIELDS in a request body, to whoever is posting it — the field really is called `wedge`, and
 * calling it a "service" in the error would send an integrator looking for a key that does not
 * exist. The distinction is the same one the console's guard draws: a word the reader cannot act on
 * versus a word that IS the action.
 */

/** No service by that name exists on this installation. */
export function unknownService(slug: unknown): string {
  return `no service called "${String(slug ?? "")}" is installed here`;
}

/** It exists, and this business is not running it. */
export function serviceNotEnabled(slug: unknown): string {
  return `"${String(slug ?? "")}" isn't one of the services this business runs`;
}
