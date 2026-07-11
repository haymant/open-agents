---
title: "Headless Agent (ACP-MCP Bridge)"
feature_id: "acp-mcp"
artifact: "requirements"
status: "approved"
version: "2"
owner_agent: "BA"
last_updated: "2026-07-11"
---

# Headless Agent — ACP-MCP Bridge

## 1. Business Value

Make Open Agents a **full-fledged headless agent** accessible via MCP that covers all features currently available through the chat UI — session management, LLM prompting with tool calling, durable workflows, sandboxed workspaces, GitHub integration, and project management. Any MCP-compatible client (Claude Desktop, VS Code, Cursor, etc.) can drive the agent without the chat UI.

## 2. Feature Modules

The headless agent is split into independent, composable MCP tool groups:

### 2.1 `acp-mcp-core` (Session & Auth)

Session lifecycle, authentication, configuration.

| Tool | ACP Method | Description |
|---|---|---|
| `acp_initialize` | `agent.initialize` | Protocol handshake; returns capabilities |
| `acp_authenticate` | `agent.authenticate` | Authenticate via bearer token |
| `acp_logout` | `agent.logout` | Logout |
| `acp_session_new` | `session.new` | Create session + sandbox + initial chat |
| `acp_session_load` | `session.load` | Load existing session |
| `acp_session_list` | `session.list` | List user sessions |
| `acp_session_delete` | `session.delete` | Archive session |
| `acp_session_fork` | `session.fork` | Fork session |
| `acp_session_resume` | `session.resume` | Resume session |
| `acp_session_close` | `session.close` | Close session |
| `acp_session_set_mode` | `session.setMode` | Set agent mode |
| `acp_session_set_config_option` | `session.setConfigOption` | Set config option |

### 2.2 `acp-mcp-llm` (LLM Providers & Prompting)

Configurable LLM providers with full agent-loop prompt execution.

| Tool | ACP Method | Description |
|---|---|---|
| `acp_providers_list` | `providers.list` | List configured providers (OpenAI, Anthropic, DeepSeek) |
| `acp_providers_set` | `providers.set` | Set active provider + model |
| `acp_providers_disable` | `providers.disable` | Disable a provider |
| `acp_session_prompt` | `session.prompt` | Execute prompt via full agent loop (LLM + tool calls) |
| `acp_session_cancel` | `session.cancel` | Cancel in-progress prompt |

### 2.3 `acp-mcp-sandbox` (Workspace & Filesystem)

Isolated sandbox workspace with file and shell operations.

| Tool | ACP Method | Description |
|---|---|---|
| `acp_fs_read_text_file` | `fs.readTextFile` | Read file from sandbox |
| `acp_fs_write_text_file` | `fs.writeTextFile` | Write file to sandbox |
| `acp_sandbox_edit_file` | ext: `sandbox/edit` | Edit file with find-replace |
| `acp_terminal_create` | `terminal.create` | Run command in sandbox |
| `acp_terminal_output` | `terminal.output` | Get terminal output |
| `acp_sandbox_status` | ext: `sandbox/status` | Get sandbox lifecycle state |
| `acp_sandbox_snapshot` | ext: `sandbox/snapshot` | Create sandbox snapshot |
| `acp_sandbox_reset` | ext: `sandbox/reset` | Reset sandbox to clean state |

### 2.4 `acp-mcp-github` (GitHub Integration)

Repository operations: create, clone, commit, push, PR management.

| Tool | ACP Method | Description |
|---|---|---|
| `acp_github_create_repo` | ext: `github/create_repo` | Create GitHub repo from workspace |
| `acp_github_clone` | ext: `github/clone` | Clone existing repo into sandbox |
| `acp_github_commit_push` | ext: `github/commit_push` | Commit all changes and push |
| `acp_github_create_pr` | ext: `github/create_pr` | Create pull request |
| `acp_github_list_branches` | ext: `github/list_branches` | List branches for linked repo |
| `acp_github_switch_branch` | ext: `github/switch_branch` | Switch to a different branch |

### 2.5 `acp-mcp-workflow` (Durable Workflow)

Long-running workflows with retry, sleep, and state persistence. Uses Vercel WDK with Local World (dev) or custom Postgres World (self-hosted).

| Tool | ACP Method | Description |
|---|---|---|
| `acp_workflow_provision` | ext: `workflow/provision` | Kick off sandbox provisioning workflow |
| `acp_workflow_wait` | ext: `workflow/wait` | Wait for workflow run to complete |
| `acp_workflow_status` | ext: `workflow/status` | Check workflow run status |

### 2.6 `acp-mcp-document` (Document Events, stubs for NES)

| Tool | ACP Method | Description |
|---|---|---|
| `acp_document_did_*` | `document.did*` | Document lifecycle events (stubs) |
| `acp_nes_*` | `nes.*` | NES methods (stubs) |
| `acp_request_permission` | `client.session.requestPermission` | Auto-accept permissions |

## 3. Scope

### In Scope

