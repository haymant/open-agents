import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { nanoid } from "nanoid";
import { tool, ToolLoopAgent, stepCountIs } from "ai";
import { gateway } from "@open-agents/agent";
import { connectSandbox, type SandboxState } from "@open-agents/sandbox";
import {
  connectCoolify,
  type CoolifyState,
} from "@open-agents/sandbox-coolify";
import {
  createHandlers,
  toolDefinitions,
  type SessionStore,
  type SandboxOps,
} from "@open-agents/acp-mcp";
import {
  createSessionWithInitialChat,
  getSessionById,
  getSessionsByUserId,
  updateSession,
  createChatMessageIfNotExists,
  getChatsBySessionId,
} from "@/lib/db/sessions";
import {
  provisionCoolifyWorkspace,
  deprovisionCoolifyWorkspace,
} from "@/lib/sandbox/coolify-workspace";

export const runtime = "nodejs";
export const maxDuration = 120;

// ── CORS ────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Expose-Headers": "Mcp-Session-Id",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

// ── Auth ────────────────────────────────────────────────

const ACP_MCP_TOKEN = process.env.ACP_MCP_TOKEN;

function checkAuth(req: NextRequest): boolean {
  const auth = req.headers.get("authorization");
  if (!auth || !ACP_MCP_TOKEN) return false;
  return auth === `Bearer ${ACP_MCP_TOKEN}`;
}

// ── DB-backed session store ────────────────────────────
// Sessions created via the bridge use the first available DB user or the
// ACP_MCP_USER_ID env var. Sessions are written to the real sessions table,
// making them visible in the chat UI alongside user-created sessions.

let _bridgeUserId: string | null | undefined;

