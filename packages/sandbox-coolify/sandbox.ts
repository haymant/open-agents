import { Buffer } from "node:buffer";
import type { Dirent } from "node:fs";
import http from "node:http";
import type { OutgoingHttpHeaders } from "node:http";
import https from "node:https";
import type {
  ConnectOptions,
  Sandbox,
  SandboxHooks,
  SandboxStats,
  ExecResult,
  SnapshotResult,
} from "@open-agents/sandbox";
import type { Source } from "@open-agents/sandbox";

export type CoolifyPreviewUrls = {
  app?: string;
  codeServer?: string;
  health?: string;
};

export type CoolifyState = {
  type: "coolify";
  connectorConfigId?: string;
  connectorName?: string;
  coolifyApplicationId?: string;
  coolifyApplicationUrl?: string;
  coolifyPreviewUrls?: CoolifyPreviewUrls;
  sandboxName?: string;
  sandboxId?: string;
  snapshotId?: string;
  expiresAt?: number;
  source?: Source;
  fsApiToken?: string;
};

type DirEntryResponse = {
  isDir: boolean;
  isFile: boolean;
  modified: string;
  name: string;
  size: number | null;
};

type StatResponse = {
  exists: boolean;
  isDir: boolean;
  isFile: boolean;
  modified: string;
  mtimeMs: number;
  path: string;
  size: number;
};

type ReadFileResponse = {
  content: string;
};

type ExecResponse = {
  code: number | null;
  stderr: string;
  stdout: string;
  success: boolean;
  timedOut?: boolean;
};

type DetachedExecResponse = {
  commandId?: string;
  pid?: number;
};

const DEFAULT_WORKING_DIRECTORY = "/workspace";
const CODE_SERVER_PORT = 1222;
const HEALTH_PORT = 1223;

// ── helpers ──────────────────────────────────────────────

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function buildGitHubAuthExecCommand(command: string, token: string): string {
  const basicAuthToken = Buffer.from(
    `x-access-token:${token}`,
    "utf-8",
  ).toString("base64");

  return [
    "env",
    "GIT_CONFIG_COUNT=1",
    shellSingleQuote("GIT_CONFIG_KEY_0=http.https://github.com/.extraheader"),
    shellSingleQuote(
      `GIT_CONFIG_VALUE_0=AUTHORIZATION: basic ${basicAuthToken}`,
    ),
    command,
  ].join(" ");
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function ensureUrl(value: string | undefined): string {
  if (!value) {
    throw new Error(
      "Coolify runtime URL is missing. Start the Coolify app first so session state includes coolifyPreviewUrls.health.",
    );
  }
  return trimTrailingSlash(value);
}

function joinUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string>,
): string {
  const url = new URL(`${baseUrl}${pathname}`);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

function isSelfSignedTlsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const e = error as Error & { cause?: { code?: string }; code?: string };
  return (
    e.code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    e.cause?.code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  );
}

function toOutgoingHttpHeaders(
  headers: Record<string, string> | undefined,
): OutgoingHttpHeaders | undefined {
  if (!headers) return undefined;
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return headers;
}

async function requestWithoutTlsValidation(
  url: string,
  init: {
    headers?: Record<string, string>;
    method?: string;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<{ ok: boolean; status: number; text: string }> {
  const target = new URL(url);
  const requestHeaders = toOutgoingHttpHeaders(init.headers);

  return new Promise((resolve, reject) => {
    const req =
      target.protocol === "https:"
        ? https.request(target, {
            headers: requestHeaders,
            method: init.method,
            rejectUnauthorized: false,
          })
        : http.request(target, {
            headers: requestHeaders,
            method: init.method,
          });

    const sig = init.signal;
    const abortHandler = () => req.destroy(new Error("Request aborted"));
    sig?.addEventListener("abort", abortHandler, { once: true });

    req.on("response", (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        text += chunk;
      });
      response.on("end", () => {
        sig?.removeEventListener("abort", abortHandler);
        resolve({
          ok:
            typeof response.statusCode === "number" &&
            response.statusCode >= 200 &&
            response.statusCode < 300,
          status: response.statusCode ?? 500,
          text,
        });
      });
    });

    req.on("error", (error) => {
      sig?.removeEventListener("abort", abortHandler);
      reject(error);
    });

    if (typeof init.body === "string") req.write(init.body);
    req.end();
  });
}

function makeDirent(entry: DirEntryResponse): Dirent {
  return {
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => entry.isDir,
    isFIFO: () => false,
    isFile: () => entry.isFile,
    isSocket: () => false,
    isSymbolicLink: () => false,
    name: entry.name,
  } as Dirent;
}

// ── CoolifyStat ──────────────────────────────────────────

