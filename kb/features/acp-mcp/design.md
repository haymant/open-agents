---
title: "Headless Agent — ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "design"
status: "draft"
version: "2"
owner_agent: "Architect"
parent_feature: "acp-mcp"
last_updated: "2026-07-11"
---

# Headless Agent — Design

## 1. Design Summary

The headless agent is split into **six composable modules**, each in `packages/acp-mcp-{module}/`. One API route (`apps/web/app/api/acpmcp/route.ts`) combines them all. Each module is a standalone MCP tool group that can be enabled/disabled independently.

### Module Map

```
packages/
  acp-mcp-core/          Session, auth, config
  acp-mcp-llm/           LLM providers + prompt execution
  acp-mcp-sandbox/        File ops + shell (rename from acp-mcp)
  acp-mcp-github/         Repo, commit, PR
  acp-mcp-workflow/       Durable workflow (WDK Local World)
  acp-mcp-document/       Document events, NES, permissions

All modules share:
  - Bridge types (SessionStore, SandboxOps) from acp-mcp-sandbox
  - Tool name prefix convention (acp_*)
```

## 2. Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   MCP Client                                 │
│  POST /api/acpmcp  { jsonrpc, method, params }              │
│  Authorization: Bearer <ACP_MCP_TOKEN>                      │
└────────────────────────┬────────────────────────────────────┘
                         ▼
┌─────────────────────────────────────────────────────────────┐
│  apps/web/app/api/acpmcp/route.ts                           │
│                                                             │
│  ┌─────┐  ┌──────────────┐  ┌───────────────────────────┐  │
│  │Auth │→│McpServer      │→│Combined Tool Registry      │  │
│  │     │  │(MCP SDK)     │  │(all 6 modules registered) │  │
│  └─────┘  └──────────────┘  └───────────────────────────┘  │
│                                    │                        │
└────────────────────────────────────┼────────────────────────┘
                   ┌─────────────────┼─────────────────┐
         ┌─────────┤                 │                 ├────────┐
         ▼         ▼                 ▼                 ▼        ▼
   ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌────────────┐ ┌──────────┐
   │acp-mcp-  │ │acp-mcp-  │ │acp-mcp-   │ │acp-mcp-    │ │acp-mcp-  │
   │core      │ │llm       │ │sandbox    │ │github      │ │workflow  │
   │          │ │          │ │           │ │             │ │          │
   │sessions  │ │openAgent │ │connectSan │ │octokit      │ │workflow  │
   │DB        │ │.run()    │ │dbox()     │ │commit/push  │ │WDK       │
   └──────────┘ └──────────┘ └────────────┘ └────────────┘ └──────────┘
                          │
                          ▼
                  ┌─────────────────┐
                  │ Vercel AI       │
                  │ Gateway         │
                  │ (OpenAI,        │
                  │  Anthropic,     │
                  │  DeepSeek)      │
                  └─────────────────┘
```

## 3. Module Designs

### 3.1 `acp-mcp-core` — Session & Auth

`packages/acp-mcp-core/` (rename existing `packages/acp-mcp/`)

**Types:**
```typescript
interface SessionStore {
  create(params): Promise<{ sessionId, sandboxName }>;
  get(sessionId): Promise<SessionRecord | undefined>;
  list(): Promise<Array<{ sessionId }>>;
  delete(sessionId): Promise<void>;
  update(sessionId, data): Promise<void>;
}
```

**Implementation:** Real DB-backed sessions using `createSessionWithInitialChat`, `getSessionsByUserId`, `updateSession`.

**Session creation flow:**
```
acp_session_new
  → createSessionWithInitialChat({ id, userId, title })
  → connectSandbox({ sandboxName, timeout, vcpus, createIfMissing })
  → updateSession({ sandboxState, lifecycleState: "active" })
  → return { sessionId, sandboxName, cwd, availableModes }
```

### 3.2 `acp-mcp-llm` — LLM Providers & Prompting

`packages/acp-mcp-llm/`

This is the key upgrade — replaces the canned `echo` response with the full agent loop.

**Prompt execution flow:**
```
acp_session_prompt({ sessionId, message: { role: "user", content: [...] }})
  → store.get(sessionId)                                     ← DB read
  → connectSandbox(sandboxState)                              ← sandbox connect
  → discoverSkills(sandbox)                                   ← skill loading
  → resolveChatModelRuntime({ userId, sessionId, requestUrl }) ← model config
  → openAgent.run({                                           ← FULL AGENT LOOP
       messages: [{ role: "user", content: userText }],
       sandbox: { state, workingDirectory, ... },
       model: selectedModelId,
       skills,
     })
  → persistAssistantMessage(chatId, response)                 ← DB write
  → return { messages: response.messages, stopReason }
