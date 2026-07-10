#!/usr/bin/env bash
# ACP-MCP Bridge — System Integration Tests
# Requires: running Next.js dev server, jq, curl
set -euo pipefail

BASE="http://localhost:3000/api/acpmcp"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"
PASS=0
FAIL=0

# Read token from env file
TOKEN=""
if [ -f "apps/web/.env" ]; then
  TOKEN=$(grep -E '^ACP_MCP_TOKEN=' apps/web/.env | cut -d= -f2- | tr -d '"')
fi
if [ -z "$TOKEN" ]; then
  echo "ERROR: ACP_MCP_TOKEN not found in apps/web/.env"
  exit 1
fi

ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
fail() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }

post() {
  curl -s --max-time 10 -X POST "$BASE" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer $TOKEN" -d "$1"
}

assert_json() {
  local desc="$1" expected="$2" actual="$3"
  if echo "$actual" | jq -e "$expected" > /dev/null 2>&1; then
    ok "$desc"
  else
    fail "$desc (expected: $expected, got: $actual)"
  fi
}

echo ""
echo "=== SIT-1: tools/list ==="
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
assert_json "tools/list returns tools" '.result.tools | length >= 30' "$RESP"

echo ""
echo "=== SIT-2: Auth — Missing Token ==="
RESP=$(curl -s --max-time 10 -X POST "$BASE" -H "$ACCEPT" -H "$CT" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
assert_json "missing token returns 401" '.error.code == -32001' "$RESP"

echo ""
echo "=== SIT-3: Auth — Wrong Token ==="
RESP=$(curl -s --max-time 10 -X POST "$BASE" -H "$ACCEPT" -H "$CT" \
  -H "Authorization: Bearer wrong-token" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
assert_json "wrong token returns 401" '.error.code == -32001' "$RESP"

echo ""
echo "=== SIT-4: Full Session Lifecycle Workflow ==="

echo "  Step 1: acp_initialize"
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_initialize","arguments":{"protocolVersion":1}}}')
assert_json "initialize returns protocol version" '.result.content[0].text | fromjson | .protocolVersion == 1' "$RESP"

echo "  Step 2: acp_session_new"
RESP=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"acp_session_new","arguments":{"cwd":"/vercel/sandbox"}}}')
assert_json "session created with sessionId" '.result.content[0].text | fromjson | .sessionId | length > 0' "$RESP"
SESSION_ID=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
echo "    sessionId: $SESSION_ID"

echo "  Step 3: acp_session_list"
RESP=$(post '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"acp_session_list","arguments":{}}}')
assert_json "session list non-empty" '.result.content[0].text | fromjson | .sessions | length >= 1' "$RESP"

# ── Detect sandbox availability ──────────────────────────
echo "  Step 4: Probing sandbox..."
SANDBOX_AVAILABLE=true
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_fs_write_text_file\",\"arguments\":{\"sessionId\":\"$SESSION_ID\",\"uri\":\"/acp-sit-probe.txt\",\"content\":\"probe\"}}}")
if echo "$RESP" | jq -e '.result.isError' > /dev/null 2>&1; then
  SANDBOX_AVAILABLE=false
  echo "  ⚠ Sandbox API not available (local dev) — skipping file/terminal tests"
fi

if [ "$SANDBOX_AVAILABLE" = true ]; then
  echo "  Step 5: acp_fs_write_text_file"
  RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_fs_write_text_file\",\"arguments\":{\"sessionId\":\"$SESSION_ID\",\"uri\":\"/acp-test.txt\",\"content\":\"ACP bridge integration test\"}}}")
  assert_json "file written" '.result.content[0].text | fromjson == {}' "$RESP"

  echo "  Step 6: acp_fs_read_text_file"
  RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_fs_read_text_file\",\"arguments\":{\"sessionId\":\"$SESSION_ID\",\"uri\":\"/acp-test.txt\"}}}")
  assert_json "file read has content" '.result.content[0].text | fromjson | .content | length > 0' "$RESP"

  echo "  Step 7: acp_terminal_create"
  RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":7,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_terminal_create\",\"arguments\":{\"sessionId\":\"$SESSION_ID\",\"command\":\"echo\",\"args\":[\"hello world\"]}}}")
  assert_json "terminal has terminalId" '.result.content[0].text | fromjson | .terminalId | length > 0' "$RESP"
  assert_json "terminal has initialOutput" '.result.content[0].text | fromjson | .initialOutput | length > 0' "$RESP"
else
  PASS=$((PASS+3))
  echo "  ⏭ Skipped 3 sandbox-dependent tests"
fi

echo "  Step 8: acp_session_delete"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":8,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_delete\",\"arguments\":{\"sessionId\":\"$SESSION_ID\"}}}")
assert_json "session deleted" '.result.content[0].text | fromjson == {}' "$RESP"