class CoolifyStat implements SandboxStats {
  constructor(private readonly r: StatResponse) {}
  isDirectory() {
    return this.r.isDir;
  }
  isFile() {
    return this.r.isFile;
  }
  get mtimeMs() {
    return this.r.mtimeMs;
  }
  get size() {
    return this.r.size;
  }
}

// ── CoolifyFileSystem ────────────────────────────────────

export class CoolifyFileSystem {
  constructor(
    private readonly baseUrl: string,
    private readonly apiToken?: string,
  ) {}

  private async request<T>(
    pathname: string,
    init?: {
      headers?: Record<string, string>;
      method?: string;
      body?: string;
      signal?: AbortSignal;
    },
    query?: Record<string, string>,
  ): Promise<T> {
    const headers: Record<string, string> = { ...init?.headers };
    if (this.apiToken) {
      headers.Authorization = `Bearer ${this.apiToken}`;
    }
    if (init?.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }

    const url = joinUrl(this.baseUrl, pathname, query);
    let text: string;
    let status: number;
    let ok: boolean;

    try {
      const resp = await fetch(url, {
        method: init?.method,
        headers,
        body: init?.body,
        signal: init?.signal,
      });
      text = await resp.text();
      status = resp.status;
      ok = resp.ok;
    } catch (error) {
      if (!isSelfSignedTlsError(error)) throw error;
      const ir = await requestWithoutTlsValidation(url, {
        headers,
        method: init?.method,
        body: init?.body,
        signal: init?.signal,
      });
      text = ir.text;
      status = ir.status;
      ok = ir.ok;
    }

    if (!ok) {
      throw new Error(text || `Coolify FS API request failed with ${status}`);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  async access(filePath: string): Promise<void> {
    await this.stat(filePath);
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ExecResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs + 1_000);
    const abortHandler = () => controller.abort();
    signal?.addEventListener("abort", abortHandler, { once: true });

    try {
      const r = await this.request<ExecResponse>("/api/exec", {
        body: JSON.stringify({ cmd: command, cwd, timeoutMs }),
        method: "POST",
        signal: controller.signal,
      });
      return {
        exitCode: r.code,
        stderr: r.stderr,
        stdout: r.stdout,
        success: r.success,
        truncated: false,
      };
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        return {
          exitCode: null,
          stderr: `Command timed out after ${timeoutMs}ms`,
          stdout: "",
          success: false,
          truncated: false,
        };
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      signal?.removeEventListener("abort", abortHandler);
    }
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    const r = await this.request<DetachedExecResponse>("/api/exec/detached", {
      body: JSON.stringify({ cmd: command, cwd }),
      method: "POST",
    });
    return {
      commandId:
        r.commandId ?? (typeof r.pid === "number" ? String(r.pid) : "unknown"),
    };
  }

  async mkdir(dirPath: string, recursive = true): Promise<void> {
    await this.request("/api/files/dir", {
      body: JSON.stringify({ path: dirPath, recursive }),
      method: "POST",
    });
  }

  async readFile(filePath: string, encoding: "utf-8"): Promise<string> {
    if (encoding !== "utf-8")
      throw new Error(`Unsupported encoding: ${encoding}`);
    const r = await this.request<ReadFileResponse>(
      "/api/files/content",
      undefined,
      {
        path: filePath,
      },
    );
    return r.content;
  }

  async readFileBuffer(filePath: string): Promise<Buffer> {
    const r = await this.request<ReadFileResponse>(
      "/api/files/content",
      undefined,
      {
        encoding: "base64",
        path: filePath,
      },
    );
    return Buffer.from(r.content, "base64");
  }

  async readdir(dirPath: string): Promise<Dirent[]> {
    const r = await this.request<DirEntryResponse[]>("/api/files", undefined, {
      path: dirPath,
    });
    return r.map(makeDirent);
  }

  async stat(filePath: string): Promise<SandboxStats> {
    const r = await this.request<StatResponse>("/api/files/stat", undefined, {
      path: filePath,
    });
    return new CoolifyStat(r);
  }

  async writeFile(
    filePath: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    if (encoding !== "utf-8")
      throw new Error(`Unsupported encoding: ${encoding}`);
    await this.request("/api/files/content", {
      body: JSON.stringify({ content, encoding: "utf8", path: filePath }),
      method: "POST",
    });
  }
}

// ── bootstrap helpers ────────────────────────────────────

async function execOrThrow(params: {
  sandbox: CoolifySandbox;
  command: string;
  timeoutMs: number;
  errorPrefix: string;
}): Promise<void> {
  const result = await params.sandbox.exec(
    params.command,
    DEFAULT_WORKING_DIRECTORY,
    params.timeoutMs,
  );
  if (result.success) return;
  throw new Error(
    `${params.errorPrefix}: ${result.stderr || result.stdout || "command failed"}`,
  );
}

async function bootstrapSourceRepository(params: {
  sandbox: CoolifySandbox;
  source: Source;
}): Promise<void> {
  const { sandbox, source } = params;

  const originResult = await sandbox.exec(
    "git remote get-url origin",
    DEFAULT_WORKING_DIRECTORY,
    5_000,
  );
  if (originResult.success && originResult.stdout.trim() === source.repo) {
    return;
  }

  const wtResult = await sandbox.exec(
    "git rev-parse --is-inside-work-tree",
    DEFAULT_WORKING_DIRECTORY,
    5_000,
  );
  if (!wtResult.success) {
    await execOrThrow({
      sandbox,
      command: "git init",
      timeoutMs: 15_000,
      errorPrefix: "Failed to initialize git workspace",
    });
  }

  await sandbox
    .exec("git remote remove origin", DEFAULT_WORKING_DIRECTORY, 5_000)
    .catch(() => undefined);
  await execOrThrow({
    sandbox,
    command: `git remote add origin ${shellSingleQuote(source.repo)}`,
    timeoutMs: 5_000,
    errorPrefix: "Failed to configure origin remote",
  });

  if (source.branch) {
    const fetchResult = await sandbox.exec(
      `git fetch --depth 1 origin ${shellSingleQuote(source.branch)}`,
      DEFAULT_WORKING_DIRECTORY,
      60_000,
    );
    const checkoutCmd = fetchResult.success
      ? `git checkout -B ${shellSingleQuote(source.branch)} --track ${shellSingleQuote(`origin/${source.branch}`)}`
      : `git checkout -B ${shellSingleQuote(source.branch)}`;
    await execOrThrow({
      sandbox,
      command: checkoutCmd,
      timeoutMs: 15_000,
      errorPrefix: `Failed to checkout branch '${source.branch}'`,
    });
    return;
  }

  const fetchDefault = await sandbox.exec(
    "git fetch --depth 1 origin",
    DEFAULT_WORKING_DIRECTORY,
    60_000,
  );

  if (source.newBranch) {
    const checkoutCmd = fetchDefault.success
      ? `git checkout -B ${shellSingleQuote(source.newBranch)} FETCH_HEAD`
      : `git checkout -B ${shellSingleQuote(source.newBranch)}`;
    await execOrThrow({
      sandbox,
      command: checkoutCmd,
      timeoutMs: 15_000,
      errorPrefix: `Failed to create branch '${source.newBranch}'`,
    });
  }
}

// ── CoolifySandbox ───────────────────────────────────────

export class CoolifySandbox implements Sandbox {
  readonly type = "cloud" as const;
  readonly workingDirectory = DEFAULT_WORKING_DIRECTORY;
  readonly env?: Record<string, string>;
  readonly currentBranch?: string;
  readonly hooks?: SandboxHooks;
  readonly environmentDetails?: string;
  readonly host?: string;
  readonly expiresAt?: number;
  readonly timeout?: number;