```

**Dependencies:** `@open-agents/agent` (existing workspace package), `ai` SDK, AI Gateway.

**Configurable providers:**
```typescript
acp_providers_set({ provider: "deepseek", model: "deepseek-chat" })
acp_providers_set({ provider: "anthropic", model: "claude-sonnet-4-20250514" })
```

### 3.3 `acp-mcp-sandbox` — Workspace & Filesystem

`packages/acp-mcp-sandbox/` (extracted from current bridge.ts)

Currently fully implemented. File read/write/edit, terminal, sandbox state, snapshots. Uses `connectSandbox()` with `createIfMissing: true` for auto-creation.

### 3.4 `acp-mcp-github` — GitHub Integration

`packages/acp-mcp-github/`

Reuses existing `apps/web/lib/github/access.ts`, `apps/web/lib/github/app.ts`, `apps/web/lib/github/commit.ts`, and the GitHub App installation token system.

**Create repo flow:**
```
acp_github_create_repo({ sessionId, repoName, isPrivate })
  → store.get(sessionId) → verify sandbox is active
  → getUserOctokit(userId) → GitHub API call
  → octokit.repos.createForAuthenticatedUser({ name, private, auto_init: true })
  → updateSession({ repoOwner, repoName, cloneUrl, branch })
  → git remote set-url origin <cloneUrl>
  → return { repoUrl, cloneUrl, branch }
```

**Commit & push flow:**
```
acp_github_commit_push({ sessionId, message })
  → store.get(sessionId) → verify repo is linked
  → mintInstallationToken({ contents: "write" })
  → syncToRemotePreservingChanges(sandbox, branch)   ← rebase
  → stageAll(sandbox) → getStagedDiff()
  → createCommit() via GitHub API                     ← broker-side commit
  → pushBranchToRemote(sandbox, branch)                 ← sandbox-side push
  → return { sha, pushed: true }
```

### 3.5 `acp-mcp-workflow` — Durable Workflow

`packages/acp-mcp-workflow/`

Uses **Vercel WDK** (`workflow` package) which supports:
- **Local World** (built-in, no infra needed) — for dev and CI
- **Vercel World** (default on Vercel) — serverless queues
- **Custom World** (Postgres, Redis) — for self-hosted

**Correction from v1:** The WDK does support local dev natively. `start(workflow, args)` uses the Local World which runs the workflow in-process with virtualized retry/sleep/state. It does NOT require Vercel cloud infrastructure.

**Flow:**
```
acp_workflow_provision({ sessionId })
  → start(sandboxProvisioningWorkflow, [sessionId])
  → return { runId }

acp_workflow_wait({ runId })
  → getRun(runId)
  → await run.returnValue
  → return { result } or throw on failure
```

### 3.6 `acp-mcp-document` — Document Events & Permissions

`packages/acp-mcp-document/`

Stubs for NES and document events. Permissions auto-accept.

## 4. API Route Wiring

`apps/web/app/api/acpmcp/route.ts` combines all modules:

```typescript
// Create McpServer
const mcpServer = new McpServer({ name, version }, { capabilities: { tools: {} } });

// Register all module tools
registerCoreTools(mcpServer, dbStore, sandboxOps);
registerLLMTools(mcpServer, dbStore, sandboxOps);
registerSandboxTools(mcpServer, dbStore, sandboxOps);
registerGitHubTools(mcpServer, dbStore, sandboxOps);
registerWorkflowTools(mcpServer, dbStore);
registerDocumentTools(mcpServer, dbStore);

