---
name: "project-coordinator"
description: "Orchestrates multi-module project sessions: parse .composer.yml, create child sandboxes, attach repos, set secrets, start dev servers, sync submodules, and teardown."
context: "Multi-service project orchestration via ACP bridge on Coolify sandboxes"
argument-hint: "Use when a user asks to set up, sync, or tear down a multi-module project, or when .composer.yml is present in the workspace"
compatibility: "ACP Bridge v0.1+, Coolify v4.x"
user-invocable: false
metadata:
  agent: Orchestrator
  feature: project-sessions
  parent: acp-mcp
  requires:
    - acp_deploy_start_dev
    - acp_deploy_stop_dev
    - acp_deploy_get_preview_url
    - acp_secret_set
    - acp_secret_list
    - acp_secret_delete
    - acp_github_create_repo
    - acp_github_attach_repo
    - acp_github_push
    - acp_github_create_pr
    - acp_session_get_tree
    - acp_sandbox_bulk_action
    - acp_session_new
    - acp_fs_write_text_file
    - acp_fs_read_text_file
    - acp_terminal_create
---

# Project Coordinator Skill

Coordinates multi-module projects in a Coolify sandbox using `.composer.yml` as the manifest.

---

## 1. `.composer.yml` Schema

A YAML file at `/workspace/.composer.yml` that declares the project's modules and their relationships.

```yaml
version: 1
project: "my-project"
modules:
  - name: "api"              # Module identifier
    repo: "https://github.com/org/api"   # Git repo URL
    branch: "main"            # Branch (default: main)
    command: "npm run dev"    # Dev server command (default: npm run dev)
    port: 3000                # Dev server port (default: 3000)
    env:                      # Optional env vars (set via acp_secret_set)
      DATABASE_URL: "..."
      API_KEY: "..."
    depends_on: []            # Module names this depends on (start order)

  - name: "web"
    repo: "https://github.com/org/web"
    branch: "main"
    command: "npm run dev"
    port: 3000
    env: {}
    depends_on: ["api"]

# Written back by the coordinator after setup:
state:
  version: 1
  sessions:
    api:
      sessionId: "..."
      previewUrl: "..."
    web:
      sessionId: "..."
      previewUrl: "..."
```

### Validation rules
- `version` must be a positive integer
- `project` must be a non-empty string
- `modules` must be a non-empty array
- Each module must have a `name`
- `depends_on` references must match other module `name` values (no dangling refs)
- No circular dependencies in `depends_on`

---

## 2. Discovery

When the agent detects a `.composer.yml` in `/workspace` (or the user mentions a multi-module project):

1. Read the file via `acp_fs_read_text_file` with URI `file:///workspace/.composer.yml`
2. Parse the YAML (the agent can use the LLM or a bash `python3 -c "import yaml; ..."` call via `acp_terminal_create`)
3. Validate the schema against the rules above
4. Report the module list and dependency order to the user

---

## 3. Setup Workflow

For each module in dependency order (leaves first, roots last):

### 3.1 Check for existing child session
Call `acp_session_get_tree` on the parent project session. If a child session with matching `name` exists in `sandboxMetadata`, reuse it.

### 3.2 Create child session
```json
{
  "name": "acp_session_new",
  "arguments": {
    "sandboxType": "coolify:default",
    "type": "child",
    "parentSessionId": "<parent-session-id>",
    "repoUrl": "<module.repo>",
    "branch": "<module.branch>"
  }
}
```
Store the returned `sessionId`.

### 3.3 Attach repo
If the repo wasn't cloned during provisioning, call:
```json
{
  "name": "acp_github_attach_repo",
  "arguments": {
    "sessionId": "<child-session-id>",
    "repoUrl": "<module.repo>",
    "branch": "<module.branch>"
  }
}
```

### 3.4 Set env vars
If the module defines `env`, call `acp_secret_set` for each child session:
```json
{
  "name": "acp_secret_set",
  "arguments": {
    "sessionId": "<child-session-id>",
    "envVars": { "KEY": "VALUE", ... }
  }
}
```

### 3.5 Start dev server
```json
{
  "name": "acp_deploy_start_dev",
  "arguments": {
    "sessionId": "<child-session-id>",
    "command": "<module.command>"
  }
}
```
Store the returned `previewUrl`.

### 3.6 Update `.composer.yml`
Write back the `state` section with session IDs and preview URLs for each module.

---

## 4. Sync Workflow

When the user asks to sync or update:

1. For each module's child session, check if there are new commits in the repo
   - Call `acp_terminal_create` with `git fetch origin` and `git log HEAD..origin/<branch> --oneline`
2. If updates exist, run `git pull --rebase` in each child session
3. In the parent session, run `git submodule update --remote` if using submodules
4. Commit and push via `acp_github_push`
5. Update `.composer.yml` version
6. If dev servers need restarting, stop then start them

---

## 5. Teardown Workflow

When the user asks to stop or clean up:

1. Stop all dev servers in child sessions via `acp_deploy_stop_dev`
2. Call `acp_sandbox_bulk_action` with `action: "pause"` (or `"delete"`) on the parent session
3. Optionally update `.composer.yml` to remove `state`

---

## 6. Error Handling

- If a child session creation fails, skip that module and report the error
- If `acp_secret_set` fails, continue (env vars are optional for the dev server to start)
- If a dev server fails to start, report the error but continue with other modules
- On teardown, try each step and log failures — don't abort mid-teardown