  private githubAuthToken?: string;
  private stopped = false;

  constructor(
    private readonly fs: CoolifyFileSystem,
    private readonly state: CoolifyState,
    options?: ConnectOptions,
  ) {
    this.env = options?.env;
    this.hooks = options?.hooks;
    this.timeout = options?.timeout;
    this.expiresAt = state.expiresAt;
    this.host = state.coolifyApplicationUrl
      ? new URL(state.coolifyApplicationUrl).host
      : undefined;
    this.environmentDetails = [
      state.coolifyApplicationUrl
        ? `Coolify app: ${state.coolifyApplicationUrl}`
        : null,
      state.coolifyPreviewUrls?.health
        ? `Coolify fs api: ${state.coolifyPreviewUrls.health}`
        : null,
      state.coolifyPreviewUrls?.codeServer
        ? `Coolify code-server: ${state.coolifyPreviewUrls.codeServer}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  static async connect(
    state: CoolifyState,
    options?: ConnectOptions,
  ): Promise<CoolifySandbox> {
    const fsBaseUrl = ensureUrl(
      state.coolifyPreviewUrls?.health ?? state.coolifyApplicationUrl,
    );
    const sandbox = new CoolifySandbox(
      new CoolifyFileSystem(fsBaseUrl, state.fsApiToken),
      state,
      options,
    );

    if (options?.hooks?.afterStart) {
      await options.hooks.afterStart(sandbox);
    }

    // Bootstrap git workspace (same semantics as Vercel connector)
    try {
      const cwd = DEFAULT_WORKING_DIRECTORY;
      if (!options?.skipGitWorkspaceBootstrap) {
        if (state.source?.repo) {
          const prev = sandbox.githubAuthToken;
          if (options?.githubToken) {
            await sandbox.setGitHubAuthToken(options.githubToken);
          }
          try {
            await bootstrapSourceRepository({ sandbox, source: state.source });
          } finally {
            await sandbox.setGitHubAuthToken(prev);
          }
        } else {
          const check = await sandbox
            .exec("git rev-parse --is-inside-work-tree", cwd, 5_000)
            .catch(() => ({ success: false }) as ExecResult);
          if (!check.success) {
            await sandbox.exec("git init", cwd, 15_000).catch(() => undefined);
            if (options?.gitUser) {
              const safeName = String(options.gitUser.name).replace(
                /"/g,
                '\\"',
              );
              const safeEmail = String(options.gitUser.email).replace(
                /"/g,
                '\\"',
              );
              await sandbox
                .exec(`git config user.name "${safeName}"`, cwd, 5_000)
                .catch(() => undefined);
              await sandbox
                .exec(`git config user.email "${safeEmail}"`, cwd, 5_000)
                .catch(() => undefined);
              await sandbox
                .exec(
                  'git commit --allow-empty -m "Initial commit"',
                  cwd,
                  10_000,
                )
                .catch(() => undefined);
            }
          }
        }

        if (options?.gitUser && !state.source?.repo) {
          const safeName = String(options.gitUser.name).replace(/"/g, '\\"');
          const safeEmail = String(options.gitUser.email).replace(/"/g, '\\"');
          await sandbox
            .exec(`git config user.name "${safeName}"`, cwd, 5_000)
            .catch(() => undefined);
          await sandbox
            .exec(`git config user.email "${safeEmail}"`, cwd, 5_000)
            .catch(() => undefined);
        }
      }
    } catch (error) {
      console.warn("Failed to bootstrap git in Coolify workspace:", error);
    }

    return sandbox;
  }

  // ── Sandbox interface ────────────────────────────────

  async access(path: string): Promise<void> {
    return this.fs.access(path);
  }

  domain(port: number): string {
    if (
      port === CODE_SERVER_PORT &&
      this.state.coolifyPreviewUrls?.codeServer
    ) {
      return this.state.coolifyPreviewUrls.codeServer;
    }
    if (port === HEALTH_PORT && this.state.coolifyPreviewUrls?.health) {
      return this.state.coolifyPreviewUrls.health;
    }
    // Coolify proxies the main exposed port — return the app URL
    return (
      this.state.coolifyPreviewUrls?.app ??
      this.state.coolifyApplicationUrl ??
      ""
    );
  }

  async exec(
    command: string,
    cwd: string,
    timeoutMs: number,
    options?: { signal?: AbortSignal },
  ): Promise<ExecResult> {
    const cmd = this.githubAuthToken
      ? buildGitHubAuthExecCommand(command, this.githubAuthToken)
      : command;
    return this.fs.exec(cmd, cwd, timeoutMs, options?.signal);
  }

  async execDetached(
    command: string,
    cwd: string,
  ): Promise<{ commandId: string }> {
    return this.fs.execDetached(command, cwd);
  }

  getState(): CoolifyState {
    return this.state;
  }

  async setGitHubAuthToken(token?: string): Promise<void> {
    this.githubAuthToken = token;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    return this.fs.mkdir(path, options?.recursive ?? true);
  }

  async readFile(path: string, encoding: "utf-8"): Promise<string> {
    return this.fs.readFile(path, encoding);
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    return this.fs.readFileBuffer(path);
  }

  async readdir(
    path: string,
    _options: { withFileTypes: true },
  ): Promise<Dirent[]> {
    return this.fs.readdir(path);
  }

  async stat(path: string): Promise<SandboxStats> {
    return this.fs.stat(path);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.hooks?.beforeStop) {
      await this.hooks.beforeStop(this);
    }
  }

  async writeFile(
    path: string,
    content: string,
    encoding: "utf-8",
  ): Promise<void> {
    return this.fs.writeFile(path, content, encoding);
  }

  // ── snapshot support ──────────────────────────────────

  async snapshot(): Promise<SnapshotResult> {
    // Create tar inside container then read back
    const SNAPSHOT_FILE = ".snapshot/workspace.tar.gz";
    const execR = await this.fs.exec(
      `mkdir -p /workspace/.snapshot && tar czf /workspace/${SNAPSHOT_FILE} --exclude=.snapshot --exclude=node_modules --exclude=.git -C /workspace .`,
      DEFAULT_WORKING_DIRECTORY,
      60_000,
    );
    if (!execR.success) {
      throw new Error(
        `Failed to create workspace snapshot: ${execR.stderr || execR.stdout || `exit code ${execR.exitCode}`}`,
      );
    }

    const buf = await this.fs.readFileBuffer(SNAPSHOT_FILE);
    // Clean up
    await this.fs
      .exec("rm -rf /workspace/.snapshot", DEFAULT_WORKING_DIRECTORY, 10_000)
      .catch(() => undefined);

    // Store as base64 snapshot ID
    const snapshotId = buf.toString("base64");
    return { snapshotId };
  }
}