async function getBridgeUserId(): Promise<string | null> {
  if (_bridgeUserId !== undefined) return _bridgeUserId;

  // 1. Try configured env var
  if (process.env.ACP_MCP_USER_ID) {
    _bridgeUserId = process.env.ACP_MCP_USER_ID;
    return _bridgeUserId;
  }

  // 2. Try any user from the DB (fallback for SIT / local dev)
  try {
    const { db } = await import("@/lib/db/client");
    const { users } = await import("@/lib/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.select({ id: users.id }).from(users).limit(1);
    if (row[0]?.id) {
      _bridgeUserId = row[0].id;
      console.warn(
        `[acpmcp] No ACP_MCP_USER_ID set; using first DB user: ${_bridgeUserId}`,
      );
    }
  } catch {
    _bridgeUserId = null;
  }

  if (!_bridgeUserId) {
    console.warn(
      "[acpmcp] No user available for bridge session creation. Set ACP_MCP_USER_ID.",
    );
    _bridgeUserId = null;
  }
  return _bridgeUserId;
}

const dbStore: SessionStore = {
  async create(params) {
    const userId = await getBridgeUserId();
    if (!userId) {
      throw new Error(
        "No user configured for bridge. Set ACP_MCP_USER_ID env var.",
      );
    }

    const sessionId = nanoid();
    const sandboxName = `sandbox-${sessionId}`;
    const isCoolify = params.sandboxType?.startsWith("coolify:");

    // ── Coolify path ───────────────────────────────────
    if (isCoolify) {
      const connectorId =
        params.sandboxType!.replace("coolify:", "") || "default";

      const initialSandboxState: CoolifyState = {
        type: "coolify",
        connectorConfigId: connectorId,
        sandboxName,
        sandboxId: sessionId,
      };

      await createSessionWithInitialChat({
        session: {
          id: sessionId,
          userId,
          title: "ACP Bridge Session (Coolify)",
          status: "running",
          sandboxState: initialSandboxState as unknown as SandboxState,
          isNewBranch: false,
          globalSkillRefs: [],
        },
        initialChat: {
          id: nanoid(),
          title: "Initial Chat",
          modelId: "gpt-4o",
        },
      });

      // Provision the Coolify workspace
      let sandboxState: CoolifyState;
      try {
        const result = await provisionCoolifyWorkspace({
          connectorId,
          sessionId,
          repoUrl: params.repoUrl,
          branch: params.branch,
        });
        sandboxState = result.state;
      } catch (error) {
        console.error("[acpmcp] Coolify provisioning failed:", error);
        // Keep initial state so the session exists but sandbox is unavailable
        sandboxState = initialSandboxState;
      }

      await updateSession(sessionId, {
        sandboxState: sandboxState as unknown as SandboxState,
        lifecycleState: "active",
        lifecycleError: null,
      });

      // Cache for future sandboxOps calls
      cacheSandboxState(
        sandboxState.sandboxName ?? sandboxName,
        sandboxState as Record<string, unknown>,
      );

      return {
        sessionId,
        sandboxName: sandboxState.sandboxName ?? sandboxName,
        cwd: "/workspace",
      };
    }

    // ── Vercel path (default) ──────────────────────────
    const initialSandboxState = { type: "vercel" as const, sandboxName };

    await createSessionWithInitialChat({
      session: {
        id: sessionId,
        userId,
        title: "ACP Bridge Session",
        status: "running",
        sandboxState: initialSandboxState,
        isNewBranch: false,
        globalSkillRefs: [],
      },
      initialChat: {
        id: nanoid(),
        title: "Initial Chat",
        modelId: "gpt-4o",
      },
    });

    // Provision the sandbox directly (same as provisionSessionSandbox does internally)
    let sandboxState: {
      type: "vercel";
      sandboxName: string;
      expiresAt?: number;
    };
    try {
      const sandbox = await connectSandbox({
        state: { type: "vercel", sandboxName },
        options: {
          timeout: 300_000,
          vcpus: 2,
          persistent: true,
          createIfMissing: true,
        },
      });
      const rawState = sandbox.getState?.() as
        | { sandboxName?: string; expiresAt?: number }
        | undefined;
      sandboxState = {
        type: "vercel",
        sandboxName: rawState?.sandboxName ?? sandboxName,
        ...(rawState?.expiresAt ? { expiresAt: rawState.expiresAt } : {}),
      };
      await sandbox.stop().catch(() => {});
    } catch {
      // Sandbox API may not be available (local dev). Keep the initial state
      // so file/terminal ops still work (they create sandboxes on-the-fly).
      sandboxState = { type: "vercel", sandboxName };
    }

    // Update session with the real sandbox state
    await updateSession(sessionId, {
      sandboxState,
      lifecycleState: "active",
      lifecycleError: null,
    });

    return {
      sessionId,
      sandboxName: sandboxState.sandboxName,
      cwd: "/vercel/sandbox",
    };
  },

  async get(sessionId) {
    const record = await getSessionById(sessionId);
    if (!record) return undefined;
    const sandboxState = record.sandboxState as
      | {
          type?: string;
          sandboxName?: string;
          coolifyPreviewUrls?: Record<string, string>;
        }
      | null
      | undefined;
    const isCoolify = sandboxState?.type === "coolify";
    return {
      sandboxName: sandboxState?.sandboxName ?? `sandbox-${sessionId}`,
      cwd: isCoolify ? "/workspace" : "/vercel/sandbox",
      mode: record.branch ?? undefined,
      sandboxType: sandboxState?.type,
    };
  },

  async list() {
    const userId = await getBridgeUserId();
    if (!userId) return [];
    const records = await getSessionsByUserId(userId);
    return records.map((r) => ({ sessionId: r.id }));
  },

  async delete(sessionId) {
    // Deprovision Coolify apps if applicable
    try {
      const record = await getSessionById(sessionId);
      if (record) {
        const sandboxState = record.sandboxState as
          | CoolifyState
          | null
          | undefined;
        if (
          sandboxState?.type === "coolify" &&
          sandboxState.coolifyApplicationId
        ) {
          await deprovisionCoolifyWorkspace(
            sandboxState.connectorConfigId ?? "default",
            sandboxState.coolifyApplicationId,
          );
        }
      }
    } catch (error) {
      console.warn(
        `[acpmcp] Failed to deprovision Coolify app for session ${sessionId}:`,
        error,
      );
    }

    await updateSession(sessionId, { status: "archived" });
  },

  async update(sessionId, data) {
    if (data.mode) {
      await updateSession(sessionId, { branch: data.mode });
    }
  },

  async createMessage(sessionId, userText, assistantText) {
    const chats = await getChatsBySessionId(sessionId);
    const chatId = chats[0]?.id;
    if (!chatId) return;

    // Match WebAgentUIMessage format: parts column stores the full message envelope
    await createChatMessageIfNotExists({
      id: nanoid(),
      chatId,
      role: "user",
      parts: {
        id: nanoid(),
        role: "user",
        parts: [{ type: "text", text: userText }],
      },
    });

    await createChatMessageIfNotExists({
      id: nanoid(),
      chatId,
      role: "assistant",
      parts: {
        id: nanoid(),
        role: "assistant",
        parts: [{ type: "text", text: assistantText }],
      },
    });
  },
};

// ── Sandbox operations ──────────────────────────────────
// Maintains a cache of sandboxName → sandbox state for Coolify sessions.
// This avoids the need to query the DB on every file/exec operation.

const sandboxStateCache = new Map<
  string,
  { type: string; state: CoolifyState }
>();

function cacheSandboxState(
  sandboxName: string,
  state: Record<string, unknown>,
) {
  const s = state as { type?: string };
  if (s.type === "coolify") {
    sandboxStateCache.set(sandboxName, {
      type: "coolify",
      state: state as CoolifyState,
    });
  }
}

async function getSandboxForSession(
  sandboxName: string,
): Promise<{ type: string; state?: CoolifyState }> {
  const cached = sandboxStateCache.get(sandboxName);
  if (cached) return cached;

  // Fallback: try DB lookup for existing sessions
  try {
    const { db } = await import("@/lib/db/client");
    const { sessions } = await import("@/lib/db/schema");
    const rows = await db
      .select({ sandboxState: sessions.sandboxState })
      .from(sessions)
      .limit(200);

    for (const row of rows) {
      const state = row.sandboxState as {
        sandboxName?: string;
        type?: string;
      } | null;
      if (state?.sandboxName === sandboxName) {
        if (state.type === "coolify") {
          sandboxStateCache.set(sandboxName, {
            type: "coolify",
            state: state as CoolifyState,
          });
          return { type: "coolify", state: state as CoolifyState };
        }
        return { type: "vercel" };
      }
    }
  } catch {
    // DB unavailable — fall through
  }

  return { type: "vercel" };
}

const sandboxOps: SandboxOps = {
  async readFile(sandboxName: string, uri: string) {
    const resolved = await getSandboxForSession(sandboxName);
    if (resolved.type === "coolify" && resolved.state) {
      const sandbox = await connectCoolify(resolved.state);
      try {
        return await sandbox.readFile(uri, "utf-8");
      } finally {
        await sandbox.stop().catch(() => {});
      }
    }
    const sandbox = await connectSandbox({ type: "vercel", sandboxName });
    try {
      return await sandbox.readFile(uri, "utf-8");
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },
  async writeFile(sandboxName: string, uri: string, content: string) {
    const resolved = await getSandboxForSession(sandboxName);
    if (resolved.type === "coolify" && resolved.state) {
      const sandbox = await connectCoolify(resolved.state);
      try {
        await sandbox.writeFile(uri, content, "utf-8");
      } finally {
        await sandbox.stop().catch(() => {});
      }
      return;
    }
    const sandbox = await connectSandbox({ type: "vercel", sandboxName });
    try {
      await sandbox.writeFile(uri, content, "utf-8");
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },
  async runCommand(
    sandboxName: string,
    command: string,
    args?: string[],
    cwd?: string,
  ) {
    const resolved = await getSandboxForSession(sandboxName);
    if (resolved.type === "coolify" && resolved.state) {
      const sandbox = await connectCoolify(resolved.state);
      try {
        const cmd = args?.length ? `${command} ${args.join(" ")}` : command;
        const result = await sandbox.exec(
          cmd,
          cwd ?? sandbox.workingDirectory,
          120_000,
        );
        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode ?? 0,
        };
      } finally {
        await sandbox.stop().catch(() => {});
      }
    }
    const sandbox = await connectSandbox({ type: "vercel", sandboxName });
    try {
      const cmd = args?.length ? `${command} ${args.join(" ")}` : command;
      const result = await sandbox.exec(
        cmd,
        cwd ?? sandbox.workingDirectory,
        120_000,
      );
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode ?? 0,
      };
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },

  async prompt(
    sessionId: string,
    userText: string,
    cwd: string,
  ): Promise<string> {
    const record = await dbStore.get(sessionId);
    const sandboxName = record?.sandboxName;
    if (!sandboxName) return "Session not found";

    const resolved = await getSandboxForSession(sandboxName);

    // Sandbox connection — mirrors packages/agent/tools/utils.ts getSandbox()
    async function connectSandboxForTools(): Promise<
      | Awaited<ReturnType<typeof connectCoolify>>
      | Awaited<ReturnType<typeof connectSandbox>>
    > {
      if (resolved.type === "coolify" && resolved.state) {
        return connectCoolify(resolved.state);
      }
      return connectSandbox({ type: "vercel", sandboxName });
    }

    try {
      const model = gateway("deepseek/deepseek-v4-flash");

      const agent = new ToolLoopAgent({
        model,
        instructions:
          "You are an AI assistant with access to a workspace sandbox at /workspace. " +
          "Use tools to read, write, and find files. Always produce a final answer.",
        stopWhen: stepCountIs(10),
        tools: {
          write_file: tool({
            description: "Write content to a file in the workspace.",
            inputSchema: z.object({
              filePath: z
                .string()
                .describe("File path, e.g. /workspace/README.md"),
              content: z.string().describe("Content to write"),
            }),
            execute: async ({ filePath, content }) => {
              const fp = filePath.startsWith("/")
                ? filePath
                : `${cwd}/${filePath}`;
              const s = await connectSandboxForTools();
              try {
                await s.writeFile(fp, content, "utf-8");
                return `wrote ${fp}`;
              } finally {
                await s.stop().catch(() => {});
              }
            },
          }),
          read_file: tool({
            description: "Read a file from the workspace.",
            inputSchema: z.object({
              filePath: z
                .string()
                .describe("File path, e.g. /workspace/README.md"),
            }),
            execute: async ({ filePath }) => {
              const fp = filePath.startsWith("/")
                ? filePath
                : `${cwd}/${filePath}`;
              const s = await connectSandboxForTools();
              try {
                return await s.readFile(fp, "utf-8");
              } finally {
                await s.stop().catch(() => {});
              }
            },
          }),
          bash: tool({
            description: "Run a shell command in the workspace.",
            inputSchema: z.object({
              command: z.string().describe("Shell command"),
            }),
            execute: async ({ command }) => {
              const s = await connectSandboxForTools();
              try {
                const r = await s.exec(command, cwd, 120_000);
                return `exit:${r.exitCode}\nstdout:${r.stdout}\nstderr:${r.stderr}`;
              } finally {
                await s.stop().catch(() => {});
              }
            },
          }),
          glob: tool({
            description: "Find files matching a glob pattern.",
            inputSchema: z.object({
              pattern: z.string().describe("Glob pattern, e.g. **/*.md"),
            }),
            execute: async ({ pattern }) => {
              const findCmd = `find ${cwd} -name "${pattern}" -type f 2>/dev/null || echo ""`;
              const s = await connectSandboxForTools();
              try {
                const r = await s.exec(findCmd, cwd, 10_000);
                return r.stdout.trim() || "(no matches)";
              } finally {
                await s.stop().catch(() => {});
              }
            },
          }),
        },
      });

      const result = await agent.stream({
        messages: [{ role: "user" as const, content: userText }],
      });

      let text = "";
      for await (const part of result.fullStream) {
        const p = part as { type: string; textDelta?: string };
        if (p.type === "text-delta") text += p.textDelta ?? "";
      }

      if (!text) text = (result as unknown as { text?: string }).text ?? "";
      if (!text) text = "(no text in response)";

      return text;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[acpmcp] LLM prompt failed:", msg);
      return `LLM error: ${msg}`;
    }
  },
};

const handlers = createHandlers(dbStore, sandboxOps);

// ── McpServer — holds all tool definitions, created once at module level ─

const mcpServer = new McpServer(
  { name: "@open-agents/acp-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// Register each ACP tool with the McpServer.
// We use a simple z.object({}) schema and pass raw args to the handler,
// since our bridge handlers do their own validation.
for (const [toolName, def] of Object.entries(toolDefinitions)) {
  const handler = (handlers as Record<string, Function>)[toolName];
  if (!handler) continue;

  // Build a zod schema from the inputSchema properties
  const shape: Record<string, z.ZodTypeAny> = {};
  const requiredFields = new Set<string>(def.inputSchema.required ?? []);
  if (def.inputSchema.properties) {
    for (const [key, prop] of Object.entries(
      def.inputSchema.properties as Record<string, any>,
    )) {
      let zodType: z.ZodTypeAny;
      switch (prop.type) {
        case "string":
          zodType = z.string();
          break;
        case "number":
          zodType = z.number();
          break;
        case "boolean":
          zodType = z.boolean();
          break;
        case "array":
          zodType = z.array(z.any());
          break;
        default:
          zodType = z.any();
          break;
      }
      if (!requiredFields.has(key)) {
        zodType = zodType.optional();
      }
      shape[key] = zodType.describe(prop.description ?? "");
    }
  }

  mcpServer.tool(
    def.name,
    def.description,
    shape,
    async (args: Record<string, unknown>) => {
      const content = await handler(args);
      return { content };
    },
  );
}

// ── Route handlers — create fresh transport per request ──

async function handleMcpRequest(req: NextRequest): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcpServer.connect(transport);
  try {
    const response = await transport.handleRequest(req);
    // Merge CORS headers into the transport's response
    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      mergedHeaders.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: mergedHeaders,
    });
  } finally {
    await mcpServer.close();
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Unauthorized" },
      },
      { status: 401, headers: CORS_HEADERS },
    );
  }

  return await handleMcpRequest(req);
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json(
      { error: "Unauthorized" },
      { status: 401, headers: CORS_HEADERS },
    );
  }
  return await handleMcpRequest(req);
}