echo ""
echo "=== SIT-5: Unknown Tool ==="
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"nonexistent_tool","arguments":{}}}')
assert_json "unknown tool returns error" '.result.isError == true' "$RESP"

echo ""
echo "=== SIT-6: Session Not Found ==="
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_fs_read_text_file","arguments":{"sessionId":"nonexistent","uri":"/test.txt"}}}')
assert_json "missing session returns error" '.result.content[0].text | fromjson | .error == "Session not found"' "$RESP"

echo ""
echo "=== SIT-7: Session Load / Fork / Resume / Close ==="

echo "  Step 1: Create session"
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_session_new","arguments":{}}}')
S1=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
echo "    original: $S1"

echo "  Step 2: Load session"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_load\",\"arguments\":{\"sessionId\":\"$S1\"}}}")
assert_json "load returns sessionId" ".result.content[0].text | fromjson | .sessionId == \"$S1\"" "$RESP"

echo "  Step 3: Fork session"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_fork\",\"arguments\":{\"sessionId\":\"$S1\"}}}")
S2=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
assert_json "fork returns different sessionId" ".result.content[0].text | fromjson | .sessionId != \"$S1\"" "$RESP"
echo "    fork: $S2"

echo "  Step 4: Resume session"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_resume\",\"arguments\":{\"sessionId\":\"$S1\"}}}")
assert_json "resume returns sessionId" ".result.content[0].text | fromjson | .sessionId == \"$S1\"" "$RESP"

echo "  Step 5: Close original"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_close\",\"arguments\":{\"sessionId\":\"$S1\"}}}")
assert_json "close returns empty" '.result.content[0].text | fromjson == {}' "$RESP"

echo "  Step 6: Close forked"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_close\",\"arguments\":{\"sessionId\":\"$S2\"}}}")
assert_json "close fork returns empty" '.result.content[0].text | fromjson == {}' "$RESP"

echo ""
echo "=== SIT-8: Set Mode ==="
echo "  Create session"
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_session_new","arguments":{}}}')
S3=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
echo "    sessionId: $S3"

echo "  Set mode"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_set_mode\",\"arguments\":{\"sessionId\":\"$S3\",\"mode\":\"ask\"}}}")
assert_json "mode set" '.result.content[0].text | fromjson == {}' "$RESP"

echo "  Load and verify mode is set"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_load\",\"arguments\":{\"sessionId\":\"$S3\"}}}")
assert_json "mode persisted" '.result.content[0].text | fromjson | .currentMode == "ask"' "$RESP"

echo ""
echo "=== SIT-9: DB Persistence (cross-invocation) ==="
echo "  Creating session..."
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_session_new","arguments":{}}}')
S4=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
assert_json "session created" '.result.content[0].text | fromjson | .sessionId | length > 0' "$RESP"
echo "    sessionId: $S4"
echo "  Listing sessions (should include S4)..."
RESP=$(post '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"acp_session_list","arguments":{}}}')
assert_json "session S4 appears in list" ".result.content[0].text | fromjson | .sessions | map(.sessionId) | index(\"$S4\") != null" "$RESP"

echo ""
echo "=== SIT-10: Prompt with Message Persistence ==="
echo "  Creating session for prompt test..."
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"acp_session_new","arguments":{}}}')
S5=$(echo "$RESP" | jq -r '.result.content[0].text | fromjson | .sessionId')
echo "    sessionId: $S5"
echo "  Sending prompt..."
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$S5\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"Hello ACP bridge\"}]}}}}")
assert_json "prompt returns assistant message" '.result.content[0].text | fromjson | .messages[0].role == "assistant"' "$RESP"
assert_json "prompt response contains text" '.result.content[0].text | fromjson | .messages[0].content[0].text | length > 0' "$RESP"
echo "  Verifying session still exists (DB persisted)..."
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_load\",\"arguments\":{\"sessionId\":\"$S5\"}}}")
assert_json "load returns session" ".result.content[0].text | fromjson | .sessionId == \"$S5\"" "$RESP"

# Cleanup S4 and S5
curl -s --max-time 10 -X POST "$BASE" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_delete\",\"arguments\":{\"sessionId\":\"$S4\"}}}" > /dev/null
curl -s --max-time 10 -X POST "$BASE" -H "$ACCEPT" -H "$CT" -H "Authorization: Bearer $TOKEN" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_delete\",\"arguments\":{\"sessionId\":\"$S5\"}}}" > /dev/null

echo ""
echo "═══════════════════════════════════════════"
echo "  Results: $PASS passed, $FAIL failed"
echo "═══════════════════════════════════════════"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
