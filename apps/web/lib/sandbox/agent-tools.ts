import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  EXPLORER_SYSTEM_PROMPT,
  EXECUTOR_SYSTEM_PROMPT,
  DESIGN_SYSTEM_PROMPT,
  SUBAGENT_STEP_LIMIT,
} from "@open-agents/agent";

// ── Interfaces & Types ──────────────────────────────────

/**
 * Minimal sandbox interface that our agent tools need.
 */
export interface SandboxExec {
  readFile(filePath: string, encoding: string): Promise<string>;
  writeFile(filePath: string, content: string, encoding: string): Promise<void>;
  stat(filePath: string): Promise<{ isDirectory(): boolean; size: number }>;
  mkdir(filePath: string, options?: { recursive?: boolean }): Promise<void>;
  exec(
    command: string,
    cwd: string,
    timeout: number,
  ): Promise<{ exitCode: number | null; stdout: string; stderr: string }>;
}

export interface SandboxConnection {
  sandbox: SandboxExec;
  stop(): Promise<void>;
}

/**
 * A function that provides a sandbox connection for a single tool invocation.
 * Called once per tool call — return a fresh (or reused) connection.
 */
export type SandboxProvider = () => Promise<SandboxConnection>;

/**
 * Metadata for an installed skill.
 */
export interface SkillMetadata {
  name: string;
  path: string;
  filename: string;
  description?: string;
}

/**
 * Additional dependencies for tools that need model access or skill metadata.
 * Pass these when calling createSandboxAgentTools inside an agent loop.
 */
export interface ToolDependencies {
  /** Factory that returns a model ID string (e.g. "anthropic/claude-sonnet-4") for sub-agents. */
  getModelId?: () => string;
  /** Available skill metadata (from the session's globalSkillRefs). */
  skills?: SkillMetadata[];
}

// ── Helpers ─────────────────────────────────────────────

/** Resolve a file path: absolute paths pass through, relative paths are prefixed with cwd. */
function resolvePath(filePath: string, cwd: string): string {
  return filePath.startsWith("/") ? filePath : `${cwd}/${filePath}`;
}

/** Parse a glob pattern into find-compatible args, returns { searchDir, maxdepth, namePattern }. */
function parseGlobForFind(
  pattern: string,
  cwd: string,
): { searchDir: string; maxdepth: string; namePattern: string } {
  const parts = pattern.split("/").filter(Boolean);
  const namePattern = parts[parts.length - 1] ?? "*";

  // Extract literal directory prefix (segments before any wildcards)
  const literalPrefix: string[] = [];
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i]!;
    if (seg.includes("*") || seg.includes("?") || seg.includes("[")) break;
    literalPrefix.push(seg);
  }
  const searchDir =
    literalPrefix.length > 0 ? `${cwd}/${literalPrefix.join("/")}` : cwd;

  // Determine maxdepth from remaining wildcard dir segments
  const remainingDirSegments = parts.slice(
    literalPrefix.length,
    parts.length - 1,
  );
  const hasRecursive = remainingDirSegments.some((s) => s === "**");
  const maxdepth =
    !hasRecursive && remainingDirSegments.length > 0
      ? `-maxdepth ${remainingDirSegments.length + 1}`
      : "";

  return { searchDir, maxdepth, namePattern };
}

// ── Factory ─────────────────────────────────────────────

/**
 * Create sandbox agent tools.
 *
 * Base tools (always included):
 *   write_file, read_file, edit_file, bash, glob, grep, web_fetch
 *
 * When `deps` is provided with getModelId, these extra tools are added:
 *   task, skill, todo_write, ask_user_question (autopilot)
 *
 * @param cwd - Working directory inside the sandbox (e.g. "/workspace").
 * @param getSandbox - Provider function called per tool invocation.
 * @param deps - Optional dependencies for advanced tools (model, skills).
 *
 * @example Shared sandbox (runAgentLoop):
 * ```ts
 * const sandbox = await connectCoolify(state);
 * const tools = createSandboxAgentTools("/workspace", async () => ({
 *   sandbox,
 *   stop: async () => {},
 * }), { getModelId: () => activeModel, skills });
 * ```
 *
 * @example Per-call sandbox (prompt handler):
 * ```ts
 * const tools = createSandboxAgentTools("/workspace", async () => {
 *   const s = await connectSandboxForTools();
 *   return { sandbox: s, stop: () => s.stop() };
 * });
 * ```
 */
