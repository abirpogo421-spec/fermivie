#!/bin/bash
# Mac: double-click to start Fermivie. Keep the window that opens; close it to stop.
cd "$(dirname "$0")" || exit 1
if ! command -v python3 >/dev/null 2>&1 || ! python3 -c "import sys" >/dev/null 2>&1; then
  echo "Python 3 isn't installed. Get it from https://www.python.org/downloads/ and double-click this file again."
  read -r -p "Press Return to close this window." _
  exit 1
fi
python3 launch.py
rc=$?
if [ "$rc" = 3 ]; then
  echo "You can close this window."
  sleep 3
  exit 0
fi
echo
read -r -p "Fermivie has stopped. Press Return to close this window." _
