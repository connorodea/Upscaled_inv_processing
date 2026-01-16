#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo ""
echo "Upscaled Inventory - macOS Installer"
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "Installing Node.js LTS..."
  tmp_dir="$(mktemp -d)"
  pkg_name="$(curl -fsSL https://nodejs.org/dist/latest-v20.x/ | sed -n 's/.*href=\"\\(node-v[^\\"]*\\.pkg\\)\".*/\\1/p' | head -n 1)"
  if [[ -z "${pkg_name}" ]]; then
    echo "Could not locate Node.js installer package."
    exit 1
  fi
  pkg_url="https://nodejs.org/dist/latest-v20.x/${pkg_name}"
  curl -fsSL "${pkg_url}" -o "${tmp_dir}/${pkg_name}"
  sudo installer -pkg "${tmp_dir}/${pkg_name}" -target /
fi

echo "Installing dependencies..."
cd "${repo_dir}"
npm install
npm run build

echo "Configuring shortcuts..."
"${repo_dir}/scripts/setup-drive-macos.sh"

can_sudo=false
if sudo -n true 2>/dev/null; then
  can_sudo=true
fi

bin_root="/usr/local/bin"
if [[ -d "/opt/homebrew/bin" ]]; then
  bin_root="/opt/homebrew/bin"
fi
if [[ "${can_sudo}" != "true" ]]; then
  bin_root="${HOME}/.local/bin"
fi

if [[ "${can_sudo}" == "true" ]]; then
  sudo mkdir -p "${bin_root}"
  sudo tee "${bin_root}/upscaled" >/dev/null <<EOF
#!/usr/bin/env bash
set -euo pipefail
node "${repo_dir}/dist/index.js" "\$@"
EOF
  sudo chmod +x "${bin_root}/upscaled"
else
  mkdir -p "${bin_root}"
  cat <<EOF > "${bin_root}/upscaled"
#!/usr/bin/env bash
set -euo pipefail
node "${repo_dir}/dist/index.js" "\$@"
EOF
  chmod +x "${bin_root}/upscaled"
fi

mkdir -p "${HOME}/.local/bin"
cat <<EOF > "${HOME}/.local/bin/upscaled"
#!/usr/bin/env bash
set -euo pipefail
node "${repo_dir}/dist/index.js" "\$@"
EOF
chmod +x "${HOME}/.local/bin/upscaled"

desktop_app="${HOME}/Desktop/Upscaled Inventory.app"
apps_app="/Applications/Upscaled Inventory.app"
rm -f "${HOME}/Desktop/Upscaled Inventory.command"
if [[ "${can_sudo}" == "true" ]]; then
  sudo rm -f "/Applications/Upscaled Inventory.command"
else
  rm -f "${HOME}/Applications/Upscaled Inventory.command" 2>/dev/null || true
fi

app_script="$(mktemp)"
cat <<EOF > "${app_script}"
tell application "Terminal"
  activate
  do script "\\"${bin_root}/upscaled\\""
end tell
EOF

rm -rf "${desktop_app}"
osacompile -o "${desktop_app}" "${app_script}"
rm -f "${app_script}"

if [[ "${can_sudo}" == "true" ]]; then
  rm -rf "${apps_app}"
  sudo cp -R "${desktop_app}" "${apps_app}"
else
  mkdir -p "${HOME}/Applications"
  rm -rf "${HOME}/Applications/Upscaled Inventory.app"
  cp -R "${desktop_app}" "${HOME}/Applications/Upscaled Inventory.app"
fi

icon_path="${repo_dir}/assets/icon.icns"
if [[ -f "${icon_path}" ]]; then
  cp "${icon_path}" "${desktop_app}/Contents/Resources/applet.icns"
  if [[ "${can_sudo}" == "true" ]]; then
    sudo cp "${icon_path}" "${apps_app}/Contents/Resources/applet.icns"
  else
    cp "${icon_path}" "${HOME}/Applications/Upscaled Inventory.app/Contents/Resources/applet.icns" 2>/dev/null || true
  fi
fi

if ! grep -q "UPSCALED shortcuts" "${HOME}/.zshrc" 2>/dev/null; then
  {
    echo ""
    echo "# UPSCALED shortcuts"
    echo "export PATH=\"${HOME}/.local/bin:\$PATH\""
  } >> "${HOME}/.zshrc"
fi

echo ""
echo "Done. Open a new terminal and run: upscaled"
