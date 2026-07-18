---
title: "Project Sessions — Testing Plan"
feature_id: "project-sessions"
artifact: "testing-plan"
status: "draft"
version: "1"
owner_agent: "QA"
parent_feature: "project-sessions"
last_updated: "2026-07-13"
---

# Project Sessions — Testing Plan

## 1. Test Strategy

- **Unit tests**: ACP bridge handlers (bun test), sandbox methods (bun test)
- **SIT**: Shell-based end-to-end tests against running `vercel dev`, extended from existing `acp-mcp-coolify-sit.sh`
- **Manual verification**: Coordinator agent-driven journeys using real Coolify + GitHub

## 2. Existing Baseline Tests

The following tests already pass in `acp-mcp-coolify-sit.sh` (CF-1 through CF-17):

| Test | What it covers |
|---|---|
| CF-1 | Server alive |
| CF-2 | tools/list returns 39+ tools |
| CF-3 | Coolify session creation |
| CF-4 | Write file via ACP |
| CF-5 | Read file via ACP |
| CF-6 | Terminal exec via ACP |
| CF-7 | LLM agent simple chat |
| CF-8 | LLM agent reads file via tools |
| CF-9 | LLM agent writes file via tools |
| CF-10 | LLM agent verifies file content |
| CF-11 | LLM agent greps for content |
| CF-12 | Session metadata with preview URLs |
| CF-13 | Copy file to sandbox |
| CF-14 | Health endpoint verification |
| CF-15 | Archive (close) session → stop container |
| CF-16 | Unarchive (resume) session → start container |
| CF-17 | Cleanup (delete session + Coolify app) |

## 3. P1 Tests: Secret Management

### P1.1 Unit tests

| Test | File | What |
|---|---|---|
| `acp_secret_set` handler defined | bridge.test.ts | Handler exists and validates input |
| `acp_secret_list` handler defined | bridge.test.ts | Handler exists |
| `acp_secret_delete` handler defined | bridge.test.ts | Handler exists |
| SandboxOps has secret methods | bridge.test.ts | Type check passes |

### P1.2 SIT tests (add to acp-mcp-coolify-sit.sh as CF-18..CF-20)

| ID | Test | Steps | Expected |
|---|---|---|---|
| CF-18 | Set secret via acp_secret_set | `acp_secret_set({ sessionId, envVars: { TEST_VAR: "test-value" } })` | `{ stored: 1 }` |
| CF-19 | List secrets via acp_secret_list | `acp_secret_list({ sessionId })` | Response includes `{ name: "TEST_VAR" }` |
| CF-20 | Verify env var available in container | `acp_terminal_create({ command: "echo $TEST_VAR" })` | Output contains "test-value" |
| CF-21 | Delete secret via acp_secret_delete | `acp_secret_delete({ sessionId, name: "TEST_VAR" })` | `{ deleted: true }` |
| CF-22 | Verify secret removed | `acp_secret_list({ sessionId })` | TEST_VAR no longer in list |

## 4. P2 Tests: GitHub Repo Tools

### P2.1 Unit tests

| Test | File | What |
|---|---|---|
| `acp_github_create_repo` handler | bridge.test.ts | Handler exists |
| `acp_github_attach_repo` handler | bridge.test.ts | Handler exists |
| `acp_github_push` handler | bridge.test.ts | Handler exists |
| `acp_github_create_pr` handler | bridge.test.ts | Handler exists |

### P2.2 SIT tests (CF-23..CF-26)

| ID | Test | Steps | Expected |
|---|---|---|---|
| CF-23 | Create session with repoUrl + branch | `acp_session_new({ sandboxType: "coolify:oai", repoUrl: "https://github.com/test/repo", branch: "main" })` | Session created, repo cloned into /workspace |
| CF-24 | Verify repo files exist | `acp_fs_read_text_file({ path: "/workspace/README.md" })` | Content matches repo's README |
| CF-25 | Attach repo to existing session | `acp_github_attach_repo({ sessionId, repoUrl, branch: "develop" })` | Branch switched to develop |
| CF-26 | Verify branch | `acp_terminal_create({ command: "git branch --show-current" })` | Output "develop" |

## 5. P3 Tests: Dev Server Lifecycle

### P5.1 Unit tests

