#!/bin/sh
set -e

# Entry point: start code-server on the configured dev port in background and run
# a lightweight health server in the foreground. The health server responds to
# GET /health on the `HEALTH_PORT` so platform probes can validate container
# readiness. We do not run an internal HTTP proxy by default; expose distinct
# ports when the platform supports per-port preview routing.

# Default code-server port (can be overridden with CODE_SERVER_PORT)
CODE_SERVER_PORT=${CODE_SERVER_PORT:-1222}

# Health server port (the lightweight server will answer /health here).
HEALTH_PORT=${HEALTH_PORT:-1223}

# Workspace directory code-server should open.
WORKSPACE_DIR=${WORKSPACE_DIR:-/workspace}

PASSWORD=${PASSWORD:-sdf234sdwes==}

export CODE_SERVER_PORT
export HEALTH_PORT
export WORKSPACE_DIR
export PASSWORD

# Start code-server on the configured dev port in background if installed.
# Use `env -u PORT` to ensure code-server does not pick up the platform `PORT`
# environment (some code-server builds prefer the `PORT` env over CLI flags),
# which avoids accidental binding to any platform probe port.
if command -v code-server >/dev/null 2>&1; then
	env -u PORT code-server --bind-addr 0.0.0.0:${CODE_SERVER_PORT} --auth password --disable-telemetry "${WORKSPACE_DIR}" &
	CS_PID=$!
fi

if [ "$#" -gt 0 ]; then
	"$@" >/tmp/open-agents-runtime-command.log 2>&1 &
fi

# Run the embedded workspace API in the foreground on HEALTH_PORT.
# It provides GET /health plus workspace file and exec APIs.
exec node /vercel/sandbox/fs.js
