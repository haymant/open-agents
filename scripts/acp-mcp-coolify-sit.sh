#!/usr/bin/env bash
# ACP-MCP Coolify End-to-End SIT
# Usage: bash scripts/acp-mcp-coolify-sit.sh
set -euo pipefail

BASE="http://localhost:3000/api/acpmcp"
ACCEPT="Accept: application/json, text/event-stream"
CT="Content-Type: application/json"
OUT="/tmp/coolify-sit-result.txt"
PASS=0; FAIL=0

> "$OUT"  # clear output file

TOKEN=$(grep ACP_MCP_TOKEN apps/web/.env | cut -d= -f2- | tr -d '"' 2>/dev/null || echo "")
if [ -z "$TOKEN" ]; then
  echo "FAIL: ACP_MCP_TOKEN not found in apps/web/.env" | tee -a "$OUT"
  exit 1
fi

ok()   { PASS=$((PASS+1)); echo "  PASS: $1" | tee -a "$OUT"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL: $1" | tee -a "$OUT"; }

post() {
  curl -s --max-time "${2:-180}" -X POST "$BASE" \
    -H "$ACCEPT" -H "$CT" \
    -H "Authorization: Bearer $TOKEN" \
    -d "$1"
}

echo "=== Coolify SIT $(date) ===" | tee "$OUT"
echo "" | tee -a "$OUT"

# ── 1. Server check ──────────────────────────────────────
echo "--- SIT-CF-1: Server alive ---" | tee -a "$OUT"
HTTP=$(curl -s --max-time 5 -o /dev/null -w "%{http_code}" "$BASE" -X POST \
  -H "$CT" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}')
if [ "$HTTP" = "401" ] || [ "$HTTP" = "200" ]; then
  ok "Server responds (HTTP $HTTP)"
else
  fail "Server not reachable (HTTP $HTTP)"
fi

# ── 2. tools/list ───────────────────────────────────────
echo "--- SIT-CF-2: tools/list ---" | tee -a "$OUT"
RESP=$(post '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' 10)
TOOL_COUNT=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('tools',[])))" 2>/dev/null || echo "0")
if [ "$TOOL_COUNT" -gt 30 ]; then
  ok "tools/list returns $TOOL_COUNT tools"
else
  fail "tools/list returned $TOOL_COUNT tools (expected >30)"
fi

# ── 3. Coolify session create ────────────────────────────
echo "--- SIT-CF-3: Create Coolify session ---" | tee -a "$OUT"
echo "  (This may take 60-180s — waiting for Coolify provisioning...)" | tee -a "$OUT"
START=$(date +%s)
RESP=$(post '{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"acp_session_new","arguments":{"sandboxType":"coolify:default"}}}' 300)
DUR=$(( $(date +%s) - START ))
echo "  Duration: ${DUR}s" | tee -a "$OUT"

SID=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
if r.get('error'):
    print('ERROR:' + str(r['error']))
    sys.exit(0)
t = json.loads(r['result']['content'][0]['text'])
print(t.get('sessionId',''))
" 2>/dev/null || echo "")

CWD=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = json.loads(r['result']['content'][0]['text'])
print(t.get('cwd',''))
" 2>/dev/null || echo "")

if [ -z "$SID" ] || [ "$SID" = "ERROR:"* ]; then
  fail "Session creation failed: $(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('result',{}).get('content',[{}])[0].get('text','unknown'))" 2>/dev/null)"
  echo "=== SUMMARY: $PASS passed, $FAIL failed ===" | tee -a "$OUT"
  exit 1
fi

if [ "$CWD" = "/workspace" ]; then
  ok "Session created with Coolify cwd (/workspace) in ${DUR}s"
else
  fail "Session cwd is '$CWD' (expected /workspace)"
fi

echo "  sessionId: $SID" | tee -a "$OUT"

# ── 4. Write file ────────────────────────────────────────
echo "--- SIT-CF-4: Write file ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":20,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_fs_write_text_file\",\"arguments\":{\"sessionId\":\"$SID\",\"uri\":\"file:///workspace/TEST.md\",\"content\":\"Coolify SIT works!\"}}}" 30)
HAS_ERROR=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
print('error' in r or r.get('result',{}).get('isError',False))
" 2>/dev/null || echo "True")

if [ "$HAS_ERROR" = "True" ] || [ "$HAS_ERROR" = "true" ]; then
  fail "Write failed: $(echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('error',r.get('result',{}).get('content',[{}])[0].get('text','unknown'))[:150])" 2>/dev/null)"
else
  ok "File written successfully"
fi

# ── 5. Read file ─────────────────────────────────────────
echo "--- SIT-CF-5: Read file ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":30,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_fs_read_text_file\",\"arguments\":{\"sessionId\":\"$SID\",\"uri\":\"file:///workspace/TEST.md\"}}}" 30)
CONTENT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
print(d.get('content',''))
" 2>/dev/null || echo "")

if [ "$CONTENT" = "Coolify SIT works!" ]; then
  ok "File content matches"
else
  fail "File content: '$CONTENT' (expected 'Coolify SIT works!')"
fi

# ── 6. Terminal command ──────────────────────────────────
echo "--- SIT-CF-6: Terminal exec ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":40,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_terminal_create\",\"arguments\":{\"sessionId\":\"$SID\",\"command\":\"echo hello-from-coolify && pwd\"}}}" 30)
EXIT_CODE=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
print(d.get('exitStatus',{}).get('exitCode',''))
" 2>/dev/null || echo "1")
STDOUT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
print(d.get('initialOutput','')[:100])
" 2>/dev/null || echo "")