- All feature modules above, each in `packages/acp-mcp-{module}/`
- Single API route `apps/web/app/api/acpmcp/route.ts` or per-module routes
- Bearer-token auth via `ACP_MCP_TOKEN`
- DB-backed sessions integrated with the existing session/chat schema
- LLM prompt execution via the full `openAgent.run()` agent loop (the same code path the chat UI uses)
- Durable workflow execution via Vercel WDK (`workflow` package) with Local World for dev
- Direct sandbox provisioning via `connectSandbox()`
- GitHub operations via existing GitHub App/OAuth integration
- Comprehensive SIT: end-to-end curl-based workflows

### Out of Scope

- Coolify / K8s sandbox backends (pluggable in future)
- Custom WDK World for self-hosted Postgres (future iteration)
- WebSocket transport for MCP (HTTP POST only)
- NES suggestion rendering (stubs only)

## 4. Functional Requirements

### FR-LLM-1: Configurable Providers

The bridge must support listing, setting, and disabling LLM providers. Supported providers: OpenAI, Anthropic, DeepSeek (via AI Gateway). Each `acp_session_prompt` call uses the provider configured for that session.

### FR-LLM-2: Full Agent-Loop Prompt

`acp_session_prompt` must execute the user prompt through the full Open Agents agent loop (`openAgent.run()`), including tool calling, multi-step reasoning, and HITL permission requests. Responses must be streamed or returned synchronously.

### FR-SANDBOX-1: Sandbox Provisioning

`acp_session_new` must provision a sandbox directly via `connectSandbox()` with configurable timeout, vcpus, and snapshot, and persist the sandbox state in the database with `lifecycleState: "active"`.

### FR-WORKFLOW-1: Durable Workflow Execution

`acp_workflow_provision` must start a durable sandbox provisioning workflow via `start(sandboxProvisioningWorkflow, [sessionId])`. In local dev, this uses the WDK Local World. `acp_workflow_wait` must poll until the workflow completes or fails.

### FR-GITHUB-1: Repo Creation from Workspace

`acp_github_create_repo` must create a GitHub repository from the current sandbox workspace via the existing `POST /api/github/create-repo` endpoint or directly via Octokit.

### FR-GITHUB-2: Commit & Push

`acp_github_commit_push` must commit all uncommitted changes in the sandbox and push to the linked remote, using the same commit flow the chat UI's auto-commit uses.

### FR-GITHUB-3: PR Management

`acp_github_create_pr` must create a pull request from the current sandbox branch, using the same PR flow the chat UI uses.

## 5. Acceptance Criteria

| ID | Criterion |
|---|---|
| AC-1 | `acp_session_prompt` invokes the real agent loop and returns LLM response |
| AC-2 | `acp_session_prompt` supports tool calling (read/write/bash) |
| AC-3 | `acp_github_create_repo` creates a GitHub repo visible on github.com |
| AC-4 | `acp_github_commit_push` commits and pushes sandbox changes to GitHub |
| AC-5 | `acp_workflow_provision` starts a workflow run via WDK Local World |
| AC-6 | SIT-11: Create session → create README via prompt → create repo → commit/push |
| AC-7 | SIT-12: Create session with existing repo → prompt → commit/push or PR |

## 6. Dependencies

- `@agentclientprotocol/sdk` — ACP types
- `@modelcontextprotocol/sdk` — MCP Server + transport
- `@open-agents/sandbox` — Sandbox connection
- `@open-agents/agent` — Full agent loop for prompt execution
- `workflow` — Vercel WDK for durable workflows (Local World)
- `@octokit/rest` — GitHub API operations
- `nanoid` — ID generation

## 7. SIT Test Plan

### SIT-11: End-to-End — New Repo from Scratch

```
1. acp_initialize
2. acp_session_new                           → sessionId
3. acp_workflow_provision(sessionId)          → runId
4. acp_workflow_wait(runId)                   → "ready"
5. acp_session_prompt(sessionId, "create a README.md with this project title: Open Agents Headless")
                                              → LLM creates README.md in sandbox
6. acp_fs_read_text_file(sessionId, "/README.md")
                                              → verify content exists
7. acp_github_create_repo(sessionId, { name: "acp-mcp-test" })
                                              → repo created on github.com
8. acp_github_commit_push(sessionId, "chore: initial README")
                                              → changes pushed to GitHub
9. Verify: repo exists on github.com with README.md
10. acp_session_delete(sessionId)
```

### SIT-12: End-to-End — Existing Repo

```
1. acp_initialize
2. acp_session_new({ repoUrl: "https://github.com/user/existing-repo", branch: "main" })
3. acp_workflow_provision → wait
4. acp_session_prompt(sessionId, "add 'Headless Agent' to the README")
                                              → LLM edits README.md
5. acp_github_commit_push(sessionId, "docs: add headless agent note")
                                              → pushed to GitHub
6. (alternative) acp_github_create_pr(sessionId, "Headless Agent update")
                                              → PR created
7. acp_session_delete(sessionId)
```
