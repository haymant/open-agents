Two image variants are provided:

| Image | Dockerfile | Includes | Use case |
|-------|-----------|----------|----------|
| `haymant/oai` | `Dockerfile-oai` | Python 3.12, Node.js v24, Go, uv, workspace API | Minimal runtime for app execution |
| `haymant/oadev` | `Dockerfile-oadev` | Everything in `oai` + code-server, Coolify CLI | Interactive dev environment in the browser |

Both images include:
- an embedded workspace API on `HEALTH_PORT` (default 1223) that answers `GET /health` and exposes file and exec APIs for the Coolify connector
- common dev ports exposed (3000, 5173, 4321) for application servers

The `oadev` image additionally includes:
- `code-server` running on `CODE_SERVER_PORT` (default 1222)
- Coolify CLI for managing Coolify apps and services

---

## Build

```bash
# Runtime-only image
docker build -f Dockerfile-oai -t haymant/oai .

# Dev image (with code-server)
docker build -f Dockerfile-oadev -t haymant/oadev .
```

## Push

```bash
docker push haymant/oai
docker push haymant/oadev
```

---

## Usage notes for Coolify

### `haymant/oai` (runtime-only)

- Set `ports_exposes` to `3000,1223` so Traefik can create preview URLs for the app and health probe.
- Ensure Coolify's application env contains `PORT` for the primary routed port (typically `3000`). The workspace API runs on `HEALTH_PORT` regardless of the platform `PORT`.

### `haymant/oadev` (with code-server)

- Set `ports_exposes` to `3000,1222,1223` so Traefik can create preview URLs for the app, code-server, and health probe.
- Ensure Coolify's application env contains `PORT` for the primary routed port (typically `3000`). The image will run code-server on `CODE_SERVER_PORT` and the health probe on `HEALTH_PORT` regardless of the platform `PORT` unless overridden.
- If the Coolify instance does not publish per-port preview URLs, consider binding your app to the platform-provided `PORT` or using a platform-level TCP proxy as a fallback.

---

## Run locally

### `haymant/oai` (runtime-only)

```bash
docker build -f Dockerfile-oai -t haymant/oai .

docker run --rm \
	-p 3000:3000 \
	-p 1223:1223 \
	-e HEALTH_PORT=1223 \
	-e WORKSPACE_DIR=/workspace \
	-v "$PWD:/workspace" \
	haymant/oai
```

The container starts:
- the embedded workspace API on `1223`
- your app command if you pass one explicitly to `docker run`

### `haymant/oadev` (with code-server)

```bash
docker build -f Dockerfile-oadev -t haymant/oadev .

docker run --rm \
	-p 3000:3000 \
	-p 1222:1222 \
	-p 1223:1223 \
	-e HEALTH_PORT=1223 \
	-e CODE_SERVER_PORT=1222 \
	-e WORKSPACE_DIR=/workspace \
	-e PASSWORD=sd68324D \
	-v "$PWD:/workspace" \
	haymant/oadev
```

The container starts:
- `code-server` on `1222` (password protected via `PASSWORD`)
- the embedded workspace API on `1223`
- your app command if you pass one explicitly to `docker run`

---

## Verify the API

```bash
curl http://127.0.0.1:1223/health

curl http://127.0.0.1:1223/api/meta | jq .

curl 'http://127.0.0.1:1223/api/files?path=.' | jq .

curl -X POST http://127.0.0.1:1223/api/files/content \
	-H 'Content-Type: application/json' \
	-d '{"path":"hello.txt","content":"hello from fs api"}'

curl 'http://127.0.0.1:1223/api/files/content?path=hello.txt' | jq -r .content

curl 'http://127.0.0.1:1223/api/files/stat?path=hello.txt' | jq .

curl -X POST http://127.0.0.1:1223/api/exec \
	-H 'Content-Type: application/json' \
	-d '{"cmd":"pwd && ls -la","cwd":"."}' | jq .
```

---

## Optional API auth

If you expose the health hostname beyond a trusted network, set `FS_API_TOKEN` and send `Authorization: Bearer <token>` on every `/api/*` request. `GET /health` remains unauthenticated so Coolify probes still work.

```bash
docker run --rm \
	-p 1223:1223 \
	-e FS_API_TOKEN=replace-me \
	-v "$PWD:/workspace" \
	haymant/oai

curl http://127.0.0.1:1223/health

curl http://127.0.0.1:1223/api/meta \
	-H 'Authorization: Bearer replace-me' | jq .
```

---

## Health check endpoints

```text
GET /health -> 200 OK (plain text "ok")
GET /api/meta -> 200 OK (JSON service metadata)
GET /api/files?path=. -> 200 OK (JSON directory listing)
GET /api/files/content?path=... -> 200 OK (JSON file content)
GET /api/files/stat?path=... -> 200 OK (JSON stat payload)
POST /api/files/content -> 200 OK (write file)
POST /api/files/dir -> 200 OK (create directory)
DELETE /api/files?path=... -> 200 OK (delete file or directory)
POST /api/exec -> 200 OK (run command and return stdout/stderr)
POST /api/exec/detached -> 200 OK (spawn detached command and return pid)
GET /api/process/:pid -> 200 OK (check detached process status)
```

---

This README is brief; see `.github/skills/coolify-sandbox/SKILL.md` for connector guidance.