---
title: "ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "design"
status: "draft"
version: "1"
owner_agent: "Architect"
parent_feature: "acp-mcp"
last_updated: "2026-07-10"
---

# ACP-MCP Bridge — Design

## 1. Design Summary

A bridge that exposes Open Agents' infrastructure through MCP tools that map to Agent Client Protocol (ACP) methods. Sessions are backed by the real database (same `sessions` and `chats` tables used by the chat UI), so sessions created via MCP are immediately visible in the UI. The bridge lives in two locations:

- **`packages/acp-mcp/`** — reusable bridge logic (tool definitions, handler factory, types)
- **`apps/web/app/api/acpmcp/route.ts`** — Next.js API route that wires the bridge into the deployment, importing DB helpers from the existing `@/lib/db/sessions` module

No existing files are modified. The bridge authenticates via a static Bearer token (`ACP_MCP_TOKEN`) independent of the app's OAuth system.

## 2. Components & Interfaces

```
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