// Per-request transport
const transport = new WebStandardStreamableHTTPServerTransport({
  sessionIdGenerator: undefined,
  enableJsonResponse: true,
});
```

## 5. SIT Strategy

Two end-to-end workflows in `scripts/acp-mcp-sit.sh`:

**SIT-11 (New Repo from Scratch):**
```
acp_initialize
→ acp_session_new
→ acp_session_prompt("create README.md")
→ acp_github_create_repo("acp-mcp-test-repo")
→ acp_github_commit_push("initial README")
→ verify: repo exists on GitHub with README.md
→ acp_session_delete
```

**SIT-12 (Existing Repo):**
```
acp_initialize
→ acp_session_new({ repoUrl, branch })
→ acp_session_prompt("add feature X")
→ acp_github_commit_push or acp_github_create_pr
→ acp_session_delete
```

## 6. Failure Modes

| Failure | Handling |
|---|---|
| Sandbox API unavailable (local dev) | Provision falls back to initial state; file/terminal ops auto-create sandbox on first use |
| LLM provider not configured | `acp_providers_set` returns available providers from AI Gateway |
| GitHub token expired | `getUserGitHubToken` returns null → 400 "GitHub not connected" |
| Workflow run times out | `getRun(runId).returnValue` throws after timeout; caller retries |

┌─────────────────────────────────────────────────────────┐
│                    MCP Client                            │
│  (Claude Desktop, VS Code, Cursor, etc.)                │
│  POST /api/acpmcp  { jsonrpc, method, params }          │
└────────────────────┬────────────────────────────────────┘
                     │ Authorization: Bearer <ACP_MCP_TOKEN>
                     ▼
┌─────────────────────────────────────────────────────────┐
│  apps/web/app/api/acpmcp/route.ts                       │
│                                                         │
│  ┌────────────┐  ┌──────────────┐  ┌────────────────┐  │
│  │ Auth Guard  │→│  JSON-RPC    │→│  Tool Handler   │  │
│  │ (Bearer     │  │  Dispatcher  │  │  Dispatch       │  │
│  │  token)     │  │              │  │                 │  │
│  └────────────┘  └──────┬───────┘  └────────────────┘  │
│                          │                               │
└──────────────────────────┼───────────────────────────────┘
                           │
              ┌────────────┴────────────┐
              │                         │
              ▼                         ▼
  ┌─────────────────────┐  ┌──────────────────────────┐
  │  @open-agents/acp-mcp│  │  @open-agents/sandbox    │
  │                     │  │                          │
  │  bridge.ts          │  │  connectSandbox()         │
  │  - tool definitions │  │  readFile / writeFile     │
  │  - createHandlers() │  │  exec()                   │
  │  - SessionStore     │  │                          │
  │  - SandboxOps       │  └──────────────────────────┘
  └─────────────────────┘
```

### 2.1 Core Interfaces

```typescript
// SessionStore — abstracts session persistence
interface SessionStore {
  create(params: { cwd?: string }): Promise<{ sessionId: string; sandboxName: string }>;
  get(sessionId: string): Promise<{ sandboxName: string; cwd?: string } | undefined>;
  list(): Promise<Array<{ sessionId: string; title?: string }>>;
  delete(sessionId: string): Promise<void>;
  getSandboxState(sessionId: string): SandboxState | undefined;
}

// SandboxOps — abstracts sandbox operations
interface SandboxOps {
  readFile(sandboxName: string, uri: string): Promise<string>;
  writeFile(sandboxName: string, uri: string, content: string): Promise<void>;
  runCommand(sandboxName: string, command: string, args?: string[], cwd?: string): Promise<ExecResult>;
}

// ToolContent — MCP tool response content
type ToolContent = { type: string; text: string };
```

### 2.2 ACP-to-MCP Tool Mapping

