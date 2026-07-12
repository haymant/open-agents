import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { URL } from "node:url";

const HEALTH_PORT = process.env.HEALTH_PORT
  ? Number(process.env.HEALTH_PORT)
  : 1222;
const HTTP_PORT = HEALTH_PORT;
const WORKSPACE = process.env.WORKSPACE_DIR || "/workspace";
const JSON_LIMIT_BYTES = 50 * 1024 * 1024;
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_SEARCH_DEPTH = 20;
const API_TOKEN = process.env.FS_API_TOKEN || "";

function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), {
    "Content-Type": "application/json; charset=utf-8",
  });
}

function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

function isAuthorized(req) {
  if (!API_TOKEN) {
    return true;
  }

  const authHeader = req.headers.authorization;
  return authHeader === `Bearer ${API_TOKEN}`;
}

function safePath(inputPath) {
  if (!inputPath) {
    return WORKSPACE;
  }

  const resolved = path.resolve(WORKSPACE, inputPath);
  if (!resolved.startsWith(WORKSPACE)) {
    throw new Error("Access denied");
  }
  return resolved;
}

async function searchFiles(rootDir, suffix, depth = 0) {
  if (depth > MAX_SEARCH_DEPTH) {
    return [];
  }

  const results = [];
  let entries;

  try {
    entries = await fs.readdir(rootDir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);

    if (entry.isDirectory()) {
      const nested = await searchFiles(fullPath, suffix, depth + 1);
      results.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(suffix)) {
      try {
        const stats = await fs.stat(fullPath);
        results.push({
          path: fullPath,
          name: entry.name,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        });
      } catch {
        // skip files that can't be stat'd
      }
    }
  }

  return results;
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > JSON_LIMIT_BYTES) {
      throw new Error("Request body too large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

async function ensureWorkspaceDir(dirPath = WORKSPACE) {
  await fs.mkdir(dirPath, { recursive: true });
}

function normalizeDirEntry(entry, stats) {
  return {
    name: entry.name,
    isDir: entry.isDirectory(),
    isFile: entry.isFile(),
    size: entry.isDirectory() ? null : stats.size,
    modified: stats.mtime.toISOString(),
  };
}

async function statPayload(targetPath) {
  const stats = await fs.stat(targetPath);
  return {
    path: targetPath,
    exists: true,
    isDir: stats.isDirectory(),
    isFile: stats.isFile(),
    size: stats.size,
    modified: stats.mtime.toISOString(),
    mtimeMs: stats.mtimeMs,
  };
}

async function handleListFiles(res, requestUrl) {
  const dir = requestUrl.searchParams.get("path") || ".";
  const fullPath = safePath(dir);
  const items = await fs.readdir(fullPath, { withFileTypes: true });
  const result = await Promise.all(
    items.map(async (item) => {
      const itemPath = path.join(fullPath, item.name);
      const stats = await fs.stat(itemPath);
      return normalizeDirEntry(item, stats);
    }),
  );
  sendJson(res, 200, result);
}

async function handleReadFile(res, requestUrl) {
  const requestPath = requestUrl.searchParams.get("path");
  const encoding = requestUrl.searchParams.get("encoding") || "utf8";
  const filePath = safePath(requestPath);
  const fileBuffer = await fs.readFile(filePath);

  if (encoding === "base64") {
    sendJson(res, 200, { content: fileBuffer.toString("base64") });
    return;
  }

  sendJson(res, 200, { content: fileBuffer.toString("utf8") });
}

async function handleWriteFile(req, res) {
  const body = await readJsonBody(req);
  const filePath = safePath(body.path);
  const encoding = body.encoding === "base64" ? "base64" : "utf8";
  const content = typeof body.content === "string" ? body.content : "";

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, encoding);
  sendJson(res, 200, { success: true });
}

async function handleDelete(requestUrl, res) {
  const requestPath = requestUrl.searchParams.get("path");
  const filePath = safePath(requestPath);
  await fs.rm(filePath, { recursive: true, force: true });
  sendJson(res, 200, { success: true });
}

async function handleMkdir(req, res) {
  const body = await readJsonBody(req);
  const dirPath = safePath(body.path);
  await fs.mkdir(dirPath, { recursive: true });
  sendJson(res, 200, { success: true });
}

async function handleSearch(req, res) {
  const body = await readJsonBody(req);
  const suffix = String(body.pattern || "").trim();

  if (!suffix || suffix.length === 0) {
    sendJson(res, 200, []);
    return;
  }

  if (suffix.includes("..") || suffix.includes("/") || suffix.includes("\\")) {
    sendError(
      res,
      400,
      "Invalid pattern: path separators and parent traversal not allowed",
    );
    return;
  }

  try {
    const results = await searchFiles(WORKSPACE, suffix);
    sendJson(res, 200, results);
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
}

async function handleStat(requestUrl, res) {
  const requestPath = requestUrl.searchParams.get("path");
  const filePath = safePath(requestPath);
  sendJson(res, 200, await statPayload(filePath));
}

async function handleExec(req, res, detached) {
  const body = await readJsonBody(req);
  const cmd = body.cmd;
  if (!cmd) {
    sendError(res, 400, "cmd required");
    return;
  }

  const cwd = body.cwd ? safePath(body.cwd) : WORKSPACE;
  const args = Array.isArray(cmd) ? cmd : ["/bin/sh", "-lc", String(cmd)];

  if (cwd.startsWith(WORKSPACE)) {
    await ensureWorkspaceDir(cwd);
  }

  if (detached) {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      detached: true,
      env: process.env,
      stdio: "ignore",
    });
    child.unref();
    sendJson(res, 200, { pid: child.pid, commandId: String(child.pid) });
    return;
  }

  const timeoutMs =
    typeof body.timeoutMs === "number" && body.timeoutMs > 0
      ? body.timeoutMs
      : DEFAULT_EXEC_TIMEOUT_MS;

  const child = spawn(args[0], args.slice(1), {
    cwd,
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
  }, timeoutMs);

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    sendJson(res, 200, {
      code,
      stdout,
      stderr,
      success: code === 0 && !timedOut,
      timedOut,
    });
  });
  child.on("error", (error) => {
    clearTimeout(timer);
    sendJson(res, 500, {
      code: null,
      stdout,
      stderr: error.message,
      success: false,
      timedOut,
    });
  });
}

