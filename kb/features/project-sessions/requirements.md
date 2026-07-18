---
title: "Project Sessions — Multi-Session Orchestration & Monorepo Dev Workbench"
feature_id: "project-sessions"
artifact: "requirements"
status: "draft"
version: "2"
owner_agent: "BA"
parent_feature: "acp-mcp"
last_updated: "2026-07-13"
---

# Project Sessions — Multi-Session Orchestration & Monorepo Dev Workbench

## 1. Business Value

Turn Open Agents into a **multi-repo development orchestration platform** where a user can:

- Maintain a project spanning multiple microservices, each in its own GitHub repo
- Have the project coordinator (monorepo with submodules) managed by a dedicated "project session" using `haymant/oadev`
- Have each microservice worked on independently in its own child chat session using `haymant/oai`
- Have the coordinator agent orchestrate: provision child sandboxes, associate submodule repos, trigger deployments, start dev servers, pause/resume the session tree
- Keep secrets (GitHub tokens, API keys) accessible to commands but invisible to the LLM agent

## 2. What Already Exists (Baseline)

The following infrastructure is already implemented and tested via `acp-mcp-coolify-sit.sh`:

| Capability | Status | Evidence |
|---|---|---|
| `acp_session_new` with `sandboxType: "coolify:default"` | ✅ | Provisions Coolify Docker-image application, returns sessionId + sandboxMetadata (preview URLs) |
| `acp_fs_write_text_file` / `acp_fs_read_text_file` | ✅ | File operations in sandbox workspace |
| `acp_terminal_create` | ✅ | Shell commands in sandbox |
| `acp_session_load` / `acp_session_list` | ✅ | Session querying |
| `acp_session_close` → stop Coolify app | ✅ | Archive: stops container (Docker preserves filesystem) |
| `acp_session_resume` → start Coolify app | ✅ | Unarchive: starts stopped container, filesystem intact |
| `acp_session_delete` → delete Coolify app | ✅ | Permanent teardown |
| `acp_session_prompt` with tool loop agent | ✅ | LLM agent with read/write/bash/glob tools |
| `haymant/oai` Docker image | ✅ | Runtime: Python 3.12, Node.js v24, Go, uv, fs.js workspace API |
| `haymant/oadev` Docker image | ✅ | Dev image: oai + code-server + Coolify CLI |
| `coolifyPreviewUrls` in session metadata | ✅ | app, health, codeServer URLs returned from `acp_session_load` |

## 3. Remaining Gaps

### 3.1 Secret Management

**Problem**: Agents in sandboxes need secrets (GitHub tokens, API keys) for git push, gh CLI, Coolify API calls. If secrets live in env vars or files the agent can read them.

**Solution**: Use Coolify's native env var API. The ACP bridge proxies setting env vars on Coolify applications. The env vars are injected at the platform level before the agent starts, so they're available to subprocesses but the **bridge never returns secret values in tool responses**.

```
User POSTs .env contents  →  acp_secret_set  →  Coolify API POST /v1/applications/{uuid}/envs
                                                →  Container restart picks them up
                                                →  Agent's bash can use them via $VAR
```

New ACP tools:

| Tool | Description |
|---|---|
| `acp_secret_set` | Accept `sessionId` + `envVars: Record<string, string>`. Calls Coolify API to set each var. Restarts app. Returns confirmation only. |
| `acp_secret_list` | Lists env var names (not values) set on a session's Coolify app |
| `acp_secret_delete` | Removes a specific env var from the Coolify app |

### 3.2 GitHub Repo Association

**Problem**: Sessions need to be associated with GitHub repos so the workspace has code, and changes can be pushed back.

**Solution**: Extend session creation and add repo tools.

| Tool | Description |
|---|---|
| `acp_github_create_repo` | Create a new GitHub repo, git init/commit/push initial scaffold to the new remote |
| `acp_github_attach_repo` | Clone an existing repo + branch into the sandbox's /workspace |
| `acp_github_create_pr` | Create a PR from the session's branch to the target branch |
| `acp_github_push` | Commit and push local changes to the session's branch |

**Required plumbing**: `provisionCoolifyWorkspace()` must populate `state.source` from `repoUrl`/`branch` params so `CoolifySandbox.connect()` clones the repo. The `CoolifySandbox` already has `bootstrapSourceRepository()` — it just needs `state.source` to be set.

### 3.3 Dev Server Lifecycle

**Problem**: Need to start/stop dev servers in sandboxes and get public preview URLs.

**Solution**: Sandbox images expose port 3000 as the dev server port. Coolify proxies the main app port, so `domain(3000)` returns the app URL.

| Tool | Description |
|---|---|
| `acp_deploy_start_dev` | Run `npm/pnpm/bun run dev` (or custom command) as detached process in sandbox |
| `acp_deploy_stop_dev` | Kill the dev server process |
| `acp_deploy_get_preview_url` | Return the Coolify app URL for the dev port |