export function createSandboxAgentTools(
  cwd: string,
  getSandbox: SandboxProvider,
  deps?: ToolDependencies,
): ToolSet {
  const execWithResult = async (
    command: string,
    timeout = 120_000,
  ): Promise<string> => {
    const { sandbox, stop } = await getSandbox();
    try {
      const r = await sandbox.exec(command, cwd, timeout);
      return `exit:${r.exitCode}\nstdout:${r.stdout}\nstderr:${r.stderr}`;
    } finally {
      await stop().catch(() => {});
    }
  };

  return {
    // ── write_file ────────────────────────────────────
    write_file: tool({
      description: `Write content to a file in the workspace.

WHEN TO USE:
- Creating a new file that does not yet exist
- Completely replacing the contents of an existing file

USAGE:
- Path can be absolute (/workspace/foo.txt) or workspace-relative (foo.txt)
- Parent directories are created automatically
- This OVERWRITES existing files entirely

EXAMPLES:
- Create a new file: filePath: "/workspace/src/index.ts", content: "..."`,
      inputSchema: z.object({
        filePath: z.string().describe("File path, e.g. /workspace/README.md"),
        content: z.string().describe("Content to write"),
      }),
      execute: async ({ filePath, content }) => {
        const fp = resolvePath(filePath, cwd);
        const { sandbox, stop } = await getSandbox();
        try {
          await sandbox.mkdir(fp.split("/").slice(0, -1).join("/") || "/", {
            recursive: true,
          });
          await sandbox.writeFile(fp, content, "utf-8");
          return `wrote ${fp}`;
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── read_file ─────────────────────────────────────
    read_file: tool({
      description: `Read a file from the workspace.

USAGE:
- Path can be absolute (/workspace/foo.txt) or workspace-relative (foo.txt)
- Cannot read directories — use glob instead
- Returns file content as-is

EXAMPLES:
- Read a file: filePath: "/workspace/src/index.ts"`,
      inputSchema: z.object({
        filePath: z.string().describe("File path, e.g. /workspace/README.md"),
      }),
      execute: async ({ filePath }) => {
        const fp = resolvePath(filePath, cwd);
        const { sandbox, stop } = await getSandbox();
        try {
          const stats = await sandbox.stat(fp);
          if (stats.isDirectory()) {
            return "ERROR: Cannot read a directory. Use glob to list files.";
          }
          return await sandbox.readFile(fp, "utf-8");
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── edit_file ─────────────────────────────────────
    edit_file: tool({
      description: `Perform exact string replacement in a file.

WHEN TO USE:
- Making small, precise edits to an existing file
- Renaming a variable or identifier within a single file
- Changing a specific block of code or configuration

USAGE:
- Path can be absolute or workspace-relative
- oldString must be the EXACT text to replace, including whitespace and indentation
- oldString must appear exactly ONCE in the file (unless replaceAll is true)
- Use replaceAll: true to change ALL occurrences

EXAMPLES:
- Replace a single occurrence: filePath: "/workspace/src/app.tsx", oldString: "Hello", newString: "Hi"
- Rename throughout a file: filePath: "/workspace/src/app.tsx", oldString: "oldFunc", newString: "newFunc", replaceAll: true`,
      inputSchema: z.object({
        filePath: z.string().describe("File path, e.g. /workspace/src/app.tsx"),
        oldString: z.string().describe("The exact text to replace"),
        newString: z.string().describe("The text to replace it with"),
        replaceAll: z
          .boolean()
          .optional()
          .describe("Replace all occurrences. Default: false"),
      }),
      execute: async ({ filePath, oldString, newString, replaceAll }) => {
        if (oldString === newString) {
          return "ERROR: oldString and newString must be different";
        }
        const fp = resolvePath(filePath, cwd);
        const { sandbox, stop } = await getSandbox();
        try {
          const content = await sandbox.readFile(fp, "utf-8");
          if (!content.includes(oldString)) {
            return "ERROR: oldString not found in file. Check exact whitespace and indentation.";
          }
          const occurrences = content.split(oldString).length - 1;
          if (occurrences > 1 && !replaceAll) {
            return `ERROR: oldString found ${occurrences} times. Use replaceAll=true or provide more context.`;
          }
          const newContent = replaceAll
            ? content.replaceAll(oldString, newString)
            : content.replace(oldString, newString);
          await sandbox.writeFile(fp, newContent, "utf-8");
          return `edited ${fp} (${replaceAll ? occurrences : 1} replacement${(replaceAll ? occurrences : 1) !== 1 ? "s" : ""})`;
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── bash ──────────────────────────────────────────
    bash: tool({
      description: `Execute a bash command in the workspace sandbox.

WHEN TO USE:
- Running build, test, lint, typecheck commands
- Using CLI tools (git, npm, pnpm, ls, cat, etc.)
- Installing dependencies

WHEN NOT TO USE:
- Reading files (use read_file instead)
- Editing or creating files (use edit_file or write_file instead)
- Code search (use grep instead)

USAGE:
- Commands run in the workspace directory
- Timeout after ~2 minutes
- Non-interactive shell only — no TTY, no editors, no REPLs

EXAMPLES:
- Install deps: command: "npm install"
- List files: command: "ls -la"
- Run tests: command: "npm test"`,
      inputSchema: z.object({
        command: z.string().describe("The bash command to execute"),
      }),
      execute: async ({ command }) => {
        return execWithResult(command, 120_000);
      },
    }),

    // ── glob ──────────────────────────────────────────
    glob: tool({
      description: `Find files matching a glob pattern.

USAGE:
- Supports patterns like "**/*.ts", "src/**/*.js", "*.json"
- Returns file paths only (not directories)
- Skips node_modules

EXAMPLES:
- All TypeScript files: pattern: "**/*.ts"
- All files in src: pattern: "src/**/*"
- JSON configs: pattern: "*.json"`,
      inputSchema: z.object({
        pattern: z.string().describe("Glob pattern, e.g. **/*.md"),
      }),
      execute: async ({ pattern }) => {
        const { searchDir, maxdepth, namePattern } = parseGlobForFind(
          pattern,
          cwd,
        );
        const findCmd = `find ${searchDir} ${maxdepth} -not -path '*/.*' -not -path '*/node_modules/*' -type f -name '${namePattern}' 2>/dev/null || echo ""`;
        const { sandbox, stop } = await getSandbox();
        try {
          const r = await sandbox.exec(findCmd, cwd, 10_000);
          return r.stdout.trim() || "(no matches)";
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── grep ──────────────────────────────────────────
    grep: tool({
      description: `Search for patterns in files using grep.

WHEN TO USE:
- Finding where a function, variable, or string is used
- Locating configuration keys, routes, or error messages
- Narrowing down which files to read or edit

WHEN NOT TO USE:
- Simple filename searches (use glob instead)
- Searching outside the workspace

USAGE:
- Uses POSIX Extended Regular Expressions (ERE)
- Searches recursively from the workspace root
- Skips hidden files (.*) and node_modules
- Results are limited to 100 matches total, 10 per file

EXAMPLES:
- Find all TODO comments: pattern: "TODO"
- Find function references: pattern: "handleClick"
- Case-insensitive search: pattern: "error", caseSensitive: false`,
      inputSchema: z.object({
        pattern: z.string().describe("Regex pattern to search for"),
        caseSensitive: z
          .boolean()
          .optional()
          .describe("Case-sensitive search. Default: true"),
        path: z
          .string()
          .optional()
          .describe(
            "Workspace-relative path to search in (default: workspace root)",
          ),
      }),
      execute: async ({ pattern, caseSensitive = true, path: searchPath }) => {
        const searchDir = searchPath ? resolvePath(searchPath, cwd) : cwd;
        const caseFlag = caseSensitive ? "" : " -i";
        // Use grep -rn with max-count 10 per file, limit output to 100 lines
        const cmd = `grep -rn${caseFlag} -m 10 --exclude-dir='.*' --exclude-dir=node_modules -E ${JSON.stringify(pattern)} ${JSON.stringify(searchDir)} 2>/dev/null | head -100 || true`;
        const { sandbox, stop } = await getSandbox();
        try {
          const r = await sandbox.exec(cmd, cwd, 30_000);
          const output = r.stdout.trim();
          if (!output) {
            return "(no matches)";
          }
          // Truncate to reasonable size
          const lines = output.split("\n");
          if (lines.length > 100) {
            return lines.slice(0, 100).join("\n") + "\n... (truncated)";
          }
          return output;
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── web_fetch ─────────────────────────────────────
    web_fetch: tool({
      description: `Fetch a URL from the web (HTTP GET).

WHEN TO USE:
- Calling external APIs or web services
- Fetching data from URLs
- Checking endpoint responses

USAGE:
- Public HTTP/HTTPS URLs only (no private/localhost)
- Returns response body text
- Truncated to ~10KB to avoid overwhelming context
- Always requires approval before executing

EXAMPLES:
- Fetch an API: url: "https://api.example.com/data"
- Fetch with headers: url: "https://api.example.com/data?format=json"`,
      inputSchema: z.object({
        url: z
          .string()
          .url()
          .describe("The URL to fetch (public HTTP/HTTPS only)"),
      }),
      execute: async ({ url }) => {
        // Basic SSRF check — reject private IPs/localhost at the tool level
        try {
          const parsed = new URL(url);
          const hostname = parsed.hostname.toLowerCase();
          if (
            hostname === "localhost" ||
            hostname === "127.0.0.1" ||
            hostname === "0.0.0.0" ||
            hostname === "[::1]" ||
            hostname.startsWith("10.") ||
            hostname.startsWith("172.16.") ||
            hostname.startsWith("192.168.") ||
            hostname.endsWith(".local") ||
            hostname.endsWith(".internal")
          ) {
            return `ERROR: URL resolves to a private or internal host (${hostname})`;
          }
        } catch {
          return "ERROR: Invalid URL";
        }

        // Execute fetch inside the sandbox via curl to avoid the Node.js process
        // making external requests directly (uses the sandbox's network).
        const { sandbox, stop } = await getSandbox();
        try {
          const r = await sandbox.exec(
            `curl -sS --max-time 15 -o /tmp/_fetch_response.txt -w '%{http_code}' ${JSON.stringify(url)} 2>/dev/null; echo; cat /tmp/_fetch_response.txt 2>/dev/null || echo ""`,
            cwd,
            20_000,
          );
          const lines = r.stdout.split("\n");
          const statusCode = lines[0]?.trim() ?? "";
          const body = lines.slice(1).join("\n").trim();
          const truncated =
            body.length > 10_000
              ? body.slice(0, 10_000) + "\n... (truncated)"
              : body;
          return `HTTP ${statusCode}\n${truncated}`;
        } finally {
          await stop().catch(() => {});
        }
      },
    }),

    // ── Extra tools (only added when deps is provided) ──
    ...(deps
      ? {
          // ── task ─────────────────────────────────────
          task: tool({
            description: `Launch a sub-agent to handle complex tasks autonomously.

WHEN TO USE:
- Clearly-scoped work that can be delegated with explicit instructions
- Tasks that require exploration, implementation, or design work

BEHAVIOR:
- Sub-agents work autonomously without asking follow-up questions
- They use the same battle-tested system prompts as the chat UI subagents
- They return a summary of what was accomplished

HOW TO USE:
- Choose the appropriate subagentType (explorer, executor, or design)
- Provide a short task string (for display)
- Provide detailed instructions including goals, steps, constraints, and verification criteria`,
            inputSchema: z.object({
              subagentType: z
                .enum(["explorer", "executor", "design"])
                .describe(
                  "Type of subagent to launch. explorer=read-only, executor=implementation, design=UI creation",
                ),
              task: z
                .string()
                .describe("Short description of the task (displayed to user)"),
              instructions: z
                .string()
                .describe(
                  "Detailed instructions for the sub-agent: goals, steps, constraints, verification criteria",
                ),
            }),
            execute: async ({ subagentType, task, instructions }) => {
              if (!deps?.getModelId) {
                return "ERROR: No model configured for sub-agent.";
              }
              const { ToolLoopAgent, stepCountIs, gateway } =
                await import("ai");
              const model = gateway(deps.getModelId());

              // Pick the battle-tested system prompt for this subagent type
              const basePrompt =
                subagentType === "explorer"
                  ? EXPLORER_SYSTEM_PROMPT
                  : subagentType === "executor"
                    ? EXECUTOR_SYSTEM_PROMPT
                    : DESIGN_SYSTEM_PROMPT;

              const explorerReminder = `## REMINDER
- You CANNOT ask questions - no one will respond
- This is READ-ONLY - do NOT create, modify, or delete any files
- Your final message MUST include both a **Summary** of what you searched AND the **Answer** to the task`;

              const subagentReminder = `## REMINDER
- You CANNOT ask questions - no one will respond
- Complete the task fully before returning
- Your final message MUST include both a **Summary** of what you did AND the **Answer** to the task`;

              const reminder =
                subagentType === "explorer"
                  ? explorerReminder
                  : subagentReminder;

              const instructionsWithContext = `${basePrompt}

Working directory: . (workspace root)
Use workspace-relative paths for all file operations.

## Your Task
${task}

## Detailed Instructions
${instructions}

${reminder}`;

              const subAgent = new ToolLoopAgent({
                model,
                instructions: instructionsWithContext,
                stopWhen: stepCountIs(SUBAGENT_STEP_LIMIT),
                tools: createSandboxAgentTools(cwd, getSandbox),
              });

              const result = await subAgent.stream({
                prompt: instructions,
              });

              // Collect the final response
              let responseText = "";
              for await (const part of result.fullStream) {
                if (part.type === "text-delta") {
                  responseText +=
                    (part as { textDelta?: string }).textDelta ?? "";
                }
              }
              let finalText = responseText;
              if (!finalText) {
                const resp = await result.response;
                const lastAssistant = resp.messages.findLast(
                  (m: { role: string }) => m.role === "assistant",
                ) as
                  | { content?: Array<{ type: string; text?: string }> }
                  | undefined;
                if (lastAssistant?.content?.[0]?.text) {
                  finalText = lastAssistant.content[0].text;
                } else {
                  finalText = "Task completed.";
                }
              }

              return finalText;
            },
          }),

          // ── todo_write ────────────────────────────────
          todo_write: tool({
            description: `Create and manage a structured task list for the current session.

WHEN TO USE:
- Complex multi-step tasks requiring 3 or more distinct steps
- When tracking progress across multiple work items
- After completing a task - mark it as completed immediately

TASK STATES:
- "pending": Task not yet started
- "in_progress": Currently being worked on
- "completed": Task finished successfully

USAGE:
- This tool REPLACES the entire todo list - always send the full, updated list
- Update statuses as you start and finish work`,
            inputSchema: z.object({
              todos: z
                .array(
                  z.object({
                    id: z.string().describe("Unique identifier"),
                    content: z.string().describe("Task description"),
                    status: z
                      .enum(["pending", "in_progress", "completed"])
                      .describe("Current status"),
                  }),
                )
                .describe(
                  "The complete list of todo items. Replaces existing todos.",
                ),
            }),
            execute: async ({ todos }) => {
              return {
                success: true,
                message: `Updated task list with ${todos.length} items`,
                todos,
              };
            },
          }),

          // ── skill ─────────────────────────────────────
          skill: tool({
            description: `Execute a skill within the main conversation.

Use this when the user asks you to perform a task that matches an available skill.
Skills provide specialized capabilities and domain knowledge.

Available skills: ${
              deps.skills?.length
                ? deps.skills.map((s) => s.name).join(", ")
                : "none available"
            }

HOW TO USE:
- Provide the skill name to invoke
- Optionally provide arguments
- The skill content will be returned for you to follow`,
            inputSchema: z.object({
              skill: z.string().describe("The skill name to invoke"),
              args: z
                .string()
                .optional()
                .describe("Optional arguments for the skill"),
            }),
            execute: async ({ skill: skillName, args }) => {
              const skillMeta = deps.skills?.find(
                (s) => s.name.toLowerCase() === skillName.toLowerCase(),
              );
              if (!skillMeta) {
                const available = deps.skills?.map((s) => s.name).join(", ");
                return `ERROR: Skill '${skillName}' not found. Available skills: ${available || "none"}`;
              }

              // Read the SKILL.md file from the sandbox
              const skillFilePath = `${skillMeta.path}/${skillMeta.filename}`;
              const { sandbox, stop } = await getSandbox();
              try {
                let fileContent: string;
                try {
                  fileContent = await sandbox.readFile(skillFilePath, "utf-8");
                } catch {
                  return `ERROR: Failed to read skill file at ${skillFilePath}`;
                }

                // Strip YAML frontmatter
                const body = fileContent.replace(/^---[\s\S]*?---\r?\n?/, "");
                // Inject skill directory info
                const withDir = `Skill directory: ${skillMeta.path}\n\n${body}`;
                // Substitute $ARGUMENTS
                const result = args
                  ? withDir.replace(/\$ARGUMENTS/g, args)
                  : withDir;

                return {
                  success: true,
                  skillName,
                  skillPath: skillMeta.path,
                  content: result,
                };
              } finally {
                await stop().catch(() => {});
              }
            },
          }),

          // ── ask_user_question (autopilot) ─────────────
          ask_user_question: tool({
            description: `Ask the user questions during execution to gather preferences or clarify requirements.

AUTOPILOT MODE: In the sandbox/headless context, questions are auto-declined
so the agent continues with its best judgment based on available context.`,
            inputSchema: z.object({
              questions: z
                .array(
                  z.object({
                    question: z
                      .string()
                      .describe("The question to ask, ends with '?'"),
                    header: z
                      .string()
                      .max(12)
                      .describe("Short label for the question"),
                    options: z
                      .array(
                        z.object({
                          label: z.string().describe("Choice text"),
                          description: z
                            .string()
                            .describe("Explanation of trade-offs"),
                        }),
                      )
                      .min(2)
                      .max(4),
                    multiSelect: z.boolean().default(false),
                  }),
                )
                .min(1)
                .max(4),
            }),
            execute: async () => {
              // Autopilot: auto-decline so the agent continues with best judgment
              return { declined: true };
            },
            toModelOutput: ({ output }) => {
              if (!output || (output as { declined?: boolean }).declined) {
                return {
                  type: "text",
                  value:
                    "Questions were auto-declined (autopilot mode). Continue with your best judgment based on available context. Do not ask again.",
                };
              }
              const ans = output as {
                answers?: Record<string, string | string[]>;
              };
              if (ans.answers) {
                const formatted = Object.entries(ans.answers)
                  .map(
                    ([q, a]) =>
                      `"${q}"="${Array.isArray(a) ? a.join(", ") : a}"`,
                  )
                  .join(", ");
                return {
                  type: "text",
                  value: `User answered: ${formatted}`,
                };
              }
              return {
                type: "text",
                value:
                  "User did not respond. Continue with your best judgment.",
              };
            },
          }),
        }
      : {}),
  };
}
