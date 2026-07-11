---
title: "Headless Agent — ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "implementation-plan"
status: "in-progress"
version: "3"
owner_agent: "Developer"
parent_feature: "acp-mcp"
last_updated: "2026-07-11"
---

# Headless Agent — Implementation Plan

## Phase 1: Rename & Scaffold ✅

~~Rename `packages/acp-mcp/` → `packages/acp-mcp-core/`.~~ **Deferred** — package remains `@open-agents/acp-mcp` with added `sandboxType`, `repoUrl`, `branch` params on `acp_session_new`.

## Phase 2: Coolify Sandbox Provider ✅

Implemented `@open-agents/sandbox-coolify` package:

- `packages/sandbox-coolify/sandbox.ts` — `CoolifySandbox` (implements `Sandbox` interface) + `CoolifyFileSystem` (HTTP client for container's `fs.js` API)
- `packages/sandbox-coolify/index.ts` — `connectCoolify()` factory with persisted state
- `apps/web/lib/sandbox/coolify-api.ts` — Coolify REST API client (create/start/stop apps, deployment wait, health probing, TLS fallback)
- `apps/web/lib/sandbox/coolify-workspace.ts` — `provisionCoolifyWorkspace()` orchestrator
- `apps/web/lib/sandbox/coolify-connector.ts` — `CoolifyConnectorConfig` loading from `TEST_COOLIFY_*` / `COOLIFY_*` env vars
- `apps/web/app/api/acpmcp/route.ts` — Updated `dbStore.create()` to detect `sandboxType: "coolify:{id}"` and provision via Coolify; updated `sandboxOps` to use `connectCoolify` for Coolify sessions
- `packages/acp-mcp/bridge.ts` — Extended `SessionStore.create()` params with `sandboxType`, `repoUrl`, `branch`; added `acp_session_new` tool params

### Self-Signed TLS Support

Both `CoolifyFileSystem` (in sandbox) and the Coolify API client (in web app) handle self-signed TLS certificates by falling back to `rejectUnauthorized: false` when standard TLS verification fails with `DEPTH_ZERO_SELF_SIGNED_CERT`.

### Vercel-Free GitHub Operations

Coolify sessions support:
- Git clone via `bootstrapSourceRepository()` using `GIT_CONFIG_COUNT` env-based auth
- Branch checkout and new branch creation
- Direct commit/push via existing `apps/web/lib/github/actions/` (already uses direct GitHub API)

## Phase 3: LLM Prompting (pending)

- `packages/acp-mcp-llm/` — `acp_session_prompt` using `@open-agents/agent` with configurable provider

## Phase 4-6: GitHub, Workflow, Document (pending)

Remaining feature modules from requirements v2.
- `packages/acp-mcp-workflow/package.json` — deps on `workflow`
- `packages/acp-mcp-sandbox/package.json` — extracted from core, deps on `@open-agents/sandbox`

## Phase 2: Extract Sandbox Module

Move file/terminal tools from `core/bridge.ts` → `acp-mcp-sandbox/bridge.ts`.

**Core keeps:** session lifecycle, auth, initialize, logout, setMode, config.
**Sandbox gets:** readTextFile, writeTextFile, edit_file, terminal, sandbox_status, sandbox_snapshot.

## Phase 3: LLM Prompt Module

`packages/acp-mcp-llm/bridge.ts` — replaces canned `echo` with full agent loop.

```typescript
// acp_session_prompt now calls openAgent.run()
import { openAgent } from "@open-agents/agent";
import { gateway } from "@open-agents/agent/models";

async acp_session_prompt({ sessionId, message }): Promise<ToolContent[]> {
  const sandbox = await connectSandbox(state);
  const skills = await discoverSkills(sandbox);

  const result = await openAgent.run({
    maxSteps: 20,
    prepareCall: (call) => ({
      ...call,
      experimental_context: { sandbox, skills, model: gateway(modelId) },
    }),
  });

  // Persist messages to DB
  await store.createMessage(sessionId, userText, assistantText);
  return ok({ messages: result.response.messages, stopReason: "end_turn" });
}
```

## Phase 4: GitHub Module

`packages/acp-mcp-github/bridge.ts` — reuses existing server actions.

## Phase 5: Workflow Module

`packages/acp-mcp-workflow/bridge.ts` — uses Vercel WDK `workflow` package.
WDK's `Local World` runs in-process with virtualized retries — no cloud infra needed.

## Phase 6: Route Wiring

Update `apps/web/app/api/acpmcp/route.ts` to register all module tools.

## Phase 7: SIT Development

Two new end-to-end scenarios in `scripts/acp-mcp-sit.sh`:
