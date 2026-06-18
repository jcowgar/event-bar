# Event Bar — Developer Guide

How to set up a development environment, understand the code, add an indicator,
and test it. For user-facing docs see [README.md](README.md).

---

## Layout

```
event-bar@cowgar.com/
├── extension.js     # entry point (Extension subclass → EventBar)
├── eventbar.js      # all the real logic
├── prefs.js         # Adwaita preferences UI (separate process)
├── metadata.json    # uuid, name, shell-version: ["50"], settings-schema
├── stylesheet.css   # pill + alert styling
├── schemas/
│   ├── org.gnome.shell.extensions.event-bar.gschema.xml  # all tunables
│   └── gschemas.compiled                                  # built artifact
├── README.md
├── DEVELOPER.md
└── dev.sh           # launch a nested shell to develop/test against
```

Target: **GNOME Shell 50**, GJS ES modules (`import ... from 'gi://...'` and
`resource:///org/gnome/shell/...`). Wayland.

---

## Development loop

```bash
# 1. install once (symlink + compile schema), then log out/in
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/event-bar@cowgar.com
glib-compile-schemas schemas/     # gschemas.compiled is generated, not in git
gnome-extensions enable event-bar@cowgar.com

# 2. iterate against a nested shell (edit, close window, rerun)
./dev.sh                          # dbus-run-session gnome-shell --devkit --wayland

# 3. watch for errors
journalctl -f -o cat /usr/bin/gnome-shell
```

GNOME 50 cannot reload the shell in place, so test every edit to `eventbar.js`,
`extension.js`, or `stylesheet.css` in a **nested shell**: run `./dev.sh`,
exercise it in the window, then close it and rerun. The nested shell needs the
`--devkit` helper from the `mutter-dev-bin` package
(`sudo apt install mutter-dev-bin`); without it, `--devkit` opens no window.

After changing the schema, recompile and rerun `./dev.sh`:

```bash
glib-compile-schemas schemas/     # rebuild schemas/gschemas.compiled
```

`prefs.js` edits need no reload — just reopen the preferences window.

### Testing in the nested shell

`./dev.sh` opens a full GNOME Shell in a window. It shares your user dconf, so an
extension already enabled in your normal session comes up active in the nested
window.

To drive the extension inside the nested shell (it has its own D-Bus session),
open a terminal within the nested window and use the normal commands there:

```bash
gnome-extensions enable  event-bar@cowgar.com
gnome-extensions disable event-bar@cowgar.com
gnome-extensions info    event-bar@cowgar.com   # State should be ACTIVE, no error
```

Errors from the nested instance print to the terminal you launched `./dev.sh`
from. Inside the window, `Alt+F2` → `lg` opens Looking Glass for live poking.

### Triggering indicators by hand

- **CPU / Disk:** `for i in $(seq 1 $(nproc)); do timeout 10 bash -c 'while :; do :; done' & done`
- **Volume:** `wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-` (and `5%+`)
- **Mic:** `timeout 4 pw-record /tmp/x.wav` then delete it
- **Workspace:** Super+Page Up/Down
- **Battery low (laptop):** raise `battery-low` to `100` in prefs, then unplug

---

## Architecture

### `extension.js`

The standard `Extension` subclass. It imports `EventBar` from `eventbar.js` and
forwards `enable()` / `disable()`, passing itself so the logic can reach
`this.getSettings()`. All real work lives in `eventbar.js`.

### `eventbar.js`

`class EventBar` (`enable` / `disable`) owns one **`SlotManager`**, an array of
**sources**, and a **`PanelController`**. Construction happens in `_build()`;
`enable()` also connects to the settings `changed` signal and calls `_rebuild()`
(`_teardown()` + `_build()`) on any change, so edits apply live. The rebuild is
debounced (`_queueRebuild`, ~150ms) so a burst of `changed` events from dragging
a prefs spin row coalesces into one rebuild. `_teardown()` and `disable()`
restore the panel first, so a source error cannot leave the panel hidden.

Sources are constructed defensively: one failing source logs and the rest still
start. `_build()` skips any source whose `<source>-enabled` key is false.

### `SlotManager`

Owns a single `St.BoxLayout` added via `Main.layoutManager.addTopChrome`,
positioned against a configurable screen edge (`anchor-vertical` = top/bottom,
`anchor-horizontal` = left/center/right — defaults `top`/`center`). Sources
interact with it through:

```js
slots.show(key, text, { lingerMs, alert });  // create/update a named pill
slots.hide(key);                             // animate out + remove
```

- A **persistent** slot stays until `hide()` is called (CPU, memory, disk, mic,
  workspace-alert).
- A **transient** slot passes `lingerMs` and auto-hides after that delay; calling
  `show()` again re-arms the timer (volume, network, workspace, clock,
  brightness, battery).
- `alert: true` adds the `event-bar-pill-alert` CSS class (red).

Pills animate in/out with `actor.ease()` (translation + opacity). They slide
from the anchored edge — down from the top, up from the bottom — so `pill-travel`
is stored signed (negative for a top anchor) and reused for both the hidden start
offset and the slide-out target. The container re-anchors itself on
`notify::width`, `notify::height` (the bottom anchor pins the lower edge, so its
Y shifts as the stack grows), and `monitors-changed`. With a non-zero
`pill-border-radius`, the rounded corners sit on the *free* edge (away from the
screen) so the pill reads as attached.

**Theming.** Each pill carries the shell's own `osd-window` class, so by default
it inherits GNOME's themed popup surface and tracks the active
light/dark/high-contrast variant; `stylesheet.css` only strips that class's
popup-sized layout. The `Appearance → Theme` keys (`pill-bg-color`,
`pill-text-color`, `pill-border-color`, `alert-bg-color`, `pill-border-radius`,
`pill-font-size`, `pill-font-weight`) are read once in the `SlotManager`
constructor and compiled into inline styles applied per pill — but only for keys
the user set (empty string / `0` ⇒ no rule, so the class wins). The colors are
stored as CSS color strings (alpha included); `prefs.js` round-trips them through
`Gdk.RGBA` since `settings.bind` cannot bridge string ⇄ color.

### Sources

Two shapes:

**Polling** — extend `PollSource` (runs `_tick()` every N seconds, plus once
immediately, and hides its slot on `destroy`):

- `CpuSource` — delta of `/proc/stat`.
- `MemSource` — `/proc/meminfo` (`MemTotal − MemAvailable`).
- `DiskSource` — `Gio.File.query_filesystem_info` on the `disk-path` setting.

The base `PollSource` defers the first `_tick()` to idle so a subclass
constructor can assign its fields (threshold, path) before `_tick()` reads them.

**Event-driven** — plain classes that connect to a signal/proxy in the
constructor and clean up in `destroy()`:

- `VolumeSource` — `Gvc.MixerControl`, default sink `notify::volume` /
  `notify::is-muted`. Suppresses the pill for ~800ms after setup so the initial
  state does not fire one.
- `NetworkSource` — `NM.Client` (async), `notify::primary-connection` /
  `notify::connectivity`. Covers wired too (`NET …`); the schema key stays
  `wifi-enabled` for compatibility.
- `WorkspaceSource` — `workspace-switched` (transient pill) and
  `window-demands-attention` / `window-marked-urgent` (persistent red alert in a
  separate `workspace-alert` slot, cleared when you switch to that workspace).
- `ClockSource` — schedules to the next wall-clock boundary and re-schedules
  after each fire (self-correcting against drift and DST); also a 3s peek on
  enable.
- `BrightnessSource` / `BatterySource` — both extend `DBusProxySource`, a base
  that async-constructs a `Gio.DBusProxy`, wires `g-properties-changed`, and owns
  the cancel/disconnect cleanup. Subclasses override `_onReady()` and
  `_onPropertiesChanged()`, and read props via `_prop()`.
  - Brightness: `org.gnome.SettingsDaemon.Power.Screen` (session bus), reacts to
    `Brightness`. Silent with no controllable backlight.
  - Battery: UPower `DisplayDevice` (**system** bus). Transient pill on AC
    plug/unplug; persistent red while low or critical.
- `MicSource` — `Gvc.MixerControl`; persistent pill while
  `get_source_outputs().length > 0`.

Signal handlers go through the `Connections` helper: keep one `this._conn = new
Connections()`, register with `this._conn.connect(obj, signal, cb)`, and empty it
with `this._conn.disconnectAll()` in `destroy()`. (`VolumeSource` keeps a second
`Connections` for the per-stream handlers it re-binds on each default-sink
change.)

### `PanelController`

Hides the top panel and reclaims its space, with a hover-reveal:

- **Reclaim space:** find the panel's tracked-actor record via
  `Main.layoutManager._findActor(panelBox)`, flip its `affectsStruts` to `false`,
  and `_queueUpdateRegions()`. The work area becomes full height.