| Tool Name | ACP Method | Input | Output | Implementation |
|---|---|---|---|---|
| `acp_initialize` | `agent.initialize` | `protocolVersion` | Protocol version + capabilities | Static response |
| `acp_authenticate` | `agent.authenticate` | `methodId`, `params` | `{ authenticated: true }` | Delegated to Bearer auth |
| `acp_logout` | `agent.logout` | — | `{}` | No-op |
| `acp_providers_list` | `providers.list` | — | Providers list | Static list |
| `acp_providers_set` | `providers.set` | `provider`, `config` | `{}` | No-op (configurable) |
| `acp_providers_disable` | `providers.disable` | `provider` | `{}` | No-op (configurable) |
| `acp_session_new` | `session.new` | `cwd`, `additionalDirectories` | `{ sessionId, cwd, availableModes }` | Create in-memory + sandbox |
| `acp_session_load` | `session.load` | `sessionId` | `{ sessionId, cwd, ... }` | Read from store |
| `acp_session_list` | `session.list` | `cursor`, `limit` | `{ sessions: [...] }` | List from store |
| `acp_session_delete` | `session.delete` | `sessionId` | `{}` | Remove from store |
| `acp_session_fork` | `session.fork` | `sessionId` | `{ sessionId }` | Clone in store |
| `acp_session_resume` | `session.resume` | `sessionId` | `{ sessionId }` | Verify in store |
| `acp_session_close` | `session.close` | `sessionId` | `{}` | Remove from store |
| `acp_session_set_mode` | `session.setMode` | `sessionId`, `mode` | `{}` | Store mode |
| `acp_session_set_config_option` | `session.setConfigOption` | `sessionId`, `option` | Full config state | Store option |
| `acp_session_prompt` | `session.prompt` | `sessionId`, `message` | `{ messages, stopReason }` | Sandbox exec |
| `acp_session_cancel` | `session.cancel` | `sessionId` | — | No-op (v1) |
| `acp_nes_start` | `nes.start` | `sessionId`, `documentUri` | `{ sessionId }` | No-op (v1) |
| `acp_nes_suggest` | `nes.suggest` | `sessionId`, `context` | `{ suggestions }` | No-op (v1) |
| `acp_nes_accept` | `nes.accept` | `sessionId`, `suggestionId` | — | No-op (v1) |
| `acp_nes_reject` | `nes.reject` | `sessionId`, `suggestionId`, `reason` | — | No-op (v1) |
| `acp_nes_close` | `nes.close` | `sessionId` | — | No-op (v1) |
| `acp_document_did_open` | `document.didOpen` | `sessionId`, `uri`, `languageId`, `text` | — | No-op (v1) |
| `acp_document_did_change` | `document.didChange` | `sessionId`, `uri`, `changes` | — | No-op (v1) |
| `acp_document_did_close` | `document.didClose` | `sessionId`, `uri` | — | No-op (v1) |
| `acp_document_did_save` | `document.didSave` | `sessionId`, `uri` | — | No-op (v1) |
| `acp_document_did_focus` | `document.didFocus` | `sessionId`, `uri` | — | No-op (v1) |
| `acp_request_permission` | `client.session.requestPermission` | `sessionId`, `prompt`, `options` | `{ outcome }` | Auto-accept (v1) |
| `acp_session_update` | `client.session.update` | `sessionId`, `update` | — | No-op (v1) |
| `acp_fs_write_text_file` | `fs.writeTextFile` | `sessionId`, `uri`, `content` | `{}` | Sandbox writeFile |
| `acp_fs_read_text_file` | `fs.readTextFile` | `sessionId`, `uri` | `{ content }` | Sandbox readFile |
| `acp_terminal_create` | `terminal.create` | `sessionId`, `command`, `args`, `cwd` | `{ terminalId, output }` | Sandbox exec |
| `acp_terminal_output` | `terminal.output` | `sessionId`, `terminalId` | `{ output, exitStatus }` | Stub (stateless) |
| `acp_terminal_release` | `terminal.release` | `sessionId`, `terminalId` | `{}` | No-op |
| `acp_terminal_wait_for_exit` | `terminal.waitForExit` | `sessionId`, `terminalId` | `{ exitStatus }` | Stub |
| `acp_terminal_kill` | `terminal.kill` | `sessionId`, `terminalId` | `{}` | No-op |
| `acp_elicitation_create` | `elicitation.create` | `sessionId`, `schema` | `{ elicitationId }` | No-op (v1) |
| `acp_elicitation_complete` | `elicitation.complete` | `elicitationId`, `value` | — | No-op (v1) |
| `acp_cancel_request` | `protocol.cancelRequest` | `requestId` | — | No-op |

## 3. Data Flow

### Session Creation Flow

