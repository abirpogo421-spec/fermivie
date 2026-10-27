#!/bin/sh
# Mac / Linux: start Fermivie from a terminal (Ctrl+C stops it). Options: see CUSTOMIZING.md.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1; then
  echo "Fermivie needs Python 3.9 or newer. Install python3 (Mac: python.org; Linux: your package manager)."
  exit 1
fi
python3 launch.py "$@"
rc=$?
[ "$rc" = 3 ] && exit 0
exit "$rc"
