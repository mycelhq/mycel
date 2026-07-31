// A Langfuse project per Mycel project.
//
// This was previously ruled out on the grounds that per-project provisioning needs Langfuse's
// Enterprise instance-management API. That was half right and the half that mattered was wrong:
// creating an ORGANISATION is Enterprise, but an organisation-scoped API key — which you make in
// the Langfuse UI under Organization Settings — can create projects and mint per-project keys
// through the ordinary public API:
//
//   POST /api/public/projects                     { name, retention }        -> { id, name }
//   POST /api/public/projects/{id}/apiKeys        {}                          -> { publicKey, secretKey }
//
// Why it's worth doing rather than tagging one shared project: traces contain customers' data.
// Tagging gives a founder a filtered view of a dataset that still physically holds every other
// tenant's traces, and "filtered" is a promise about our query construction rather than a boundary.
// Separate projects mean a founder's key reads their traces and nothing else — the same posture the
// rest of the kernel takes.
//
// Provisioning is LAZY, on the first trace rather than at signup. Two reasons: signup must not
// depend on a third-party API being up, and an org that never runs anything should never appear in
// our Langfuse bill.
import { getSecret, setSecret } from "./secrets";

export interface LangfuseProjectKeys {
  projectId: string;
  publicKey: string;
  secretKey: string;
}

/** The organisation-scoped credential, and where the instance lives. Absent = feature off. */
export function orgCredentials(): { host: string; auth: string } | undefined {
  const pub = process.env.LANGFUSE_ORG_PUBLIC_KEY;
  const sec = process.env.LANGFUSE_ORG_SECRET_KEY;
  if (!pub || !sec) return undefined;
  return {
    host: (process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/+$/, ""),
    // Basic auth, per the public API.
    auth: `Basic ${Buffer.from(`${pub}:${sec}`).toString("base64")}`,
  };
}

/** Where a project's minted keys live in the encrypted vault. */
const vaultKey = (projectId: string) => `langfuse:project:${projectId}`;

/**
 * The keys for this project, provisioning them on first use.
 *
 * Returns undefined when the feature is off or Langfuse is unreachable — the caller degrades to the
 * shared instance or to no tracing at all. Losing a trace is never worth failing a customer's run.
 */
export async function keysForProject(
  projectId: string,
  displayName: string,
): Promise<LangfuseProjectKeys | undefined> {
  const stored = await getSecret(vaultKey(projectId));
  if (stored) {
    try {
      return JSON.parse(stored) as LangfuseProjectKeys;
    } catch {
      // A corrupt entry should not wedge tracing forever; fall through and mint a fresh project.
    }
  }
  const org = orgCredentials();
  if (!org) return undefined;

  try {
    const created = await provision(org, projectId, displayName);
    // Stored encrypted, in the same vault as every other credential the kernel holds. These are
    // write keys for a customer's trace data — they are not configuration.
    await setSecret(vaultKey(projectId), JSON.stringify(created));
    return created;
  } catch (e) {
    console.error(`[mycel] could not provision a Langfuse project for ${projectId}:`, (e as Error).message);
    return undefined;
  }
}

async function provision(
  org: { host: string; auth: string },
  projectId: string,
  displayName: string,
): Promise<LangfuseProjectKeys> {
  const headers = { authorization: org.auth, "content-type": "application/json" };
  const timeout = () => AbortSignal.timeout(10_000);

  const res = await fetch(`${org.host}/api/public/projects`, {
    method: "POST",
    headers,
    signal: timeout(),
    body: JSON.stringify({
      // Suffixed with our project id so two founders who both call their business "Bookkeeping"
      // remain distinguishable to a human reading the Langfuse sidebar.
      name: `${displayName} (${projectId.slice(0, 8)})`,
      // Required by the API. 0 means "keep indefinitely" — any other value needs a data-retention
      // entitlement we may not have, and silently failing to provision would be worse than keeping.
      retention: 0,
      metadata: { mycel_project_id: projectId },
    }),
  });
  if (!res.ok) throw new Error(`create project: ${res.status} ${await res.text()}`);
  const project = (await res.json()) as { id: string };

  const keyRes = await fetch(`${org.host}/api/public/projects/${project.id}/apiKeys`, {
    method: "POST",
    headers,
    signal: timeout(),
    body: JSON.stringify({ note: `mycel ${projectId}` }),
  });
  if (!keyRes.ok) throw new Error(`create api key: ${keyRes.status} ${await keyRes.text()}`);
  const key = (await keyRes.json()) as { publicKey: string; secretKey: string };

  return { projectId: project.id, publicKey: key.publicKey, secretKey: key.secretKey };
}

/**
 * A link straight to this project's traces.
 *
 * Only meaningful once the project exists — before that there is nothing to look at, and sending a
 * founder to an empty dashboard is the failure `langfuseState()` already warns about.
 */
export async function traceUrlFor(projectId: string): Promise<string | undefined> {
  const stored = await getSecret(vaultKey(projectId));
  if (!stored) return undefined;
  try {
    const { projectId: lfId } = JSON.parse(stored) as LangfuseProjectKeys;
    const host = (process.env.LANGFUSE_HOST ?? "https://cloud.langfuse.com").replace(/\/+$/, "");
    return `${host}/project/${lfId}/traces`;
  } catch {
    return undefined;
  }
}

/** True when a founder gets their own Langfuse project rather than a filtered view of a shared one. */
export const perProjectTracing = (): boolean => !!orgCredentials();