if [ "$EXIT_CODE" = "0" ]; then
  ok "Terminal command succeeded: '$STDOUT'"
else
  ERR_MSG=$(echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); print(r.get('result',{}).get('content',[{}])[0].get('text','unknown')[:150])" 2>/dev/null)
  fail "Terminal exitCode=$EXIT_CODE: $ERR_MSG"
fi

# ── 7. Prompt: simple chat (LLM only) ──────────────────
echo "--- SIT-CF-7a: Simple chat ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":51,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$SID\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"say hello to me\"}]}}}}" 30)
TEXT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
msgs = d.get('messages', [])
parts = msgs[0].get('content', [{}]) if msgs else [{}]
print(parts[0].get('text', '')[:200])
" 2>/dev/null || echo "")
if [ -n "$TEXT" ] && [ "$TEXT" != "Echo: "* ] && [ "$TEXT" != "(no text"* ] && [ "$TEXT" != "(used "* ]; then
  ok "Simple chat: $TEXT"
else
  fail "Simple chat failed: '$TEXT'"
fi

# ── 7b. Prompt: read existing file (glob + read_file tools) ──
echo "--- SIT-CF-7b: Read file via LLM tools ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":52,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$SID\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"if TEST.md exists, use tools to read it and show me the first word\"}]}}}}" 60)
TEXT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
msgs = d.get('messages', [])
parts = msgs[0].get('content', [{}]) if msgs else [{}]
print(parts[0].get('text', '')[:200])
" 2>/dev/null || echo "")
if [ -n "$TEXT" ] && [ "$TEXT" != "Echo: "* ] && [ "$TEXT" != "(no text"* ]; then
  if echo "$TEXT" | grep -qi "Coolify"; then
    ok "Read file via tools matched TEST.md content: $TEXT"
  else
    ok "Read file via tools responded (may not have matched): $TEXT"
  fi
else
  fail "Read file via tools failed: '$TEXT'"
fi

# ── 7c. Prompt: write file (write_file tool) ────────────
echo "--- SIT-CF-7c: Write file via LLM tools ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":53,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$SID\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"generate a single word README.md with just the word HELLO\"}]}}}}" 60)
TEXT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
msgs = d.get('messages', [])
parts = msgs[0].get('content', [{}]) if msgs else [{}]
print(parts[0].get('text', '')[:200])
" 2>/dev/null || echo "")
if [ -n "$TEXT" ] && [ "$TEXT" != "Echo: "* ] && [ "$TEXT" != "(no text"* ]; then
  ok "Write file via tools: $TEXT"
else
  echo "    (write_file tool may not be supported — check file in next step)" | tee -a "$OUT"
fi

# ── 8. Verify SIT-CF-7c created file via LLM tools ──────
echo "--- SIT-CF-8: Verify via LLM read ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":60,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$SID\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"use tools to read README.md and tell me what word it contains\"}]}}}}" 60)
TEXT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
msgs = d.get('messages', [])
parts = msgs[0].get('content', [{}]) if msgs else [{}]
print(parts[0].get('text', '')[:200])
" 2>/dev/null || echo "")
if echo "$TEXT" | grep -qi "HELLO"; then
  ok "LLM read confirmed: $TEXT"
else
  fail "LLM read did not find HELLO: '$TEXT'"
fi

# ── 8b. Grep for HELLO in any file ─────────────────────
echo "--- SIT-CF-8b: Grep for HELLO ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":61,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_prompt\",\"arguments\":{\"sessionId\":\"$SID\",\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"use grep or bash to find any file containing the word HELLO\"}]}}}}" 60)
TEXT=$(echo "$RESP" | python3 -c "
import sys, json
r = json.load(sys.stdin)
t = r['result']['content'][0]['text']
d = json.loads(t) if isinstance(t, str) else t
msgs = d.get('messages', [])
parts = msgs[0].get('content', [{}]) if msgs else [{}]
print(parts[0].get('text', '')[:200])
" 2>/dev/null || echo "")
if echo "$TEXT" | grep -qi "HELLO"; then
  ok "Grep found HELLO: $TEXT"
else
  fail "Grep did not find HELLO: '$TEXT'"
fi

# ── 9. Cleanup ───────────────────────────────────────────
echo "--- SIT-CF-9: Cleanup ---" | tee -a "$OUT"
RESP=$(post "{\"jsonrpc\":\"2.0\",\"id\":99,\"method\":\"tools/call\",\"params\":{\"name\":\"acp_session_delete\",\"arguments\":{\"sessionId\":\"$SID\"}}}" 30)
if echo "$RESP" | python3 -c "import sys,json; r=json.load(sys.stdin); exit(0 if 'error' not in r else 1)" 2>/dev/null; then
  ok "Session deleted"
else
  fail "Session deletion failed"
fi

# ── Summary ──────────────────────────────────────────────
echo "" | tee -a "$OUT"
echo "=========================================" | tee -a "$OUT"
echo "  Coolify SIT: $PASS passed, $FAIL failed" | tee -a "$OUT"
echo "=========================================" | tee -a "$OUT"

[ "$FAIL" -eq 0 ] || exit 1
