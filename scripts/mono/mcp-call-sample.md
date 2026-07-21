# MCP Call Sample — Project Sessions via ACP Bridge

This guide walks through the JSON-RPC calls to create a **parent project session with two child submodule sandboxes** — an API server (`sum.cjs`) and an HTML frontend (`sum.html`).

**Setup**: Open the MCP Inspector pointing at your local bridge:

```bash
npx @modelcontextprotocol/inspector http://localhost:3000/api/acpmcp
```

Authenticate by setting an `Authorization: Bearer <token>` header in the inspector (the `ACP_MCP_TOKEN` value from `apps/web/.env`).

---

## 1. List available tools

Verify the bridge is alive and see all tools:

```json
{
  "method": "tools/list",
  "jsonrpc": "2.0",
  "id": 1
}
```

You should see ~40+ tools including `acp_session_new`, `acp_deploy_start_dev`, `acp_secret_set`, `acp_session_get_tree`, etc.

The response also includes `activeProvider` and `activeModel` showing the currently configured LLM.

### Switch the LLM model (optional)

Before prompting, you can change which model the agent uses:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 2,
  "params": {
    "name": "acp_providers_set",
    "arguments": {
      "provider": "deepseek",
      "config": {
        "model": "deepseek/deepseek-v4-flash"
      }
    }
  }
}
```

Run `tools/list` again afterward to confirm `activeModel` changed.

---

## 2. Create parent project session

Create a top-level project session (type `"project"`). This session will hold the two child submodule sessions.

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 10,
  "params": {
    "name": "acp_session_new",
    "arguments": {
      "sandboxType": "coolify:default",
      "type": "project"
    }
  }
}
```

**Save the returned `sessionId`** — you'll use it as `parentSessionId` for children.

---

## 3. Load parent session (get preview URLs)

Retrieve metadata including `coolifyPreviewUrls` (app URL, health URL, code-server URL if using `haymant/oadev`):

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 20,
  "params": {
    "name": "acp_session_load",
    "arguments": {
      "sessionId": "<PARENT_SESSION_ID>"
    }
  }
}
```

---

## 4. Create module1 child session (the API / sum.cjs)

Create a child session that will run the sum calculator API:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 30,
  "params": {
    "name": "acp_session_new",
    "arguments": {
      "sandboxType": "coolify:default",
      "type": "child",
      "parentSessionId": "<PARENT_SESSION_ID>"
    }
  }
}
```

**Save the returned `sessionId`** as `MODULE1_SID`.

---

## 5. Create module2 child session (the UI / sum.html)

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 40,
  "params": {
    "name": "acp_session_new",
    "arguments": {
      "sandboxType": "coolify:default",
      "type": "child",
      "parentSessionId": "<PARENT_SESSION_ID>"
    }
  }
}
```

**Save the returned `sessionId`** as `MODULE2_SID`.

---

## 6. Write sum.cjs to module1

The API server exposes `/n1` → `1.1` and `/n2` → `2.1`:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 50,
  "params": {
    "name": "acp_fs_write_text_file",
    "arguments": {
      "sessionId": "<MODULE1_SID>",
      "uri": "file:///workspace/sum.cjs",
      "content": "require(\"http\").createServer((req, res) => { res.setHeader(\"Access-Control-Allow-Origin\", \"*\"); res.setHeader(\"Content-Type\", \"application/json\"); if (req.url === \"/n1\") return res.end(JSON.stringify({ value: 1.1 })); if (req.url === \"/n2\") return res.end(JSON.stringify({ value: 2.1 })); res.end(JSON.stringify({ error: \"not found\" })); }).listen(3000);"
    }
  }
}
```

---

## 7. Start dev server on module1

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 60,
  "params": {
    "name": "acp_deploy_start_dev",
    "arguments": {
      "sessionId": "<MODULE1_SID>",
      "command": "cd /workspace && node sum.cjs &"
    }
  }
}
```

**Save the returned `previewUrl`** — call it `M1_URL`. This is the base URL for module1 (e.g., `https://xxx.h.lizhao.net`).

---

## 8. Verify module1 endpoints

Open in browser or curl:
- `M1_URL/n1` → `{"value":1.1}`
- `M1_URL/n2` → `{"value":2.1}`

---

## 9. Prompt the agent in module1's session

