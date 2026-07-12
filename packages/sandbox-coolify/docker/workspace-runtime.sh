#!/bin/sh
set -e

mkdir -p /workspace
cd /workspace

git init >/tmp/open-agents-git-init.log 2>&1 || true