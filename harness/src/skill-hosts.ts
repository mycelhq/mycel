// The hosts a skill may be fetched from, in one place because three callers need the same answer.
//
// `server.ts` had this inline as SKILL_SOURCE_HOSTS. Once `skill-sourcing.ts` had to answer the same
// question for the agent path, a second copy would have been a second thing to update — and the
// failure mode of the two disagreeing is that one door is open wider than the other, silently.
//
// RAW hosts only. A rendered github.com page is HTML wrapping the prose; importing it would store
// navigation chrome as procedure, and the difference is invisible in a diff.
export const GITHUB_RAW_HOSTS: ReadonlySet<string> = new Set([
  "raw.githubusercontent.com",
  "gist.githubusercontent.com",
]);
