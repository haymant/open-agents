import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { nanoid } from "nanoid";
import { connectSandbox } from "@open-agents/sandbox";
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

    return { sessionId, sandboxName: sandboxState.sandboxName };
  },

  async get(sessionId) {
    const record = await getSessionById(sessionId);
    if (!record) return undefined;
    const sandboxState = record.sandboxState as
      | { type?: string; sandboxName?: string }
      | null
      | undefined;
    return {
      sandboxName: sandboxState?.sandboxName ?? `sandbox-${sessionId}`,
      cwd: "/vercel/sandbox",
      mode: record.branch ?? undefined,
    };
  },

  async list() {
    const userId = await getBridgeUserId();
    if (!userId) return [];
    const records = await getSessionsByUserId(userId);
    return records.map((r) => ({ sessionId: r.id }));
  },

  async delete(sessionId) {
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

    await createChatMessageIfNotExists({
      id: nanoid(),
      chatId,
      role: "user",
      parts: [{ type: "text", text: userText }],
    });

    await createChatMessageIfNotExists({
      id: nanoid(),
      chatId,
      role: "assistant",
      parts: [{ type: "text", text: assistantText }],
    });
  },
};

// ── Sandbox operations ──────────────────────────────────

const sandboxOps: SandboxOps = {
  async readFile(sandboxName: string, uri: string) {
    const sandbox = await connectSandbox({ type: "vercel", sandboxName });
    try {
      return await sandbox.readFile(uri, "utf-8");
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },
  async writeFile(sandboxName: string, uri: string, content: string) {
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
