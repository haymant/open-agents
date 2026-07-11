---
name: vercel
description: Vercel deployment gotchas for Go & Python MCP SDKs — CORS, Host header, SSE format, auth, and agent host compatibility.
---

# Vercel Deployment for MCP Servers

When deploying an MCP server to Vercel (as a Go serverless function or Python
service), several issues recur. This document covers both Go
(`github.com/modelcontextprotocol/go-sdk`) and Python
(`mcp>=2.0.0a1,<3`) SDKs.

---

## Issue 1: DNS Rebinding / "Forbidden: invalid Host header"

### Symptom

```
HTTP/2 403
content-type: text/plain; charset=utf-8

Forbidden: invalid Host header "tech-indicator.vercel.app"
```

### Cause

The Go MCP SDK enables **DNS rebinding protection** by default. On Vercel, the
serverless function listens on `127.0.0.1` internally, but the request arrives
with a public Host header (`tech-indicator.vercel.app`). The SDK sees a loopback
listener with a non-loopback Host and rejects the request.

### Fix — Go

Set `DisableLocalhostProtection: true` in `StreamableHTTPOptions`:

```go
mcpHandler := mcp.NewStreamableHTTPHandler(
    func(r *http.Request) *mcp.Server { return server },
    &mcp.StreamableHTTPOptions{
        Stateless:                   true,
        DisableLocalhostProtection: true, // required on Vercel
    },
)
```

### Fix — Python

The Python SDK has an equivalent setting via `TransportSecuritySettings`:

```python
from mcp.server.transport_security import TransportSecuritySettings

_security = TransportSecuritySettings(
    enable_dns_rebinding_protection=False,
)

app = yfinance_server.streamable_http_app(
    stateless_http=True,
    transport_security=_security,
)
```

Both are safe because Vercel's edge network already handles DNS rebinding
protection at the platform level.

---

## Issue 2: CORS — "No 'Access-Control-Allow-Origin' header"

### Symptom

```
Access to fetch at 'http://localhost:3000/api/mcp' from origin 'http://localhost:6274'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present
on the requested resource.
```

Also variants:
- `Request header field mcp-protocol-version is not allowed by Access-Control-Allow-Headers`
- `Response to preflight request doesn't pass access control check`

### Cause

The browser sends a preflight `OPTIONS` request before the actual POST. If the
server responds without CORS headers (or returns 403 from auth before CORS runs),
the browser blocks the request.

Two sub-issues:

#### 2a. Middleware order — CORS must be outermost

If auth middleware wraps CORS middleware, an auth rejection writes the 403
**before** CORS headers are set:

```go
// WRONG — auth runs first, 403 has no CORS headers
return authMiddleware(corsMiddleware(handler))

// RIGHT — CORS runs first, headers always set
return corsMiddleware(authMiddleware(handler))
```

#### 2b. Missing `mcp-session-id` and `mcp-protocol-version` in allowed headers

The MCP transport relies on `Mcp-Session-Id` (response header) and
`Mcp-Protocol-Version` (request header). These must be exposed/allowed by CORS.

### Fix — Go

```go
func corsMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        w.Header().Set("Access-Control-Allow-Origin", "*")
        w.Header().Set("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        w.Header().Set("Access-Control-Allow-Headers", "*")
        w.Header().Set("Access-Control-Expose-Headers", "Mcp-Session-Id")

        if r.Method == http.MethodOptions {
            w.WriteHeader(http.StatusNoContent)
            return
        }

        next.ServeHTTP(w, r)
    })
}
```

### Fix — Python

The Python SDK uses Starlette's built-in CORSMiddleware on the ASGI app:

```python
from starlette.middleware.cors import CORSMiddleware

app = yfinance_server.streamable_http_app(
    stateless_http=True,
    streamable_http_path="/mcp",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["mcp-session-id"],  # ← lowercase; critical for browser clients
)
```

Key points (both SDKs):
- `Access-Control-Allow-Headers: *` — wildcard avoids missing future headers.
- `Access-Control-Expose-Headers: Mcp-Session-Id` — without this, browsers hide
  the session ID header from the MCP client transport.
