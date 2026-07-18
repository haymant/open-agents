---
title: "Project Sessions — Implementation Plan"
feature_id: "project-sessions"
artifact: "implementation-plan"
status: "in-progress"
version: "4"
owner_agent: "Developer"
parent_feature: "project-sessions"
last_updated: "2026-07-18"
---

# Project Sessions — Implementation Plan

## Phase P1: Secret Management

**Goal**: Allow users to set environment variables on Coolify applications via ACP tools, without the agent seeing the values.

### P1.1 Add ACP tools to bridge

**File**: `packages/acp-mcp/bridge.ts`

Add three tool definitions to `toolDefinitions`:
- `acp_secret_set`
- `acp_secret_list`
- `acp_secret_delete`

Add three handler stubs to `createHandlers()`:
- `acp_secret_set` → calls `sandbox.setSecrets(sessionId, envVars)`
- `acp_secret_list` → calls `sandbox.listSecrets(sessionId)`
- `acp_secret_delete` → calls `sandbox.deleteSecret(sessionId, name)`

### P1.2 Add secret ops to SandboxOps interface

**File**: `packages/acp-mcp/bridge.ts`

```typescript
export interface SandboxOps {
  // ...existing fields...
  setSecrets?(sessionId: string, envVars: Record<string, string>): Promise<{ stored: number }>;
  listSecrets?(sessionId: string): Promise<Array<{ name: string }>>;
  deleteSecret?(sessionId: string, name: string): Promise<void>;
}
```

### P1.3 Implement secret ops in route

**File**: `apps/web/app/api/acpmcp/route.ts`

Add to `sandboxOps`:
```typescript
async setSecrets(sessionId: string, envVars: Record<string, string>) {
  const record = await getSessionById(sessionId);
  if (!record) throw new Error("Session not found");
  const state = record.sandboxState as CoolifyState | null;
  if (!state?.coolifyApplicationId || !state.connectorConfigId)
    throw new Error("No Coolify app for this session");

  const config = getCoolifyConnectorConfig(state.connectorConfigId);
  if (!config) throw new Error("Connector config not found");

  const apiConfig = { apiToken: config.apiToken, baseUrl: config.baseUrl };
  let stored = 0;
  for (const [key, value] of Object.entries(envVars)) {
    await setCoolifyAppEnv(apiConfig, state.coolifyApplicationId, key, value);
    stored++;
  }
  // Restart to pick up env vars
  await startCoolifyApplication(apiConfig, state.coolifyApplicationId);
  return { stored };
}

async listSecrets(sessionId: string) {
  const record = await getSessionById(sessionId);
  if (!record) throw new Error("Session not found");
  const state = record.sandboxState as CoolifyState | null;
  if (!state?.coolifyApplicationId || !state.connectorConfigId)
    return [];

  const config = getCoolifyConnectorConfig(state.connectorConfigId);
  if (!config) return [];

  const apiConfig = { apiToken: config.apiToken, baseUrl: config.baseUrl };
  const envs = await getCoolifyApplicationEnvs(apiConfig, state.coolifyApplicationId);
  return envs.map((e) => ({ name: e.key }));
}

async deleteSecret(sessionId: string, name: string) {
  // Coolify API: DELETE /v1/applications/{uuid}/envs/{name}
  // or POST with empty value as workaround
  const record = await getSessionById(sessionId);
  if (!record) throw new Error("Session not found");
  const state = record.sandboxState as CoolifyState | null;
  if (!state?.coolifyApplicationId || !state.connectorConfigId)
    return;

  const config = getCoolifyConnectorConfig(state.connectorConfigId);
  if (!config) return;

  const apiConfig = { apiToken: config.apiToken, baseUrl: config.baseUrl };
  await setCoolifyAppEnv(apiConfig, state.coolifyApplicationId, name, "");
}
```

### P1.4 Register tools in route

**File**: `apps/web/app/api/acpmcp/route.ts`

Register `acp_secret_set`, `acp_secret_list`, `acp_secret_delete` with the MCP server.

### P1.5 SIT test

**File**: `scripts/acp-mcp-coolify-sit.sh`

Add test cases:
- `acp_secret_set` with test env var → verify via `acp_secret_list`
- `acp_secret_delete` → verify removed from list
- Verify values never appear in responses

---

## Phase P2: GitHub Repo Tools + Provisioning Fix

**Goal**: Create/attach repos to sessions and fix provisioning to clone repos on connect.

### P2.1 Fix state.source in provisioning

**File**: `apps/web/lib/sandbox/coolify-workspace.ts`

In `provisionCoolifyWorkspace()`, add after building the state:

```typescript
if (params.repoUrl) {
  state.source = {
    repo: params.repoUrl,
    branch: params.branch ?? "main",
  };
}
```

### P2.2 Add GitHub tools to bridge

**File**: `packages/acp-mcp/bridge.ts`

Add tool definitions:
- `acp_github_create_repo` — input: `repoName`, `org?`, `private?`, `branch?`
- `acp_github_attach_repo` — input: `sessionId`, `repoUrl`, `branch?`
- `acp_github_push` — input: `sessionId`, `message?`
- `acp_github_create_pr` — input: `sessionId`, `title?`, `base?`

### P2.3 Register handlers

**File**: `apps/web/app/api/acpmcp/route.ts`