function handleProcessStatus(res, requestUrl) {
  const pidText = requestUrl.pathname.split("/").at(-1) || "";
  const pid = Number(pidText);
  if (!pid) {
    sendError(res, 400, "pid required");
    return;
  }

  try {
    process.kill(pid, 0);
    sendJson(res, 200, { pid, running: true });
  } catch {
    sendJson(res, 200, { pid, running: false });
  }
}

const server = createServer(async (req, res) => {
  const requestUrl = new URL(
    req.url || "/",
    `http://${req.headers.host || "127.0.0.1"}`,
  );

  if (req.method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/health") {
    send(res, 200, "ok", { "Content-Type": "text/plain; charset=utf-8" });
    return;
  }

  if (req.method === "GET" && requestUrl.pathname === "/api/meta") {
    sendJson(res, 200, {
      workspace: WORKSPACE,
      apiTokenRequired: API_TOKEN.length > 0,
      endpoints: [
        "GET /health",
        "GET /api/meta",
        "GET /api/files",
        "GET /api/files/content",
        "GET /api/files/stat",
        "POST /api/files/content",
        "POST /api/files/dir",
        "POST /api/files/search",
        "DELETE /api/files",
        "POST /api/exec",
        "POST /api/exec/detached",
        "GET /api/process/:pid",
      ],
    });
    return;
  }

  if (!isAuthorized(req)) {
    sendError(res, 401, "Unauthorized");
    return;
  }

  try {
    if (req.method === "GET" && requestUrl.pathname === "/api/files") {
      await handleListFiles(res, requestUrl);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/files/content") {
      await handleReadFile(res, requestUrl);
      return;
    }
    if (req.method === "GET" && requestUrl.pathname === "/api/files/stat") {
      await handleStat(requestUrl, res);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/files/content") {
      await handleWriteFile(req, res);
      return;
    }
    if (req.method === "DELETE" && requestUrl.pathname === "/api/files") {
      await handleDelete(requestUrl, res);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/files/dir") {
      await handleMkdir(req, res);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/files/search") {
      await handleSearch(req, res);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/exec") {
      await handleExec(req, res, false);
      return;
    }
    if (req.method === "POST" && requestUrl.pathname === "/api/exec/detached") {
      await handleExec(req, res, true);
      return;
    }
    if (
      req.method === "GET" &&
      requestUrl.pathname.startsWith("/api/process/")
    ) {
      handleProcessStatus(res, requestUrl);
      return;
    }

    sendError(res, 404, "Not found");
  } catch (error) {
    sendError(res, 500, error instanceof Error ? error.message : String(error));
  }
});

ensureWorkspaceDir()
  .then(() => {
    server.listen(HTTP_PORT, "0.0.0.0", () => {
      console.log(
        `[fs api] listening on 0.0.0.0:${HTTP_PORT}, workspace=${WORKSPACE}`,
      );
    });
  })
  .catch((error) => {
    console.error("failed to initialize workspace", error);
    process.exit(1);
  });

process.on("SIGINT", () => process.exit(0));