- CORS middleware **must be outermost** so headers are set even on auth errors.
- CORS preflight (`OPTIONS`) must return `204 No Content` **before** auth check.

---

## Issue 3: Custom Headers (Challenge)

### Symptom

The MCP Inspector or agent host sends custom headers that the server doesn't
recognize:

```
Request header field mcp-protocol-version is not allowed by Access-Control-Allow-Headers
```

### Cause

The MCP protocol uses several custom headers:
- `Mcp-Session-Id` — session tracking (response)
- `Mcp-Protocol-Version` — protocol version negotiation (request)
- `Authorization` — Bearer token auth

### Fix

Use `Access-Control-Allow-Headers: *` (see Issue 2). This tells the browser that
any custom header is permitted. If you prefer an explicit list, include:

```
Access-Control-Allow-Headers: Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version
```

---

## Issue 4: Auth Middleware Must Pass OPTIONS

### Symptom

CORS preflight returns 403 instead of 204.

### Cause

The auth middleware rejects all requests without a Bearer token, including
`OPTIONS` preflight requests.

### Fix — Go

```go
func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        if r.Method == http.MethodOptions {
            next.ServeHTTP(w, r) // preflight passes through
            return
        }
        expected := os.Getenv("TECH_INDICATOR_API_KEY")
        if expected == "" {
            next.ServeHTTP(w, r)
            return
        }
        auth := r.Header.Get("Authorization")
        if auth != "Bearer "+expected {
            http.Error(w, "Forbidden: invalid or missing API key", http.StatusForbidden)
            return
        }
        next.ServeHTTP(w, r)
    })
}
```

### Fix — Python

```python
from starlette.responses import PlainTextResponse

class BearerAuthMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        api_key = os.environ.get("YF_API_KEY", "")
        if api_key:
            if scope["type"] != "http":
                await self.app(scope, receive, send)
                return
            # OPTIONS passes through unauthenticated.
            if scope.get("method", "").upper() == "OPTIONS":
                await self.app(scope, receive, send)
                return
            headers = dict(scope.get("headers", []))
            auth_header = headers.get(b"authorization", b"").decode()
            if not auth_header.startswith("Bearer ") or auth_header[7:] != api_key:
                response = PlainTextResponse(
                    "Forbidden: invalid or missing API key", status_code=403
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)

# Order: BearerAuthMiddleware wraps the CORS-wrapped ASGI app.
app = BearerAuthMiddleware(app)
```

---

## Issue 6: Agent Host Fails to List Tools (SSE Format Required)

### Symptom

The agent host (Grok connectors-manager, MCP Inspector, etc.) calls `initialize`,
gets 200 OK with `Mcp-Session-Id`, but then **never sends `tools/list`**. The
host shows no tools or reports a connection failure.

Debug logs show only the `initialize` request — no follow-up calls.

### Root Cause

