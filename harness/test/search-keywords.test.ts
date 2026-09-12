import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPHQL_URL,
  SEARCH_ACCEPT,
  SEARCH_PAGE,
  XHR_ACCEPT,
  isBlendedSearchRedirect,
  isDeadSearchRedirect,
  isLoginHtml,
  isPeopleSrpRedirect,
  isSearchRefusedRedirect,
  isSessionRedirect,
  keywordsFor,
  parseEmbeddedPeople,
  parseHtmlPeople,
  parsePeople,
  peopleFromSearchBody,
  peopleSearchUrl,
  graphqlXhrFromHtml,
  searchHeaders,
} from "../src/linkedin/search";
import { describeNetworkError } from "../src/linkedin/proxy";

test("country or city is folded into search keywords, not a fake geo filter", () => {
  assert.equal(keywordsFor({ query: "bookkeeper", location: "United Kingdom" }), "bookkeeper United Kingdom");
  assert.equal(keywordsFor({ query: "founder SaaS", location: "France" }), "founder SaaS France");
  assert.equal(keywordsFor({ query: "bookkeeper" }), "bookkeeper");
});

test("people search GETs the people SRP with France in keywords, not GraphQL and not a geo URN", () => {
  const url = peopleSearchUrl("founder SaaS France", 0);
  assert.match(url, /^https:\/\/www\.linkedin\.com\/search\/results\/people\/\?/);
  assert.equal(url.startsWith(SEARCH_PAGE), true);
  assert.match(url, /keywords=founder(\+|%20)SaaS(\+|%20)France/);
  assert.doesNotMatch(url, /origin=/);
  assert.doesNotMatch(url, /geoUrn|geo-/i);
  assert.doesNotMatch(url, /voyagerSearchDashClusters/);
  assert.doesNotMatch(url, /\/voyager\/api\//);
  assert.doesNotMatch(url, /\/search\/blended/);
  assert.notEqual(url, GRAPHQL_URL);
});

test("GraphQL path-only is not the people search URL", () => {
  assert.notEqual(peopleSearchUrl("founder France"), GRAPHQL_URL);
  assert.doesNotMatch(peopleSearchUrl("founder France"), /\/voyager\/api\/graphql/);
});

test("search headers are a document GET, not Voyager JSON", () => {
  const h = searchHeaders();
  assert.equal(h.accept, SEARCH_ACCEPT);
  assert.match(h.accept, /text\/html/);
  assert.doesNotMatch(h.accept, /vnd\.linkedin\.normalized\+json/);
  assert.match(h.referer ?? "", /linkedin\.com\/feed/);
  assert.equal(h.origin, undefined);
  assert.equal(h["sec-fetch-site"], "none");
  assert.equal(h["sec-fetch-mode"], "navigate");
  assert.doesNotMatch(JSON.stringify(h), /geoUrn/i);
});

test("a 302 onto /search/blended or path-only /graphql is a dead search endpoint", () => {
  assert.equal(isBlendedSearchRedirect(302, "https://www.linkedin.com/voyager/api/search/blended"), true);
  assert.equal(isBlendedSearchRedirect(200, "https://www.linkedin.com/voyager/api/search/blended"), false);
  assert.equal(isBlendedSearchRedirect(302, "https://www.linkedin.com/voyager/api/graphql"), false);
  assert.equal(isDeadSearchRedirect(302, "https://www.linkedin.com/voyager/api/graphql"), true);
  assert.equal(isDeadSearchRedirect(302, "https://www.linkedin.com/voyager/api/search/blended"), true);
  assert.equal(isDeadSearchRedirect(200, "https://www.linkedin.com/voyager/api/graphql"), false);
});

test("a 302 onto /uas/login is a session error, not a search hop", () => {
  assert.equal(isSessionRedirect(302, "https://www.linkedin.com/uas/login"), true);
  assert.equal(isSessionRedirect(302, "https://www.linkedin.com/voyager/api/graphql"), false);
  assert.equal(isSessionRedirect(200, "https://www.linkedin.com/uas/login"), false);
});

test("a 302 onto /search/results/people/ is the HTML SRP, with or without query", () => {
  assert.equal(isPeopleSrpRedirect(302, "https://www.linkedin.com/search/results/people/"), true);
  assert.equal(isPeopleSrpRedirect(302, "https://www.linkedin.com/search/results/people/?keywords=x"), true);
  assert.equal(isPeopleSrpRedirect(200, "https://www.linkedin.com/search/results/people/"), false);
  assert.equal(isPeopleSrpRedirect(302, "https://www.linkedin.com/voyager/api/graphql"), false);
});

test("a keyword-stripping 302 is search REFUSED (the free-account monthly cap), not a page to follow", () => {
  const bare = "https://www.linkedin.com/search/results/people/";
  const kept = "https://www.linkedin.com/search/results/people/?keywords=founder";
  // Keywords dropped onto a bare SRP → refused.
  assert.equal(isSearchRefusedRedirect({ status: 302, redirectUrl: bare } as never, "founder"), true);
  // Keywords survived → a real hop, follow it (not refused).
  assert.equal(isSearchRefusedRedirect({ status: 302, redirectUrl: kept } as never, "founder"), false);
  // No query in what we asked → nothing to strip, so this signal cannot fire.
  assert.equal(isSearchRefusedRedirect({ status: 302, redirectUrl: bare } as never, ""), false);
  // A 200 is an answer, not a refusal.
  assert.equal(isSearchRefusedRedirect({ status: 200, redirectUrl: bare } as never, "founder"), false);
  // Only the query-stripped location is available (no redirectUrl) → we cannot tell, so say no.
  assert.equal(isSearchRefusedRedirect({ status: 302, location: bare } as never, "founder"), false);
  // A redirect somewhere else entirely is not this signal.
  assert.equal(
    isSearchRefusedRedirect({ status: 302, redirectUrl: "https://www.linkedin.com/voyager/api/graphql" } as never, "founder"),
    false,
  );
});

const ADA_SRP_HTML = `
<div role="listitem">
  <a href="https://www.linkedin.com/in/ada-lovelace/">Ada Lovelace<span> </span></a>
  <p><span>Mathematician at Analytical Engine</span></p>
  <p><span>London, United Kingdom</span></p>
  <div id="SearchResultsACoAAAAda"></div>
</div>`;

test("parseHtmlPeople reads Brave people-SRP listitem cards", () => {
  const people = parseHtmlPeople(ADA_SRP_HTML);
  assert.equal(people.length, 1);
  assert.equal(people[0].public_id, "ada-lovelace");
  assert.equal(people[0].name, "Ada Lovelace");
  assert.match(people[0].headline ?? "", /Mathematician/);
  assert.match(people[0].location ?? "", /London/);
  assert.equal(people[0].urn, "urn:li:fsd_profile:ACoAAAAda");
  assert.equal(people[0].profile_url, "https://www.linkedin.com/in/ada-lovelace");
});

const FLAGSHIP_DOUBLED = `
<div role="listitem">
  <a href="https://www.linkedin.com/in/ada-lovelace/">Ada Lovelace Ada Lovelace</a>
  <p><span>Mathematician at Analytical Engine</span></p>
  <p><span>London, United Kingdom</span></p>
  <div id="SearchResultsACoAAAAda"></div>
</div>`;

test("parseHtmlPeople collapses flagship doubled profile-link names", () => {
  const people = parseHtmlPeople(FLAGSHIP_DOUBLED);
  assert.equal(people.length, 1);
  assert.equal(people[0].name, "Ada Lovelace");
  assert.match(people[0].headline ?? "", /Mathematician/);
});

const ADA_BPR = `<code id="bpr-guid-3498" style="display:none"><!--{"included":[{"title":{"text":"Ada Lovelace"},"publicIdentifier":"ada-lovelace","navigationUrl":"https://www.linkedin.com/in/ada-lovelace","entityUrn":"urn:li:fsd_profile:ACoAAA"}]}--></code>`;
const ADA_BPR_ENCODED = `<code id="bpr-guid-1">{&quot;included&quot;:[{&quot;title&quot;:{&quot;text&quot;:&quot;Ada Lovelace&quot;},&quot;publicIdentifier&quot;:&quot;ada-lovelace&quot;,&quot;navigationUrl&quot;:&quot;https://www.linkedin.com/in/ada-lovelace&quot;}]}</code>`;
const ADA_NEXT = `<script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"included":[{"title":{"text":"Ada Lovelace"},"publicIdentifier":"ada-lovelace","navigationUrl":"https://www.linkedin.com/in/ada-lovelace"}]}}}</script>`;

test("parseEmbeddedPeople reads bpr-guid, entity-encoded code, and __NEXT_DATA__", () => {
  for (const html of [ADA_BPR, ADA_BPR_ENCODED, ADA_NEXT]) {
    const people = parseEmbeddedPeople(html);
    assert.equal(people.length, 1, html.slice(0, 40));
    assert.equal(people[0].public_id, "ada-lovelace");
    assert.equal(people[0].name, "Ada Lovelace");
  }
});

test("peopleFromSearchBody prefers embedded JSON over empty listitem markup", () => {
  const people = peopleFromSearchBody(undefined, `<div>${ADA_BPR}</div>`);
  assert.equal(people.length, 1);
  assert.equal(people[0].public_id, "ada-lovelace");
});

test("isLoginHtml is a login form, not a people SRP that mentions sign in", () => {
  assert.equal(
    isLoginHtml(`<form action="/uas/login"><input name="session_key"><input type="password" name="session_password"></form>`),
    true,
  );
  assert.equal(isLoginHtml(ADA_SRP_HTML), false);
  assert.equal(isLoginHtml(`<div>Sign in to see more profiles</div>`), false);
});

test("graphqlXhrFromHtml copies the one clusters URL out of the SRP HTML", () => {
  const html = `<script>fetch("https://www.linkedin.com/voyager/api/graphql?queryId=voyagerSearchDashClusters.abc123def456&variables=(start:0)")</script>`;
  const url = graphqlXhrFromHtml(html);
  assert.match(url ?? "", /\/voyager\/api\/graphql\?/);
  assert.match(url ?? "", /voyagerSearchDashClusters\.abc123def456/);
  assert.equal(graphqlXhrFromHtml(ADA_SRP_HTML), undefined);
  assert.equal(XHR_ACCEPT.includes("json"), true);
});

test("parsePeople reads voyagerSearchDashClusters entityResultViewModel hits", () => {
  const people = parsePeople({
    data: {
      data: {
        searchDashClustersByAll: {
          metadata: { totalResultCount: 1 },
          elements: [
            {
              items: [
                {
                  item: {
                    entityResultViewModel: {
                      title: { text: "Ada Lovelace" },
                      primarySubtitle: { text: "Mathematician at Analytical Engine" },
                      secondarySubtitle: { text: "London, United Kingdom" },
                      navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
                      entityUrn: "urn:li:fsd_entityResultViewModel:(urn:li:fsd_profile:ACoAAA,SEARCH_SRP,people)",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    },
  });
  assert.equal(people.length, 1);
  assert.equal(people[0].public_id, "ada-lovelace");
  assert.equal(people[0].name, "Ada Lovelace");
  assert.match(people[0].headline ?? "", /Mathematician/);
});

test("parsePeople reads typeahead included[] profile hits", () => {
  const people = parsePeople({
    included: [
      {
        title: { text: "Ada Lovelace" },
        publicIdentifier: "ada-lovelace",
        navigationUrl: "https://www.linkedin.com/in/ada-lovelace",
        entityUrn: "urn:li:fsd_profile:ACoAAA",
      },
    ],
  });
  assert.equal(people.length, 1);
  assert.equal(people[0].public_id, "ada-lovelace");
  assert.equal(people[0].name, "Ada Lovelace");
});

test("describeNetworkError unwraps undici's empty `fetch failed`", () => {
  const cause = Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" });
  const wrapped = new TypeError("fetch failed", { cause });
  const detail = describeNetworkError(wrapped);
  assert.match(detail, /UND_ERR_SOCKET/);
  assert.match(detail, /other side closed/);
  assert.notEqual(detail, "fetch failed");
});

test("describeNetworkError names a timeout instead of fetch failed", () => {
  const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const wrapped = new TypeError("fetch failed", { cause: timeout });
  const detail = describeNetworkError(wrapped);
  assert.match(detail, /timeout/i);
  assert.notEqual(detail, "fetch failed");
});