**Coolify `domain()` gap**: `CoolifySandbox.domain(port)` only works for hardcoded health/code-server ports. It needs to return `coolifyApplicationUrl` for any port matching the app's exposed ports.

### 3.4 Session Hierarchy

**Problem**: Need to distinguish project coordinator sessions from child sessions.

**Solution**: Add `type` (`"chat" | "project" | "child"`) and `parentSessionId` to the `sessions` table.

| Tool | Description |
|---|---|
| `acp_session_get_tree` | Return nested session hierarchy |
| `acp_sandbox_bulk_action` | Pause/resume/delete all children of a project session |

### 3.5 `.composer.yml` Schema & Project Coordinator Skill

**Problem**: The coordinator agent needs a structured way to describe submodule relationships — start commands, env vars, port mappings, dependencies.

**Solution**: Define a `.composer.yml` schema, version-controlled in the monorepo root:

```yaml
version: "1"
project: "my-app"
modules:
  api:
    repo: "github.com/org/my-app-api"
    path: "services/api"
    image: "haymant/oai"
    start_command: "pnpm dev"
    port: 3001
    env:
      DATABASE_URL: "${DATABASE_URL}"
    depends_on:
      - db
  web:
    repo: "github.com/org/my-app-web"
    path: "services/web"
    image: "haymant/oai"
    start_command: "pnpm dev"
    port: 3000
    env:
      API_URL: "http://api:3001"
    depends_on:
      - api
```

A `project-coordinator` SKILL.md (`.github/skills/project-coordinator/SKILL.md`) teaches the agent how to:

1. Parse `.composer.yml` to discover modules and dependencies
2. Create child sessions from module definitions
3. Set env vars on child sandboxes (including cross-references)
4. Start dev servers in dependency order
5. Sync submodule refs when child work is complete
6. Map git submodule commits to `.composer.yml` versions

## 4. Functional Requirements

### FR-PS-1: Secret Management

`acp_secret_set` must:
- Accept `sessionId` + `envVars: Record<string, string>`
- Look up the session's Coolify application UUID
- Call Coolify API `POST /v1/applications/{uuid}/envs` for each var
- Restart the Coolify application so env vars take effect
- Return only `{ stored: count }` — never echo back values

`acp_secret_list` returns env var names only (never values).
`acp_secret_delete` removes the env var from the Coolify app.

### FR-PS-2: GitHub Repo Operations

`acp_github_create_repo(repoName, org?, private?, branch?)` must create a GitHub repo and return the URL.

`acp_github_attach_repo(sessionId, repoUrl, branch?)` must:
- Set `state.source` with `{ repo: repoUrl, branch }`
- Persist on session record
- Return when repo is cloned into /workspace

### FR-PS-3: Provisioning Sets state.source

`provisionCoolifyWorkspace()` must set `state.source` from `repoUrl`/`branch` params.

### FR-PS-4: Dev Server Start/Stop

`acp_deploy_start_dev(sessionId, command?)` must run the command via `execDetached()` and return the preview URL.

`acp_deploy_stop_dev(sessionId)` must kill the dev server process.

### FR-PS-5: Coolify domain(port)

`CoolifySandbox.domain(port)` must return `coolifyApplicationUrl` for any port matching exposed ports.

### FR-PS-6: Session Type System

`sessions` table gains `type` (`"chat" | "project" | "child"`) and `parentSessionId` columns.

### FR-PS-7: .composer.yml Schema

Define a YAML schema with version, project name, modules with repo/path/image/start_command/port/env/depends_on.

### FR-PS-8: Project Coordinator SKILL.md

Create `.github/skills/project-coordinator/SKILL.md` teaching the agent the full orchestration workflow.

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-PS-1 | `acp_secret_set` stores env vars on the Coolify app and they're available in the container |
| AC-PS-2 | `acp_secret_list` returns names only, never values |
| AC-PS-3 | `acp_github_create_repo` creates a repo and returns the URL |
| AC-PS-4 | `acp_github_attach_repo` with `repoUrl` + `branch` clones into /workspace |
| AC-PS-5 | `acp_deploy_start_dev` starts a dev server and returns a reachable preview URL |
| AC-PS-6 | `acp_deploy_stop_dev` stops it |
| AC-PS-7 | Session with `type: "project"` can list children via `acp_session_get_tree` |
| AC-PS-8 | Coordinator agent guided by SKILL.md can create child sessions from .composer.yml |
| AC-PS-9 | Coordinator can set env vars on children and start them in dependency order |
| AC-PS-10 | Full journey: "create a React app with two backend services" works end-to-end |

## 6. Out of Scope

- Vercel sandbox support for project/child sessions
- GUI for session hierarchy tree
- Auto-sync on child commit (agent-in-the-loop pattern)
- Multi-container dev environments per service

## 7. Open Questions

1. Should the bridge add output sanitization to redact known secret patterns from exec stdout/stderr?
2. Should .composer.yml versions auto-increment on submodule updates?
3. Should .composer.yml support per-module CPU/memory limits?
4. How should child sandboxes discover each other (Coolify internal network, or via env vars with preview URLs)?
