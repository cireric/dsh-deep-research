#!/bin/bash
# dsh-deep-research build: compile src/ → lib/ with the dsh checkout's tsc.
#
# This script is the super-injector production-line contract:
#   dev_build_plugin runs `bash scripts/build.sh` (with DSH_CHECKOUT injected)
#   and expects lib/ present, then `npm pack`. It is modelled on the
#   dev_scaffold_plugin template, with the link set trimmed to this package's
#   actual dependencies (no client/UI step).
#
# Usable standalone too: DSH_CHECKOUT env first, then common home locations,
# then the sibling layout this repo already pins (tsconfig extends/references
# and the link: devDependencies all resolve the checkout at ../.. /deepseek-harness).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# DSH_CHECKOUT probe: env var → 常见路径 → 本仓库既定的平级布局。
CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness" "$HOME/deepseek-harness" "$(cd "$ROOT/../.." && pwd)/deepseek-harness"; do
    if [ -d "$candidate/packages" ]; then CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$CHECKOUT" ] || [ ! -d "$CHECKOUT/packages" ]; then
  echo "build: cannot locate the dsh checkout (set DSH_CHECKOUT)" >&2
  exit 1
fi

TSC="$CHECKOUT/node_modules/.bin/tsc"
if [ ! -x "$TSC" ] && [ ! -f "$TSC.cmd" ]; then
  echo "build: tsc not found at $TSC" >&2
  exit 1
fi

link_pkg() {
  local target="$CHECKOUT/$2"
  if [ ! -e "$target" ]; then
    echo "build: dependency target missing: $target" >&2
    exit 1
  fi
  node -e "
    const fs = require('fs');
    const path = require('path');
    const link = path.resolve(process.argv[1]);
    const target = path.resolve(process.argv[2]);
    fs.rmSync(link, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  " "node_modules/$1" "$target"
}

echo "=== Linking build dependencies (checkout: $CHECKOUT) ==="
mkdir -p node_modules/@deepseek-ai
link_pkg cordis vendor/cordis
link_pkg @deepseek-ai/dsh-agent packages/core/agent
link_pkg @deepseek-ai/dsh-agent-presets packages/preset/agent-presets
link_pkg @deepseek-ai/dsh-tools packages/core/tools
link_pkg @deepseek-ai/dsh-workflow packages/workflow/workflow
link_pkg @deepseek-ai/dsh-jobs packages/jobs/jobs
link_pkg @deepseek-ai/dsh-commands packages/interaction/commands
link_pkg @types/node node_modules/@types/node

echo "=== Compiling src → lib (tsc -b, project references) ==="
"$TSC" -b tsconfig.json --pretty false

# 产物兼容垫片：本包 main 为 lib/types/index.js，而注入器/看门狗的预检与重载按
# lib/index.js 定位入口（实测：缺此文件时 watch 预检永远失败、dev_reload_package
# 磁盘降级找不到入口）。垫片仅重导出真实入口（ESM 同名模块去重，不产生双实例）。
printf '%s
' "export * from './types/index.js'" > lib/index.js
echo "=== Shim written: lib/index.js → lib/types/index.js ==="

echo "=== Build complete ==="
