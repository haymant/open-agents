---
title: "ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "testing-plan"
status: "draft"
version: "1"
owner_agent: "QA"
parent_feature: "acp-mcp"
last_updated: "2026-07-10"
---

# ACP-MCP Bridge — Testing Plan

## 1. Test Strategy

Two layers:

- **Unit tests** (`bridge.test.ts`): Mock `SessionStore` and `SandboxOps` to verify each handler's logic in isolation — input parsing, error handling, response shapes.
- **System Integration Tests** (`scripts/acp-mcp-sit.sh`): curl-based against the running Next.js dev server. Tests the full stack: auth → dispatch → handler → sandbox.

## 2. Unit Tests

File: `packages/acp-mcp/bridge.test.ts`

### 2.1 Fixtures

```typescript
const mockStore: SessionStore = {
  create: mock(async () => ({ sessionId: "test-session-1", sandboxName: "acp-test-session-1" })),
  get: mock(async (id) =>
    id === "test-session-1"
      ? { sandboxName: "acp-test-session-1", cwd: "/vercel/sandbox" }
      : undefined,
  ),
  list: mock(async () => [{ sessionId: "test-session-1" }]),
  delete: mock(async () => {}),
  getSandboxState: mock(async () => ({ type: "vercel", sandboxName: "acp-test-session-1" })),
};

const mockSandbox: SandboxOps = {
  readFile: mock(async () => "Hello from sandbox"),
  writeFile: mock(async () => {}),
  runCommand: mock(async () => ({ stdout: "hello world", stderr: "", exitCode: 0 })),
};
```

### 2.2 Test Cases

| # | Test | Handler | Input | Expected |
|---|---|---|---|---|
| UT-1 | Initialize returns capabilities | `acp_initialize` | `{ protocolVersion: 1 }` | Response has `protocolVersion: 1`, `agentCapabilities.loadSession: true`, `agentCapabilities.sessionCapabilities.list: true` |
| UT-2 | Authenticate succeeds | `acp_authenticate` | `{ methodId: "bearer" }` | `{ authenticated: true }` |
| UT-3 | Logout succeeds | `acp_logout` | `{}` | `{}` |
| UT-4 | Create session | `acp_session_new` | `{ cwd: "/workspace" }` | `sessionId` is defined, `cwd` is `/workspace`, `availableModes` is non-empty |
| UT-5 | Create session default cwd | `acp_session_new` | `{}` | `cwd` defaults to `/vercel/sandbox` |
| UT-6 | Load existing session | `acp_session_load` | `{ sessionId: "test-session-1" }` | `sessionId` matches, `cwd` from store |
| UT-7 | Load nonexistent session | `acp_session_load` | `{ sessionId: "missing" }` | Returns error content, not success |
| UT-8 | List sessions | `acp_session_list` | `{}` | Array with at least the test session |
| UT-9 | Delete session | `acp_session_delete` | `{ sessionId: "test-session-1" }` | store.delete was called, response is `{}` |
| UT-10 | Prompt with text message | `acp_session_prompt` | `{ sessionId: "test-session-1", message: { role: "user", content: [{ type: "text", text: "hello" }] } }` | Response has `messages` array with `role: "assistant"` |
| UT-11 | Prompt on nonexistent session | `acp_session_prompt` | `{ sessionId: "missing", message: {} }` | Returns error content |
| UT-12 | Cancel session | `acp_session_cancel` | `{ sessionId: "test-session-1" }` | Returns `{}` |
| UT-13 | Read file | `acp_fs_read_text_file` | `{ sessionId: "test-session-1", uri: "/test.txt" }` | `content` matches mock |
| UT-14 | Read file nonexistent session | `acp_fs_read_text_file` | `{ sessionId: "missing", uri: "/test.txt" }` | Returns error |
| UT-15 | Write file | `acp_fs_write_text_file` | `{ sessionId: "test-session-1", uri: "/test.txt", content: "data" }` | sandbox.writeFile called with correct args |
| UT-16 | Write file nonexistent session | `acp_fs_write_text_file` | `{ sessionId: "missing", uri: "/test.txt", content: "data" }` | Returns error |
| UT-17 | Create terminal (run command) | `acp_terminal_create` | `{ sessionId: "test-session-1", command: "echo", args: ["hi"] }` | `terminalId` defined, `initialOutput` matches stdout |
| UT-18 | Terminal on nonexistent session | `acp_terminal_create` | `{ sessionId: "missing", command: "echo" }` | Returns error |
| UT-19 | NES start (stub) | `acp_nes_start` | `{ sessionId: "test-session-1", documentUri: "file:///test.ts" }` | Returns `{}` |
| UT-20 | Fork session | `acp_session_fork` | `{ sessionId: "test-session-1" }` | `sessionId` is defined and different from source |
| UT-21 | Set session mode | `acp_session_set_mode` | `{ sessionId: "test-session-1", mode: { id: "code" } }` | Returns `{}` |
| UT-22 | Providers list | `acp_providers_list` | `{}` | Array with at least one provider |
| UT-23 | Request permission auto-accept | `acp_request_permission` | `{ sessionId: "test-session-1", prompt: "Allow?", options: [...] }` | `outcome` is `{ kind: "approved" }` |
| UT-24 | Document events | `acp_document_did_open` | `{ sessionId: "test-session-1", uri: "file:///test.ts", languageId: "typescript", text: "" }` | Returns `{}` |
| UT-25 | Cancel request | `acp_cancel_request` | `{ requestId: "req-1" }` | Returns `{}` |
| UT-26 | Elicitation create (stub) | `acp_elicitation_create` | `{ sessionId: "test-session-1", schema: { type: "form", properties: {} } }` | `elicitationId` is defined |
| UT-27 | Elicitation complete | `acp_elicitation_complete` | `{ elicitationId: "el-1", value: "result" }` | Returns `{}` |

