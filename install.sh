#!/usr/bin/env bash
#
# kappa.yashi Cinnamon applets — installer
#
# Copies the selected applet(s) into your local Cinnamon applets folder.
# With no arguments it installs all of them.
#
# Usage:
#   ./install.sh                         # install everything
#   ./install.sh separator@kappayashi    # install one (or more) by uuid
#
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${HOME}/.local/share/cinnamon/applets"

ALL=(
  separator@kappayashi
  launcher@kappayashi
  workspace-switcher@kappayashi
  musiccontrols@kappayashi
  grouped-window-list@kappayashi
  sessionManager@kappayashi
)

if [ "$#" -gt 0 ]; then
  TARGETS=("$@")
else
  TARGETS=("${ALL[@]}")
fi

mkdir -p "$DEST"

for uuid in "${TARGETS[@]}"; do
  if [ ! -d "${SRC}/${uuid}" ]; then
    echo "  skip: ${uuid} (not found in this repo)"
    continue
  fi
  rm -rf "${DEST:?}/${uuid}"
  cp -r "${SRC}/${uuid}" "${DEST}/"
  rm -rf "${DEST}/${uuid}/__pycache__"
  echo "  installed: ${uuid}"
done

echo
echo "Done. Now reload Cinnamon:  Ctrl+Alt+Esc   (or Alt+F2 -> r)"
echo "Then add the applet(s) from:  System Settings -> Applets"