Add to `sandboxOps`:
- `createRepo(repoName, org?, private?, branch?)` — calls GitHub App API
- `attachRepo(sessionId, repoUrl, branch?)` — updates sandboxState.source, reconnects sandbox
- `gitPush(sessionId, message?)` — runs `git add -A && git commit && git push` via terminal
- `createPr(sessionId, title?, base?)` — runs `gh pr create` via terminal

### P2.4 SIT tests

Add:
- Create session with `repoUrl` + `branch` → verify repo cloned into /workspace
- `acp_github_attach_repo` → verify workspace updated

---

## Phase P3: Dev Server Tools ✅

**Goal**: Start/stop dev servers in sandboxes and get preview URLs. **Implemented**.

### P3.1 Add deploy tools to bridge

**File**: `packages/acp-mcp/bridge.ts`

Tool definitions:
- `acp_deploy_start_dev` — input: `sessionId`, `command?`
- `acp_deploy_stop_dev` — input: `sessionId`
- `acp_deploy_get_preview_url` — input: `sessionId`, `port?`

### P3.2 Register handlers

**File**: `apps/web/app/api/acpmcp/route.ts`

Add to `sandboxOps`:
- `startDevServer(sessionId, command?)` — calls `sandbox.execDetached()`, returns preview URL from `sandbox.domain(port)`
- `stopDevServer(sessionId)` — kills the dev server process
- `getPreviewUrl(sessionId, port?)` — calls `sandbox.domain(port ?? 3000)`

### P3.3 Update CoolifySandbox.domain()

**File**: `packages/sandbox-coolify/sandbox.ts`

Clarify the domain method (no functional change needed — fallback already returns `coolifyApplicationUrl`):

```typescript
get domain(): (port: number) => string | undefined {
  return (port: number) => {
    if (port === CODE_SERVER_PORT) return this.state.coolifyPreviewUrls?.codeServer;
    if (port === DEFAULT_HEALTH_PORT) return this.state.coolifyPreviewUrls?.health;
    // Coolify proxies the main exposed port — return the app URL
    return this.state.coolifyApplicationUrl;
  };
}
```

### P3.4 SIT tests

Add:
- `acp_deploy_start_dev` → verify preview URL returned
- `acp_deploy_stop_dev` → verify process stopped
- `acp_deploy_get_preview_url` → matches sandboxMetadata.app

---

## Phase P4: Session Hierarchy ✅

**Goal**: Add session type and parent-child linking. **Implemented**.

### P4.1 DB migration

**File**: `apps/web/lib/db/schema.ts`

```typescript
// Add to sessions table definition:
type: text("type", { enum: ["chat", "project", "child"] })
  .default("chat")
  .notNull(),
parentSessionId: text("parent_session_id"),
```

**File**: `apps/web/lib/db/migrations/` — Add drizzle migration.

### P4.2 Add hierarchy tools

**File**: `packages/acp-mcp/bridge.ts`

Tool definitions:
- `acp_session_get_tree` — input: `sessionId`
- `acp_sandbox_bulk_action` — input: `sessionId`, `action` (pause/resume/delete)

Handlers:
- `acp_session_get_tree` → query session + children from DB, return nested JSON
- `acp_sandbox_bulk_action` → iterate children, call close/resume/delete per child

### P4.3 SIT tests

Add:
- Create project session, create child sessions → verify `acp_session_get_tree` returns hierarchy
- `acp_sandbox_bulk_action(pause)` → verify all children paused
- `acp_sandbox_bulk_action(resume)` → verify all children resumed

---

## Phase P5: .composer.yml + Project Coordinator SKILL.md ✅

**Goal**: Define the orchestration schema and teach the agent how to use it. **Implemented**.

### P5.1 Create SKILL.md

**File**: `.github/skills/project-coordinator/SKILL.md`

Create a skill that teaches the agent:

**Discovery**:
1. Check if `/workspace/.composer.yml` exists
2. Parse it to discover modules
3. Validate schema

**Setup**:
1. For each module in dependency order:
   a. Check if child session exists for this module
   b. If not, create child session, attach repo, set env vars, start dev server
2. Update `.composer.yml` with session IDs and preview URLs

**Sync**:
1. Check child repos for new commits
2. Run `git submodule update --remote` in monorepo
3. Commit and push monorepo
4. Update `.composer.yml` version

**Teardown**:
1. Stop all dev servers
2. Bulk-pause or bulk-delete child sessions

### P5.2 SIT tests

Add coordinator-driven test:
1. Create `.composer.yml` with 2 modules (api, web)
2. Agent creates child sessions, attaches repos, sets env vars
3. Agent starts dev servers
4. Agent syncs submodules
5. Agent tears down

---

## Phase P6: End-to-End User Journey

**Goal**: User can prompt "create a React app with two backend services" and the full flow works.

### P6.1 Integration test

Create `scripts/project-coordinator-journey.sh`:

1. Start vercel dev
2. Create project session
3. Agent creates GitHub repos for monorepo + 2 submodules
4. Agent scaffolds `.composer.yml`
5. Agent creates child sessions + attaches repos
6. Agent sets env vars + starts dev servers
7. Agent verifies health endpoints
8. Agent runs unit tests in each child
9. Agent syncs submodules
10. Agent tears down

### P6.2 Documentation

Create `docs/project-coordinator.md` explaining:
- `.composer.yml` schema reference
- How to start a project session
- How the coordinator agent works
- Secret management best practices
