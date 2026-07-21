import { NextRequest, NextResponse } from "next/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { ToolLoopAgent, stepCountIs } from "ai";
import { gateway, openAgent } from "@open-agents/agent";
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
  getSessionsByParentId,
  updateSession,
  createChatMessageIfNotExists,
  getChatsBySessionId,
} from "@/lib/db/sessions";
import {
  provisionCoolifyWorkspace,
  deprovisionCoolifyWorkspace,
} from "@/lib/sandbox/coolify-workspace";
import {
  startCoolifyApplication,
  bulkUpdateCoolifyApplicationEnvs,
  getCoolifyApplicationEnvs,
} from "@/lib/sandbox/coolify-api";
import { getCoolifyConnectorConfig } from "@/lib/sandbox/coolify-connector";
import { createSandboxAgentTools } from "@/lib/sandbox/agent-tools";

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
          type: (params.type as "chat" | "project" | "child") ?? "chat",
          parentSessionId: params.parentSessionId as string | undefined,
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
        const isProject = params.type === "project";
        const result = await provisionCoolifyWorkspace({
          connectorId,
          sessionId,
          repoUrl: params.repoUrl,
          branch: params.branch,
          dockerImage: isProject ? "haymant/oadev" : undefined,
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
        sandboxMetadata: sandboxState.coolifyPreviewUrls
          ? { coolifyPreviewUrls: sandboxState.coolifyPreviewUrls }
          : undefined,
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
        type: (params.type as "chat" | "project" | "child") ?? "chat",
        parentSessionId: params.parentSessionId as string | undefined,
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
      sandboxMetadata: sandboxState?.coolifyPreviewUrls
        ? { coolifyPreviewUrls: sandboxState.coolifyPreviewUrls }
        : undefined,
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

  async resume(sessionId) {
    try {
      const record = await getSessionById(sessionId);
      if (!record) return;
      const sandboxState = record.sandboxState as
        | CoolifyState
        | null
        | undefined;
      if (
        sandboxState?.type === "coolify" &&
        sandboxState.coolifyApplicationId &&
        sandboxState.connectorConfigId
      ) {
        const config = getCoolifyConnectorConfig(
          sandboxState.connectorConfigId,
        );
        if (!config) {
          console.warn(
            `[acpmcp] Connector "${sandboxState.connectorConfigId}" not found; cannot resume`,
          );
          return;
        }
        const apiConfig = {
          apiToken: config.apiToken,
          baseUrl: config.baseUrl,
        };
        // Fire-and-forget: start the app and return immediately.
        // The caller (e.g. SIT polling loop) waits for the health endpoint.
        startCoolifyApplication(
          apiConfig,
          sandboxState.coolifyApplicationId,
        ).catch((err) =>
          console.warn(
            `[acpmcp] Failed to start Coolify app ${sandboxState.coolifyApplicationId}:`,
            err,
          ),
        );
        await updateSession(sessionId, { status: "running" });
        console.log(
          `[acpmcp] Resuming Coolify app ${sandboxState.coolifyApplicationId} for session ${sessionId}`,
        );
      }
    } catch (error) {
      console.warn(
        `[acpmcp] Failed to resume Coolify app for session ${sessionId}:`,
        error,
      );
    }
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

// Track dev server process IDs for each session (keyed by sessionId)
const devServerProcesses = new Map<string, string>();

// Active LLM model — defaults to deepseek/deepseek-v4-flash, changeable via acp_providers_set
let activeModel = "deepseek/deepseek-v4-flash";

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

  // Fallback: try DB lookup
  try {
    const { db } = await import("@/lib/db/client");
    const { sessions } = await import("@/lib/db/schema");

    // Coolify sandboxNames follow "coolify-<sessionId>" pattern
    const sessionIdFromName = sandboxName.startsWith("coolify-")
      ? sandboxName.slice(8)
      : null;

    let state: { sandboxName?: string; type?: string } | null | undefined;

    if (sessionIdFromName) {
      const row = await db
        .select({ sandboxState: sessions.sandboxState })
        .from(sessions)
        .where(eq(sessions.id, sessionIdFromName))
        .limit(1);
      state = row[0]?.sandboxState as typeof state;
    }

    if (state?.type === "coolify") {
      sandboxStateCache.set(sandboxName, {
        type: "coolify",
        state: state as CoolifyState,
      });
      return { type: "coolify", state: state as CoolifyState };
    }

    // Broader fallback: scan recent sessions for matching sandboxName
    const rows = await db
      .select({ sandboxState: sessions.sandboxState })
      .from(sessions)
      .limit(200);

    for (const row of rows) {
      const s = row.sandboxState as {
        sandboxName?: string;
        type?: string;
      } | null;
      if (s?.sandboxName === sandboxName) {
        if (s.type === "coolify") {
          sandboxStateCache.set(sandboxName, {
            type: "coolify",
            state: s as CoolifyState,
          });
          return { type: "coolify", state: s as CoolifyState };
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
    messages?: Array<{
      role: string;
      content: Array<Record<string, unknown>>;
    }>,
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
      const model = gateway(activeModel);

      // Extract the user's request text to embed in instructions
      const firstUserMsg = messages?.find((m) => m.role === "user");
      const firstUserText =
        (firstUserMsg?.content?.[0] as { text?: string } | undefined)?.text ??
        userText ??
        "";

      const agent = new ToolLoopAgent({
        model,
        instructions:
          "You are an AI assistant with access to a workspace sandbox at /workspace.\n\n" +
          "## YOUR TASK\n" +
          firstUserText +
          "\n\n" +
          "Build EXACTLY what is written above. Do not add features not requested. " +
          "Use tools to read, write, and find files. Always produce a final answer.",
        stopWhen: stepCountIs(10),
        tools: createSandboxAgentTools(cwd, async () => {
          const s = await connectSandboxForTools();
          return { sandbox: s, stop: () => s.stop() };
        }),
      });

      // Build conversation history — only include messages with actual text.
      // Messages can use `content` (MCP) or `parts` (WebAgentUIMessage) format.
      const conversationMessages = messages
        ? (() => {
            const result: import("ai").ModelMessage[] = [];
            for (const m of messages) {
              const rawContent =
                m.content ?? (m as Record<string, unknown>).parts;
              let text = "";
              if (typeof rawContent === "string") {
                text = rawContent;
              } else if (Array.isArray(rawContent)) {
                for (const block of rawContent) {
                  const b = block as Record<string, unknown>;
                  if (
                    b?.type === "text" &&
                    typeof b.text === "string" &&
                    b.text.trim()
                  ) {
                    text = b.text;
                    break;
                  }
                }
              }
              if (text.trim().length > 0) {
                result.push({
                  role: m.role as "user" | "assistant",
                  content: text,
                });
              }
            }
            return result;
          })()
        : [{ role: "user" as const, content: userText }];

      const result = await agent.stream({
        messages: conversationMessages,
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

  async setSecrets(
    sessionId: string,
    envVars: Record<string, string>,
  ): Promise<{ stored: number }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState?.coolifyApplicationId || !sandboxState.connectorConfigId)
      throw new Error("No Coolify app for this session");

    const config = getCoolifyConnectorConfig(sandboxState.connectorConfigId);
    if (!config) throw new Error("Connector config not found");

    const apiConfig = {
      apiToken: config.apiToken,
      baseUrl: config.baseUrl,
    };

    let stored = 0;
    const envPayload = Object.entries(envVars).map(([key, value]) => ({
      key,
      value,
      isLiteral: true,
      isRuntime: true,
      isBuildtime: false,
      isMultiline: false,
      isPreview: false,
    }));
    await bulkUpdateCoolifyApplicationEnvs(
      apiConfig,
      sandboxState.coolifyApplicationId,
      envPayload,
    );
    stored = envPayload.length;
    return { stored };
  },

  async listSecrets(sessionId: string): Promise<Array<{ name: string }>> {
    const record = await getSessionById(sessionId);
    if (!record) return [];
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState?.coolifyApplicationId || !sandboxState.connectorConfigId)
      return [];

    const config = getCoolifyConnectorConfig(sandboxState.connectorConfigId);
    if (!config) return [];

    const apiConfig = {
      apiToken: config.apiToken,
      baseUrl: config.baseUrl,
    };

    const envs = await getCoolifyApplicationEnvs(
      apiConfig,
      sandboxState.coolifyApplicationId,
    );
    return envs.map((e) => ({ name: e.key }));
  },

  async deleteSecret(sessionId: string, name: string): Promise<void> {
    const record = await getSessionById(sessionId);
    if (!record) return;
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState?.coolifyApplicationId || !sandboxState.connectorConfigId)
      return;

    const config = getCoolifyConnectorConfig(sandboxState.connectorConfigId);
    if (!config) return;

    const apiConfig = {
      apiToken: config.apiToken,
      baseUrl: config.baseUrl,
    };

    // Use PATCH to set env var to empty string (effectively removes it)
    await bulkUpdateCoolifyApplicationEnvs(
      apiConfig,
      sandboxState.coolifyApplicationId,
      [
        {
          key: name,
          value: "",
          isLiteral: true,
          isRuntime: true,
          isBuildtime: false,
          isMultiline: false,
          isPreview: false,
        },
      ],
    );
    console.log(`[acpmcp] Cleared env var ${name} for session ${sessionId}`);
  },

  async createRepo(
    repoName: string,
    org?: string,
    isPrivate?: boolean,
    branch?: string,
  ): Promise<{ repoUrl: string; cloneUrl: string }> {
    const userId = await getBridgeUserId();
    if (!userId) throw new Error("No user configured for bridge");
    const { getUserGitHubToken } = await import("@/lib/github/token");
    const token = await getUserGitHubToken(userId);
    if (!token) {
      throw new Error(
        "GitHub account not connected. User must sign in with GitHub first.",
      );
    }

    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });

    // Check if the requested owner is the authenticated user or an org
    const { data: authenticatedUser } =
      await octokit.rest.users.getAuthenticated();
    const isUserOwner =
      !org || authenticatedUser.login.toLowerCase() === org.toLowerCase();

    // Create repo WITHOUT auto_init so we control the initial branch name
    const result = isUserOwner
      ? await octokit.rest.repos.createForAuthenticatedUser({
          name: repoName,
          private: isPrivate ?? true,
          auto_init: false,
        })
      : await octokit.rest.repos.createInOrg({
          org: org!,
          name: repoName,
          private: isPrivate ?? true,
          auto_init: false,
        });

    const owner = result.data.owner.login;
    const repo = result.data.name;
    const targetBranch = branch ?? "main";

    // Create an initial commit on the target branch so the repo has content
    // and the default branch matches what the session will use.
    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "Initial commit",
      content: Buffer.from(`# ${repoName}\n`).toString("base64"),
      branch: targetBranch,
    });

    // Set the default branch so GitHub's HEAD matches
    await octokit.rest.repos.update({
      owner,
      repo,
      default_branch: targetBranch,
      name: repo,
    });

    return {
      repoUrl: result.data.html_url,
      cloneUrl: `${result.data.html_url}.git`,
    };
  },

  async attachRepo(
    sessionId: string,
    repoUrl: string,
    branch?: string,
  ): Promise<{ status: string; cwd: string }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState) throw new Error("No sandbox state for this session");

    // Parse owner/repo from URL: https://github.com/owner/repo or https://github.com/owner/repo.git
    const urlPath = repoUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const parts = urlPath.split("/");
    const repoOwner = parts.length >= 4 ? parts[parts.length - 2] : undefined;
    const repoName = parts.length >= 4 ? parts[parts.length - 1] : undefined;

    // Update sandboxState with source so CoolifySandbox.connect() clones the repo
    sandboxState.source = { repo: repoUrl, branch: branch ?? "main" };
    await updateSession(sessionId, {
      sandboxState: sandboxState as unknown as SandboxState,
      repoOwner: repoOwner ?? null,
      repoName: repoName ?? null,
      cloneUrl: repoUrl,
      branch: branch ?? "main",
    });
    return { status: "attached", cwd: "/workspace" };
  },

  async gitPush(
    sessionId: string,
    _message?: string,
  ): Promise<{
    success: boolean;
    branch?: string;
    pushedToNewBranch?: boolean;
  }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState) throw new Error("No sandbox state");

    const cloneUrl = (record as Record<string, unknown>).cloneUrl as
      | string
      | undefined;
    if (!cloneUrl)
      throw new Error(
        "No repo URL associated with this session. Use acp_github_attach_repo first.",
      );

    const userId = await getBridgeUserId();
    if (!userId) throw new Error("No user configured for bridge");
    const { getUserGitHubToken } = await import("@/lib/github/token");
    const token = await getUserGitHubToken(userId);
    if (!token) {
      throw new Error(
        "GitHub account not connected. User must sign in with GitHub first.",
      );
    }

    const authedUrl = cloneUrl.replace("https://", `https://oauth2:${token}@`);
    const branch =
      ((record as Record<string, unknown>).branch as string) ?? "main";

    if (sandboxState.type === "coolify") {
      const sandbox = await connectCoolify(sandboxState);
      try {
        const runCommands = (cmds: string[]) =>
          sandbox.exec(cmds.join(" && "), "/workspace", 60_000);

        // Step 1: setup remote, fetch, checkout, stage
        const setup = [
          `cd /workspace`,
          `git config user.name "ACP Bridge"`,
          `git config user.email "acp@open-agents.dev"`,
          `git remote remove origin 2>/dev/null; git remote add origin ${authedUrl}`,
          `git fetch origin ${branch}`,
          `git checkout -B ${branch}`,
          `git add -A`,
        ];
        const setupResult = await runCommands(setup);
        if (setupResult.exitCode !== 0) {
          throw new Error(
            `Git setup failed:\n${(setupResult.stderr || "") + (setupResult.stdout || "")}`,
          );
        }

        // Step 2: pull --rebase
        const pullResult = await sandbox.exec(
          `cd /workspace && git pull --rebase origin ${branch} 2>&1`,
          "/workspace",
          60_000,
        );
        const pullOutput =
          (pullResult.stderr || "") + (pullResult.stdout || "");

        if (pullResult.exitCode !== 0) {
          const hasConflict =
            pullOutput.includes("CONFLICT") ||
            pullOutput.includes("conflict") ||
            pullOutput.includes("unborn branch");

          // Fallback: abort rebase, reset current branch to FETCH_HEAD
          // (preserving working tree and staged changes), commit, then push
          // HEAD to a new remote branch.
          const pushFallback = async (reason: string) => {
            const timestamp = Date.now();
            const tempBranch = `acp-push-${timestamp}`;
            const fallbackCmds = [
              `cd /workspace`,
              `git rebase --abort 2>/dev/null || true`,
              `git fetch origin HEAD 2>/dev/null || true`,
              `git reset --soft FETCH_HEAD 2>/dev/null || true`,
              `git add -A`,
              `git diff --cached --quiet || git commit -m "acp: staged changes"`,
              `git push origin HEAD:refs/heads/${tempBranch} 2>&1`,
            ].join(" && ");

            const tempResult = await sandbox.exec(
              fallbackCmds,
              "/workspace",
              60_000,
            );
            if (tempResult.exitCode !== 0) {
              const tempOut =
                (tempResult.stderr || "") + (tempResult.stdout || "");
              throw new Error(
                `${reason} — fallback push to ${tempBranch} also failed:\n${tempOut.slice(0, 2000)}`,
              );
            }
            return {
              success: true,
              branch: tempBranch,
              pushedToNewBranch: true,
            };
          };

          if (hasConflict) {
            return pushFallback("Merge conflict or unborn branch");
          }

          // Not a conflict — real error
          console.warn(`[acpmcp] git pull --rebase failed:`, pullOutput);
          throw new Error(`Git pull failed:\n${pullOutput.slice(0, 2000)}`);
        }

        // Step 3: push (pull succeeded)
        const pushResult = await sandbox.exec(
          `cd /workspace && git push origin ${branch} 2>&1`,
          "/workspace",
          60_000,
        );
        const pushOutput =
          (pushResult.stderr || "") + (pushResult.stdout || "");
        if (pushResult.exitCode !== 0) {
          // Push rejected (diverged) — fallback to temp branch
          const hasRejected =
            pushOutput.includes("[rejected]") ||
            pushOutput.includes("non-fast-forward");
          if (hasRejected) {
            // Fallback: fetch origin, reset to FETCH_HEAD, commit, push HEAD
            // to a new remote branch.
            const timestamp = Date.now();
            const tempBranch = `acp-push-${timestamp}`;
            const tempResult = await sandbox.exec(
              [
                `cd /workspace`,
                `git fetch origin ${branch} 2>&1`,
                `git reset --soft FETCH_HEAD 2>/dev/null || true`,
                `git add -A`,
                `git diff --cached --quiet || git commit -m "acp: staged changes"`,
                `git push origin HEAD:refs/heads/${tempBranch} 2>&1`,
              ].join(" && "),
              "/workspace",
              60_000,
            );
            if (tempResult.exitCode !== 0) {
              const tempOut =
                (tempResult.stderr || "") + (tempResult.stdout || "");
              console.warn(
                `[acpmcp] fallback push to ${tempBranch} also failed:`,
                tempOut,
              );
              throw new Error(
                `Push rejected and fallback to ${tempBranch} failed:\n${tempOut.slice(0, 2000)}`,
              );
            }
            return {
              success: true,
              branch: tempBranch,
              pushedToNewBranch: true,
            };
          }
          console.warn(`[acpmcp] git push failed:`, pushOutput);
          throw new Error(`Git push failed:\n${pushOutput.slice(0, 2000)}`);
        }

        return { success: true, branch };
      } finally {
        await sandbox.stop().catch(() => {});
      }
    }
    throw new Error("Can only push from Coolify sandbox");
  },

  async createPr(
    sessionId: string,
    title?: string,
    base?: string,
    branch?: string,
  ): Promise<{ prUrl: string }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");

    const cloneUrl = (record as Record<string, unknown>).cloneUrl as
      | string
      | undefined;
    if (!cloneUrl)
      throw new Error("No repo URL. Use acp_github_attach_repo first.");

    // Use explicit branch if provided, otherwise fall back to session's stored branch
    const headBranch =
      branch ||
      ((record as Record<string, unknown>).branch as string | undefined);
    if (!headBranch)
      throw new Error("No branch specified and no branch on session record.");

    const userId = await getBridgeUserId();
    if (!userId) throw new Error("No user configured for bridge");
    const { getUserGitHubToken } = await import("@/lib/github/token");
    const token = await getUserGitHubToken(userId);
    if (!token) {
      throw new Error("GitHub account not connected.");
    }

    // Parse owner and repo from clone URL
    const path = cloneUrl.replace(/\.git$/, "").replace(/\/$/, "");
    const parts = path.split("/");
    const owner = parts[parts.length - 2];
    const repo = parts[parts.length - 1];
    if (!owner || !repo)
      throw new Error(`Could not parse owner/repo from ${cloneUrl}`);

    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });
    const baseBranch = base ?? "main";

    const response = await octokit.rest.pulls.create({
      owner,
      repo,
      title: title ?? `Changes from ${headBranch}`,
      body: "Auto-generated by ACP Bridge.",
      head: headBranch,
      base: baseBranch,
    });

    return { prUrl: response.data.html_url };
  },

  async startDevServer(
    sessionId: string,
    command?: string,
  ): Promise<{ previewUrl: string }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState) throw new Error("No sandbox state");

    const sandbox = await connectCoolify(sandboxState);
    try {
      const cmd = command ?? "npm run dev";
      const result = await sandbox.execDetached(cmd, "/workspace");
      // Track the dev server process so we can stop it later
      devServerProcesses.set(sessionId, result.commandId);
      const previewUrl = sandbox.domain(3000);
      return { previewUrl };
    } finally {
      // Don't stop the sandbox — the dev server must keep running
    }
  },

  async stopDevServer(sessionId: string): Promise<void> {
    const commandId = devServerProcesses.get(sessionId);
    if (!commandId) return;

    const record = await getSessionById(sessionId);
    if (!record) return;
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState) return;

    const sandbox = await connectCoolify(sandboxState);
    try {
      // Kill only the tracked process by PID — never use pkill -f (would kill fs.js)
      await sandbox.exec(
        `kill ${commandId} 2>/dev/null; true`,
        "/workspace",
        10_000,
      );
    } finally {
      await sandbox.stop().catch(() => {});
    }
    devServerProcesses.delete(sessionId);
  },

  async setActiveModel(
    provider: string,
    config?: Record<string, unknown>,
  ): Promise<{ provider: string; model: string }> {
    const modelId = (config?.model as string) ?? `${provider}/default`;
    activeModel = modelId;
    console.log(`[acpmcp] Active model set to: ${activeModel}`);
    return { provider, model: activeModel };
  },

  async getActiveModel(): Promise<{ provider: string; model: string }> {
    const parts = activeModel.split("/");
    return { provider: parts[0] ?? "unknown", model: activeModel };
  },

  async getAvailableModels(
    search?: string,
  ): Promise<Array<{ id: string; name: string; provider: string }>> {
    try {
      const { fetchAvailableLanguageModelsWithContext } =
        await import("@/lib/models-with-context");
      const models = await fetchAvailableLanguageModelsWithContext();
      return models.map((m) => {
        const parts = m.id.split("/");
        return {
          id: m.id,
          name: m.name ?? m.id,
          provider: parts[0] ?? "unknown",
        };
      });
    } catch {
      return [];
    }
  },

  async getPreviewUrl(sessionId: string, port?: number): Promise<string> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");
    const sandboxState = record.sandboxState as CoolifyState | null;
    if (!sandboxState) throw new Error("No sandbox state");

    const sandbox = await connectCoolify(sandboxState);
    try {
      const url = sandbox.domain(port ?? 3000);
      return url;
    } finally {
      await sandbox.stop().catch(() => {});
    }
  },

  async getSessionTree(sessionId: string): Promise<{
    session: Record<string, unknown>;
    children: Array<Record<string, unknown>>;
  }> {
    const record = await getSessionById(sessionId);
    if (!record) throw new Error("Session not found");

    const children = await getSessionsByParentId(sessionId);

    return {
      session: {
        id: record.id,
        title: record.title,
        status: record.status,
        type: record.type,
        createdAt: record.createdAt,
      },
      children: children.map((c) => ({
        id: c.id,
        title: c.title,
        status: c.status,
        type: c.type,
        createdAt: c.createdAt,
      })),
    };
  },

  async bulkSandboxAction(
    sessionId: string,
    action: string,
  ): Promise<{ affected: number }> {
    const children = await getSessionsByParentId(sessionId);
    let affected = 0;

    for (const child of children) {
      const sandboxState = child.sandboxState as
        | CoolifyState
        | null
        | undefined;
      if (!sandboxState?.coolifyApplicationId) continue;

      const config = sandboxState.connectorConfigId
        ? getCoolifyConnectorConfig(sandboxState.connectorConfigId)
        : undefined;
      const apiConfig = config
        ? { apiToken: config.apiToken, baseUrl: config.baseUrl }
        : undefined;

      switch (action) {
        case "pause":
          if (apiConfig) {
            try {
              const { stopCoolifyApplication } =
                await import("@/lib/sandbox/coolify-api");
              await stopCoolifyApplication(
                apiConfig,
                sandboxState.coolifyApplicationId,
              );
              await updateSession(child.id, { status: "archived" });
              affected++;
            } catch {
              // skip failed
            }
          }
          break;
        case "resume":
          if (apiConfig) {
            try {
              const { startCoolifyApplication } =
                await import("@/lib/sandbox/coolify-api");
              await startCoolifyApplication(
                apiConfig,
                sandboxState.coolifyApplicationId,
              );
              await updateSession(child.id, { status: "running" });
              affected++;
            } catch {
              // skip failed
            }
          }
          break;
        case "delete":
          try {
            if (apiConfig && sandboxState.coolifyApplicationId) {
              const { stopCoolifyApplication } =
                await import("@/lib/sandbox/coolify-api");
              await stopCoolifyApplication(
                apiConfig,
                sandboxState.coolifyApplicationId,
              ).catch(() => {});
            }
            await updateSession(child.id, { status: "archived" });
            affected++;
          } catch {
            // skip failed
          }
          break;
      }
    }

    // Also handle the parent session
    if (action === "delete" || action === "pause") {
      await updateSession(sessionId, { status: "archived" }).catch(() => {});
    } else if (action === "resume") {
      await updateSession(sessionId, { status: "running" }).catch(() => {});
    }

    return { affected };
  },

  async runAgentLoop(
    sessionId: string,
    messages: Array<Record<string, unknown>>,
    maxSteps?: number,
  ): Promise<{ messages: Array<Record<string, unknown>> }> {
    const record = await getSessionById(sessionId);
    if (!record)
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "Session not found" }],
          },
        ],
      };

    const sandboxState = record.sandboxState as CoolifyState | null;
    if (
      !sandboxState?.coolifyPreviewUrls?.health &&
      !sandboxState?.coolifyApplicationUrl
    ) {
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: "No sandbox state" }],
          },
        ],
      };
    }

    const sandbox = await connectCoolify(sandboxState);
    try {
      // Build AgentSandboxContext matching what the chat UI passes.
      // Embed the pre-connected Coolify sandbox in state._connectedSandbox
      // so connectSandbox() (called by getSandbox() in tools) returns it directly.
      const sandboxContext = {
        state: {
          type: "vercel" as const,
          sandboxName: sandboxState.sandboxName ?? "",
          _connectedSandbox: sandbox,
        },
        workingDirectory: "/workspace",
        environmentDetails: "Coolify sandbox",
      };

      // Map incoming MCP messages to SDK simple format.
      // Messages can use either `content` (standard MCP) or `parts`
      // (WebAgentUIMessage format) for their content blocks.
      // Only include messages with actual text content —
      // tool-call/tool-result blocks produce empty text and would be
      // rejected by Anthropic as "text content blocks must be non-empty".
      const conversationMessages: Array<{ role: string; content: string }> = [];
      for (const m of messages) {
        const rawContent = m.content ?? (m as Record<string, unknown>).parts;
        let text = "";
        if (typeof rawContent === "string") {
          text = rawContent;
        } else if (Array.isArray(rawContent)) {
          for (const block of rawContent) {
            const b = block as Record<string, unknown>;
            if (
              b?.type === "text" &&
              typeof b.text === "string" &&
              b.text.trim()
            ) {
              text = b.text;
              break;
            }
          }
        }
        if (text.trim().length > 0) {
          conversationMessages.push({
            role: (m.role as "user" | "assistant") ?? "user",
            content: text,
          });
        }
      }

      const result = await (openAgent.stream as any)({
        messages: conversationMessages,
        options: {
          sandbox: sandboxContext,
        },
        stopWhen: stepCountIs(maxSteps ?? 50),
      });

      // Collect full-stream messages including tool calls
      const allMessages: Array<Record<string, unknown>> = [];
      let currentRole = "";
      let currentParts: Array<Record<string, unknown>> = [];

      for await (const part of result.fullStream) {
        const p = part as {
          type: string;
          textDelta?: string;
          role?: string;
          args?: unknown;
          input?: unknown;
          output?: unknown;
          name?: string;
          toolName?: string;
          toolCallId?: string;
          state?: string;
          error?: unknown;
        };

        if (p.type === "text-delta") {
          // Accumulate text into current assistant message
          if (currentRole !== "assistant") {
            if (currentRole && currentParts.length > 0) {
              allMessages.push({ role: currentRole, content: currentParts });
            }
            currentRole = "assistant";
            currentParts = [];
          }
          const last = currentParts[currentParts.length - 1];
          if (last?.type === "text") {
            last.text += p.textDelta ?? "";
          } else {
            currentParts.push({ type: "text", text: p.textDelta ?? "" });
          }
        } else if (p.type === "tool-call") {
          // Flush previous text
          if (currentRole && currentParts.length > 0) {
            allMessages.push({ role: currentRole, content: currentParts });
            currentParts = [];
          }
          currentRole = "assistant";
          allMessages.push({
            role: "assistant",
            content: [
              {
                type: "tool-call",
                toolName: p.toolName ?? p.name ?? "unknown",
                args: p.input ?? p.args,
                toolCallId: p.toolCallId,
              },
            ],
          });
        } else if (p.type === "tool-result") {
          allMessages.push({
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolName: p.toolName ?? p.name ?? "unknown",
                toolCallId: p.toolCallId,
                result: p.output ?? p.args,
              },
            ],
          });
        } else if (p.type === "error") {
          allMessages.push({
            role: "system",
            content: [{ type: "text", text: `Error: ${p.error}` }],
          });
        }
      }

      // Flush remaining
      if (currentRole && currentParts.length > 0) {
        allMessages.push({ role: currentRole, content: currentParts });
      }

      return { messages: allMessages };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Agent error: ${msg}` }],
          },
        ],
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
