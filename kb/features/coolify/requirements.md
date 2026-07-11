---
title: "Coolify Sandbox Provider + Vercel-Free GitHub Ops"
feature_id: "coolify"
artifact: "requirements"
status: "implemented"
version: "2"
owner_agent: "BA"
parent_feature: "acp-mcp"
last_updated: "2026-07-11"
---

# Coolify Sandbox Provider + Vercel-Free GitHub Operations

## 1. Business Value

Eliminate Vercel vendor lock-in by providing a **self-hosted sandbox backend** (Coolify) and **direct GitHub operations** (no Vercel AI Gateway dependency). This makes Open Agents fully deployable on any infrastructure without paid Vercel services. When combined with the ACP-MCP headless bridge, it becomes a completely portable, self-hosted AI coding agent.

## 2. Background from docker-open-agents Reference

The `docker-open-agents` fork implements this via:

1. **Coolify as sandbox provider** — Uses a connector-based `Sandbox` abstraction where Coolify is a built-in connector alongside Vercel. Containers run a lightweight `fs.js` Express app exposing file/exec APIs at `/api/files` and `/api/exec`.

2. **Direct GitHub operations** — Uses `@octokit/rest` directly with user OAuth tokens (via better-auth), bypassing Vercel AI Gateway entirely for repo creation, cloning, committing, and PR management.

3. **Sandbox connector registry** — `packages/sandbox/registry.ts` registers sandbox providers with metadata (`configurable`, `supportsSnapshots`, etc.). Coolify has `type: "coolify"` with configurable API token, base URL, project UUID, destination UUID, server UUID, and container image.

## 3. Scope

### 3.1 Sub-Feature: `coolify-sandbox` — Self-hosted Sandbox Provider

#### In Scope