Send a prompt to the LLM agent running in module1's sandbox. The agent can use workspace tools (read_file, bash, glob) and respond intelligently:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 65,
  "params": {
    "name": "acp_session_prompt",
    "arguments": {
      "sessionId": "<MODULE1_SID>",
      "messages": [
        {
          "role": "user",
          "content": [
            {
              "type": "text",
              "text": "Read /workspace/sum.cjs and tell me what endpoints it exposes"
            }
          ]
        }
      ]
    }
  }
}
```

Expected response: the agent reads the file via tools and answers something like *"It exposes /n1 returning 1.1 and /n2 returning 2.1"*.

You can also ask the agent to make changes (single message in `messages` array):

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 66,
  "params": {
    "name": "acp_session_prompt",
    "arguments": {
      "sessionId": "<MODULE1_SID>",
      "messages": [
        {
          "role": "user",
          "content": [
            {
              "type": "text",
              "text": "Add a /sum endpoint that reads `a` and `b` from query params and returns their sum as JSON"
            }
          ]
        }
      ]
    }
  }
}
```

The agent will modify `sum.cjs`, restart the dev server, and confirm the new endpoint works.

### Multi-turn conversation (chat history)

For follow-up prompts, pass the full `messages` array including the assistant's previous response:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 67,
  "params": {
    "name": "acp_session_prompt",
    "arguments": {
      "sessionId": "<MODULE1_SID>",
      "messages": [
        {
          "role": "user",
          "content": [{"type": "text", "text": "Read /workspace/sum.cjs and tell me what endpoints it exposes"}]
        },
        {
          "role": "assistant",
          "content": [{"type": "text", "text": "It exposes /n1 returning 1.1 and /n2 returning 2.1."}]
        },
        {
          "role": "user",
          "content": [{"type": "text", "text": "Now add a /sum endpoint that reads a and b from query params and returns their sum as JSON"}]
        }
      ]
    }
  }
}
```

The LLM sees the full conversation context — it knows you've already discussed the file, so it can proceed with the change without re-reading.

---

## 10. Write sum.html to module2 (with injected URLs)

**Important**: Replace `N1_PLACEHOLDER` with `M1_URL/n1` and `N2_PLACEHOLDER` with `M1_URL/n2` before writing. The HTML runs in the browser so it needs the absolute URLs baked in.

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 70,
  "params": {
    "name": "acp_fs_write_text_file",
    "arguments": {
      "sessionId": "<MODULE2_SID>",
      "uri": "file:///workspace/sum.html",
      "content": "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"UTF-8\" />\n  <title>Sum Calculator</title>\n  <style>\n    body { font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center; }\n    h1 { font-size: 1.8rem; }\n    .row { display: flex; justify-content: center; gap: 1rem; }\n    .box { background: #f0f0f0; border-radius: 8px; padding: 1rem 2rem; min-width: 100px; }\n    .box .value { font-size: 1.6rem; font-weight: 700; }\n    .result { font-size: 2rem; font-weight: 700; color: #2b6; }\n    button { font-size: 1rem; padding: 0.5rem 2rem; border-radius: 6px; background: #2b6; color: #fff; cursor: pointer; }\n  </style>\n</head>\n<body>\n  <h1>Sum Calculator</h1>\n  <div class=\"row\">\n    <div class=\"box\"><div class=\"label\">n1</div><div class=\"value\" id=\"n1\">—</div></div>\n    <div class=\"box\"><div class=\"label\">n2</div><div class=\"value\" id=\"n2\">—</div></div>\n  </div>\n  <div class=\"result\" id=\"sum\">= ?</div>\n  <button onclick=\"fetchSum()\">Calculate</button>\n  <script>\n    const N1 = \"<M1_URL>/n1\";\n    const N2 = \"<M1_URL>/n2\";\n    async function fetchSum() {\n      try {\n        const [r1, r2] = await Promise.all([\n          fetch(N1).then(r => r.json()),\n          fetch(N2).then(r => r.json())\n        ]);\n        document.getElementById(\"n1\").textContent = r1.value;\n        document.getElementById(\"n2\").textContent = r2.value;\n        document.getElementById(\"sum\").textContent = r1.value + \" + \" + r2.value + \" = \" + (r1.value + r2.value);\n      } catch (e) {\n        document.getElementById(\"error\").textContent = \"Error: \" + e.message;\n      }\n    }\n    fetchSum();\n  </script>\n</body>\n</html>"
    }
  }
}
```

> Replace `<M1_URL>` in the two `const N1` / `const N2` lines with the actual preview URL from step 7.

