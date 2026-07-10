import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

type AuthSession = {
  user: {
    id: string;
  };
} | null;

let authSession: AuthSession;

mock.module("@/lib/session/get-server-session", () => ({
  getServerSession: async () => authSession,
}));

// Mock GitHub token — return null by default (no token connected)
let mockToken: string | null = null;
mock.module("@/lib/github/token", () => ({
  getUserGitHubToken: async () => mockToken,
}));

// Mock DB update
mock.module("@/lib/db/sessions", () => ({
  updateSession: async () => ({}),
}));

const routeModulePromise = import("./route");

function createRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/github/create-repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("/api/github/create-repo", () => {
  beforeEach(() => {
    authSession = {
      user: {
        id: "user-1",
      },
    };
    mockToken = null;
  });

  test("returns 401 when unauthenticated", async () => {
    authSession = null;
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest({ sessionId: "session-1" }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Not authenticated" });
  });

  test("returns 400 for invalid JSON", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      new Request("http://localhost/api/github/create-repo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Invalid JSON body" });
  });

  test("returns 400 when missing required fields", async () => {
    mockToken = "github-token";
    const { POST } = await routeModulePromise;

    const response = await POST(createRequest({ sessionId: "session-1" }));

    expect(response.status).toBe(400);
    const json = await response.json();
    expect(json.error).toContain("Missing required fields");
  });

  test("returns 400 when GitHub is not connected", async () => {
    const { POST } = await routeModulePromise;

    const response = await POST(
      createRequest({
        sessionId: "session-1",
        repoName: "my-repo",
        owner: "test-user",
      }),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "GitHub account not connected. Please connect GitHub in settings.",
    });
  });
});