The Go MCP SDK's `StreamableHTTPOptions.JSONResponse: true` makes the server
respond with `Content-Type: application/json` instead of the standard SSE format
(`text/event-stream`). Some agent hosts (particularly Grok's connectors-manager)
**require SSE format responses** and silently stop after initialize if they
receive plain JSON.

The reference Python SDK (`mcp>=2.0.0a1,<3`) does **not** have a
`JSONResponse` option — it always uses SSE format by default.

### Fix — Go

**Remove** `JSONResponse: true` from `StreamableHTTPOptions`. The server will
then return SSE format (`event: message\ndata: {...}`) which all MCP clients
understand:

```go
// BEFORE — broken with some agent hosts:
mcpHandler := mcp.NewStreamableHTTPHandler(
    handlerFunc,
    &mcp.StreamableHTTPOptions{
        Stateless:     true,
        JSONResponse:  true,  // ← REMOVE THIS
        DisableLocalhostProtection: true,
    },
)

// AFTER — works with all MCP clients:
mcpHandler := mcp.NewStreamableHTTPHandler(
    handlerFunc,
    &mcp.StreamableHTTPOptions{
        Stateless:                   true,
        DisableLocalhostProtection: true,
    },
)
```

### Fix — Python

No action needed — the Python SDK defaults to SSE format. Just ensure you
use `stateless_http=True`:

```python
app = yfinance_server.streamable_http_app(
    stateless_http=True,
    streamable_http_path="/mcp",
    transport_security=_security,
)
```

### Verification

After removing `JSONResponse`, the response format changes:

```diff
- Content-Type: application/json
- {"jsonrpc":"2.0","id":1,"result":{...}}

+ Content-Type: text/event-stream
+ event: message
+ data: {"jsonrpc":"2.0","id":1,"result":{...}}
```

Both formats are valid per the MCP spec, but some agent hosts only support SSE.

---

## Issue 5: Asset Name Case Sensitivity

### Symptom

Syncing `"uso"` stores it as `"uso"` in the database, but querying with `"USO"`
returns no results.

### Fix

Normalize to uppercase at write time AND use case-insensitive `LOWER()` in SQL:

```go
// On write — normalize to uppercase.
for i, a := range req.Assets {
    req.Assets[i] = strings.ToUpper(a)
}

// On read — case-insensitive matching.
query := `SELECT ... FROM indicators WHERE LOWER(name) IN (LOWER($1), LOWER($2))`
```

Apply in all entry points: REST handlers + MCP tool handlers.

---

## Quick Reference: Correct Middleware Stack

### Go

```go
return corsMiddleware(authMiddleware(mcpHandler))
```

| Layer | Responsibility |
|-------|---------------|
| `corsMiddleware` | Sets `Access-Control-*` headers, handles OPTIONS (204) |
| `authMiddleware` | Checks Bearer token, passes OPTIONS through |
| `mcpHandler` | `StreamableHTTPHandler` with `DisableLocalhostProtection: true`, NO `JSONResponse` |

### Python

```python
# Build the ASGI app.
app = yfinance_server.streamable_http_app(
    stateless_http=True,
    streamable_http_path="/mcp",
    transport_security=_security,
)

# Stack: BearerAuth (outer) → CORS (inner) → MCP (innermost).
app.add_middleware(CORSMiddleware, allow_origins=["*"], ...)
app = BearerAuthMiddleware(app)
```

## Checklist for New MCP Deployments on Vercel

- [ ] `DisableLocalhostProtection: true` (Go) or `enable_dns_rebinding_protection=False` (Python)
- [ ] CORS middleware is **outermost** in the middleware stack
- [ ] `Access-Control-Expose-Headers: Mcp-Session-Id` (Go) or `expose_headers=["mcp-session-id"]` (Python)
- [ ] `Access-Control-Allow-Headers: *` or explicit list including MCP headers
- [ ] Auth middleware passes `OPTIONS` through before checking token
- [ ] **NO** `JSONResponse: true` (Go only) — use SSE format for agent host compatibility
- [ ] Asset names normalized to uppercase on write, case-insensitive on read

---

## Quick Reference: Correct Middleware Stack

```go
// Order: CORS (outermost) → Auth → MCP Handler (innermost)
return corsMiddleware(authMiddleware(mcpHandler))
```

| Layer | Responsibility |
|-------|---------------|
| `corsMiddleware` | Sets `Access-Control-*` headers, handles OPTIONS (204) |
| `authMiddleware` | Checks Bearer token, passes OPTIONS through |
| `mcpHandler` | `StreamableHTTPHandler` with `DisableLocalhostProtection: true` |

## Checklist for New MCP Deployments on Vercel

- [ ] `DisableLocalhostProtection: true` in `StreamableHTTPOptions`
- [ ] CORS middleware is **outermost** in the middleware stack
- [ ] `Access-Control-Expose-Headers: Mcp-Session-Id` is set
- [ ] `Access-Control-Allow-Headers: *` or explicit list including `Mcp-Session-Id, Mcp-Protocol-Version`
- [ ] Auth middleware passes `OPTIONS` through before checking token
- [ ] Asset names are normalized to uppercase (write) and matched case-insensitively (read)
