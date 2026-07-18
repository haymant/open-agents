// ── Types ──────────────────────────────────────────────────────────

export type ToolContent = { type: string; text: string };

export interface SessionRecord {
  sandboxName: string;
  cwd: string;
  mode?: string;
  sandboxType?: string;
  configOptions?: Record<string, unknown>;
  sandboxMetadata?: Record<string, unknown>;
}

export interface SessionStore {
  create(params: {
    cwd?: string;
    sandboxType?: string;
    repoUrl?: string;
    branch?: string;
    type?: string;
    parentSessionId?: string;
  }): Promise<{
    sessionId: string;
    sandboxName: string;
    cwd: string;
    sandboxMetadata?: Record<string, unknown>;
  }>;
  get(sessionId: string): Promise<SessionRecord | undefined>;
  list(): Promise<Array<{ sessionId: string }>>;
  delete(sessionId: string): Promise<void>;
  /** Resume/restart a previously closed session's sandbox. */
  resume?(sessionId: string): Promise<void>;
  update(sessionId: string, data: Partial<SessionRecord>): Promise<void>;
  /** Persist a user+assistant message pair in the session's chat. */
  createMessage?(
    sessionId: string,
    userText: string,
    assistantText: string,
  ): Promise<void>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxOps {
  readFile(sandboxName: string, uri: string): Promise<string>;
  writeFile(sandboxName: string, uri: string, content: string): Promise<void>;
  runCommand(
    sandboxName: string,
    command: string,
    args?: string[],
    cwd?: string,
  ): Promise<ExecResult>;
  /** Send a prompt to the LLM agent. Returns the assistant's text response. */
  prompt?(sessionId: string, userText: string, cwd: string): Promise<string>;
  /** Set environment variables (secrets) on a session's sandbox. */
  setSecrets?(
    sessionId: string,
    envVars: Record<string, string>,
  ): Promise<{ stored: number }>;
  /** List environment variable names on a session's sandbox. */
  listSecrets?(sessionId: string): Promise<Array<{ name: string }>>;
  /** Delete an environment variable from a session's sandbox. */
  deleteSecret?(sessionId: string, name: string): Promise<void>;
  /** Create a new GitHub repo. */
  createRepo?(
    repoName: string,
    org?: string,
    isPrivate?: boolean,
    branch?: string,
  ): Promise<{ repoUrl: string; cloneUrl: string }>;
  /** Attach an existing GitHub repo to a session. */
  attachRepo?(
    sessionId: string,
    repoUrl: string,
    branch?: string,
  ): Promise<{ status: string; cwd: string }>;
  /** Stage, pull --rebase, and push changes. Falls back to a temp branch if push to original branch fails (conflict). */
  gitPush?(
    sessionId: string,
    message?: string,
  ): Promise<{
    success: boolean;
    branch?: string;
    pushedToNewBranch?: boolean;
  }>;
  /** Create a pull request from the session's branch (or an explicit branch). */
  createPr?(
    sessionId: string,
    title?: string,
    base?: string,
    branch?: string,
  ): Promise<{ prUrl: string }>;
  /** Start a dev server in the session sandbox and return its preview URL. */
  startDevServer?(
    sessionId: string,
    command?: string,
  ): Promise<{ previewUrl: string }>;
  /** Stop a running dev server in the session sandbox. */
  stopDevServer?(sessionId: string): Promise<void>;
  /** Get the preview URL for a session's sandbox at the given port. */
  getPreviewUrl?(sessionId: string, port?: number): Promise<string>;
  /** Get the session tree (session + children) for a session. */
  getSessionTree?(sessionId: string): Promise<{
    session: Record<string, unknown>;
    children: Array<Record<string, unknown>>;
  }>;
  /** Perform a bulk action (pause/resume/delete) on a session and its children. */
  bulkSandboxAction?(
    sessionId: string,
    action: string,
  ): Promise<{ affected: number }>;
}

// ── Tool definitions (JSON Schema for MCP) ────────────────────────

const stringProp = (desc: string) => ({
  type: "string" as const,
  description: desc,
});
const numberProp = (desc: string) => ({
  type: "number" as const,
  description: desc,
});
const boolProp = (desc: string) => ({
  type: "boolean" as const,
  description: desc,
});

export const toolDefinitions: Record<
  string,
  {
    name: string;
    description: string;
    inputSchema: {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };
  }
> = {
  acp_initialize: {
    name: "acp_initialize",
    description:
      "Initialize ACP connection. Returns protocol version and agent capabilities.",
    inputSchema: {
      type: "object",
      properties: { protocolVersion: numberProp("ACP protocol version") },
      required: ["protocolVersion"],
    },
  },
  acp_authenticate: {
    name: "acp_authenticate",
    description:
      "Authenticate with a provider. HTTP Bearer token handles real auth.",
    inputSchema: {
      type: "object",
      properties: {
        methodId: stringProp("Auth method ID"),
        params: { type: "object" },
      },
      required: ["methodId"],
    },
  },
  acp_logout: {
    name: "acp_logout",
    description: "Logout of the current authentication method.",
    inputSchema: { type: "object", properties: {} },
  },
  acp_providers_list: {
    name: "acp_providers_list",
    description: "List available LLM providers.",
    inputSchema: { type: "object", properties: {} },
  },
  acp_providers_set: {
    name: "acp_providers_set",
    description: "Set a provider configuration.",
    inputSchema: {
      type: "object",
      properties: {
        provider: stringProp("Provider ID"),
        config: { type: "object" },
      },
      required: ["provider"],
    },
  },
  acp_providers_disable: {
    name: "acp_providers_disable",
    description: "Disable a provider.",
    inputSchema: {
      type: "object",
      properties: { provider: stringProp("Provider ID") },
      required: ["provider"],
    },
  },
  acp_session_new: {
    name: "acp_session_new",
    description: "Create a new session backed by a sandbox workspace.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: stringProp("Working directory"),
        sandboxType: stringProp(
          'Sandbox type: "vercel" (default) or "coolify:{connectorId}"',
        ),
        repoUrl: stringProp("GitHub repository URL to clone"),
        branch: stringProp("Branch to checkout"),
        type: stringProp(
          'Session type: "chat" (default), "project", or "child"',
        ),
        parentSessionId: stringProp("Parent session ID for child sessions"),
      },
    },
  },
  acp_session_load: {
    name: "acp_session_load",
    description: "Load an existing session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_session_list: {
    name: "acp_session_list",
    description: "List all sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  acp_session_delete: {
    name: "acp_session_delete",
    description: "Delete a session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_session_fork: {
    name: "acp_session_fork",
    description: "Fork an existing session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_session_resume: {
    name: "acp_session_resume",
    description: "Resume an existing session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_session_close: {
    name: "acp_session_close",
    description: "Close a session and free resources.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_session_set_mode: {
    name: "acp_session_set_mode",
    description: "Set the operational mode for a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        mode: stringProp("Mode ID"),
      },
      required: ["sessionId", "mode"],
    },
  },
  acp_session_set_config_option: {
    name: "acp_session_set_config_option",
    description: "Set a configuration option for a session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        option: stringProp("Option ID"),
        value: {},
      },
      required: ["sessionId", "option"],
    },
  },
  acp_session_prompt: {
    name: "acp_session_prompt",
    description: "Send a prompt to a session. Returns the assistant response.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        message: {
          type: "object",
          properties: { role: stringProp("Role"), content: { type: "array" } },
        },
      },
      required: ["sessionId", "message"],
    },
  },
  acp_session_cancel: {
    name: "acp_session_cancel",
    description: "Cancel an active prompt turn.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_nes_start: {
    name: "acp_nes_start",
    description: "Start a NES (Next Edit Suggestions) session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_nes_suggest: {
    name: "acp_nes_suggest",
    description: "Send a NES suggestion.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_nes_accept: {
    name: "acp_nes_accept",
    description: "Accept a NES suggestion.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        suggestionId: stringProp("Suggestion ID"),
      },
      required: ["sessionId"],
    },
  },
  acp_nes_reject: {
    name: "acp_nes_reject",
    description: "Reject a NES suggestion.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        suggestionId: stringProp("Suggestion ID"),
      },
      required: ["sessionId"],
    },
  },
  acp_nes_close: {
    name: "acp_nes_close",
    description: "Close a NES session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_document_did_open: {
    name: "acp_document_did_open",
    description: "Notify that a document was opened.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("Document URI"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_document_did_change: {
    name: "acp_document_did_change",
    description: "Notify that a document changed.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("Document URI"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_document_did_close: {
    name: "acp_document_did_close",
    description: "Notify that a document was closed.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("Document URI"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_document_did_save: {
    name: "acp_document_did_save",
    description: "Notify that a document was saved.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("Document URI"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_document_did_focus: {
    name: "acp_document_did_focus",
    description: "Notify that a document received focus.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("Document URI"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_request_permission: {
    name: "acp_request_permission",
    description:
      "Request permission from the user for a tool call (auto-accepts in v1).",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        prompt: stringProp("Permission prompt"),
        options: { type: "array" },
      },
      required: ["sessionId"],
    },
  },
  acp_session_update: {
    name: "acp_session_update",
    description: "Send a session update notification.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_fs_write_text_file: {
    name: "acp_fs_write_text_file",
    description: "Write content to a file in the session sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("File URI or path"),
        content: stringProp("File content"),
      },
      required: ["sessionId", "uri", "content"],
    },
  },
  acp_fs_read_text_file: {
    name: "acp_fs_read_text_file",
    description: "Read a file from the session sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        uri: stringProp("File URI or path"),
      },
      required: ["sessionId", "uri"],
    },
  },
  acp_terminal_create: {
    name: "acp_terminal_create",
    description: "Create a terminal and run a command in the session sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        command: stringProp("Command to run"),
        args: { type: "array", items: { type: "string" } },
        cwd: stringProp("Working directory"),
      },
      required: ["sessionId", "command"],
    },
  },
  acp_terminal_output: {
    name: "acp_terminal_output",
    description: "Get terminal output.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        terminalId: stringProp("Terminal ID"),
      },
      required: ["sessionId", "terminalId"],
    },
  },
  acp_terminal_release: {
    name: "acp_terminal_release",
    description: "Release a terminal and free resources.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        terminalId: stringProp("Terminal ID"),
      },
      required: ["sessionId", "terminalId"],
    },
  },
  acp_terminal_wait_for_exit: {
    name: "acp_terminal_wait_for_exit",
    description: "Wait for a terminal command to exit.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        terminalId: stringProp("Terminal ID"),
      },
      required: ["sessionId", "terminalId"],
    },
  },
  acp_terminal_kill: {
    name: "acp_terminal_kill",
    description: "Kill a terminal command.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        terminalId: stringProp("Terminal ID"),
      },
      required: ["sessionId", "terminalId"],
    },
  },
  acp_elicitation_create: {
    name: "acp_elicitation_create",
    description: "Create an elicitation to request input from the user.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_elicitation_complete: {
    name: "acp_elicitation_complete",
    description: "Complete an elicitation.",
    inputSchema: {
      type: "object",
      properties: { elicitationId: stringProp("Elicitation ID") },
      required: ["elicitationId"],
    },
  },
  acp_cancel_request: {
    name: "acp_cancel_request",
    description: "Cancel an in-progress request by ID.",
    inputSchema: {
      type: "object",
      properties: { requestId: stringProp("Request ID") },
      required: ["requestId"],
    },
  },
  acp_secret_set: {
    name: "acp_secret_set",
    description:
      "Set environment variables (secrets) on a session's sandbox. " +
      "Values are stored via Coolify env var API and never returned in responses.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        envVars: {
          type: "object",
          description: "Key-value pairs of environment variables to set",
          additionalProperties: { type: "string" },
        },
      },
      required: ["sessionId", "envVars"],
    },
  },
  acp_secret_list: {
    name: "acp_secret_list",
    description:
      "List environment variable names set on a session's sandbox. Returns names only, never values.",
    inputSchema: {
      type: "object",
      properties: { sessionId: stringProp("Session ID") },
      required: ["sessionId"],
    },
  },
  acp_secret_delete: {
    name: "acp_secret_delete",
    description: "Delete an environment variable from a session's sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        name: stringProp("Environment variable name to delete"),
      },
      required: ["sessionId", "name"],
    },
  },
  acp_github_create_repo: {
    name: "acp_github_create_repo",
    description: "Create a new GitHub repository and return its URL.",
    inputSchema: {
      type: "object",
      properties: {
        repoName: stringProp("Repository name"),
        org: stringProp(
          "GitHub organization (optional, uses user account if omitted)",
        ),
        private: {
          type: "boolean",
          description: "Whether the repo should be private",
        },
        branch: stringProp("Default branch (default: main)"),
      },
      required: ["repoName"],
    },
  },
  acp_github_attach_repo: {
    name: "acp_github_attach_repo",
    description:
      "Attach an existing GitHub repo to a session. The repo is cloned into /workspace.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        repoUrl: stringProp(
          "GitHub repository URL (e.g. https://github.com/owner/repo)",
        ),
        branch: stringProp("Branch to checkout"),
      },
      required: ["sessionId", "repoUrl"],
    },
  },
  acp_github_push: {
    name: "acp_github_push",
    description:
      "Stage (git add -A), pull --rebase, and push to the session's branch. Falls back to a temp branch on conflict.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
      },
      required: ["sessionId"],
    },
  },
  acp_github_create_pr: {
    name: "acp_github_create_pr",
    description: "Create a pull request from a branch to the target branch.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        title: stringProp("PR title (default: auto-generated)"),
        base: stringProp("Target branch (default: main)"),
        branch: stringProp("Head branch (default: session's branch)"),
      },
      required: ["sessionId"],
    },
  },
  acp_deploy_start_dev: {
    name: "acp_deploy_start_dev",
    description:
      "Start a dev server in the session sandbox. Returns the preview URL where the server is accessible.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        command: stringProp(
          "Command to start the dev server (default: npm run dev)",
        ),
      },
      required: ["sessionId"],
    },
  },
  acp_deploy_stop_dev: {
    name: "acp_deploy_stop_dev",
    description:
      "Stop a running dev server in the session sandbox started via acp_deploy_start_dev.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
      },
      required: ["sessionId"],
    },
  },
  acp_deploy_get_preview_url: {
    name: "acp_deploy_get_preview_url",
    description:
      "Get the preview URL for a session sandbox at the specified port.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        port: numberProp("Port to get the preview URL for (default: 3000)"),
      },
      required: ["sessionId"],
    },
  },
  acp_session_get_tree: {
    name: "acp_session_get_tree",
    description:
      "Get the session hierarchy tree. Returns the session and its child sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
      },
      required: ["sessionId"],
    },
  },
  acp_sandbox_bulk_action: {
    name: "acp_sandbox_bulk_action",
    description:
      "Perform a bulk action (pause/resume/delete) on a session and all its child sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: stringProp("Session ID"),
        action: stringProp("Action: pause, resume, or delete"),
      },
      required: ["sessionId", "action"],
    },
  },
};

function ok(data: unknown): ToolContent[] {
  return [{ type: "text", text: JSON.stringify(data) }];
}

function err(message: string): ToolContent[] {
  return [{ type: "text", text: JSON.stringify({ error: message }) }];
}

// ── Handler factory ───────────────────────────────────────────────

export function createHandlers(store: SessionStore, sandbox: SandboxOps) {
  return {
    // ── Auth & Provider ──────────────────────────────────

    async acp_initialize(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      return ok({
        protocolVersion: params.protocolVersion ?? 1,
        agentCapabilities: {
          loadSession: true,
          sessionCapabilities: {
            list: true,
            delete: true,
            close: true,
            fork: true,
            resume: true,
          },
          authCapabilities: { authenticate: true },
          providers: { list: true, set: true, disable: true },
        },
        agentInfo: { name: "Open Agents ACP Bridge", version: "0.1.0" },
      });
    },

    async acp_authenticate(): Promise<ToolContent[]> {
      return ok({ authenticated: true });
    },

    async acp_logout(): Promise<ToolContent[]> {
      return ok({});
    },

    async acp_providers_list(): Promise<ToolContent[]> {
      return ok({
        providers: [
          { id: "openai", name: "OpenAI", llmProtocol: "openai" },
          { id: "anthropic", name: "Anthropic", llmProtocol: "anthropic" },
        ],
      });
    },

    async acp_providers_set(): Promise<ToolContent[]> {
      return ok({});
    },

    async acp_providers_disable(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Session Lifecycle ─────────────────────────────────

    async acp_session_new(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const result = await store.create({
        cwd: (params.cwd as string) ?? "/vercel/sandbox",
        sandboxType: params.sandboxType as string | undefined,
        repoUrl: params.repoUrl as string | undefined,
        branch: params.branch as string | undefined,
        type: params.type as string | undefined,
        parentSessionId: params.parentSessionId as string | undefined,
      });
      return ok({
        sessionId: result.sessionId,
        cwd: result.cwd,
        availableModes: [{ id: "code", label: "Code" }],
        ...(result.sandboxMetadata
          ? { sandboxMetadata: result.sandboxMetadata }
          : {}),
      });
    },

    async acp_session_load(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      return ok({
        sessionId,
        cwd: record.cwd,
        availableModes: [{ id: "code", label: "Code" }],
        ...(record.mode ? { currentMode: record.mode } : {}),
        ...(record.sandboxMetadata
          ? { sandboxMetadata: record.sandboxMetadata }
          : {}),
      });
    },

    async acp_session_list(): Promise<ToolContent[]> {
      const sessions = await store.list();
      return ok({ sessions });
    },

    async acp_session_delete(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      await store.delete(params.sessionId as string);
      return ok({});
    },

    async acp_session_fork(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sourceId = params.sessionId as string;
      const source = await store.get(sourceId);
      if (!source) return err("Source session not found");
      const result = await store.create({
        cwd: source.cwd,
        sandboxType: source.sandboxType,
      });
      return ok({ sessionId: result.sessionId, cwd: source.cwd });
    },

    async acp_session_resume(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      if (store.resume) {
        await store.resume(sessionId);
      }
      return ok({ sessionId, cwd: record.cwd });
    },

    async acp_session_close(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      await store.delete(params.sessionId as string);
      return ok({});
    },

    async acp_session_set_mode(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const mode = params.mode as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      await store.update(sessionId, { mode });
      return ok({});
    },

    async acp_session_set_config_option(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      return ok({ configOptions: {} });
    },

    // ── Conversation ──────────────────────────────────────

    async acp_session_prompt(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      const message = params.message as Record<string, unknown> | undefined;
      const content = message?.content as
        | Array<Record<string, unknown>>
        | undefined;
      const text = (content?.[0]?.text as string) ?? "";

      let assistantText: string;

      // Use LLM agent if available, otherwise fall back to echo
      if (sandbox.prompt) {
        try {
          assistantText = await sandbox.prompt(sessionId, text, record.cwd);
        } catch (error) {
          assistantText = `LLM error: ${error instanceof Error ? error.message : String(error)}`;
        }
      } else {
        // Echo fallback for unit tests / no LLM configured
        assistantText = `Echo: ${text}`;
      }

      // Persist the message pair if the store supports it
      if (store.createMessage) {
        await store.createMessage(sessionId, text, assistantText);
      }

      return ok({
        messages: [
          {
            role: "assistant",
            content: [{ type: "text", text: assistantText }],
          },
        ],
        stopReason: "end_turn",
      });
    },

    async acp_session_cancel(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── NES (stubs) ───────────────────────────────────────

    async acp_nes_start(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_nes_suggest(): Promise<ToolContent[]> {
      return ok({ suggestions: [] });
    },
    async acp_nes_accept(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_nes_reject(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_nes_close(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Document Events (stubs) ──────────────────────────

    async acp_document_did_open(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_document_did_change(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_document_did_close(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_document_did_save(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_document_did_focus(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Client Ops ────────────────────────────────────────

    async acp_request_permission(): Promise<ToolContent[]> {
      return ok({ outcome: { kind: "approved" } });
    },

    async acp_session_update(): Promise<ToolContent[]> {
      return ok({});
    },

    async acp_fs_write_text_file(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      const uri = (params.uri as string).replace(/^file:\/\//, "");
      await sandbox.writeFile(
        record.sandboxName,
        uri,
        params.content as string,
      );
      return ok({});
    },

    async acp_fs_read_text_file(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      const uri = (params.uri as string).replace(/^file:\/\//, "");
      const content = await sandbox.readFile(record.sandboxName, uri);
      return ok({ content });
    },

    async acp_terminal_create(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const record = await store.get(sessionId);
      if (!record) return err("Session not found");
      const args = params.args as string[] | undefined;
      const command = params.command as string;
      const result = await sandbox.runCommand(
        record.sandboxName,
        command,
        args,
        (params.cwd as string) ?? record.cwd,
      );
      const terminalId = `term-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      return ok({
        terminalId,
        initialOutput: result.stdout || result.stderr,
        exitStatus: { exitCode: result.exitCode },
      });
    },

    async acp_terminal_output(): Promise<ToolContent[]> {
      return ok({ output: "", exitStatus: { exitCode: 0 } });
    },

    async acp_terminal_release(): Promise<ToolContent[]> {
      return ok({});
    },
    async acp_terminal_wait_for_exit(): Promise<ToolContent[]> {
      return ok({ exitStatus: { exitCode: 0 } });
    },
    async acp_terminal_kill(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Elicitation (stubs) ─────────────────────────────

    async acp_elicitation_create(): Promise<ToolContent[]> {
      return ok({ elicitationId: `el-${Date.now()}` });
    },

    async acp_elicitation_complete(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Protocol Control ─────────────────────────────────

    async acp_cancel_request(): Promise<ToolContent[]> {
      return ok({});
    },

    // ── Secret Management ──────────────────────────────────

    async acp_secret_set(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const envVars = params.envVars as Record<string, string>;
      if (!sandbox.setSecrets) return err("Secret management not supported");
      const result = await sandbox.setSecrets(sessionId, envVars);
      return ok(result);
    },

    async acp_secret_list(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      if (!sandbox.listSecrets) return err("Secret management not supported");
      const secrets = await sandbox.listSecrets(sessionId);
      return ok({ secrets });
    },

    async acp_secret_delete(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      const sessionId = params.sessionId as string;
      const name = params.name as string;
      if (!sandbox.deleteSecret) return err("Secret management not supported");
      await sandbox.deleteSecret(sessionId, name);
      return ok({ deleted: true });
    },

    // ── GitHub Tools ──────────────────────────────────────

    async acp_github_create_repo(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.createRepo) return err("GitHub tools not supported");
      const result = await sandbox.createRepo(
        params.repoName as string,
        params.org as string | undefined,
        params.private as boolean | undefined,
        params.branch as string | undefined,
      );
      return ok(result);
    },

    async acp_github_attach_repo(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.attachRepo) return err("GitHub tools not supported");
      const result = await sandbox.attachRepo(
        params.sessionId as string,
        params.repoUrl as string,
        params.branch as string | undefined,
      );
      return ok(result);
    },

    async acp_github_push(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.gitPush) return err("GitHub tools not supported");
      const result = await sandbox.gitPush(
        params.sessionId as string,
        params.message as string | undefined,
      );
      return ok(result);
    },

    async acp_github_create_pr(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.createPr) return err("GitHub tools not supported");
      const result = await sandbox.createPr(
        params.sessionId as string,
        params.title as string | undefined,
        params.base as string | undefined,
        params.branch as string | undefined,
      );
      return ok(result);
    },

    // ── Dev Server Tools ─────────────────────────────────

    async acp_deploy_start_dev(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.startDevServer) return err("Dev server tools not supported");
      const result = await sandbox.startDevServer(
        params.sessionId as string,
        params.command as string | undefined,
      );
      return ok(result);
    },

    async acp_deploy_stop_dev(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.stopDevServer) return err("Dev server tools not supported");
      await sandbox.stopDevServer(params.sessionId as string);
      return ok({ stopped: true });
    },

    async acp_deploy_get_preview_url(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.getPreviewUrl) return err("Dev server tools not supported");
      const url = await sandbox.getPreviewUrl(
        params.sessionId as string,
        params.port as number | undefined,
      );
      return ok({ previewUrl: url });
    },

    // ── Session Hierarchy ───────────────────────────────

    async acp_session_get_tree(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.getSessionTree)
        return err("Session hierarchy not supported");
      const result = await sandbox.getSessionTree(params.sessionId as string);
      return ok(result);
    },

    async acp_sandbox_bulk_action(
      params: Record<string, unknown>,
    ): Promise<ToolContent[]> {
      if (!sandbox.bulkSandboxAction)
        return err("Session hierarchy not supported");
      const result = await sandbox.bulkSandboxAction(
        params.sessionId as string,
        params.action as string,
      );
      return ok(result);
    },
  };
}

export type ACPHandlers = ReturnType<typeof createHandlers>;
