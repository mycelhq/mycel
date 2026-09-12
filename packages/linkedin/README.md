# @mycel/linkedin

The self-hosted LinkedIn (Voyager) core: session capture, search / profile / invite / message
actions, pacing hooks, a proxy pool and a bandwidth meter. Everything a host must provide — secrets,
pacing semantics, storage, GTM bookkeeping — is injected through the seams in `src/host.ts`, so the
package runs the same inside the kernel, inside `growth/`, or inside a script.

This talks to LinkedIn's private Voyager API. That **violates the LinkedIn User Agreement and can get
an account restricted**: it is opt-in, human-approved, low volume, and behind a per-account
residential proxy. `kernel/docs/VERIFY-LINKEDIN.md` is the operational write-up.

Every module is split the same way on purpose: a thin fetch we cannot verify from here, and pure
parsers we can verify exhaustively against fixtures. Endpoints last for years; response shapes drift
with every web deploy.

---

## Profile reads are a ladder, not an endpoint

On **2026-08-18** `GET /voyager/api/identity/profiles/{publicId}/profileView` started answering
`410 Gone`. It had been the confident profile endpoint for years, and its retirement killed
`get_profile`, `view_profile` **and** `send_invite` (an invitation is addressed by member urn, and a
slug cannot be computed into one) — for every account, at once. Production logged 35,456 copies of
`voyager profile 410` in a day.

`src/health.ts` made that failure quiet. `src/profile.ts` makes it survivable, by trying candidates
in cheapest-first order and **latching** onto the first that returns a parsable shape:

| # | Strategy | Request | Evidence |
|---|---|---|---|
| 1 | `dash-profiles` | `GET /voyager/api/identity/dash/profiles?q=memberIdentity&memberIdentity=<id>` | Inferred, on the same mechanism as the confident `?q=universalName` company finder: a Rest.li dash collection addressed by a named finder. No rotating hash, ~20KB. `decorationId` is an optimisation, never a requirement. |
| 2 | `graphql-dash-profiles` | `GET /voyager/api/graphql?includeWebMetadata=true&variables=(vanityName:<id>)&queryId=voyagerIdentityDashProfiles.<hash>` | The URL **form** is confident — `discover.ts` builds exactly it for the company People tab, `voyager.ts` for the inbox. The `<hash>` is never invented: this candidate is **skipped** unless `MYCEL_LINKEDIN_QID_PROFILE` is set or one was harvested from profile-page HTML. |
| 3 | `profile-page` | `GET https://www.linkedin.com/in/<id>/` as a browser **document**, parsing the SSR JSON islands then the `og:` markup | The strongest evidence in the file: `search.ts` proved on 2026-08-13 that this exact manoeuvre (document accept, no csrf / Rest.li / origin, just `li_at` + `JSESSIONID`) returns 200 flagship HTML on a home IP and through a residential proxy while the JSON APIs 302. It cannot be retired by an API change — it is the page a human loads. Last because it is ~900KB. |
| 4 | `legacy-profile-view` | the 410'd endpoint | **Off** unless `MYCEL_LINKEDIN_LEGACY_PROFILEVIEW=1`. Kept for an account LinkedIn still serves it to. |

Rules the ladder follows:

* a **parsed** profile latches the candidate — the ladder costs extra requests once per process, not
  once per prospect;
* **404 / 403** is an *answer* ("no such profile" / "not visible to this account"). If every
  candidate says it, the read is `null` and nothing is stopped;
* **410** retires that one candidate and clears the connection stop it stamped — but only while
  another candidate remains. A dead endpoint is a fact about the endpoint, not the account;
* a **200 in a shape we cannot read** retires that candidate too, so we do not pay for the same
  unreadable body on every prospect;
* **429 / 5xx / timeouts / challenges** stop the ladder immediately. They are about the account, and
  walking three more endpoints while LinkedIn asks us to slow down is how the next incident starts;
* when everything is spent: `LinkedInProfileEndpointUnknownError` — **permanent**, coded
  `linkedin_profile_endpoint_unknown` (so the sequencer waits a day, not an hour), and carrying the
  devtools capture list below.

### The parser is tolerant on purpose

