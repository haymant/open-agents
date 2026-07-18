---
title: "Project Sessions — Architecture & Design"
feature_id: "project-sessions"
artifact: "design"
status: "draft"
version: "2"
owner_agent: "Architect"
parent_feature: "project-sessions"
last_updated: "2026-07-13"
---

# Project Sessions — Architecture & Design

## 1. Design Summary

The project-sessions feature extends the existing ACP-MCP bridge and Coolify sandbox provider with four new concerns:

1. **Secret management** — Bridge proxies Coolify env var API; secrets flow user → Coolify platform → container, never through agent responses
2. **GitHub repo association** — New ACP tools for repo create/attach, plus plumbing `state.source` through Coolify provisioning
3. **Dev server lifecycle** — `execDetached()` for background dev servers, `domain(port)` fix for preview URLs
4. **Session hierarchy + coordinator SKILL.md** — Minimal DB schema extension, `.composer.yml` schema, and an agent skill that teaches orchestration

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                 Open Agents Web App                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐  │
│  │ ACP MCP  │  │ Secret   │  │ DB (sessions,     │  │
│  │ Bridge   │  │ Proxy    │  │ session_secrets)  │  │
│  └────┬─────┘  └────┬─────┘  └───────────────────┘  │
│       │             │                                │
└───────┼─────────────┼────────────────────────────────┘
        │             │
        │             ▼
        │    ┌──────────────────┐
        │    │  Coolify API     │
        │    │  /v1/applications│
        │    │  /{uuid}/envs    │
        │    └────────┬─────────┘
        │             │
        ▼             ▼
┌──────────────────────────────────────────────┐
│         Coolify Server (Docker host)          │
│  ┌────────────────┐  ┌──────────────────┐    │
│  │ Coordinator    │  │ Child Sandbox 1  │    │
│  │ haymant/oadev  │  │ haymant/oai      │    │
│  │ git + gh +     │  │ Node.js + Python │    │
│  │ Coolify CLI    │  │ + git            │    │
│  │ code-server    │  │                  │    │
│  └────────────────┘  └──────────────────┘    │
│  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Child Sandbox 2  │  │ Child Sandbox N  │  │
│  │ haymant/oai      │  │ haymant/oai      │  │
│  └──────────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────┘
```

## 3. Secret Management: Coolify Env Var API

### 3.1 Data Flow

```
1. User: acp_secret_set(sessionId, { GITHUB_TOKEN: "ghp_xxx", DATABASE_URL: "postgres://..." })

2. Bridge:
   a. Looks up Coolify app UUID from session's sandboxState
   b. For each env var, calls:
      POST /v1/applications/{uuid}/envs
      { key: "GITHUB_TOKEN", value: "ghp_xxx", is_literal: true, is_runtime: true }

3. Coolify:
   a. Stores env var in application config
   b. On next container start, injects into process environment

4. Bridge calls startCoolifyApplication to restart the app with new env vars

5. Agent runs:
   acp_terminal_create(sessionId, command="git push origin main")
   → Works because GITHUB_TOKEN is in the environment
   → But agent never receives the token value in tool output
```

### 3.2 API Integration

The `setCoolifyAppEnv()` function already exists in `coolify-api.ts`:

```typescript
async function setCoolifyAppEnv(
  config: CoolifyRequestConfig,
  appUuid: string,
  key: string,
  value: string,
  opts?: { isBuildtime?: boolean; isLiteral?: boolean },
): Promise<void>
```

`acp_secret_set` wraps this function. No new Coolify API integration needed.

### 3.3 No fs.js Changes Required

Since secrets go through Coolify's env var API (not through fs.js exec), there is **no need** to modify `fs.js` to accept an `env` parameter. The secrets are already in the container's environment from Coolify.

## 4. GitHub Repo Association

### 4.1 New ACP Tools

All GitHub tools use the Bridge's GitHub App credentials (already configured via `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) to authenticate API calls.

#### acp_github_create_repo

```
Input:  repoName, org?, private?, branch?
Flow:
  1. GitHub API: POST /orgs/{org}/repos or POST /user/repos
  2. Return { repoUrl, cloneUrl }
```

#### acp_github_attach_repo

```
Input:  sessionId, repoUrl, branch?
Flow:
  1. Get session from DB
  2. Get CoolifyState from sandboxState
  3. Set state.source = { repo: repoUrl, branch: branch ?? "main" }
  4. Update session in DB
  5. Call connectCoolify(state) → CoolifySandbox.connect()
     → bootstrapSourceRepository() clones the repo into /workspace
  6. Return { status: "cloned", cwd: "/workspace" }
```

### 4.2 Provisioning Fix

In `provisionCoolifyWorkspace()`, add:

```typescript
if (params.repoUrl) {
  state.source = {
    repo: params.repoUrl,
    branch: params.branch ?? "main",
    newBranch: undefined,
  };
}
```

This is the only code change needed — `CoolifySandbox.connect()` already handles cloning.

## 5. Dev Server Lifecycle

### 5.1 acp_deploy_start_dev

```
Input:  sessionId, command?
Flow:
  1. Get session, resolve sandbox
  2. Call sandbox.execDetached(command ?? "npm run dev", { cwd: "/workspace" })
  3. Return { previewUrl: sandbox.domain(3000), pid }
```

### 5.2 acp_deploy_stop_dev

```
Input:  sessionId
Flow:
  1. Get session, resolve sandbox
  2. Kill the dev server process (by PID or command name)
  3. Return { stopped: true }
```

### 5.3 CoolifySandbox.domain(port) Fix

Current implementation in `packages/sandbox-coolify/sandbox.ts` only handles hardcoded ports:

```typescript
get domain(): (port: number) => string | undefined {
  return (port: number) => {
    if (port === CODE_SERVER_PORT) return this.state.coolifyPreviewUrls?.codeServer;
    if (port === DEFAULT_HEALTH_PORT) return this.state.coolifyPreviewUrls?.health;
    return this.state.coolifyApplicationUrl;
  };
}
```

The fallback `return this.state.coolifyApplicationUrl` actually works for any port — Coolify proxies the main exposed port. The issue is conceptual: the current code doesn't document this behavior. No code change needed, but the function should be updated for clarity:

```typescript
return (port: number) => {
  if (port === CODE_SERVER_PORT) return this.state.coolifyPreviewUrls?.codeServer;
  if (port === DEFAULT_HEALTH_PORT) return this.state.coolifyPreviewUrls?.health;
  // Coolify proxies the main exposed port — return the app URL
  // for any port the user wants to expose via dev server
  return this.state.coolifyApplicationUrl;
};
```

## 6. Session Hierarchy

### 6.1 DB Schema Extension

```typescript
// In apps/web/lib/db/schema.ts, add to sessions table:
type: text("type", { enum: ["chat", "project", "child"] })
  .default("chat")
  .notNull(),
parentSessionId: text("parent_session_id"),
```

### 6.2 ACP Tools

`acp_session_get_tree(sessionId)`:
```sql
SELECT * FROM sessions WHERE id = :sessionId
UNION ALL
SELECT * FROM sessions WHERE parent_session_id = :sessionId
```
Build nested JSON response.

`acp_sandbox_bulk_action(sessionId, action)`:
```sql
SELECT * FROM sessions WHERE parent_session_id = :sessionId
```
For each child, call acp_session_close / acp_session_resume / acp_session_delete.

## 7. .composer.yml Schema

```yaml
version: "1"           # schema version, incremented on breaking changes
project: "my-app"      # project name, matches monorepo name

modules:
  <module-name>:
    repo: "<github-repo-url>"         # child repo
    path: "<submodule-path>"           # e.g. "services/api"
    image: "haymant/oai"              # sandbox image
    start_command: "pnpm dev"         # dev server command
    port: 3000                        # dev server port
    env:                              # env vars (values reference secrets or are literal)
      KEY: "${SECRET_NAME}"           # references a secret set via acp_secret_set
      KEY2: "literal-value"
    depends_on:                       # startup order
      - <other-module>
    resource_limits:                  # optional Coolify resource limits
      cpus: "1"
      memory: "512M"
```

The schema is validated by the coordinator agent (via SKILL.md) and stored in the monorepo root as `.composer.yml`.

## 8. Project Coordinator SKILL.md

Location: `.github/skills/project-coordinator/SKILL.md`

The skill teaches the agent:

### 8.1 Discovery Phase
1. Check if `/workspace/.composer.yml` exists
2. If yes, read and parse it to discover modules
3. If no, ask the user what they want to build and scaffold it

### 8.2 Setup Phase
1. For each module in `.composer.yml`:
   a. Create child GitHub repo (if not exists)
   b. Create child session via `acp_session_new`
   c. Attach repo via `acp_github_attach_repo`
   d. Set env vars via `acp_secret_set`
   e. Start dev server via `acp_deploy_start_dev`

### 8.3 Development Phase
1. Monitor submodule commits
2. Sync submodule refs in monorepo
3. Update `.composer.yml` version on each sync
4. Map git commit SHAs to version entries

### 8.4 Testing Phase
1. Run unit tests in each child sandbox
2. Run integration tests across services
3. Run Playwright UI automation for web service

## 9. Implementation Phases

| Phase | What | Dependencies |
|---|---|---|
| **P1** | Secret management (acp_secret_set/list/delete) | Coolify env API (already exists) |
| **P2** | GitHub repo tools + provisioning state.source fix | GitHub App credentials (already configured) |
| **P3** | Dev server tools (acp_deploy_start/stop/get_preview) | execDetached (already exists), domain() fix (trivial) |
| **P4** | Session hierarchy (type, parentSessionId, get_tree) | DB migration |
| **P5** | .composer.yml schema + project-coordinator SKILL.md | P1-P4 complete |
| **P6** | End-to-end user journey test | P1-P5 complete |

## 10. Key TypeScript Interfaces

```typescript
// Extended session type
type SessionType = "chat" | "project" | "child";

// .composer.yml parsed type
interface ComposerFile {
  version: string;
  project: string;
  modules: Record<string, ComposerModule>;
}

interface ComposerModule {
  repo: string;
  path: string;
  image: string;
  start_command: string;
  port: number;
  env: Record<string, string>;
  depends_on?: string[];
  resource_limits?: { cpus?: string; memory?: string };
}

// acp_secret_set input
interface SecretSetInput {
  sessionId: string;
  envVars: Record<string, string>;
}

// acp_github_attach_repo input
interface GithubAttachInput {
  sessionId: string;
  repoUrl: string;
  branch?: string;
}
```

## 11. Dependencies

- `coolify-api.ts` — `setCoolifyAppEnv()` exists and is ready for acp_secret_set
- `coolify-workspace.ts` — `provisionCoolifyWorkspace()` needs `state.source` population
- `sandbox-coolify/sandbox.ts` — `domain()` fallback already works (documentation fix only)
- `sandbox-coolify/sandbox.ts` — `execDetached()` exists for dev server start
- `apps/web/lib/db/schema.ts` — Needs `type` and `parentSessionId` columns
- `apps/web/app/api/acpmcp/route.ts` — New ACP tool handlers
- GitHub App credentials — Already configured in `.env`
