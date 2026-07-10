---
title: "ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "requirements"
status: "approved"
version: "1"
owner_agent: "BA"
last_updated: "2026-07-10"
---

# ACP-MCP Bridge

## 1. Business Value

Enable any MCP-compatible client (Claude Desktop, VS Code Copilot, Cursor, etc.) to interact with Open Agents' infrastructure — sandboxed workspaces, file operations, shell access, and session management — through the Agent Client Protocol (ACP). This allows third-party AI coding tools to use Open Agents as their execution backend without needing the Open Agents chat UI.

## 2. Scope

### In Scope

- New `packages/acp-mcp/` package implementing the ACP→MCP bridge
- New `apps/web/app/api/acpmcp/route.ts` Next.js API route
- Bearer-token auth using `ACP_MCP_TOKEN` env var (separate from OAuth)
- MCP tools mapping to these ACP method groups:
  - **Auth & Provider:** `agent.initialize`, `agent.authenticate`, `agent.logout`, `providers.list`, `providers.set`, `providers.disable`
  - **Session Lifecycle:** `session.new`, `session.load`, `session.list`, `session.delete`, `session.fork`, `session.resume`, `session.close`, `session.setMode`, `session.setConfigOption`
  - **Conversation:** `session.prompt`, `session.cancel`, NES methods (`nes.start`, `nes.suggest`, `nes.accept`, `nes.reject`, `nes.close`)
  - **Document Events:** `document.didOpen`, `document.didChange`, `document.didClose`, `document.didSave`, `document.didFocus`
  - **Client Ops:** `client.session.requestPermission`, `client.session.update`, `fs.writeTextFile`, `fs.readTextFile`, `terminal.create`, `terminal.output`, `terminal.release`, `terminal.waitForExit`, `terminal.kill`
  - **Elicitation:** `elicitation.create`, `elicitation.complete`
  - **Protocol Control:** `protocol.cancelRequest`
- Session sandbox backed by `@open-agents/sandbox` (Vercel Firecracker VMs)
- Unit tests and System Integration Tests (curl-based SIT)

### Out of Scope

- ACP streamable HTTP / WebSocket transport (initial release uses MCP HTTP POST)
- Full ACP client implementation (we serve the Agent side, not the Client side)
- Integration with the existing Open Agents chat UI or OAuth system

## 3. Stakeholders

| Role | Interest |
|---|---|
| **MCP client users** | Use Open Agents as a remote execution backend from their preferred AI coding tool |
| **Open Agents maintainers** | No changes to existing code required; bridge is a self-contained module |

## 4. Functional Requirements

### FR-1: MCP Server Discovery

The endpoint `POST /api/acpmcp` must respond to `tools/list` with the full set of ACP-mapped MCP tool definitions, each with a valid JSON Schema `inputSchema`.

### FR-2: Bearer Token Authentication

All requests to `/api/acpmcp` must require an `Authorization: Bearer <token>` header where `<token>` equals the `ACP_MCP_TOKEN` environment variable. Requests without a valid token must return HTTP 401 with a JSON-RPC error.

### FR-3: Session Lifecycle (DB-Backed)

The bridge must provide MCP tools for creating, loading, listing, deleting, and closing sessions. Each session maps to a real Open Agents session in the database (via the existing `apps/web/lib/db/sessions.ts` APIs), creating a `sessions` row and an initial chat. Sessions created through the bridge must be visible in the chat UI's session list sidebar. The session ID returned by `acp_session_new` is the real database session ID.

### FR-4: Sandbox File Operations

The bridge must provide MCP tools for reading and writing files in a session's sandbox (`fs.readTextFile`, `fs.writeTextFile`). Each operation connects to the sandbox by name, performs the action, then disconnects.

### FR-5: Sandbox Shell Access

The bridge must provide MCP tools for running commands in a session's sandbox (`terminal.create`, `terminal.output`). Each command runs via `sandbox.exec()` and returns stdout/stderr/exitCode.

