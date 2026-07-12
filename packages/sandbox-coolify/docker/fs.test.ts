import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

type RunningServer = {
  port: number;
  process: Bun.Subprocess;
  workspaceDir: string;
};

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(`http://127.0.0.1:${port}/health`).catch(
      () => null,
    );
    if (response?.ok) {
      return;
    }
    await Bun.sleep(100);
  }

  throw new Error(`Timed out waiting for fs.js on port ${port}`);
}

describe("fs.js", () => {
  let server: RunningServer | null = null;

  beforeEach(async () => {
    const workspaceDir = await mkdtemp(path.join(tmpdir(), "coolify-fs-"));
    const port = 12280 + Math.floor(Math.random() * 1000);
    const child = Bun.spawn(
      [process.execPath, path.join(import.meta.dir, "fs.js")],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          HEALTH_PORT: String(port),
          WORKSPACE_DIR: workspaceDir,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    server = {
      port,
      process: child,
      workspaceDir,
    };

    await waitForHealth(port);
  });

  afterEach(async () => {
    if (server) {
      server.process.kill();
      await server.process.exited;
      await rm(server.workspaceDir, { force: true, recursive: true });
      server = null;
    }
  });

  test("serves health, file operations, and exec endpoints", async () => {
    const port = server?.port;
    expect(port).toBeDefined();

    const baseUrl = `http://127.0.0.1:${port}`;

    const metaResponse = await fetch(`${baseUrl}/api/meta`);
    expect(metaResponse.ok).toBe(true);
    const meta = await metaResponse.json();
    expect(meta.workspace).toBe(server?.workspaceDir);

    const writeResponse = await fetch(`${baseUrl}/api/files/content`, {
      body: JSON.stringify({ content: "hello from test", path: "hello.txt" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(writeResponse.ok).toBe(true);

    const readResponse = await fetch(
      `${baseUrl}/api/files/content?path=hello.txt`,
    );
    expect(readResponse.ok).toBe(true);
    expect((await readResponse.json()).content).toBe("hello from test");

    const statResponse = await fetch(
      `${baseUrl}/api/files/stat?path=hello.txt`,
    );
    expect(statResponse.ok).toBe(true);
    const stat = await statResponse.json();
    expect(stat.isFile).toBe(true);
    expect(stat.size).toBeGreaterThan(0);

    const listResponse = await fetch(`${baseUrl}/api/files?path=.`);
    expect(listResponse.ok).toBe(true);
    const entries = await listResponse.json();
    expect(
      entries.some((entry: { name: string }) => entry.name === "hello.txt"),
    ).toBe(true);

    const execResponse = await fetch(`${baseUrl}/api/exec`, {
      body: JSON.stringify({ cmd: "pwd && cat hello.txt", cwd: "." }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(execResponse.ok).toBe(true);
    const execPayload = await execResponse.json();
    expect(execPayload.success).toBe(true);
    expect(execPayload.stdout).toContain("hello from test");

    const detachedResponse = await fetch(`${baseUrl}/api/exec/detached`, {
      body: JSON.stringify({ cmd: 'node -e "setTimeout(() => {}, 1000)"' }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(detachedResponse.ok).toBe(true);
    const detachedPayload = await detachedResponse.json();
    expect(detachedPayload.commandId).toBeTruthy();

    const processResponse = await fetch(
      `${baseUrl}/api/process/${detachedPayload.commandId}`,
    );
    expect(processResponse.ok).toBe(true);
    expect((await processResponse.json()).running).toBe(true);
  });

  test("POST /api/files/search returns matching files recursively", async () => {
    const port = server?.port;
    expect(port).toBeDefined();
    const baseUrl = `http://127.0.0.1:${port}`;

    // Create nested files to search
    const mkdir = (p: string) =>
      fetch(`${baseUrl}/api/files/dir`, {
        body: JSON.stringify({ path: p }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

    const write = (p: string, content: string) =>
      fetch(`${baseUrl}/api/files/content`, {
        body: JSON.stringify({ content, path: p }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

    await mkdir("nested");
    await mkdir("nested/deep");
    await mkdir("other");
    await write("root.md", "root file");
    await write("nested/skill.md", "nested skill");
    await write("nested/deep/skill.md", "deep skill");
    await write("other/readme.md", "readme");

    // Search for .md files
    const searchResponse = await fetch(`${baseUrl}/api/files/search`, {
      body: JSON.stringify({ pattern: ".md" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(searchResponse.ok).toBe(true);
    const results = await searchResponse.json();
    expect(Array.isArray(results)).toBe(true);
    expect(results.length).toBeGreaterThanOrEqual(3);
    expect(results.some((r: { name: string }) => r.name === "root.md")).toBe(
      true,
    );
    expect(results.some((r: { name: string }) => r.name === "skill.md")).toBe(
      true,
    );
  });

  test("POST /api/files/search returns empty array for no matches", async () => {
    const port = server?.port;
    expect(port).toBeDefined();
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/files/search`, {
      body: JSON.stringify({ pattern: ".nonexistent" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.ok).toBe(true);
    expect(await response.json()).toEqual([]);
  });

  test("POST /api/files/search rejects path traversal patterns", async () => {
    const port = server?.port;
    expect(port).toBeDefined();
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/files/search`, {
      body: JSON.stringify({ pattern: "../etc/passwd" }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });
    expect(response.ok).toBe(false);
    expect(response.status).toBe(400);
  });

  test("POST /api/files/search returns 404 for non-POST method", async () => {
    const port = server?.port;
    expect(port).toBeDefined();
    const baseUrl = `http://127.0.0.1:${port}`;

    const response = await fetch(`${baseUrl}/api/files/search`);
    expect(response.status).toBe(404);
  });
});
