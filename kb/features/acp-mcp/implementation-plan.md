---
title: "ACP-MCP Bridge"
feature_id: "acp-mcp"
artifact: "implementation-plan"
status: "draft"
version: "1"
owner_agent: "Developer"
parent_feature: "acp-mcp"
last_updated: "2026-07-10"
---

# ACP-MCP Bridge — Implementation Plan

## Phase 1: Package Scaffold

Create `packages/acp-mcp/` with minimal package.json, tsconfig, and index.ts.

**Files:**
- `packages/acp-mcp/package.json` — name `@open-agents/acp-mcp`, deps on `@agentclientprotocol/sdk`, `@open-agents/sandbox`, `nanoid`
- `packages/acp-mcp/tsconfig.json` — extends `@open-agents/tsconfig/base.json`
- `packages/acp-mcp/index.ts` — re-export bridge exports

**Dependencies to install:**
```bash
pnpm --filter @open-agents/acp-mcp add @agentclientprotocol/sdk nanoid
```

**Verification:** `pnpm --filter @open-agents/acp-mcp typecheck` passes.

## Phase 2: Bridge Core

Create `packages/acp-mcp/bridge.ts` containing:

1. **`toolDefinitions`** — object mapping each ACP-derived tool name to its MCP tool definition (`name`, `description`, `inputSchema`). All ~35 tools from the mapping table in `design.md`.
2. **Types** — `SessionStore`, `SandboxOps`, `ToolContent` interfaces
3. **`createHandlers(store, sandbox)`** — factory returning an object with one async method per tool. Each method accepts `Record<string, unknown>` and returns `Promise<ToolContent[]>`.

Implementation pattern for each handler:

```typescript
async acp_<method>(params: Record<string, unknown>): Promise<ToolContent[]> {
  try {
    // 1. Validate params
    // 2. Call store or sandbox
    // 3. Return JSON response
    return [{ type: "text", text: JSON.stringify(response) }];
  } catch (err) {
    return [{ type: "text", text: JSON.stringify({ error: err.message }) }];
  }
}
```

**Key implementation notes:**

- **Session methods** (new, load, list, delete, fork, resume, close, setMode, setConfigOption): Operate on the `SessionStore` interface. Each creates/reads/updates/deletes entries in the store.
- **File methods** (readTextFile, writeTextFile): Call `sandboxOps.readFile/writeFile`. Strip `file://` prefix from URIs.
- **Terminal/command** (create, output, release, waitForExit, kill): `terminal.create` calls `sandboxOps.runCommand()` and returns `{ terminalId, initialOutput }`. Other terminal methods are stubs for v1.
- **Conversation** (prompt, cancel): `session.prompt` calls `sandboxOps.runCommand()` with the message text as a command echo. Future iteration will integrate the full agent loop.
- **Document events** (didOpen, didChange, etc.): Stubs returning `{}`.
- **NES methods** (start, suggest, accept, reject, close): Stubs returning `{}`.
- **Elicitation** (create, complete): Stubs for v1.
- **Auth** (initialize, authenticate, logout): `initialize` returns static capabilities. `authenticate` returns `{ authenticated: true }` (HTTP Bearer auth handles real auth). `logout` is a no-op.
- **Providers** (list, set, disable): `list` returns a static providers array. `set` and `disable` are no-ops.
- **Client ops** (requestPermission, sessionUpdate): `requestPermission` auto-accepts (returns `{ outcome: { kind: "approved" } }`).
- **Protocol control** (cancelRequest): No-op.

**Verification:**
- `pnpm --filter @open-agents/acp-mcp typecheck` passes
- Unit tests pass (Phase 4)

## Phase 3: API Route

Create `apps/web/app/api/acpmcp/route.ts`:

1. **Auth guard**: Check `Authorization: Bearer <token>` against `process.env.ACP_MCP_TOKEN`. Return 401 JSON-RPC error on mismatch.
2. **JSON-RPC dispatcher**: Parse request body, route `tools/list` → return tool definitions, route `tools/call` → dispatch to handler by tool name.
3. **Instantiate dependencies**: Create in-memory `Map`-based `SessionStore`. Create `SandboxOps` backed by `connectSandbox()`.

**Auth implementation:**

```typescript
function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth || !process.env.ACP_MCP_TOKEN) return false;
  return auth === `Bearer ${process.env.ACP_MCP_TOKEN}`;
}
```

**SandboxOps implementation:**

```typescript
const sandboxOps: SandboxOps = {
  async readFile(sandboxName, uri) {
    const sandbox = await connectSandbox({ type: "vercel", sandboxName });
    try {
      return await sandbox.readFile(uri.replace(/^file:\/\//, ""));
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },
  // writeFile: similar
  // runCommand: similar, using sandbox.exec()
};
```

**Verification:** `pnpm --filter web typecheck` passes.

## Phase 4: Unit Tests

Create `packages/acp-mcp/bridge.test.ts`:

- Mock `SessionStore` and `SandboxOps` with `mock()` from `bun:test`
- Test all handlers from the UT table in `testing-plan.md`
- Use `describe`/`test` blocks grouped by ACP method category

**Run:**
```bash
bun test packages/acp-mcp/bridge.test.ts
```

## Phase 5: SIT Script

Create `scripts/acp-mcp-sit.sh`:

- Source `apps/web/.env` to get `ACP_MCP_TOKEN`
- Run through SIT scenarios from `testing-plan.md`
- Use `jq` for JSON parsing and assertions
- Exit with non-zero code on assertion failure

**Verification:**
```bash
bash scripts/acp-mcp-sit.sh
```

## Phase 6: CI Integration

Add the SIT script to CI if desired (not required for initial release since it requires a running dev server).

Update `package.json` scripts if needed.

---

## Implementation Order

```
Phase 1: Package scaffold
    ↓
Phase 2: Bridge core (bridge.ts)
    ↓
Phase 3: API route (route.ts)
    ↓
Phase 4: Unit tests
    ↓
Phase 5: SIT script
    ↓
Phase 6: CI (optional)
```

Each phase is independent and can be verified before moving to the next.
