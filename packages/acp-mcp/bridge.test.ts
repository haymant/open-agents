import { describe, test, expect, mock } from "bun:test";
import { createHandlers, type SessionStore, type SandboxOps } from "./bridge";

// ── Mocks ─────────────────────────────────────────────────────────

let mockCreateCounter = 0;
const mockStore: SessionStore = {
  create: mock(async (params: { cwd?: string }) => {
    mockCreateCounter++;
    return {
      sessionId: `test-session-${mockCreateCounter}`,
      sandboxName: `acp-test-session-${mockCreateCounter}`,
      cwd: params.cwd ?? "/vercel/sandbox",
    };
  }),
  get: mock(async (id: string) =>
    id === "test-session-1"
      ? {
          sandboxName: "acp-test-session-1",
          cwd: "/vercel/sandbox",
          mode: "code",
        }
      : undefined,
  ),
  list: mock(async () => [{ sessionId: "test-session-1" }]),
  delete: mock(async () => {}),
  update: mock(async () => {}),
};

const mockSandbox: SandboxOps = {
  readFile: mock(async () => "Hello from sandbox"),
  writeFile: mock(async () => {}),
  runCommand: mock(async () => ({
    stdout: "hello world",
    stderr: "",
    exitCode: 0,
  })),
  prompt: mock(async () => "hello world"),
};

function createTestHandlers() {
  return createHandlers(mockStore, mockSandbox);
}

// ── Tests ─────────────────────────────────────────────────────────

describe("acp_initialize", () => {
  const h = createTestHandlers();

  test("returns protocol version and capabilities", async () => {
    const res = await h.acp_initialize({ protocolVersion: 1 });
    const data = JSON.parse(res[0].text);
    expect(data.protocolVersion).toBe(1);
    expect(data.agentCapabilities.loadSession).toBe(true);
    expect(data.agentCapabilities.sessionCapabilities.list).toBe(true);
    expect(data.agentInfo.name).toBe("Open Agents ACP Bridge");
  });

  test("defaults protocol version when omitted", async () => {
    const res = await h.acp_initialize({});
    const data = JSON.parse(res[0].text);
    expect(data.protocolVersion).toBe(1);
  });
});

describe("acp_authenticate", () => {
  const h = createTestHandlers();

  test("returns authenticated", async () => {
    const res = await h.acp_authenticate({ methodId: "bearer" });
    const data = JSON.parse(res[0].text);
    expect(data.authenticated).toBe(true);
  });
});

