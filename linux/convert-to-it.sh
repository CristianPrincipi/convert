#!/bin/sh
# Launcher for the locally built Convert desktop app (linux-local branch).
# Offline by default; run with CONVERT_ONLINE=1 to allow the update check.
exec "$HOME/.local/share/convert-to-it/convert-to-it" --ozone-platform-hint=auto "$@"