| Test | File | What |
|---|---|---|
| `acp_deploy_start_dev` handler | bridge.test.ts | Handler exists |
| `acp_deploy_stop_dev` handler | bridge.test.ts | Handler exists |
| `acp_deploy_get_preview_url` handler | bridge.test.ts | Handler exists |

### P5.2 SIT tests (CF-27..CF-29)

| ID | Test | Steps | Expected |
|---|---|---|---|
| CF-27 | Start dev server | `acp_deploy_start_dev({ sessionId, command: "node /workspace/http.js" })` | Returns `previewUrl` matching sandboxMetadata.app |
| CF-28 | Get preview URL | `acp_deploy_get_preview_url({ sessionId })` | Returns URL, curl to it returns "Hello World" |
| CF-29 | Stop dev server | `acp_deploy_stop_dev({ sessionId })` | `{ stopped: true }` |

## 6. P4 Tests: Session Hierarchy

### P6.1 Unit tests

| Test | File | What |
|---|---|---|
| `acp_session_get_tree` handler | bridge.test.ts | Handler exists |
| `acp_sandbox_bulk_action` handler | bridge.test.ts | Handler exists |
| Session type in DB schema | schema.test.ts | Column exists with correct enum |

### P6.2 SIT tests (CF-30..CF-33)

| ID | Test | Steps | Expected |
|---|---|---|---|
| CF-30 | Create project session | `acp_session_new({ type: "project", sandboxType: "coolify:oadev" })` | Session type is "project" |
| CF-31 | Create child sessions | `acp_session_new({ type: "child", parentSessionId, sandboxType: "coolify:oai" })` x 2 | Two child sessions with parentSessionId set |
| CF-32 | Get session tree | `acp_session_get_tree({ sessionId: projectSessionId })` | Returns project + 2 children with nested structure |
| CF-33 | Bulk pause children | `acp_sandbox_bulk_action({ sessionId: projectSessionId, action: "pause" })` | All children paused; health endpoint fails |

## 7. P5 Tests: .composer.yml + Coordinator Skill

### P7.1 Agent simulation test

Create `scripts/test-project-coordinator.sh`:

1. Create project session
2. Write `.composer.yml` to /workspace with 2 modules
3. Call agent prompt: "parse .composer.yml and create child sessions for each module"
4. Verify child sessions created with correct repo URLs
5. Call agent prompt: "set env vars on child sessions"
6. Verify env vars via acp_secret_list
7. Call agent prompt: "start dev servers"
8. Verify health endpoints respond
9. Call agent prompt: "sync submodules and update .composer.yml version"
10. Verify .composer.yml version incremented

## 8. P6 Tests: End-to-End User Journey

### P8.1 Integration test

Create `scripts/project-coordinator-journey.sh`:

**Setup**:
1. Start vercel dev
2. Create project session with `haymant/oadev`
3. Agent creates monorepo + 2 submodule repos on GitHub
4. Agent scaffolds `.composer.yml`
5. Agent creates child sessions, attaches repos, sets env vars

**Development simulation**:
6. Child 1 agent writes API code, commits, pushes
7. Child 2 agent writes web code, commits, pushes
8. Coordinator agent syncs submodules
9. Coordinator starts dev servers in dependency order

**Verification**:
10. Health endpoints return OK for both services
11. Web service can call API service (cross-referencing via env vars)

**Teardown**:
12. Stop dev servers
13. Bulk-delete child sessions
14. Delete project session

## 9. Test Environment Requirements

| Resource | Required | Notes |
|---|---|---|
| Running `vercel dev` | Yes | Port 3000 |
| Coolify instance | Yes | Configured via TEST_COOLIFY_* env vars |
| Docker images | Yes | `haymant/oai` and `haymant/oadev` pushed to registry |
| GitHub App | Yes | Already configured for repo operations |
| GitHub test repos | Optional | Can create fresh repos per test run |
| `acp-mcp-coolify-sit.sh` | Yes | Extended with new CF tests |

## 10. Risk Register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Coolify env var API rate limits | Low | Medium | Batch env var updates |
| GitHub API rate limits | Medium | High | Use GitHub App installation token with higher limits |
| Docker image pull timeout | Low | Medium | Pre-pull images on Coolify server |
| Secret exposure in logs | Low | High | Bridge never logs secret values; audit bridge response handling |