describe("acp_logout", () => {
  const h = createTestHandlers();

  test("returns empty object", async () => {
    const res = await h.acp_logout({});
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("acp_providers_list", () => {
  const h = createTestHandlers();

  test("returns providers array", async () => {
    const res = await h.acp_providers_list({});
    const data = JSON.parse(res[0].text);
    expect(data.providers).toBeInstanceOf(Array);
    expect(data.providers.length).toBeGreaterThanOrEqual(2);
    expect(data.providers[0]).toHaveProperty("id");
  });
});

describe("acp_providers_set / disable", () => {
  const h = createTestHandlers();

  test("set returns empty", async () => {
    const res = await h.acp_providers_set({ provider: "openai" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("disable returns empty", async () => {
    const res = await h.acp_providers_disable({ provider: "openai" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("acp_session_new", () => {
  const h = createTestHandlers();

  test("creates session with given cwd", async () => {
    const res = await h.acp_session_new({ cwd: "/workspace" });
    const data = JSON.parse(res[0].text);
    expect(data.sessionId).toBeDefined();
    expect(data.cwd).toBe("/workspace");
    expect(data.availableModes).toBeInstanceOf(Array);
  });

  test("creates session with default cwd", async () => {
    const res = await h.acp_session_new({});
    const data = JSON.parse(res[0].text);
    expect(data.sessionId).toBeDefined();
    expect(data.cwd).toBe("/vercel/sandbox");
  });
});

describe("acp_session_load", () => {
  const h = createTestHandlers();

  test("loads existing session", async () => {
    const res = await h.acp_session_load({ sessionId: "test-session-1" });
    const data = JSON.parse(res[0].text);
    expect(data.sessionId).toBe("test-session-1");
    expect(data.cwd).toBe("/vercel/sandbox");
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_session_load({ sessionId: "nonexistent" });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_session_list", () => {
  const h = createTestHandlers();

  test("returns sessions array", async () => {
    const res = await h.acp_session_list({});
    const data = JSON.parse(res[0].text);
    expect(data.sessions).toBeInstanceOf(Array);
    expect(data.sessions.length).toBeGreaterThanOrEqual(1);
  });
});

describe("acp_session_delete", () => {
  const h = createTestHandlers();

  test("deletes session", async () => {
    const res = await h.acp_session_delete({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
    expect(mockStore.delete).toHaveBeenCalledWith("test-session-1");
  });
});

describe("acp_session_fork", () => {
  const h = createTestHandlers();

  test("forks existing session", async () => {
    const res = await h.acp_session_fork({ sessionId: "test-session-1" });
    const data = JSON.parse(res[0].text);
    expect(data.sessionId).toBeDefined();
    expect(data.sessionId).not.toBe("test-session-1");
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_session_fork({ sessionId: "nonexistent" });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Source session not found");
  });
});

describe("acp_session_resume", () => {
  const h = createTestHandlers();

  test("resumes existing session", async () => {
    const res = await h.acp_session_resume({ sessionId: "test-session-1" });
    const data = JSON.parse(res[0].text);
    expect(data.sessionId).toBe("test-session-1");
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_session_resume({ sessionId: "nonexistent" });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_session_close", () => {
  const h = createTestHandlers();

  test("closes session", async () => {
    const res = await h.acp_session_close({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("acp_session_set_mode", () => {
  const h = createTestHandlers();

  test("sets mode on existing session", async () => {
    const res = await h.acp_session_set_mode({
      sessionId: "test-session-1",
      mode: "ask",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
    expect(mockStore.update).toHaveBeenCalled();
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_session_set_mode({
      sessionId: "nonexistent",
      mode: "ask",
    });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_session_set_config_option", () => {
  const h = createTestHandlers();

  test("returns config options", async () => {
    const res = await h.acp_session_set_config_option({
      sessionId: "test-session-1",
      option: "theme",
    });
    const data = JSON.parse(res[0].text);
    expect(data).toHaveProperty("configOptions");
  });
});

describe("acp_session_prompt", () => {
  const h = createTestHandlers();

  test("returns assistant response for valid session", async () => {
    const res = await h.acp_session_prompt({
      sessionId: "test-session-1",
      message: { role: "user", content: [{ type: "text", text: "hello" }] },
    });
    const data = JSON.parse(res[0].text);
    expect(data.messages).toBeInstanceOf(Array);
    expect(data.messages[0].role).toBe("assistant");
    expect(data.messages[0].content[0].text).toBe("hello world");
    expect(data.stopReason).toBe("end_turn");
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_session_prompt({
      sessionId: "nonexistent",
      message: {},
    });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_session_cancel", () => {
  const h = createTestHandlers();

  test("returns empty", async () => {
    const res = await h.acp_session_cancel({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("acp_fs_read_text_file", () => {
  const h = createTestHandlers();

  test("reads file from sandbox", async () => {
    const res = await h.acp_fs_read_text_file({
      sessionId: "test-session-1",
      uri: "/test.txt",
    });
    const data = JSON.parse(res[0].text);
    expect(data.content).toBe("Hello from sandbox");
  });

  test("strips file:// prefix", async () => {
    await h.acp_fs_read_text_file({
      sessionId: "test-session-1",
      uri: "file:///test.txt",
    });
    expect(mockSandbox.readFile).toHaveBeenCalledWith(
      "acp-test-session-1",
      "/test.txt",
    );
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_fs_read_text_file({
      sessionId: "nonexistent",
      uri: "/test.txt",
    });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_fs_write_text_file", () => {
  const h = createTestHandlers();

  test("writes file to sandbox", async () => {
    const res = await h.acp_fs_write_text_file({
      sessionId: "test-session-1",
      uri: "/test.txt",
      content: "data",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
    expect(mockSandbox.writeFile).toHaveBeenCalledWith(
      "acp-test-session-1",
      "/test.txt",
      "data",
    );
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_fs_write_text_file({
      sessionId: "nonexistent",
      uri: "/test.txt",
      content: "data",
    });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_terminal_create", () => {
  const h = createTestHandlers();

  test("runs command and returns result", async () => {
    const res = await h.acp_terminal_create({
      sessionId: "test-session-1",
      command: "echo",
      args: ["hi"],
    });
    const data = JSON.parse(res[0].text);
    expect(data.terminalId).toBeDefined();
    expect(data.initialOutput).toBe("hello world");
    expect(data.exitStatus.exitCode).toBe(0);
  });

  test("returns error for missing session", async () => {
    const res = await h.acp_terminal_create({
      sessionId: "nonexistent",
      command: "echo",
    });
    const data = JSON.parse(res[0].text);
    expect(data.error).toBe("Session not found");
  });
});

describe("acp_terminal_output / release / wait / kill", () => {
  const h = createTestHandlers();

  test("output returns empty", async () => {
    const res = await h.acp_terminal_output({
      sessionId: "test-session-1",
      terminalId: "t1",
    });
    const data = JSON.parse(res[0].text);
    expect(data).toHaveProperty("output");
  });

  test("release returns empty", async () => {
    const res = await h.acp_terminal_release({
      sessionId: "test-session-1",
      terminalId: "t1",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("wait_for_exit returns exit status", async () => {
    const res = await h.acp_terminal_wait_for_exit({
      sessionId: "test-session-1",
      terminalId: "t1",
    });
    const data = JSON.parse(res[0].text);
    expect(data.exitStatus).toBeDefined();
  });

  test("kill returns empty", async () => {
    const res = await h.acp_terminal_kill({
      sessionId: "test-session-1",
      terminalId: "t1",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("NES stubs", () => {
  const h = createTestHandlers();

  test("nes_start returns empty", async () => {
    const res = await h.acp_nes_start({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("nes_suggest returns suggestions array", async () => {
    const res = await h.acp_nes_suggest({ sessionId: "test-session-1" });
    const data = JSON.parse(res[0].text);
    expect(data.suggestions).toBeInstanceOf(Array);
  });

  test("nes_accept returns empty", async () => {
    const res = await h.acp_nes_accept({
      sessionId: "test-session-1",
      suggestionId: "s1",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("nes_reject returns empty", async () => {
    const res = await h.acp_nes_reject({
      sessionId: "test-session-1",
      suggestionId: "s1",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("nes_close returns empty", async () => {
    const res = await h.acp_nes_close({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("Document event stubs", () => {
  const h = createTestHandlers();

  test("didOpen returns empty", async () => {
    const res = await h.acp_document_did_open({
      sessionId: "test-session-1",
      uri: "file:///test.ts",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("didChange returns empty", async () => {
    const res = await h.acp_document_did_change({
      sessionId: "test-session-1",
      uri: "file:///test.ts",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("didClose returns empty", async () => {
    const res = await h.acp_document_did_close({
      sessionId: "test-session-1",
      uri: "file:///test.ts",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("didSave returns empty", async () => {
    const res = await h.acp_document_did_save({
      sessionId: "test-session-1",
      uri: "file:///test.ts",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });

  test("didFocus returns empty", async () => {
    const res = await h.acp_document_did_focus({
      sessionId: "test-session-1",
      uri: "file:///test.ts",
    });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("Client ops", () => {
  const h = createTestHandlers();

  test("request_permission auto-accepts", async () => {
    const res = await h.acp_request_permission({
      sessionId: "test-session-1",
      prompt: "Allow?",
      options: [],
    });
    const data = JSON.parse(res[0].text);
    expect(data.outcome.kind).toBe("approved");
  });

  test("session_update returns empty", async () => {
    const res = await h.acp_session_update({ sessionId: "test-session-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("Elicitation stubs", () => {
  const h = createTestHandlers();

  test("create returns elicitationId", async () => {
    const res = await h.acp_elicitation_create({ sessionId: "test-session-1" });
    const data = JSON.parse(res[0].text);
    expect(data.elicitationId).toBeDefined();
  });

  test("complete returns empty", async () => {
    const res = await h.acp_elicitation_complete({ elicitationId: "el-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});

describe("Protocol control", () => {
  const h = createTestHandlers();

  test("cancel_request returns empty", async () => {
    const res = await h.acp_cancel_request({ requestId: "req-1" });
    expect(JSON.parse(res[0].text)).toEqual({});
  });
});