```
MCP Client                     API Route                     acp-mcp              DB / Sandbox
    │                              │                           │                        │
    │ tools/call("acp_session_new")│                           │                        │
    │─────────────────────────────►│                           │                        │
    │                              │ checkAuth(Bearer token)   │                        │
    │                              │ McpServer dispatch        │                        │
    │                              │                           │                        │
    │                              │ createSessionWithInitialChat()                    │
    │                              │──────────────────────────────────────────────► DB  │
    │                              │◄── { sessionId, chatId }                         │
    │                              │                           │                        │
    │                              │ connectSandbox() (async)                          │
    │                              │──────────────────────────────────────────────► Vercel
    │                              │                           │                        │
    │                              │ store sandboxState in DB                          │
    │                              │──────────────────────────────────────────────► DB  │
    │                              │                           │                        │
    │◄──── { sessionId, cwd }     │                           │                        │


### File Read/Write Flow

```
MCP Client                     API Route                     acp-mcp                   Sandbox
    │                              │                           │                        │
    │ tools/call("acp_fs_write_    │                           │                        │
    │   text_file", {sessionId,   │                           │                        │
    │   uri, content})            │                           │                        │
    │─────────────────────────────►│                           │                        │
    │                              │ store.get(sessionId)      │                        │
    │                              │───────────────────────►   │                        │
    │                              │◄── { sandboxName }       │                        │
    │                              │                           │                        │
    │                              │ connectSandbox({          │                        │
    │                              │   type:"vercel",          │                        │
    │                              │   sandboxName })          │                        │
    │                              │──────────────────────────────────────────────────►│
    │                              │◄──── Sandbox instance                             │
    │                              │                           │                        │
    │                              │ sandbox.writeFile(uri)    │                        │
    │                              │──────────────────────────────────────────────────►│
    │                              │                           │                        │
    │                              │ sandbox.stop()            │                        │
    │                              │──────────────────────────────────────────────────►│
    │                              │◄──── response             │                        │
    │◄──── { content }            │                           │                        │
```

### Terminal (Command) Flow

```
MCP Client                     API Route                     acp-mcp                   Sandbox
    │                              │                           │                        │
    │ tools/call("acp_terminal_    │                           │                        │
    │   create", {sessionId,      │                           │                        │
    │   command, args})           │                           │                        │
    │─────────────────────────────►│                           │                        │
    │                              │ store.get(sessionId)      │                        │
    │                              │ sandboxOps.runCommand()   │                        │
    │                              │───────────────────────►   │                        │
    │                              │ connectSandbox + exec()   │                        │
    │                              │◄──── { stdout, stderr,    │                        │
    │                              │         exitCode }        │                        │
    │◄──── { terminalId, output } │                           │                        │
```

## 4. File Structure

```
packages/acp-mcp/
  package.json
  tsconfig.json
  index.ts              # Public exports
  bridge.ts             # Tool definitions + handler factory + types
  bridge.test.ts        # Unit tests

apps/web/app/api/acpmcp/
  route.ts              # Next.js API route (auth + dispatch)

scripts/
  acp-mcp-sit.sh        # curl-based SIT tests
```

## 5. Failure Modes

| Failure | Symptom | Handling |
|---|---|---|
| Invalid Bearer token | HTTP 401 | JSON-RPC error response, no processing |
| Session not found | Tool returns error content | Handler checks store.get() and returns descriptive error |
| Sandbox connection failure (402) | connectSandbox throws | Catch in handler, return JSON-RPC error |
| Sandbox operation timeout | exec() throws | Caught by handler, returned as error content |
| Invalid JSON body | Parse error | HTTP 400 + JSON-RPC parse error |
| Unknown tool name | `tools/call` returns method-not-found | JSON-RPC error code -32601 |
| Cold start loses sessions | session list empty | Expected; sandboxes persist by name on Vercel side |

## 6. Non-Functional Safeguards

- **Auth isolation** — Bearer token checked before any dispatch; no OAuth dependency
- **Sandbox cleanup** — Each operation connects and disconnects; sandbox.stop() in `finally` block
- **Timeout** — `maxDuration: 120` on the API route; each sandbox exec has a 120s timeout
- **No persisted secrets** — Token is validated in-memory; never logged or stored
- **Stateless handlers** — All handler state comes from the injected `SessionStore` and `SandboxOps` interfaces; handlers are pure functions

## 7. Test Planning Inputs

See `testing-plan.md` for full test strategy. Key coverage targets:

- **Unit tests**: Each handler in `bridge.ts`, mocked store and sandbox ops
- **SIT tests**: Full curl-based workflow — initialize → create session → write file → read file → run command → list sessions → delete session
- **Auth tests**: Missing token, wrong token, valid token
- **Error paths**: Session not found, unknown tool
