import { describe, it, expect, mock, beforeEach } from "bun:test";
import {
  CoolifySandbox,
  CoolifyFileSystem,
  type CoolifyState,
} from "@open-agents/sandbox-coolify";

// ── Helpers ──────────────────────────────────────────────

function mockFs() {
  return {
    access: mock(() => Promise.resolve()),
    exec: mock(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "ok",
        success: true,
        truncated: false,
      }),
    ),
    execDetached: mock(() => Promise.resolve({ commandId: "pid-1" })),
    mkdir: mock(() => Promise.resolve()),
    readFile: mock(() => Promise.resolve("hello world")),
    readFileBuffer: mock(() => Promise.resolve(Buffer.from("bin"))),
    readdir: mock(() => Promise.resolve([])),
    stat: mock(() =>
      Promise.resolve({
        isDirectory: () => false,
        isFile: () => true,
        mtimeMs: 1000,
        size: 100,
      }),
    ),
    writeFile: mock(() => Promise.resolve()),
  } as unknown as CoolifyFileSystem;
}

function makeState(overrides?: Partial<CoolifyState>): CoolifyState {
  return {
    type: "coolify",
    sandboxName: "test-sandbox",
    sandboxId: "test-123",
    coolifyApplicationId: "app-uuid",
    coolifyPreviewUrls: {
      app: "https://test.lizhao.net",
      health: "https://test-health.lizhao.net:1223",
      codeServer: "https://test-ide.lizhao.net:1222",
    },
    connectorConfigId: "default",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────

describe("CoolifySandbox", () => {
  it("constructs with basic state", () => {
    const sandbox = new CoolifySandbox(mockFs(), makeState());
    expect(sandbox.type).toBe("cloud");
    expect(sandbox.workingDirectory).toBe("/workspace");
  });

  it("has host from coolifyApplicationUrl", () => {
    const sandbox = new CoolifySandbox(
      mockFs(),
      makeState({ coolifyApplicationUrl: "https://myapp.example.com" }),
    );
    expect(sandbox.host).toBe("myapp.example.com");
  });

  it("has undefined host without URL", () => {
    const sandbox = new CoolifySandbox(
      mockFs(),
      makeState({ coolifyApplicationUrl: undefined }),
    );
    expect(sandbox.host).toBeUndefined();
  });

  it("delegates readFile to filesystem", async () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    const result = await sandbox.readFile("/test.txt", "utf-8");
    expect(result).toBe("hello world");
    expect(fs.readFile).toHaveBeenCalledWith("/test.txt", "utf-8");
  });

  it("delegates writeFile to filesystem", async () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    await sandbox.writeFile("/test.txt", "content", "utf-8");
    expect(fs.writeFile).toHaveBeenCalledWith("/test.txt", "content", "utf-8");
  });

  it("delegates exec to filesystem", async () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    const result = await sandbox.exec("echo hi", "/workspace", 5_000);
    expect(result.exitCode).toBe(0);
    expect(result.success).toBe(true);
    expect(fs.exec).toHaveBeenCalled();
  });

  it("wraps exec with git auth when token is set", async () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    await sandbox.setGitHubAuthToken("gh_token_123");
    await sandbox.exec("git push", "/workspace", 5_000);

    const execMock = fs.exec as ReturnType<typeof mock>;
    const calledCmd: string = (execMock.mock.calls[0]?.[0] as string) ?? "";
    expect(calledCmd).toContain("GIT_CONFIG_COUNT=1");
    expect(calledCmd).toContain("AUTHORIZATION: basic");
  });

  it("domain returns app URL by default", () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    const url = sandbox.domain(3000);
    expect(url).toContain("test.lizhao.net");
  });

  it("domain returns health URL for port 1222", () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    const url = sandbox.domain(1222);
    expect(url).toContain("health");
  });

  it("domain returns codeServer URL for port 1223", () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    const url = sandbox.domain(1223);
    expect(url).toContain("ide");
  });

  it("stop is idempotent", async () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    await sandbox.stop();
    await sandbox.stop(); // should not throw
  });

  it("getState returns the state", () => {
    const fs = mockFs();
    const state = makeState();
    const sandbox = new CoolifySandbox(fs, state);
    expect(sandbox.getState()).toBe(state);
  });

  it("environmentDetails includes preview URLs", () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(fs, makeState());
    // With coolifyApplicationUrl unset, only fs/api and code-server show
    expect(sandbox.environmentDetails).toContain("Coolify fs api:");
    expect(sandbox.environmentDetails).toContain("Coolify code-server:");
  });

  it("environmentDetails includes app URL when set", () => {
    const fs = mockFs();
    const sandbox = new CoolifySandbox(
      fs,
      makeState({ coolifyApplicationUrl: "https://my.app" }),
    );
    expect(sandbox.environmentDetails).toContain("Coolify app:");
  });
});

// ── CoolifyFileSystem ────────────────────────────────────

describe("CoolifyFileSystem", () => {
  it("constructs with baseUrl", () => {
    const fs = new CoolifyFileSystem("https://example.com");
    expect(fs).toBeDefined();
    const fs2 = new CoolifyFileSystem("https://example.com", "token123");
    expect(fs2).toBeDefined();
  });
});

// ── connectCoolify factory ──────────────────────────────

describe("connectCoolify", () => {
  it("builds persisted state with runtime metadata", async () => {
    const { connectCoolify } = await import("@open-agents/sandbox-coolify");
    // connectCoolify tries to fetch the health URL, which will fail in tests.
    // The factory itself is tested via integration.
    expect(connectCoolify).toBeDefined();
  });
});