---

## 10. Write serve.cjs to module2 + start dev server

Write a static file server for `sum.html`:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 75,
  "params": {
    "name": "acp_fs_write_text_file",
    "arguments": {
      "sessionId": "<MODULE2_SID>",
      "uri": "file:///workspace/serve.cjs",
      "content": "require(\"http\").createServer((req, res) => { res.setHeader(\"Content-Type\", \"text/html; charset=utf-8\"); require(\"fs\").createReadStream(\"/workspace/sum.html\").pipe(res); }).listen(3000);"
    }
  }
}
```

Then start it:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 80,
  "params": {
    "name": "acp_deploy_start_dev",
    "arguments": {
      "sessionId": "<MODULE2_SID>",
      "command": "cd /workspace && node serve.cjs &"
    }
  }
}
```

**Save the returned `previewUrl`** — call it `M2_URL`.

---

## 11. Set env vars on module2 (optional)

Set `N1` / `N2` environment variable names on the Coolify container (these are for server-side use if needed; the browser-side HTML already has the URLs baked in):

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 90,
  "params": {
    "name": "acp_secret_set",
    "arguments": {
      "sessionId": "<MODULE2_SID>",
      "envVars": {
        "N1": "<M1_URL>/n1",
        "N2": "<M1_URL>/n2"
      }
    }
  }
}
```

---

## 12. List secrets (verify)

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 100,
  "params": {
    "name": "acp_secret_list",
    "arguments": {
      "sessionId": "<MODULE2_SID>"
    }
  }
}
```

Should return names `N1`, `N2` (never their values).

---

## 13. View session tree

Inspect the parent-child hierarchy:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 110,
  "params": {
    "name": "acp_session_get_tree",
    "arguments": {
      "sessionId": "<PARENT_SESSION_ID>"
    }
  }
}
```

Expected: the parent session (type `"project"`) with 2 children (type `"child"`).

---

## 14. Pause children (simulate hibernation)

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 120,
  "params": {
    "name": "acp_sandbox_bulk_action",
    "arguments": {
      "sessionId": "<PARENT_SESSION_ID>",
      "action": "pause"
    }
  }
}
```

Wait a few seconds, then resume.

---

## 15. Resume children

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 130,
  "params": {
    "name": "acp_sandbox_bulk_action",
    "arguments": {
      "sessionId": "<PARENT_SESSION_ID>",
      "action": "resume"
    }
  }
}
```

Wait for the health endpoints to come back.

---

## 16. Verify after resume

Check module1 API still works:

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 140,
  "params": {
    "name": "acp_deploy_get_preview_url",
    "arguments": {
      "sessionId": "<MODULE1_SID>"
    }
  }
}
```

Then curl `M1_URL/n1` in a browser — should still return `{"value":1.1}`.

---

## 17. Cleanup

### Stop dev servers

Stop module1:
```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 150,
  "params": {
    "name": "acp_deploy_stop_dev",
    "arguments": {
      "sessionId": "<MODULE1_SID>"
    }
  }
}
```

Stop module2:
```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 151,
  "params": {
    "name": "acp_deploy_stop_dev",
    "arguments": {
      "sessionId": "<MODULE2_SID>"
    }
  }
}
```

### Delete child sessions

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 160,
  "params": {
    "name": "acp_session_delete",
    "arguments": {
      "sessionId": "<MODULE1_SID>"
    }
  }
}
```

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 161,
  "params": {
    "name": "acp_session_delete",
    "arguments": {
      "sessionId": "<MODULE2_SID>"
    }
  }
}
```

### Delete parent session

```json
{
  "method": "tools/call",
  "jsonrpc": "2.0",
  "id": 170,
  "params": {
    "name": "acp_session_delete",
    "arguments": {
      "sessionId": "<PARENT_SESSION_ID>"
    }
  }
}
```

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `Unauthorized` | Missing or wrong `Authorization: Bearer <token>` header |
| Tool not found | Bridge not restarted after code changes |
| Session creation timeout | Coolify provisioning is slow (60-180s is normal) |
| Dev server Bad Gateway | Node process crashed — check it uses CommonJS (`.cjs` or `require()`) |
| HTML shows placeholders | Forgot to replace `N1_PLACEHOLDER` / `N2_PLACEHOLDER` before writing |
| Code-server URL Bad Gateway | Using `haymant/oai` image — switch to `haymant/oadev` |
