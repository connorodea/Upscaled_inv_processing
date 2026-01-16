#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
dist_root="${repo_root}/dist/macos"
app_root="${dist_root}/app"
app_name="Upscaled Inventory"
app_bundle="${app_root}/${app_name}.app"

mkdir -p "${dist_root}"
rm -rf "${app_root}"
mkdir -p "${app_root}"

pushd "${repo_root}" >/dev/null
npm ci
npm run build
popd >/dev/null

arch="$(uname -m)"
if [[ "${arch}" == "arm64" ]]; then
  node_platform="darwin-arm64"
else
  node_platform="darwin-x64"
fi

node_version="v20.11.1"
node_tar="node-${node_version}-${node_platform}.tar.gz"
node_url="https://nodejs.org/dist/${node_version}/${node_tar}"

tmp_dir="$(mktemp -d)"
curl -fsSL "${node_url}" -o "${tmp_dir}/${node_tar}"
tar -xzf "${tmp_dir}/${node_tar}" -C "${tmp_dir}"

mkdir -p "${app_bundle}/Contents/MacOS"
mkdir -p "${app_bundle}/Contents/Resources"
mkdir -p "${app_bundle}/Contents/Resources/app"

cp -R "${tmp_dir}/node-${node_version}-${node_platform}" "${app_bundle}/Contents/Resources/node"

copy_if_exists() {
  local src="$1"
  local dest="$2"
  if [[ -e "${src}" ]]; then
    cp -R "${src}" "${dest}"
  fi
}

copy_if_exists "${repo_root}/dist" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/package.json" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/assets" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/data" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/MasterManifests" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/labels" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/sku_templates" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/ui" "${app_bundle}/Contents/Resources/app"
copy_if_exists "${repo_root}/docs" "${app_bundle}/Contents/Resources/app"

rm -f "${app_bundle}/Contents/Resources/app/data/upscaled-sheets-sync.json"
rm -f "${app_bundle}/Contents/Resources/app/data/upscaled-sheets-sync-2.json"

cat > "${app_bundle}/Contents/MacOS/upscaled" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

app_dir="$(cd "$(dirname "$0")/../Resources/app" && pwd)"
node_bin="$(cd "$(dirname "$0")/../Resources/node/bin" && pwd)/node"
cd "${app_dir}"
"${node_bin}" "${app_dir}/dist/index.js" "$@"
EOF
chmod +x "${app_bundle}/Contents/MacOS/upscaled"

cat > "${app_bundle}/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${app_name}</string>
  <key>CFBundleDisplayName</key>
  <string>${app_name}</string>
  <key>CFBundleIdentifier</key>
  <string>com.upscaled.inventory</string>
  <key>CFBundleExecutable</key>
  <string>upscaled</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>LSMinimumSystemVersion</key>
  <string>11.0</string>
</dict>
</plist>
EOF

cp "${repo_root}/assets/icon.icns" "${app_bundle}/Contents/Resources/icon.icns"

pkg_root="${dist_root}/pkgroot"
rm -rf "${pkg_root}"
mkdir -p "${pkg_root}/Applications"
cp -R "${app_bundle}" "${pkg_root}/Applications/"

pkg_id="com.upscaled.inventory"
pkg_version="1.0.0"
pkg_out="${dist_root}/UpscaledInventory-${node_platform}.pkg"

pkgbuild \
  --root "${pkg_root}" \
  --identifier "${pkg_id}" \
  --version "${pkg_version}" \
  --scripts "${repo_root}/installer/macos" \
  "${pkg_out}"

echo "Built ${pkg_out}"
