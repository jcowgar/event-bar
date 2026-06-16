# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A GNOME Shell 50 extension (`event-bar@cowgar.com`, Wayland, GJS ES modules). The status bar is invisible by default; named "pill" indicators drop from the top-center only on an event (CPU spike, volume change, workspace switch, …) and slide away. It also optionally hides the GNOME top panel and reclaims that screen space, with hover-to-reveal.

There is no build step, no test suite, and no package manager — it's plain GJS loaded directly by the shell. `README.md` is user-facing; `DEVELOPER.md` is the deep reference for internals and GNOME 50 specifics. Read `DEVELOPER.md` before non-trivial work.

## Development loop

```bash
# install once (then log out/in — Wayland can't reload the shell in place)
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/event-bar@cowgar.com
glib-compile-schemas schemas/                    # build the settings schema (not in git)
gnome-extensions enable event-bar@cowgar.com

./dev.sh                                         # nested shell for manual testing (needs mutter-dev-bin)
journalctl -f -o cat /usr/bin/gnome-shell        # watch for JS errors
```

GNOME 50 can't reload the shell in place, so iterate against a **nested shell**:
`./dev.sh` runs `dbus-run-session gnome-shell --devkit --wayland` (the `--devkit`
helper ships in Ubuntu/Debian's `mutter-dev-bin`). The extension comes up
already active inside it (shared user dconf); to load any edit, close the window
and rerun. After editing the GSettings schema, run `glib-compile-schemas
schemas/`; `prefs.js` edits just need the preferences window reopened. Manual
event triggers are listed in `DEVELOPER.md`.

## Architecture

- **`extension.js`** — thin entry point: the `Extension` subclass that statically imports `EventBar` and forwards `enable()`/`disable()`. All real logic lives in `eventbar.js`.
- **`eventbar.js`** — `class EventBar` (`enable`/`disable`) reads all tunables from GSettings and owns one `SlotManager`, an array of **sources**, and a `PanelController`. Construction happens in `_build()`; `enable()` also subscribes to the settings `changed` signal and calls `_rebuild()` (`_teardown()` + `_build()`) on any change, so edits apply live. `_teardown()`/`disable()` restore the panel *first*, so a source error can't leave the panel hidden.
- **`prefs.js` + `schemas/`** — the Adwaita preferences UI (separate process) and the GSettings schema where every tunable lives. See `DEVELOPER.md`.
- **`SlotManager`** — the top-center `St.BoxLayout`. `show(key, text, {lingerMs, alert})` / `hide(key)`. No `lingerMs` → persistent slot (polling sources); with `lingerMs` → transient, re-arming on each `show()`. `alert: true` → red CSS class.
- **Sources** — either extend `PollSource` (override `_tick()`; CPU/mem/disk) or are event-driven classes connecting to a signal/proxy in the constructor. Each takes `(slots, settings)` and reads its keys in the constructor. **Cleanup is mandatory in `destroy()`**: remove every GLib timer, disconnect every signal, cancel every `Gio.Cancellable`, destroy every actor. Leaks get the extension rejected from EGO review. To add one: write the class, add a `<source>-enabled` key (and any knobs) to the schema, add a row to `prefs.js`, and add a `['my-enabled', () => new MySource(this._slots, s)]` line to `EventBar._build()`.
- **`PanelController`** — hides the top panel and reclaims its strut space using *private* LayoutManager APIs (`_findActor`, `affectsStruts`, `_queueUpdateRegions`). These are unstable across GNOME versions — re-verify on upgrade. See `DEVELOPER.md` for the reveal-strip and overview handling.

## Conventions

- Match the existing GJS import style (`import X from 'gi://...'`, `resource:///org/gnome/shell/...`).
- Tunables are GSettings keys, not code constants: add a new one to `schemas/…gschema.xml`, expose it as a row in `prefs.js`, read it in the relevant constructor, and document it in `README.md`'s Configuration section. The `clock-interval-seconds` key ships at `300` (5 min) for visible testing — `900` is the calmer default. Only cosmetic "turns red" alert sub-thresholds stay inline in `eventbar.js`.
- Brightness/battery sources stay silent when the hardware isn't present — preserve that for any hardware-dependent source.

## Committing

- Ensure static sanity checks are passing
- Use conventional commits, imperative mood
