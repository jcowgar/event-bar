#!/bin/bash
# Build the EGO-ready bundle: event-bar@cowgar.com.shell-extension.zip
#
# `gnome-extensions pack` bundles ONLY metadata.json, extension.js, prefs.js,
# stylesheet.css and the schemas/ directory (which it compiles for us). Every
# other source module — here eventbar.js — must be named with --extra-source,
# or the packed extension breaks on load because extension.js imports it.
#
# Everything else in the repo (AGENTS.md, CLAUDE.md, DEVELOPER.md, dev.sh,
# package.json, eslint.config.js, node_modules/, README) is simply never added
# to the default set, so it stays out of the bundle the guidelines ask us to
# keep lean — no exclude list needed.
set -euo pipefail
cd "$(dirname "$0")"

gnome-extensions pack \
    --force \
    --extra-source=eventbar.js \
    --podir=po \
    --gettext-domain=event-bar@cowgar.com \
    .

zip="event-bar@cowgar.com.shell-extension.zip"
echo "Built ${zip}:"
unzip -l "$zip"
