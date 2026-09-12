import { test } from "node:test";
import assert from "node:assert/strict";
import { companyPeopleUrl } from "../src/linkedin/discover";
import { hasLinkedInExecutor } from "../src/actions";
import { capability, riskFor, touchFor } from "../src/linkedin/capabilities";
import { READ_LIVE_SET, SEQUENCE_LIVE_SET } from "../src/linkedin/verbs";

test("company_people is a wired, executable capability", () => {
  assert.equal(hasLinkedInExecutor("company_people"), true);
  const c = capability("company_people");
  assert.ok(c, "capability must be declared in the catalogue");
  assert.equal(c!.kind, "read");
  assert.equal(riskFor("company_people"), "low");
  // touch:null → free and unpaced today, exactly like search_people.
  assert.equal(touchFor("company_people"), null);
});

test("company_people is a finder read, never a sequence step", () => {
  assert.equal(READ_LIVE_SET.has("company_people"), true);
  assert.equal(SEQUENCE_LIVE_SET.has("company_people"), false);
});

test("company-people URL carries the ORGANIZATION_ALUMNI facet and the numeric org id", () => {
  const u = companyPeopleUrl("2135371", 0, 10);
  assert.match(u, /\/voyager\/api\/graphql\?/);
  assert.match(u, /flagshipSearchIntent:ORGANIZATIONS_PEOPLE_ALUMNI/);
  assert.match(u, /\(key:currentCompany,value:List\(2135371\)\)/);
  assert.match(u, /\(key:resultType,value:List\(ORGANIZATION_ALUMNI\)\)/);
  assert.match(u, /start:0/);
  assert.match(u, /count:10/);
  assert.match(u, /queryId=voyagerSearchDashClusters\./);
});

test("company-people URL sends Rest.li tokens literally, not percent-encoded (encoding them 400s)", () => {
  const u = companyPeopleUrl("42", 0, 12);
  // The structural characters LinkedIn's Rest.li parser wants raw must survive verbatim.
  assert.ok(u.includes("List("), "List( must be literal");
  assert.ok(u.includes("query:(flagshipSearchIntent"), "nested object parens must be literal");
  assert.doesNotMatch(u, /%28|%29|%3A/, "no encoded parens or colons in the variables");
});

test("company-people URL paging is offset-based", () => {
  assert.match(companyPeopleUrl("42", 24, 12), /start:24/);
  assert.match(companyPeopleUrl("42", 0, 12), /start:0/);
});

test("company id is coerced to digits — a caller cannot inject into the Rest.li string", () => {
  // Anything non-numeric is stripped, so ')' or facet-injection attempts cannot break out.
  assert.match(companyPeopleUrl("2135371)),evil:List((x", 0, 12), /value:List\(2135371\)\)/);
  assert.match(companyPeopleUrl("urn:li:fsd_company:88", 0, 12), /value:List\(88\)/);
});

test("company-people URL refuses an id with no digits at all", () => {
  assert.throws(() => companyPeopleUrl("stripe", 0, 12), /numeric organization id/);
  assert.throws(() => companyPeopleUrl("", 0, 12), /numeric organization id/);
});

test("negative or fractional start is floored to a safe offset", () => {
  assert.match(companyPeopleUrl("42", -5, 12), /start:0/);
  assert.match(companyPeopleUrl("42", 12.9, 12), /start:12/);
});
