#!/usr/bin/env bash
# Single entry point for the verifier (one allow-list rule: Bash(bash <profile>/run-tests.sh *)).
# Usage: run-tests.sh <worktree> check | setup | test <test-project> [filter] | sdk <version-dir>
# Toolchain notes [from reviews 2283-9df83c38, 2234-9007cee1]: NBGV fails on partial clones, so
# its git engine is disabled; ExecutionTests need a Roslyn >= 4.12 SDK (CS9057 on SDK 8.0.4xx):
# pass DOTNET_SDK_OVERRIDE=<version> to write a worktree-only global.json.
set -euo pipefail
WT="${1:?worktree}"; CMD="${2:?command}"; shift 2
export PATH="$HOME/.dotnet:$PATH" DOTNET_CLI_TELEMETRY_OPTOUT=1 NBGV_GitEngine=Disabled
if [ "$(git -C "$WT" rev-parse --git-common-dir)" = "$(git -C "$WT" rev-parse --git-dir)" ]; then echo "refusing: $WT is the main working tree, not a linked worktree" >&2; exit 2; fi
cd "$WT"
if [ -n "${DOTNET_SDK_OVERRIDE:-}" ]; then printf '{"sdk":{"version":"%s","rollForward":"latestMajor"}}\n' "$DOTNET_SDK_OVERRIDE" > global.json; fi
case "$CMD" in
  check) dotnet --version; dotnet --list-sdks ;;
  setup) dotnet restore "${1:-tests/MessagePack.SourceGenerator.Tests}" -v q ;;
  test)  dotnet test "${1:?test project}" ${2:+--filter "$2"} ;;
  *) echo "unknown command: $CMD" >&2; exit 2 ;;
esac
