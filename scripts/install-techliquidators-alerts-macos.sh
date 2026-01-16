#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLIST_SOURCE="${PROJECT_DIR}/deploy/launchd/com.upscaled.techliquidators-alerts.plist"
PLIST_TARGET="${HOME}/Library/LaunchAgents/com.upscaled.techliquidators-alerts.plist"

if [[ ! -f "${PLIST_SOURCE}" ]]; then
  echo "Plist not found: ${PLIST_SOURCE}"
  exit 1
fi

mkdir -p "${HOME}/Library/LaunchAgents"
cp "${PLIST_SOURCE}" "${PLIST_TARGET}"

USER_ID="$(id -u)"
launchctl bootout "gui/${USER_ID}" "${PLIST_TARGET}" >/dev/null 2>&1 || true
launchctl bootstrap "gui/${USER_ID}" "${PLIST_TARGET}"
launchctl enable "gui/${USER_ID}/com.upscaled.techliquidators-alerts"
launchctl kickstart -k "gui/${USER_ID}/com.upscaled.techliquidators-alerts"

echo "Installed and started com.upscaled.techliquidators-alerts"