It reads the legacy `profileView` document, the dash `elements[0]` shape, the GraphQL envelope with
its fragments split across `included`, and the SSR page bootstrap — off one code path. It extracts
what exists and **omits what does not**: absent fields are absent keys, never empty strings, because
`graph.ts` *merges* these rows and an empty string would overwrite a headline a previous read had
already learned. Nothing throws on a missing optional field. The single refusal is a document with
neither a public identifier nor a name — that is not a profile, and saying so is what lets the ladder
tell "unrecognised shape" apart from "read worked".

The field set is exactly what the callers use (`graph.ts` → the CRM):
`public_id` (the natural key), `urn` (what `send_invite` addresses), `name`, `headline`, `title`,
`company`, `company_domain`, `company_slug`, `photo_url`, `location`, `industry`, `summary`,
`profile_url`.

---

## Verifying against a real session (no credentials in the repo)

Nothing here can log in to LinkedIn, so the ladder is an ordered set of well-evidenced guesses until
someone with a live session runs it. That script takes cookies from the **environment**, never a
file, never a default, and never prints them — only a fingerprint (`li_at 812 chars, ends …q4Xa`).

```sh
export MYCEL_LI_AT='AQEDA…'                                # from a logged-in browser
export MYCEL_JSESSIONID='"ajax:1234567890"'                # quotes included
export MYCEL_LI_PROXY='http://user:pass@resi.example:8080' # the account's residential proxy

npx tsx packages/linkedin/scripts/verify-profile.ts williamhgates
npx tsx packages/linkedin/scripts/verify-profile.ts williamhgates --all   # probe every candidate
npx tsx packages/linkedin/scripts/verify-profile.ts williamhgates --json  # machine-readable
```

Export the cookies rather than putting them on the command line — a command line lands in shell
history. Without `MYCEL_LI_PROXY` the call is refused by the proxy rule the whole surface rests on;
`MYCEL_LINKEDIN_ALLOW_DIRECT=1` waives it for a one-off probe from your own IP.

It prints which candidate answered, every rung it tried and why each failed, the parsed profile with
an explicit `ABSENT:` line (a tolerant parser is only trustworthy if you can see what it omitted),
and the bytes transferred. Exit 0 = something works; exit 1 = nothing does.

### If nothing works, capture this

Open linkedin.com in a browser where you are logged in, devtools → Network, filter on `voyager`, and
load any profile page. Find the request that returns that person's name / headline / photo, then copy
**six things**:

1. the full request URL, including `queryId=` and `variables=` (or `decorationId=`);
2. the request method;
3. the `accept` request header;
4. any `x-li-*` request headers;
5. the response status;
6. the first ~200 lines of the response JSON — the *shape* is what matters.

Then set `MYCEL_LINKEDIN_QID_PROFILE` (the query id) or `MYCEL_LINKEDIN_PROFILE_DECORATION` (the
decoration id) from it — no code change, no redeploy — or open an issue with the capture so the
parser can be taught the shape. This same list is the text of the permanent error, so a founder who
only ever reads the log gets it too.

---

## Environment

| Var | Default | Meaning |
|---|---|---|
| `MYCEL_LINKEDIN_QID_PROFILE` | unset | Profile GraphQL query id. Unset skips that candidate — hashes are never invented |
| `MYCEL_LINKEDIN_PROFILE_DECORATION` | unset | Named response shape for the dash profile finder. A rotated one costs one 400, then the read continues undecorated |
| `MYCEL_LINKEDIN_LEGACY_PROFILEVIEW` | unset | `1` re-enables the 410'd `profileView` endpoint |
| `MYCEL_LINKEDIN_ALLOW_DIRECT` | unset | `1` waives the per-account proxy requirement. Local only |

The full table — proxies, inbox query ids, sync paging — is in `kernel/docs/VERIFY-LINKEDIN.md`.

## Tests

```sh
npm test --prefix packages/linkedin     # pure-logic tests, no host wired
npm test --prefix kernel                # includes harness/test/linkedin-profile.test.ts
```

`kernel/harness/test/linkedin-profile.test.ts` covers every branch of the ladder against a mocked
transport and every shape the parser accepts against a fixture — including a payload missing all its
optional fields. What no test in this repo can cover is *which* candidate LinkedIn answers today.
That is what the script above is for.