- New `packages/sandbox/coolify/` module implementing `Sandbox` interface for Coolify
- `CoolifySandbox` class with native filesystem transport via `CoolifyFileSystem` (HTTP to container's `fs.js`)
- Coolify REST API client (`apps/web/lib/sandbox/coolify-api.ts`):
  - `createCoolifyDockerImageApplication()` — creates Docker-based app
  - `startCoolifyApplication()` / `stopCoolifyApplication()` — lifecycle
  - `deleteCoolifyApplication()` — cleanup
  - `getCoolifyApplication()` / `getCoolifyApplicationEnvs()` — state queries
  - `waitForCoolifyPreview()` / `waitForCoolifyHealthUrl()` — readiness polling
  - `validateCoolifyServerUuid()` — discover available servers
  - `patchCoolifyApplication()` / `bulkUpdateCoolifyApplicationEnvs()` — updates
- Workspace orchestrator (`apps/web/lib/sandbox/coolify-workspace.ts`):
  - `ensureCoolifyWorkspace()` — DB-lease-backed provisioning
  - Polling-based wait for deployment and health
- `fs.js` Docker image — Express app running inside Coolify containers:
  - `GET /api/files` — list directory
  - `GET /api/files/content?path=` — read file
  - `POST /api/files/content` — write file
  - `DELETE /api/files?path=` — delete file
  - `POST /api/files/dir` — create directory
  - `POST /api/exec` — execute commands
  - `POST /api/exec/detached` — launch background processes
  - TLS: self-signed cert support
- Connector config management:
  - Settings UI at `/settings/sandbox-connectors`
  - CRUD API for `CoolifyConnectorConfig` (encrypted API tokens)
  - User-facing sandbox type resolution (`coolify:{configId}` prefix)
- Sandbox connector registry:
  - `packages/sandbox/registry.ts` — registers Coolify as built-in connector
  - `connectCoolify()` factory in `packages/sandbox/coolify/`
  - `hydrateSandboxStateForConnection()` — populates runtime config from DB
- Session provisioning via Coolify:
  - `acp_session_new({ sandboxType: "coolify:{configId}" })` creates Coolify-backed session
- SIT: create Coolify session → write/read file → run terminal → close session

#### Comparison Vercel vs Coolify

| Capability | Vercel Sandbox | Coolify Sandbox |
|---|---|---|
| VM isolation | Firecracker microVM | Docker container |
| Filesystem API | SDK (readFile/writeFile/exec) | HTTP to `fs.js` |
| Snapshots | ✓ Native Vercel snapshots | ✗ Not supported |
| Preview URLs | Vercel auto-provisioned domains | Custom domain via Coolify proxy |
| Code Server (IDE) | Port 8000 | Port 1223 |
| Git auth | Credential brokering (network proxy) | `GIT_CONFIG_COUNT` env vars |
| Billing | Vercel usage-based | Self-hosted (free) |

#### Out of Scope

- Container snapshots / hibernation (Vercel-specific feature)
- Multi-server load balancing
- Automatic container image building (use pre-built `open-agents-sandbox` image)

### 3.2 Sub-Feature: `vercel-free-github` — Direct GitHub Operations

#### In Scope

- Direct GitHub repo creation via `@octokit/rest` with user OAuth token (no AI Gateway dependency)
- Git clone in sandbox via `git clone` with `GIT_CONFIG_COUNT` env-based auth
- Branch selection when creating session from existing repo
- GitHub commit/push via existing `apps/web/lib/github/actions/commit.ts` (already direct)
- PR creation via existing `apps/web/lib/github/actions/pr.ts` (already direct)
- List branches for linked repo
- Switch branches in sandbox

#### Bypassed Vercel Dependencies

| Feature | Vercel-dependent path | Vercel-free path |
|---|---|---|
| Create repo | `apps/web/app/api/github/create-repo/route.ts` (recently implemented, uses Octokit directly) | Already direct — no change needed |
| Clone repo | `VercelSandbox.create({ source })` via Vercel SDK | `git clone` inside Coolify container via `fs.js` exec |
| Git auth for clone | `syncGitHubCredentialBrokering()` — Vercel network proxy | `buildGitHubAuthExecCommand()` — env vars → `GIT_CONFIG_COUNT` |
| Commit/push | `apps/web/lib/github/actions/commit.ts` — direct GitHub API | Already direct — no change needed |
| Create PR | `apps/web/lib/github/actions/pr.ts` — direct GitHub API | Already direct — no change needed |
| AI model access | Vercel AI Gateway | Provider API keys directly (Anthropic, OpenAI, DeepSeek) |

## 4. Functional Requirements

### FR-CF-1: Connector Configuration

Users must be able to configure Coolify connectors via the settings UI (`/settings/sandbox-connectors`). Each connector stores: `apiToken` (encrypted), `baseUrl`, `projectUuid`, `destinationUuid`, `serverUuid`, `image`. Connectors appear as `coolify:{connectorConfigId}` in the sandbox type selector.

### FR-CF-2: Coolify Sandbox Provisioning

When a session uses a Coolify sandbox type, `ensureCoolifyWorkspace()` must:
1. Check for existing usable workspace
2. Create a new Coolify Docker-image application if none exists
3. Start the application
4. Poll `waitForCoolifyDeployment()` until the deployment completes
5. Poll `waitForCoolifyHealthUrl()` until the `fs.js` health endpoint responds
6. Return the sandbox state with `coolifyPreviewUrls`

### FR-CF-3: Coolify Filesystem Operations

The `CoolifySandbox` must provide read, write, list, delete, mkdir, stat, exec, and execDetached operations via HTTP calls to the `fs.js` container. All paths must be validated against `/workspace` to prevent path traversal.

### FR-CF-4: Coolify Self-Signed TLS

The `CoolifyFileSystem` must support self-signed TLS certificates by probing with `rejectUnauthorized: false` when standard TLS verification fails, enabling use with self-hosted Coolify instances using self-signed certs.

### FR-CF-5: Vercel-Free Repo Creation

Session creation from an existing GitHub repo must work without the Vercel Sandbox API by using `git clone` inside the Coolify container. Git authentication must use `GIT_CONFIG_COUNT` environment variables rather than Vercel's network proxy brokering.

### FR-CF-6: Device-Domain Preview URLs

Coolify sandbox preview URLs must follow the pattern `{sessionPrefix}-{suffix}-{entropy}.{baseHost}`, with suffixes: default for app, `-health` for health endpoint, `-ide` for code-server.

### FR-CF-7: Sandbox Source with Repo

`acp_session_new` with `{ repoUrl: "...", branch: "main", sandboxType: "coolify:{id}" }` must create a Coolify-backed session with the repo cloned into `/workspace`.

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-CF-1 | Settings UI at `/settings/sandbox-connectors` allows adding/editing/deleting Coolify connectors |
| AC-CF-2 | `acp_session_new({ sandboxType: "coolify:{id}" })` provisions a Coolify-backed sandbox with working `fs.js` |
| AC-CF-3 | `acp_fs_write_text_file` + `acp_fs_read_text_file` round-trip works on Coolify sandbox |
| AC-CF-4 | `acp_terminal_create` executes commands on Coolify sandbox |
| AC-CF-5 | `acp_session_new({ repoUrl, branch, sandboxType: "coolify:{id}" })` clones a real GitHub repo into `/workspace` |
| AC-CF-6 | Session with repo works without Vercel Sandbox API or AI Gateway |
| AC-CF-7 | Self-signed TLS on Coolify instance is handled transparently |

## 6. Dependencies

- `@octokit/rest` — Direct GitHub API (already in `apps/web`)
- `better-auth` — User OAuth token management (already in `apps/web`)
- Coolify instance — Self-hosted at user's domain
- `open-agents-sandbox` Docker image — Contains `fs.js` Express app for file/exec API

## 7. What to Port from docker-open-agents

| Source File | Target | Purpose |
|---|---|---|
| `packages/sandbox/coolify/` | `packages/sandbox/coolify/` | Coolify sandbox implementation |
| `packages/sandbox/registry.ts` | `packages/sandbox/registry.ts` | Connector registry |
| `apps/web/lib/sandbox/coolify-api.ts` | `apps/web/lib/sandbox/coolify-api.ts` | Coolify REST API client |
| `apps/web/lib/sandbox/coolify-workspace.ts` | `apps/web/lib/sandbox/coolify-workspace.ts` | Workspace orchestrator |
| `apps/web/lib/sandbox-connector-configs.ts` | `apps/web/lib/sandbox-connector-configs.ts` | Connector config CRUD |
| `apps/web/lib/sandbox/user-connector-types.ts` | `apps/web/lib/sandbox/user-connector-types.ts` | User-facing type resolution |
| `apps/web/app/settings/sandbox-connectors/` | `apps/web/app/settings/sandbox-connectors/` | Settings UI |
| `packages/sandbox/docker/fs.js` | `packages/sandbox/docker/fs.js` | Container filesystem API |
| `packages/sandbox/coolify/index.test.ts` | `packages/sandbox/coolify/index.test.ts` | Tests |

## 8. SIT Plan

### SIT-CF-1: Coolify Sandbox Lifecycle

```
1. Configure Coolify connector via settings UI (or API)
2. acp_initialize
3. acp_session_new({ sandboxType: "coolify:{configId}" })
   → sessionId returned; poll for workspace until health URL responds
4. acp_fs_write_text_file(sessionId, "/README.md", "Coolify Works!")
5. acp_fs_read_text_file(sessionId, "/README.md")
   → "Coolify Works!"
6. acp_terminal_create(sessionId, "echo hello")
   → { exitCode: 0, initialOutput: "hello" }
7. acp_session_delete(sessionId)
   → Coolify application stopped
```

### SIT-CF-2: Coolify Session with GitHub Repo

```
1. acp_session_new({
     repoUrl: "https://github.com/user/public-repo",
     branch: "main",
     sandboxType: "coolify:{configId}"
   })
2. Wait for provisioning → sandbox ready
3. acp_fs_read_text_file(sessionId, "/workspace/README.md")
   → repo content present
4. acp_terminal_create(sessionId, "git remote -v")
   → shows origin as the repo URL
5. acp_session_delete(sessionId)
```

### SIT-CF-3: Self-Signed TLS

```
1. Configure Coolify connector pointing to self-signed TLS instance
2. acp_session_new → succeeds despite certificate validation failure
3. All file/terminal operations work
```