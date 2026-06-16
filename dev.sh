#!/bin/bash
# Launch a nested GNOME Shell in a window to develop and test against (no logout).
# Event Bar comes up active inside it (shared dconf); to load any edit, close the
# window and rerun this.
exec dbus-run-session -- gnome-shell --devkit --wayland
