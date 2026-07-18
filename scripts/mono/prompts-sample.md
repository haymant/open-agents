# Project Sessions — Sample Prompts

Below are step-by-step prompts you can paste into **Open Agents chat** to exercise the full Project Sessions feature set. Each step builds on the previous one.

---

## Prerequisites

- A running Coolify instance with a configured connector (`coolify:default`)
- `haymant/oadev` Docker image for code-server IDE support (optional, fallback to `haymant/oai`)
- GitHub account linked to Open Agents (for repo operations)

---

## Step 1: Create a Project Session

Start a parent project session with code-server IDE:

> Create a new project session using the Coolify sandbox

The agent will call `acp_session_new` with `sandboxType: "coolify:default"` and `type: "project"`.

---

## Step 2: Create Two Child Sessions

Create child sandboxes for the API (module1) and UI (module2) services:

> Create two child sessions under my project session.
> Label them "api" and "web" so I can reference them later.

The agent will call `acp_session_new` twice with `type: "child"` and `parentSessionId` set to your project session ID, then record them.

---

## Step 3: Deploy Module1 (sum.cjs)

Copy and start the sum calculator API server in the "api" child sandbox:

> In the "api" child session, write a file called `sum.cjs` with this content:
> ```js
> require("http")
>   .createServer((req, res) => {
>     res.setHeader("Access-Control-Allow-Origin", "*");
>     res.setHeader("Content-Type", "application/json");
>     if (req.url === "/n1") return res.end(JSON.stringify({ value: 1.1 }));
>     if (req.url === "/n2") return res.end(JSON.stringify({ value: 2.1 }));
>     res.end(JSON.stringify({ error: "not found" }));
>   })
>   .listen(3000);
> ```
> Then start it as a dev server so it's accessible via its preview URL.

The agent will write the file via `acp_fs_write_text_file` and start the server via `acp_deploy_start_dev`.

---

## Step 4: Verify Module1 Endpoints

Confirm the API returns the expected values:

> Read the `/n1` endpoint from the "api" child's preview URL. What does it return?
> Also read `/n2`.

Expected: `{"value":1.1}` and `{"value":2.1}`.

---

## Step 5: Get Module1 Preview URL

Find the API child's endpoint URLs before deploying the frontend:

> Show me the preview URL for the "api" child session. I need the full URL for its `/n1` and `/n2` endpoints.

Expected: something like `https://xxx-xxx.h.lizhao.net/n1` and `https://xxx-xxx.h.lizhao.net/n2`.

---

## Step 6: Deploy Module2 (sum.html) with Injected URLs

Copy the HTML frontend to the "web" child sandbox — replacing the placeholder URLs with the actual module1 endpoints **before writing the file**:

> In the "web" child session, write a file called `sum.html` with this content.
> **Important**: Replace `N1_PLACEHOLDER` with the actual URL of the "api" child's `/n1` endpoint, and `N2_PLACEHOLDER` with the actual URL of `/n2`.
> ```html
> <!DOCTYPE html>
> <html lang="en">
> <head>
>   <meta charset="UTF-8" />
>   <title>Sum Calculator</title>
>   <style>
>     body { font-family: sans-serif; max-width: 480px; margin: 80px auto; text-align: center; }
>     h1 { font-size: 1.8rem; }
>     .row { display: flex; justify-content: center; gap: 1rem; }
>     .box { background: #f0f0f0; border-radius: 8px; padding: 1rem 2rem; min-width: 100px; }
>     .box .value { font-size: 1.6rem; font-weight: 700; }
>     .result { font-size: 2rem; font-weight: 700; color: #2b6; margin-top: 1.5rem; }
>     button { font-size: 1rem; padding: 0.5rem 2rem; border-radius: 6px; background: #2b6; color: #fff; cursor: pointer; }
>   </style>
> </head>
> <body>
>   <h1>Sum Calculator</h1>
>   <div class="row">
>     <div class="box"><div class="label">n1</div><div class="value" id="n1">—</div></div>
>     <div class="box"><div class="label">n2</div><div class="value" id="n2">—</div></div>
>   </div>
>   <div class="result" id="sum">= ?</div>
>   <button onclick="fetchSum()">Calculate</button>
>   <script>
>     const N1 = "N1_PLACEHOLDER";   // ← replace with actual /n1 URL
>     const N2 = "N2_PLACEHOLDER";   // ← replace with actual /n2 URL
>     async function fetchSum() { ... }
>     fetchSum();
>   </script>
> </body>
> </html>
> ```
> Then start a dev server that serves `sum.html` as the main page.

The agent will write the file (with URLs replaced) and start a simple HTTP server via `acp_deploy_start_dev`.

---

## Step 7: Verify the Full Stack

Confirm the frontend serves correctly:

> Read the main page from the "web" child's preview URL. Show me the HTML content.
> Does it contain "Sum Calculator"? Check that the N1 and N2 variables contain real URLs, not placeholders.

The agent will curl the preview URL and confirm.

---

## Step 8: Pause and Resume

Test session lifecycle:

> Pause both child sessions using the bulk action tool.
> Wait a few seconds, then resume both.
> After resuming, verify that the "api" child's `/n1` endpoint still returns 1.1.

The agent will call `acp_sandbox_bulk_action` with `action: "pause"`, wait, then `action: "resume"`, and re-verify.

---

## Step 9: View Session Hierarchy

Inspect the parent-child relationship:

> Show me the session tree for the project session. How many children does it have?

The agent will call `acp_session_get_tree` and display the hierarchy.

---

## Step 10: Clean Up

Tear down when done:

> Stop all dev servers and delete the project session and its children.

The agent will call `acp_deploy_stop_dev` for each child, then `acp_sandbox_bulk_action` or individual `acp_session_delete` calls.