### FR-6: Prompt Execution

The bridge must provide an MCP tool (`session.prompt`) that accepts a user message and returns an assistant response. The prompt must be persisted as a real chat message in the database via the existing chat/message APIs (`lib/db/sessions.ts`), making it visible in the chat UI. The initial implementation returns a canned response; future iterations can integrate the full Open Agents agent loop.

### FR-7: Initialize & Capabilities

The bridge must respond to `agent.initialize` with the ACP protocol version and advertised capabilities (session lifecycle, file system, terminal, authentication, providers).

## 5. Non-Functional Requirements

### NFR-1: Zero Changes to Existing Files

The bridge must be self-contained in `packages/acp-mcp/` and `apps/web/app/api/acpmcp/`. No existing file in the repository shall be modified.

### NFR-2: Sandbox Lifecycle

Each sandbox operation (read, write, command) connects, performs the action, and disconnects. Sandboxes persist on the Vercel side and can be reconnected by name. No background lifecycle management is required for initial release; sandboxes use Vercel's built-in timeout (configurable via `timeout` option).

### NFR-3: Request/Response Latency

Sandbox operations (file read/write, shell) should complete within the function's `maxDuration` (120s configured). Simple operations (initialize, list sessions) should return in under 1s.

### NFR-4: Auth Isolation

The `ACP_MCP_TOKEN`-based auth must be completely independent from the existing OAuth/session auth used by other pages and API routes. No user session or OAuth token is required to use the bridge.

### NFR-5: Deployment

The bridge deploys as part of the existing Next.js app. No separate service or infrastructure is needed. Standard `vercel --prod` picks up the new API route automatically.

## 6. Acceptance Criteria

| ID | Criterion | Verification |
|---|---|---|
| AC-1 | `POST /api/acpmcp` with `tools/list` returns ≥20 tool definitions | SIT test |
| AC-2 | `POST /api/acpmcp` without Bearer token returns 401 | curl test |
| AC-3 | `POST /api/acpmcp` with wrong Bearer token returns 401 | curl test |
| AC-4 | `acp_initialize` returns protocol version + agent capabilities | Unit test |
| AC-5 | `acp_session_new` creates a real DB session visible in the chat UI session list | SIT test (verify via `GET /api/sessions`) |
| AC-6 | `acp_session_list` returns the created session | SIT test |
| AC-7 | `acp_fs_write_text_file` writes content to a sandbox file | Unit + SIT |
| AC-8 | `acp_fs_read_text_file` reads back written file content | Unit + SIT |
| AC-9 | `acp_terminal_create` runs a command and returns output | Unit + SIT |
| AC-10 | `acp_session_delete` archives a session | SIT test |
| AC-11 | `acp_session_prompt` creates a real chat message in the session, visible from the chat UI | SIT test (verify via `GET /api/sessions/.../chats`) |
| AC-12 | No existing files in the repository were modified | `git diff --stat` |
| AC-13 | `pnpm run ci` passes after adding the new package | CI run |

## 7. Dependencies

- `@agentclientprotocol/sdk` — ACP type definitions and method-name constants
- `@modelcontextprotocol/sdk` — MCP server types and JSON-RPC structures (optional; can use raw JSON-RPC dispatch)
- `@open-agents/sandbox` (workspace dep) — Sandbox connection and operations
- `nanoid` — Session ID generation
- `ACP_MCP_TOKEN` env var — Bearer token for auth

## 8. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Sandbox provisioning fails (402) on plans without git-source support | Medium | High | Already handled by error wrapping in `provisioning.ts`; MCP creates sandboxes without source by default |
| ACP SDK API changes | Low | Medium | Pin to a specific version; the bridge only uses stable type definitions and method constants |
| Rate limiting from concurrent tool calls | Medium | Low | Each tool call is independent; Vercel scales automatically with concurrent requests |
