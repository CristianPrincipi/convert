#!/bin/sh
# Build the desktop app from this checkout and install it for the current user.
# Usage: linux/install.sh            build + install
#        linux/install.sh --no-build install the last build
set -eu
cd "$(dirname "$0")/.."

built=0
if [ "${1:-}" != "--no-build" ]; then
  built=1
  bun install --frozen-lockfile
  bun run desktop:build
  bunx electron-builder --linux dir --publish never
fi

src=release/linux-unpacked
[ -x "$src/convert-to-it" ] || { echo "Build not found in $src" >&2; exit 1; }

dest="$HOME/.local/share/convert-to-it"
restart_daemon=0
if pgrep -u "$(id -u)" -f "^$dest/convert-to-it .*--daemon" >/dev/null; then
  restart_daemon=1
  pkill -u "$(id -u)" -f "^$dest/convert-to-it " || true
  sleep 1
fi
rm -rf "$dest.new"
cp -a "$src" "$dest.new"
rm -rf "$dest"
mv "$dest.new" "$dest"
# which commit is installed: arch-setup's sync.sh rebuilds when the checkout moves past it
[ "$built" = 1 ] && git rev-parse HEAD > "$dest/.installed-commit"

install -Dm755 linux/convert-to-it.sh "$HOME/.local/bin/convert-to-it"
install -Dm644 linux/convert-to-it.desktop "$HOME/.local/share/applications/convert-to-it.desktop"
install -Dm644 linux/convert.nemo_action "$HOME/.local/share/nemo/actions/convert.nemo_action"
install -Dm644 linux/convert-wheel.nemo_action "$HOME/.local/share/nemo/actions/convert-wheel.nemo_action"
install -Dm644 linux/hypr/convert.lua "$HOME/.config/hypr/modules/convert.lua"
install -Dm644 src/ui/img/logo.svg "$HOME/.local/share/icons/hicolor/scalable/apps/convert-to-it.svg"
update-desktop-database -q "$HOME/.local/share/applications" 2>/dev/null || true
# the background instance (wheel) restarts on the new build
if [ "$restart_daemon" = 1 ]; then
  setsid -f "$HOME/.local/bin/convert-to-it" --daemon >/dev/null 2>&1 </dev/null
fi
echo "Installed to $dest"
