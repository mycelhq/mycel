# Security Policy

Mycel mediates privileged I/O — provider keys, connection secrets, and real-world actions. We take
reports seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Use GitHub's private vulnerability reporting on this repo
(Security → Report a vulnerability), or email the maintainers listed on the org profile.

Include: what you found, how to reproduce it, and the impact you think it has. We'll acknowledge
within a few days and keep you updated as we work on a fix.

## What we consider in scope

- Anything that gets a **real secret into the sandbox** (provider keys, connection secrets).
- Bypassing the **human approval gate** on an outward action.
- **Cross-tenant access**: reading or acting on another project's tasks, connections, clients,
  threads, knowledge, or artifacts.
- Auth bypass on `/v1`, or forging a member session / product key.
- Escaping the intended scope of the LLM proxy (model/token pinning, path allowlist).

## Known limitations (not vulnerabilities)

These are documented trade-offs in `docs/INTEGRATION.md`, not bugs:

- **`MYCEL_SANDBOX=local` is not an isolation boundary.** It shares the host kernel and is a dev
  convenience. Use `docker` or `daytona` for untrusted work.
- **Per-task tool ACLs are coarse** — governed by the approval gate and a bash denylist, not a hard
  per-task allowlist yet.
- **Single-instance assumptions** — cancel, approvals, the SSE bus, and grants are in-process.

## Supported versions

Pre-alpha: only the `main` branch is supported. Fixes land there.