- **Hide visually:** `panelBox.translation_y = -height` (kept visible so it can
  animate; translation does not change allocation, so struts stay reclaimed).
- **Reveal:** a reactive strip (`addTopChrome`) along the top edge catches the
  pointer (`enter-event`) and slides `panelBox` down as an overlay. A
  `panel-watch-ms` pointer-poll retracts it once the pointer leaves (staying down
  while a panel menu is open).
- **Overview:** the bar stays hidden during the overview. A hover-revealed bar
  retracts on overview `showing`, and hover cannot reveal while the overview is
  visible.
- **`destroy()`** restores `translation_y = 0`, the original `affectsStruts`, and
  `_queueUpdateRegions()`.

The LayoutManager APIs used here (`_findActor`, `_trackedActors`,
`_queueUpdateRegions`) are private and may change between GNOME versions —
re-verify on upgrade.

---

## Settings (`prefs.js` + `schemas/`)

Every tunable lives in GSettings, not in code. The schema defines one key per
knob plus a `<source>-enabled` boolean per source. `prefs.js` is an
`ExtensionPreferences` subclass that builds an Adwaita UI and `settings.bind()`s
each row to its key; it runs in a separate process, so edits apply on next open.
Settings come from `this._extension.getSettings()`, which resolves the schema
from `metadata.json`'s `settings-schema` key.

---

## Adding a source

1. Write a class taking `(slots, settings)` with a constructor (read keys, start
   watching) and `destroy()` (stop + `this._slots.hide(key)`), or extend
   `PollSource` and override `_tick()`.
2. Call `this._slots.show(key, text, opts)` / `.hide(key)`. Wrap any visible pill
   text in `_()` (use `fmt(_('…%d…'), value)` when it carries a value).
3. Add a `<source>-enabled` key (and any knobs) to the schema and a row to
   `prefs.js`, then a keyed factory line to `EventBar._build()`:
   ```js
   ['my-enabled', () => new MySource(this._slots, s)],
   ```
4. Re-run `xgettext` (see Translations) so the `.pot` stays in sync.
5. Reload in a nested shell (`./dev.sh`) and check the journal.

**Cleanup is mandatory.** In `destroy()`, remove every GLib timer
(`GLib.Source.remove`), disconnect every signal, cancel every `Gio.Cancellable`,
and destroy every actor. Leaks get extensions rejected from EGO review.

---

## Translations (gettext)

User-visible strings are wrapped for gettext. `metadata.json` declares
`"gettext-domain": "event-bar@cowgar.com"`, and each process imports the
domain-aware convenience function:

- `eventbar.js` (shell process): `import {gettext as _} from
  'resource:///org/gnome/shell/extensions/extension.js';`
- `prefs.js` (prefs process): `gettext as _` from the `…/prefs.js` resource.

Pills interpolate a value into a translated template via the local `fmt()` helper
(`fmt(_('CPU %d%'), usage)`), which fills one `%s`/`%d` with a replacer function
so a value containing `$` (e.g. a Wi-Fi SSID) is never read as a substitution
pattern. The clock pill is not wrapped: its text is the user's `clock-format`
strftime string.

No `locale/` is shipped, so gettext returns the English msgid as-is. The template
lives at `po/event-bar@cowgar.com.pot`. To regenerate it (needs the `gettext`
package) and add a language:

```bash
xgettext --from-code=UTF-8 --language=JavaScript \
    --keyword=_ --keyword=ngettext:1,2 --package-name='Event Bar' \
    -o po/event-bar@cowgar.com.pot eventbar.js prefs.js   # refresh template
msginit --input=po/event-bar@cowgar.com.pot --locale=de --output=po/de.po
# …translate po/de.po, then compile into the loaded locale tree:
msgfmt po/de.po -o locale/de/LC_MESSAGES/event-bar@cowgar.com.mo
```

---

## Before publishing

- Bump `version` in `metadata.json`.
- Refresh `po/event-bar@cowgar.com.pot` if any `_()` strings changed.
- Run `glib-compile-schemas schemas/` and include `gschemas.compiled` in the ZIP
  so a manual install works (it is git-ignored; EGO recompiles it server-side).
- Verify everything is torn down in `destroy()` (including `PollSource._initTimer`
  and the settings `changed` handler).
- Confirm `disable` restores the panel and removes all chrome.
</content>
</invoke>
