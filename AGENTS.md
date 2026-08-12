# AGENTS.md

Guidance for AI agents working in this repository. Human contributors: see [README.md](./README.md).

## What this is

A single-file [pi](https://pi.dev) provider extension (`index.ts`) for the [Bifrost](https://docs.getbifrost.ai/overview) LLM gateway. It discovers models from Bifrost's OpenAI-compatible endpoint and routes chat completions through it. There is no build step; the package ships TypeScript source directly.

## Commands

```bash
npm run check            # Biome lint/format + tsc --noEmit — must pass before any commit
npm test                 # full suite in mock mode (no network, no processes)
npm run test:integration # same suite against a real Bifrost + aimock fixture (needs network for npx)
npm run fixture          # keep the integration fixture running for manual testing
```

Always run `npm run check` and `npm test` before committing. Run `test:integration` when you touched anything on the request path (URL building, headers, streaming) — mock mode alone can miss real-gateway behavior. Both modes run the same `*.test.ts` files; backend-aware tests switch on `BIFROST_TEST_MODE`.

## Required: AI disclosure on commits, PRs, and issues

This repo's contribution policy (README § "AI policy and usage disclosure") requires every AI-involved commit, pull request, and issue to disclose:

1. **Nature of involvement** — AI-assisted (human-driven with AI help) or agent-generated (agent did the work).
2. **The model used** — e.g. `claude-fable-5`.
3. **The agent harness / tooling** — e.g. Claude Code, Cursor, Copilot Workspace.

Put the disclosure in the PR description (and issue body); for commits, a trailer line is enough. Example PR footer:

```markdown
## AI disclosure
- Involvement: agent-generated, human-reviewed
- Model: claude-fable-5
- Harness: Claude Code
```

Including the initial prompt or conversation history is encouraged but optional. Do not omit the disclosure — all changes receive human review, and undisclosed AI involvement violates repo policy.

## Code style

- Enforced by Biome (`biome.json`): tabs, double quotes, semicolons, trailing commas, 120-column lines. Don't hand-format; run `npx biome check --write <file>`.
- Strict TypeScript; `tsc --noEmit` must stay clean. No `any` without a modeled shape — upstream response types are modeled as deep-optional interfaces (`BifrostModel`) and narrowed with helpers (`nonEmpty`, `positiveInteger`).
- Comments document contracts and constraints only, not narration of the code.

## Contracts that are easy to break

These are documented inline in `index.ts` — read the comment at the site before changing:

- **`bifrostHeaders` uses `Authorization: null` as an active suppression sentinel** (keyless instances must not send pi's default Authorization header). Omission ≠ null. Raw `fetch` callers must filter nulls out.
- **`replaceCatalog` must mutate the catalog array in place** (`splice`) — `createProvider` captures the array by reference; reassignment silently breaks model refresh.
- **Startup model discovery is best-effort.** The extension entry point must never throw on a down Bifrost; it warns on stderr and registers the provider anyway so `/login`-persisted models and `refreshModels` can recover.
- **`pricePerMillion` heuristically converts per-token prices** (values ≤ 0.01 are multiplied by 1e6). Changing the threshold silently corrupts pricing for real catalogs — don't touch without tests covering both units.
- **URL normalization** (`normalizeBifrostUrl`) accepts instance URLs, `/openai` mounts, and existing `/v1` bases, and strips trailing endpoint paths. New URL behavior needs cases in the "normalizes Bifrost instance and API URLs" test.
- **Credential precedence**: stored `/login` credentials > CLI flags > environment. A credential that carries its own URL "owns" its config — ambient fallbacks must not leak into it (see `credentialConfig`).

## Testing conventions

- Tests use `node:test` + `node:assert/strict`, run via `tsx` by `test/run-tests.ts` (which discovers `test/**/*.test.ts`). Add tests next to the existing ones in `test/provider.test.ts`; new files need the `.test.ts` suffix.
- Mock HTTP by passing a `fetch` implementation through the options that `fetchBifrostModels` / `createBifrostProvider` / stream options accept — never patch globals.
- Integration fixture knobs (ports, hosts, package pins, timeouts) are env vars documented in README § Testing.

## CI

- `ci.yml`: check + mock tests on every push/PR.
- `integration.yml`: daily canary (03:00 UTC) against the **latest published** `@maximhq/bifrost`. A red canary with green CI means an upstream Bifrost change broke the provider — fix the provider or pin/report upstream; don't silence the workflow.
