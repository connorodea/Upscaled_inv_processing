#!/usr/bin/env bash
set -euo pipefail

repo_default="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -t 0 ]]; then
  read -r -p "Repo path [${repo_default}]: " repo_input
  repo_dir="${repo_input:-$repo_default}"
else
  repo_dir="${repo_default}"
fi

drive_root_default=""
if [[ -d "${HOME}/Library/CloudStorage" ]]; then
  for candidate in "${HOME}/Library/CloudStorage"/GoogleDrive-*; do
    if [[ -d "${candidate}/My Drive" ]]; then
      drive_root_default="${candidate}/My Drive"
      break
    fi
    if [[ -d "${candidate}/Shared drives" ]]; then
      drive_root_default="${candidate}/Shared drives"
      break
    fi
  done
fi

if [[ -n "${DRIVE_ROOT:-}" ]]; then
  drive_root="${DRIVE_ROOT}"
elif [[ -t 0 ]]; then
  echo "Example Google Drive path:"
  echo "  /Users/$USER/Library/CloudStorage/GoogleDrive-<account>/My Drive/Upscaled2026_SharedDrive"
  read -r -p "Google Drive base folder [${drive_root_default}]: " drive_root
  drive_root="${drive_root:-$drive_root_default}"
else
  drive_root="${drive_root_default}"
fi

if [[ -z "${drive_root}" ]]; then
  echo "Google Drive root not found. Skipping photo intake config."
  exit 0
fi

intake_dir="${drive_root}/Upscaled_Photo_Intake"
output_dir="${drive_root}/Upscaled_Photos"

mkdir -p "${intake_dir}" "${output_dir}"

mkdir -p "${HOME}/.local/bin"
cat <<EOW > "${HOME}/.local/bin/upscaled"
#!/usr/bin/env bash
set -euo pipefail
cd "${repo_dir}"
node "${repo_dir}/dist/index.js" "\$@"
EOW
chmod +x "${HOME}/.local/bin/upscaled"

python3 - <<PY
from pathlib import Path

intake_dir = "${intake_dir}"
output_dir = "${output_dir}"
zshrc = Path.home() / ".zshrc"
text = zshrc.read_text() if zshrc.exists() else ""
lines = text.splitlines()
block_header = "# Upscaled shortcuts"
out = []
skip = False
for line in lines:
    if line.strip() == block_header:
        skip = True
        continue
    if skip:
        if line.strip() == "":
            skip = False
            out.append(line)
        continue
    out.append(line)

updated = "\n".join(out).rstrip("\n")
block = (
    "\n\n# Upscaled shortcuts\n"
    f'export PHOTO_INTAKE_DIR="{intake_dir}"\n'
    f'export PHOTO_OUTPUT_DIR="{output_dir}"\n'
    'export PATH="$HOME/.local/bin:$PATH"\n'
    f'alias upscaled-photos="open \\\"{output_dir}\\\""\n'
    f'alias upscaled-install="\\\"{repo_dir}/install.sh\\\""\n'
    f'alias upscaled-intake="open \\\"{intake_dir}\\\""\n'
)
zshrc.write_text(updated + block)
PY

cat <<EOT
Done.
- Intake: ${intake_dir}
- Output: ${output_dir}

Next:
1) source ~/.zshrc
2) cd "${repo_dir}" && npm install && npm run build
3) run: upscaled
EOT
