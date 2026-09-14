// A file's instructions, without its explanations.
//
// ═══ FIVE TIMES IN ONE WEEK ═══
//
// Guards here scan source and config for a pattern that must or must not be present. Every one of
// them also scans the COMMENTS, and the comments are where this repo explains why the rule exists —
// usually by quoting the exact thing being banned. So:
//
//   · `ci-does-not-drift` looked for `branches: ["**"]`, which the comment above the fixed `on:`
//     block quotes to explain what was removed. It failed a correct file.
//   · `docs: nothing is listed as a wedge` flagged the sentence recording that a wedge was deleted.
//   · the publish scanner saw its own test's explanation of the path it bans.
//   · the rewrite's self-check fired on the Dockerfile header, which quotes `file:../packages/x`
//     to explain why the destination is absolute.
//   · `setup-scripts-agree` asserted setup.ps1 contains "npm run demo" — satisfied by the paragraph
//     saying that line USED to be missing. Deleting the real line left the test green.
//
// Four false failures and one false pass. The false pass is the reason this is a helper rather than
// a note: a guard that fires on a correct file gets noticed and fixed; a guard satisfied by its own
// documentation is invisible.
//
// The fix is never an exclusion for the offending string. A check on instructions reads instructions.

/**
 * Drop whole-line comments, keeping line numbers intact so a reported match is still findable.
 *
 * `#` covers YAML, shell, PowerShell, Dockerfile and .npmrc — every format these guards read. It is
 * deliberately not clever: a trailing comment on a real directive stays, because that line IS an
 * instruction and the guard should see it. JSON has no comments and passes through unchanged.
 */
export const directives = (src: string): string =>
  src
    .split("\n")
    .map((line) => (/^\s*#/.test(line) ? "" : line))
    .join("\n");