### 2.3 Running Unit Tests

```bash
bun test packages/acp-mcp/bridge.test.ts
```

## 3. System Integration Tests

File: `scripts/acp-mcp-sit.sh`

### 3.1 Prerequisites

- Next.js dev server running on `http://localhost:3000`
- `ACP_MCP_TOKEN` set in `apps/web/.env`
- `jq` installed for JSON parsing

### 3.2 SIT Scenarios

#### SIT-1: tools/list

Verify the MCP discovery endpoint returns all tool definitions.

```bash
curl -s -X POST "$BASE" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Expected:** Status 200, `result.tools` is an array with ≥20 tools.

#### SIT-2: Auth — Missing Token

```bash
curl -s -X POST "$BASE" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Expected:** Status 401, error message includes "Unauthorized".

#### SIT-3: Auth — Wrong Token

```bash
curl -s -X POST "$BASE" \
  -H "Authorization: Bearer wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

**Expected:** Status 401.

#### SIT-4: Full Session Lifecycle Workflow

1. Initialize → 2. Create session → 3. List sessions → 4. Write file → 5. Read file → 6. Run command → 7. Delete session

```bash
# Step 1: Initialize
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",\
       "params":{"name":"acp_initialize","arguments":{"protocolVersion":1}}}'

# Step 2: Create session (capture sessionId)
SESSION_RESP=$(curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call",\
       "params":{"name":"acp_session_new","arguments":{"cwd":"/vercel/sandbox"}}}')
SESSION_ID=$(echo "$SESSION_RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')

# Step 3: List sessions
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call",\
       "params":{"name":"acp_session_list","arguments":{}}}'

# Step 4: Write file
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\
       \"params\":{\"name\":\"acp_fs_write_text_file\",\
         \"arguments\":{\"sessionId\":\"$SESSION_ID\",\"uri\":\"/test.txt\",\"content\":\"ACP bridge test\"}}}"

# Step 5: Read file
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\
       \"params\":{\"name\":\"acp_fs_read_text_file\",\
         \"arguments\":{\"sessionId\":\"$SESSION_ID\",\"uri\":\"/test.txt\"}}}"

# Step 6: Run command
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\
       \"params\":{\"name\":\"acp_terminal_create\",\
         \"arguments\":{\"sessionId\":\"$SESSION_ID\",\"command\":\"echo\",\"args\":[\"hello world\"]}}}"

# Step 7: Delete session
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\
       \"params\":{\"name\":\"acp_session_delete\",\
         \"arguments\":{\"sessionId\":\"$SESSION_ID\"}}}"
```

#### SIT-5: Unknown Tool

```bash
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",\
       "params":{"name":"nonexistent_tool","arguments":{}}}'
```

**Expected:** Error code -32601 (method not found).

#### SIT-6: Session Not Found

```bash
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",\
       "params":{"name":"acp_fs_read_text_file",\
         "arguments":{"sessionId":"nonexistent","uri":"/test.txt"}}}'
```

**Expected:** Error content with "Session not found".

#### SIT-7: Session Load/Fork/Resume/Close

Creates a session, loads it, forks it, resumes it, then closes both.

```bash
# Create
S1=$(curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  | jq -r '.result.content[0].text | fromjson | .sessionId')
# Load
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  -d "{\"name\":\"acp_session_load\",\"arguments\":{\"sessionId\":\"$S1\"}}"
# Fork
S2=$(curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  -d "{\"name\":\"acp_session_fork\",\"arguments\":{\"sessionId\":\"$S1\"}}" \
  | jq -r '.result.content[0].text | fromjson | .sessionId')
# Resume
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  -d "{\"name\":\"acp_session_resume\",\"arguments\":{\"sessionId\":\"$S1\"}}"
# Close both
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  -d "{\"name\":\"acp_session_close\",\"arguments\":{\"sessionId\":\"$S1\"}}"
curl -s -X POST "$BASE" -H "Authorization: Bearer $TOKEN" ... \
  -d "{\"name\":\"acp_session_close\",\"arguments\":{\"sessionId\":\"$S2\"}}"
```

## 4. Test Coverage Matrix

| AC ID | Acceptance Criterion | UT Coverage | SIT Coverage |
|---|---|---|---|
| AC-1 | `tools/list` returns ≥20 tools | — | SIT-1 |
| AC-2 | No token → 401 | — | SIT-2 |
| AC-3 | Wrong token → 401 | — | SIT-3 |
| AC-4 | Initialize returns capabilities | UT-1 | SIT-4 step 1 |
| AC-5 | Create session returns sessionId | UT-4, UT-5 | SIT-4 step 2 |
| AC-6 | List sessions returns created session | UT-8 | SIT-4 step 3 |
| AC-7 | Write file to sandbox | UT-15, UT-16 | SIT-4 step 4 |
| AC-8 | Read file from sandbox | UT-13, UT-14 | SIT-4 step 5 |
| AC-9 | Run command in sandbox | UT-17, UT-18 | SIT-4 step 6 |
| AC-10 | Delete session | UT-9 | SIT-4 step 7 |
| AC-11 | No existing files modified | — | `git diff --stat HEAD` |
| AC-12 | CI passes | All | All |

## 5. Testing Report

Results will be recorded in `testing-report.md` after execution.
