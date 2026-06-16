// SPDX-FileCopyrightText: 2026 Jeremy Cowgar <jeremy@cowgar.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gvc from 'gi://Gvc';
import NM from 'gi://NM';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Tunables live in GSettings (schemas/…gschema.xml), read at construction.
// Only the cosmetic "turns red" alert sub-thresholds stay inline below.

/**
 * Launch a user-configured shell command line for a clicked pill. Errors (e.g. a
 * mistyped command) are swallowed by the shell's helper, so a bad command can't
 * break the source that wired it.
 */
function launchCommand(command) {
    Util.spawnCommandLine(command);
}

/**
 * Resolve a `*-click-command` setting into an `onClick` handler for `show()`, or
 * null when the command is empty (the pill then stays non-interactive). Built
 * once per source so each tick reuses the same closure.
 */
function clickAction(settings, key) {
    const command = settings.get_string(key);
    return command ? () => launchCommand(command) : null;
}

/**
 * Fill a single `%s`/`%d` placeholder in a (translated) template. Uses a
 * replacer function so the substituted value is taken literally — values like a
 * Wi-Fi SSID containing `$` won't be read as a replacement pattern.
 */
function fmt(template, value) {
    return template.replace(/%[sd]/, () => String(value));
}

/**
 * A per-owner on/off latch over Mutter's fullscreen unredirection.
 *
 * A monitor-filling opaque window is scanned out directly, bypassing the
 * compositor, which hides anything we draw over it. Disabling unredirect keeps
 * the compositor in the loop so our overlays stay visible; re-enabling lets
 * direct scanout resume. The disable/enable calls are reference-counted in
 * Mutter, so each overlay keeps its own latch and toggles it freely without
 * unbalancing the others; `release()` is the idempotent teardown.
 */
class UnredirectGuard {
    constructor() {
        this._off = false;
    }

    set(off) {
        if (off === this._off)
            return;
        this._off = off;
        if (off)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    }

    release() {
        this.set(false);
    }
}

/**
 * Run `callback` once just before the next redraw, after the layout pass has
 * allocated actors. Returns an id to pass to `laterRemove()`. Used to defer work
 * that would otherwise touch a freshly-added, not-yet-allocated actor.
 */
function laterAdd(callback) {
    return global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, callback);
}

function laterRemove(id) {
    global.compositor.get_laters().remove(id);
}

/**
 * Tracks signal connections so a class can disconnect them all in one call.
 * Every source and controller keeps one and empties it in `destroy()`.
 */
class Connections {
    constructor() {
        this._items = []; // [obj, handlerId]
    }

    /** Connect `signal` on `obj` and remember the handler for later cleanup. */
    connect(obj, signal, callback) {
        this._items.push([obj, obj.connect(signal, callback)]);
    }

    disconnectAll() {
        for (const [obj, id] of this._items)
            obj.disconnect(id);
        this._items = [];
    }
}

/**
 * Owns the top-center container and a set of named "slots". Each event source
 * asks for a slot by key; slots animate in/out independently and the container
 * reflows as they come and go. A slot can be persistent (shown until hidden) or
 * transient (auto-hidden after `lingerMs`).
 */
class SlotManager {
    constructor(settings) {
        this._slots = new Map(); // key -> { pill, label, timer, enterId }
        this._slideMs = settings.get_int('slide-ms');
        this._pillTravel = settings.get_int('pill-travel');
        this._conn = new Connections();
        this._unredirect = new UnredirectGuard();

        // Theme overrides: inline styles built only from the keys the user
        // actually set. Empty/0 → no inline rule, so the `osd-window` class (and
        // stylesheet.css) supply the themed default. Inline beats both classes,
        // so a set value always wins. The pill needs two variants because its
        // background differs between the normal and alert state.
        this._pillStyleNormal = this._pillOverrides(settings, false) || null;
        this._pillStyleAlert = this._pillOverrides(settings, true) || null;
        this._labelStyle = this._labelOverrides(settings) || null;

        this._container = new St.BoxLayout({
            style_class: 'event-bar-container',
            reactive: false,
            x_expand: false,
            y_expand: false,
        });
        Main.layoutManager.addTopChrome(this._container);

        this._reposition();
        this._conn.connect(this._container, 'notify::width', () => this._reposition());
        this._conn.connect(Main.layoutManager, 'monitors-changed', () => this._reposition());
    }

    _reposition() {
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon)
            return;
        const w = this._container.width;
        this._container.set_position(
            Math.round(mon.x + (mon.width - w) / 2),
            mon.y,
        );
    }

    /**
     * Inline style for the pill surface, assembled from only the theme keys the
     * user set. In the alert state the background comes from `alert-bg-color`
     * (if set); leaving it empty lets the `event-bar-pill-alert` class supply
     * its built-in red. Returns '' when nothing is overridden.
     */
    _pillOverrides(s, alert) {
        const rules = [];
        const bg = alert ? s.get_string('alert-bg-color') : s.get_string('pill-bg-color');
        if (bg)
            rules.push(`background-color: ${bg};`);
        const border = s.get_string('pill-border-color');
        if (border)
            rules.push(`border-color: ${border};`);
        const radius = s.get_int('pill-border-radius');
        if (radius > 0) // squared top edge, rounded below — matches the classic look
            rules.push(`border-radius: 0 0 ${radius}px ${radius}px;`);
        return rules.join(' ');
    }

    /**
     * Inline style for the label. Always pins `margin: 0` to cancel the
     * `osd-window StLabel` margin (meant to offset text from the OSD icon we
     * don't have), then layers any user color/font overrides on top.
     */
    _labelOverrides(s) {
        const rules = ['margin: 0;'];
        const color = s.get_string('pill-text-color');
        if (color)
            rules.push(`color: ${color};`);
        const size = s.get_int('pill-font-size');
        if (size > 0)
            rules.push(`font-size: ${size}px;`);
        const weight = s.get_int('pill-font-weight');
        if (weight > 0)
            rules.push(`font-weight: ${weight};`);
        return rules.join(' ');
    }

    /**
     * Show or update slot `key` with `text`.
     * @param {object} [opts]
     * @param {number} [opts.lingerMs] auto-hide after this many ms (transient)
     * @param {boolean} [opts.alert] add an alert style class
     * @param {Function} [opts.onClick] make the pill clickable, calling this on
     *   press. Wired once, when the pill is first created for this key.
     */
    show(key, text, opts = {}) {
        let slot = this._slots.get(key);
        if (!slot) {
            const label = new St.Label({
                text,
                style_class: 'event-bar-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (this._labelStyle)
                label.set_style(this._labelStyle);
            // `osd-window` makes the pill inherit GNOME's themed popup surface;
            // stylesheet.css trims that class's popup-sized layout.
            const pill = new St.Bin({
                style_class: 'event-bar-pill osd-window',
                child: label,
                opacity: 0,
                translation_y: -this._pillTravel,
            });
            this._container.add_child(pill);
            slot = {pill, label, timer: 0, enterId: 0};
            this._slots.set(key, slot);
            // A clickable pill becomes reactive and runs the source's command on
            // press. The handler dies with the actor, so no separate cleanup.
            if (opts.onClick) {
                pill.reactive = true;
                pill.connect('button-press-event', () => {
                    opts.onClick();
                    return Clutter.EVENT_STOP;
                });
            }
            this._unredirect.set(true);
            // Defer the slide-in until the pill has an allocation: starting the
            // transition reads the actor's stage views, which warns (and skips)
            // if it runs before the first layout pass.
            slot.enterId = laterAdd(() => {
                slot.enterId = 0;
                pill.ease({
                    opacity: 255,
                    translation_y: 0,
                    duration: this._slideMs,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
                return GLib.SOURCE_REMOVE;
            });
        } else {
            slot.label.text = text;
        }

        slot.pill.remove_style_class_name('event-bar-pill-alert');
        if (opts.alert)
            slot.pill.add_style_class_name('event-bar-pill-alert');
        // Inline overrides win over both classes; null clears them so the
        // themed `osd-window`/alert defaults show through.
        slot.pill.set_style(opts.alert ? this._pillStyleAlert : this._pillStyleNormal);

        this._clearTimer(slot);
        if (opts.lingerMs) {
            slot.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, opts.lingerMs, () => {
                slot.timer = 0;
                this.hide(key);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    hide(key) {
        const slot = this._slots.get(key);
        if (!slot)
            return;
        this._slots.delete(key);
        this._clearPending(slot);
        slot.pill.ease({
            opacity: 0,
            translation_y: -this._pillTravel,
            duration: this._slideMs,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                slot.pill.destroy();
                if (this._slots.size === 0)
                    this._unredirect.release();
            },
        });
    }

    /** Cancel the linger timer (re-armed on each show). */
    _clearTimer(slot) {
        if (slot.timer) {
            GLib.Source.remove(slot.timer);
            slot.timer = 0;
        }
    }

    /** Cancel everything still pending for a slot we're tearing down. */
    _clearPending(slot) {
        this._clearTimer(slot);
        if (slot.enterId) {
            laterRemove(slot.enterId);
            slot.enterId = 0;
        }
    }

    destroy() {
        for (const slot of this._slots.values()) {
            this._clearPending(slot);
            slot.pill.destroy();
        }
        this._slots.clear();
        this._unredirect.release();
        this._conn.disconnectAll();
        this._container.destroy();
        this._container = null;
    }
}

/** Base for sources that run a callback every N seconds. */
class PollSource {
    constructor(slots, key, periodSeconds) {
        this._slots = slots;
        this._key = key;
        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT, periodSeconds, () => {
                this._tick();
                return GLib.SOURCE_CONTINUE;
            });
        // Defer the first tick to idle so the subclass constructor can assign its
        // fields (threshold, path) before _tick() reads them.
        this._initTimer = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._initTimer = 0;
            this._tick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _tick() { /* override */ }

    destroy() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }
        if (this._initTimer) {
            GLib.Source.remove(this._initTimer);
            this._initTimer = 0;
        }
        this._slots.hide(this._key);
    }
}

/** Aggregate CPU usage % from /proc/stat (delta between successive reads). */
class CpuSource extends PollSource {
    constructor(slots, settings) {
        super(slots, 'cpu', settings.get_int('cpu-poll-seconds'));
        this._threshold = settings.get_int('cpu-threshold');
        this._onClick = clickAction(settings, 'cpu-click-command');
        this._prev = null;
    }

    _tick() {
        const [ok, contents] = GLib.file_get_contents('/proc/stat');
        if (!ok)
            return;
        const parts = new TextDecoder().decode(contents)
            .split('\n')[0].trim().split(/\s+/).slice(1).map(Number);
        const [, , , idleTime, iowaitTime = 0] = parts;
        const idle = idleTime + iowaitTime;
        const total = parts.reduce((a, b) => a + b, 0);
        const now = {idle, total};
        if (this._prev) {
            const dTotal = now.total - this._prev.total;
            const dIdle = now.idle - this._prev.idle;
            const usage = dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : 0;
            if (usage > this._threshold)
                this._slots.show('cpu', fmt(_('CPU %d%'), usage), {alert: usage > 90, onClick: this._onClick});
            else
                this._slots.hide('cpu');
        }
        this._prev = now;
    }
}

/** Used-memory % from /proc/meminfo (MemTotal - MemAvailable). */
class MemSource extends PollSource {
    constructor(slots, settings) {
        super(slots, 'mem', settings.get_int('mem-poll-seconds'));
        this._threshold = settings.get_int('mem-threshold');
        this._onClick = clickAction(settings, 'mem-click-command');
    }

    _tick() {
        const [ok, contents] = GLib.file_get_contents('/proc/meminfo');
        if (!ok)
            return;
        const text = new TextDecoder().decode(contents);
        const grab = (name) => {
            const m = text.match(new RegExp(`^${name}:\\s+(\\d+)`, 'm'));
            return m ? Number(m[1]) : null;
        };
        const total = grab('MemTotal');
        const avail = grab('MemAvailable');
        if (!total || avail === null)
            return;
        const usage = Math.round((1 - avail / total) * 100);
        if (usage > this._threshold)
            this._slots.show('mem', fmt(_('MEM %d%'), usage), {alert: usage > 92, onClick: this._onClick});
        else
            this._slots.hide('mem');
    }
}

/** Filesystem usage % for the configured disk path via Gio. */
class DiskSource extends PollSource {
    constructor(slots, settings) {
        super(slots, 'disk', settings.get_int('disk-poll-seconds'));
        this._threshold = settings.get_int('disk-threshold');
        this._path = settings.get_string('disk-path');
        this._onClick = clickAction(settings, 'disk-click-command');
    }

    _tick() {
        try {
            const info = Gio.File.new_for_path(this._path).query_filesystem_info(
                'filesystem::size,filesystem::free,filesystem::used', null);
            const size = info.get_attribute_uint64('filesystem::size');
            const free = info.get_attribute_uint64('filesystem::free');
            let used = info.get_attribute_uint64('filesystem::used');
            if (!used)
                used = size - free;
            if (!size)
                return;
            const usage = Math.round((used / size) * 100);
            if (usage > this._threshold)
                this._slots.show('disk', fmt(_('DISK %d%'), usage), {alert: usage > 95, onClick: this._onClick});
            else
                this._slots.hide('disk');
        } catch (e) {
            logError(e, 'EventBar: disk query failed');
        }
    }
}

/** Event-driven: transient pill when the output volume/mute changes. */
class VolumeSource {
    constructor(slots, settings) {
        this._slots = slots;
        this._lingerMs = settings.get_int('volume-linger-ms');
        this._stream = null;
        this._streamConn = new Connections(); // re-bound on each sink change
        this._conn = new Connections();
        this._ready = false; // suppress the pill during initial setup
        this._readyTimer = 0;

        this._control = new Gvc.MixerControl({name: 'Event Bar'});
        this._conn.connect(this._control, 'default-sink-changed',
            (_c, id) => this._onDefaultSinkChanged(id));
        this._control.open();
    }

    _onDefaultSinkChanged(id) {
        this._disconnectStream();
        this._stream = id ? this._control.lookup_stream_id(id) : null;
        if (!this._stream)
            return;
        this._streamConn.connect(this._stream, 'notify::volume', () => this._report());
        this._streamConn.connect(this._stream, 'notify::is-muted', () => this._report());
        if (!this._ready && !this._readyTimer) {
            this._readyTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 800, () => {
                this._ready = true;
                this._readyTimer = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _report() {
        if (!this._ready || !this._stream)
            return;
        let text, alert = false;
        if (this._stream.is_muted) {
            text = _('VOL muted');
            alert = true;
        } else {
            const max = this._control.get_vol_max_norm();
            const pct = max > 0 ? Math.round((this._stream.volume / max) * 100) : 0;
            text = fmt(_('VOL %d%'), pct);
        }
        this._slots.show('volume', text, {lingerMs: this._lingerMs, alert});
    }

    _disconnectStream() {
        this._streamConn.disconnectAll();
        this._stream = null;
    }

    destroy() {
        if (this._readyTimer)
            GLib.Source.remove(this._readyTimer);
        this._disconnectStream();
        this._conn.disconnectAll();
        this._control.close();
        this._control = null;
        this._slots.hide('volume');
    }
}

/**
 * Event-driven: transient pill on network change; alert when connectivity drops.
 * Covers wired connections too (the `NET …` label), not just Wi-Fi — the schema
 * key stays `wifi-enabled` for backwards compatibility.
 */
class NetworkSource {
    constructor(slots, settings) {
        this._slots = slots;
        this._lingerMs = settings.get_int('wifi-linger-ms');
        this._client = null;
        this._conn = new Connections();
        this._cancellable = new Gio.Cancellable();

        NM.Client.new_async(this._cancellable, (_obj, res) => {
            try {
                this._client = NM.Client.new_finish(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    logError(e, 'EventBar: NM client failed');
                return; // cancelled means we were torn down mid-construction
            }
            this._conn.connect(this._client, 'notify::primary-connection', () => this._update(false));
            this._conn.connect(this._client, 'notify::connectivity', () => this._update(false));
            this._conn.connect(this._client, 'notify::wireless-enabled', () => this._update(false));
            this._update(true); // record startup state without showing a pill
        });
    }

    _update(initial) {
        if (!this._client)
            return;
        const ac = this._client.get_primary_connection();
        const full = this._client.get_connectivity() === NM.ConnectivityState.FULL;

        let text, alert = false;
        if (!ac) {
            text = _('No network');
            alert = true;
        } else {
            const id = ac.get_id();
            const wireless = ac.get_connection_type() === '802-11-wireless';
            text = fmt(wireless ? _('WiFi %s') : _('NET %s'), id);
            alert = !full;
        }
        if (!initial)
            this._slots.show('network', text, {lingerMs: this._lingerMs, alert});
    }

    destroy() {
        this._cancellable.cancel();
        this._conn.disconnectAll();
        this._client = null;
        this._slots.hide('network');
    }
}

/**
 * Event-driven: transient pill when the active workspace changes, plus a
 * persistent red alert pill listing workspaces with a window demanding
 * attention. An alert clears once you switch to that workspace.
 */
class WorkspaceSource {
    constructor(slots, settings) {
        this._slots = slots;
        this._lingerMs = settings.get_int('workspace-linger-ms');
        this._wm = global.workspace_manager;
        this._display = global.display;
        this._alerts = new Set(); // workspace indices with pending attention
        this._conn = new Connections();

        this._gnomePopupShowSwitcher = null;
        if (settings.get_boolean('workspace-disable-popup'))
            this._suppressGnomeWorkspacePopup();

        this._conn.connect(this._wm, 'workspace-switched',
            (_wm, _from, to) => this._onSwitch(to));
        this._conn.connect(this._display, 'window-demands-attention',
            (_d, win) => this._onAttention(win));
        this._conn.connect(this._display, 'window-marked-urgent',
            (_d, win) => this._onAttention(win));
    }

    _onSwitch(to) {
        this._slots.show('workspace', fmt(_('Workspace %d'), to + 1),
            {lingerMs: this._lingerMs});
        if (this._alerts.delete(to))
            this._updateAlertPill();
    }

    _onAttention(win) {
        const ws = win?.get_workspace?.();
        if (!ws)
            return;
        const idx = ws.index();
        if (idx === this._wm.get_active_workspace_index())
            return; // you're already looking at it
        this._alerts.add(idx);
        this._updateAlertPill();
    }

    _updateAlertPill() {
        if (this._alerts.size === 0) {
            this._slots.hide('workspace-alert');
            return;
        }
        const list = [...this._alerts].sort((a, b) => a - b)
            .map(i => i + 1).join(',');
        this._slots.show('workspace-alert', fmt(_('⚠ Workspace %s'), list),
            {alert: true}); // persistent until visited
    }

    _suppressGnomeWorkspacePopup() {
        this._gnomePopupShowSwitcher = Main.wm._showWorkspaceSwitcher;
        Main.wm._showWorkspaceSwitcher = () => {};
    }

    _restoreGnomeWorkspacePopup() {
        if (!this._gnomePopupShowSwitcher)
            return;
        Main.wm._showWorkspaceSwitcher = this._gnomePopupShowSwitcher;
        this._gnomePopupShowSwitcher = null;
    }

    destroy() {
        this._conn.disconnectAll();
        this._restoreGnomeWorkspacePopup();
        this._slots.hide('workspace');
        this._slots.hide('workspace-alert');
    }
}

/**
 * Base for sources backed by an async-constructed `Gio.DBusProxy` that reacts to
 * `g-properties-changed`. The subclass passes its bus/name/path/interface, then
 * overrides `_onReady()` (proxy just connected) and `_onPropertiesChanged()`.
 * Proxy construction is async, so the subclass constructor can finish assigning
 * its fields before either hook fires. Cleanup (cancel, disconnect) is handled
 * here; the subclass only hides its slots in `_onDestroy()`.
 */
class DBusProxySource {
    constructor(slots, {bus, name, path, iface}) {
        this._slots = slots;
        this._proxy = null;
        this._conn = new Connections();
        this._cancellable = new Gio.Cancellable();

        Gio.DBusProxy.new(
            bus, Gio.DBusProxyFlags.NONE, null, name, path, iface,
            this._cancellable, (_src, res) => {
                try {
                    this._proxy = Gio.DBusProxy.new_finish(res);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        logError(e, `EventBar: ${name} proxy failed`);
                    return; // cancelled means we were torn down mid-construction
                }
                this._conn.connect(this._proxy, 'g-properties-changed',
                    (_p, changed) => this._onPropertiesChanged(changed));
                this._onReady();
            });
    }

    /** Read and unpack a cached D-Bus property, or null if absent. */
    _prop(name) {
        const v = this._proxy?.get_cached_property(name);
        return v ? v.deep_unpack() : null;
    }

    _onReady() { /* override: proxy is connected */ }

    _onPropertiesChanged(_changed) { /* override */ }

    _onDestroy() { /* override: hide slots */ }

    destroy() {
        this._cancellable.cancel();
        this._conn.disconnectAll();
        this._proxy = null;
        this._onDestroy();
    }
}

/** Event-driven: transient pill when screen brightness changes (gsd Power). */
class BrightnessSource extends DBusProxySource {
    constructor(slots, settings) {
        super(slots, {
            bus: Gio.DBus.session,
            name: 'org.gnome.SettingsDaemon.Power',
            path: '/org/gnome/SettingsDaemon/Power',
            iface: 'org.gnome.SettingsDaemon.Power.Screen',
        });
        this._lingerMs = settings.get_int('brightness-linger-ms');
    }

    _onPropertiesChanged(changed) {
        if (!('Brightness' in changed.deep_unpack()))
            return;
        const val = this._prop('Brightness');
        if (val === null || val < 0)
            return; // no controllable backlight
        this._slots.show('brightness', fmt(_('BRT %d%'), val), {lingerMs: this._lingerMs});
    }

    _onDestroy() {
        this._slots.hide('brightness');
    }
}

// org.freedesktop.UPower.Device State enum values.
const UPOWER_STATE_CHARGING = 1;
const UPOWER_STATE_DISCHARGING = 2;
const UPOWER_STATE_PENDING_CHARGE = 5;

/** Event-driven: pill on AC plug/unplug; persistent red pill while low. */
class BatterySource extends DBusProxySource {
    constructor(slots, settings) {
        super(slots, {
            bus: Gio.DBus.system,
            name: 'org.freedesktop.UPower',
            path: '/org/freedesktop/UPower/devices/DisplayDevice',
            iface: 'org.freedesktop.UPower.Device',
        });
        this._lingerMs = settings.get_int('battery-linger-ms');
        this._low = settings.get_int('battery-low');
        this._critical = settings.get_int('battery-critical');
        this._prevCharging = null;
    }

    _onReady() {
        this._update(true);
    }

    _onPropertiesChanged() {
        this._update(false);
    }

    _update(initial) {
        if (!this._prop('IsPresent'))
            return; // no battery (desktop)
        const pct = Math.round(this._prop('Percentage') ?? 0);
        const state = this._prop('State');
        const charging = state === UPOWER_STATE_CHARGING
            || state === UPOWER_STATE_PENDING_CHARGE;
        const discharging = state === UPOWER_STATE_DISCHARGING;

        if (!initial && this._prevCharging !== null && charging !== this._prevCharging) {
            this._slots.show('battery', fmt(charging ? _('AC %d%') : _('BAT %d%'), pct),
                {lingerMs: this._lingerMs});
        }
        this._prevCharging = charging;

        if (discharging && pct <= this._low)
            this._slots.show('battery-low', fmt(_('BAT %d%'), pct), {alert: pct <= this._critical});
        else
            this._slots.hide('battery-low');
    }

    _onDestroy() {
        this._slots.hide('battery');
        this._slots.hide('battery-low');
    }
}

/** Event-driven: persistent red pill while a microphone is being recorded. */
class MicSource {
    constructor(slots, _settings) { // no tunables; signature matches its siblings
        this._slots = slots;
        this._conn = new Connections();
        this._control = new Gvc.MixerControl({name: 'Event Bar Mic'});
        this._conn.connect(this._control, 'stream-added', () => this._update());
        this._conn.connect(this._control, 'stream-removed', () => this._update());
        this._conn.connect(this._control, 'state-changed', () => this._update());
        this._control.open();
    }

    _update() {
        if (!this._control)
            return;
        const inUse = this._control.get_source_outputs().length > 0;
        if (inUse)
            this._slots.show('mic', _('MIC ●'), {alert: true});
        else
            this._slots.hide('mic');
    }

    destroy() {
        this._conn.disconnectAll();
        this._control.close();
        this._control = null;
        this._slots.hide('mic');
    }
}

/**
 * Time-driven: drops the clock pill aligned to wall-clock increments
 * (e.g. :00, :05, :10 for a 5-min interval), plus an immediate peek on load.
 * Re-aligns after each fire, so it self-corrects against timer drift and DST.
 * Assumes clock-interval-seconds is a whole number of minutes that divides 60.
 */
class ClockSource {
    constructor(slots, settings) {
        this._slots = slots;
        this._intervalSeconds = settings.get_int('clock-interval-seconds');
        this._lingerMs = settings.get_int('clock-linger-ms');
        this._format = settings.get_string('clock-format');
        this._timer = 0;
        // brief peek shortly after load
        this._peekTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
            this._show();
            this._peekTimer = 0;
            return GLib.SOURCE_REMOVE;
        });
        this._scheduleNext();
    }

    _scheduleNext() {
        const now = GLib.DateTime.new_now_local();
        const blockMin = this._intervalSeconds / 60;
        const intoBlock = (now.get_minute() % blockMin) * 60 + now.get_second();
        let wait = this._intervalSeconds - intoBlock; // seconds to next boundary
        if (wait <= 0)
            wait = this._intervalSeconds;
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, wait, () => {
            this._timer = 0;
            this._show();
            this._scheduleNext();
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        const now = GLib.DateTime.new_now_local().format(this._format);
        this._slots.show('clock', now, {lingerMs: this._lingerMs});
    }

    destroy() {
        if (this._peekTimer)
            GLib.Source.remove(this._peekTimer);
        if (this._timer)
            GLib.Source.remove(this._timer);
        this._peekTimer = 0;
        this._timer = 0;
        this._slots.hide('clock');
    }
}

/**
 * Hides the top panel and reclaims its space, with a hover-reveal. The panel's
 * strut contribution is turned off (via the LayoutManager tracked-actor record)
 * so the work area is full height, and the panel is moved off-screen with a
 * translation — kept "visible" so it can animate back. Pointing at the top edge
 * slides it down as an overlay; it retracts when the pointer leaves. The bar
 * stays hidden during the overview (re-adding struts there resizes the windows
 * behind it and snaps when it closes). All of this is reverted in destroy().
 */
class PanelController {
    constructor(settings) {
        this._lm = Main.layoutManager;
        this._box = this._lm.panelBox;
        this._revealed = false;
        this._watch = 0;
        this._enabled = false;
        this._unredirect = new UnredirectGuard();
        this._strutData = null;
        this._conn = new Connections();
        this._slideMs = settings.get_int('slide-ms');
        this._watchMs = settings.get_int('panel-watch-ms');
        this._triggerPx = settings.get_int('panel-hover-trigger-px');

        if (settings.get_boolean('hide-panel'))
            this._enable();
    }

    _enable() {
        const idx = this._lm._findActor(this._box);
        if (idx >= 0) {
            this._strutData = this._lm._trackedActors[idx];
            this._origAffectsStruts = this._strutData.affectsStruts;
        }

        this._height = this._box.height || Main.panel.height || 32;
        this._setStruts(false);
        this._box.translation_y = -this._height;

        this._trigger = new St.Widget({reactive: true, can_focus: false});
        this._lm.addTopChrome(this._trigger);
        this._sizeTrigger();
        this._conn.connect(this._trigger, 'enter-event', () => this._reveal());
        this._conn.connect(this._lm, 'monitors-changed', () => this._sizeTrigger());

        this._conn.connect(Main.overview, 'showing', () => this._hide());

        this._enabled = true;
    }

    _sizeTrigger() {
        const mon = this._lm.primaryMonitor;
        if (!mon || !this._trigger)
            return;
        this._trigger.set_position(mon.x, mon.y);
        this._trigger.set_size(mon.width, this._triggerPx);
    }

    _pointerInPanel() {
        const [px, py] = global.get_pointer();
        const [bx, by] = this._box.get_transformed_position();
        return px >= bx && px < bx + this._box.width
            && py >= by && py < by + this._box.height;
    }

    _menuOpen() {
        return !!(Main.panel.menuManager && Main.panel.menuManager.activeMenu);
    }

    _reveal() {
        if (Main.overview.visible)
            return; // overview shows without the bar to avoid overlap
        if (!this._revealed) {
            this._revealed = true;
            this._unredirect.set(true);
            this._box.ease({
                translation_y: 0,
                duration: this._slideMs,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }
        this._startWatch();
    }

    _setStruts(on) {
        if (!this._strutData)
            return;
        this._strutData.affectsStruts = on ? this._origAffectsStruts : false;
        this._lm._queueUpdateRegions();
    }

    _startWatch() {
        if (this._watch)
            return;
        this._watch = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this._watchMs, () => {
            if (this._pointerInPanel() || this._menuOpen())
                return GLib.SOURCE_CONTINUE;
            this._watch = 0;
            this._hide();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopWatch() {
        if (this._watch) {
            GLib.Source.remove(this._watch);
            this._watch = 0;
        }
    }

    _hide() {
        this._stopWatch();
        if (!this._revealed)
            return;
        this._revealed = false;
        this._unredirect.release();
        this._box.ease({
            translation_y: -this._height,
            duration: this._slideMs,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
        });
    }

    destroy() {
        if (!this._enabled)
            return;
        this._stopWatch();
        this._unredirect.release();
        this._conn.disconnectAll();
        if (this._trigger) {
            this._trigger.destroy();
            this._trigger = null;
        }
        // restore the panel to its normal place
        this._box.translation_y = 0;
        if (this._strutData) {
            this._strutData.affectsStruts = this._origAffectsStruts;
            this._lm._queueUpdateRegions();
            this._strutData = null;
        }
        this._enabled = false;
    }
}

/** Top-level orchestrator: owns the slot manager, sources, and panel controller. */
export class EventBar {
    constructor(extension) {
        this._extension = extension;
    }

    enable() {
        this._settings = this._extension.getSettings();
        this._rebuildTimer = 0;
        // Sources read settings once at construction, so rebuild everything on
        // any change to apply new values live — debounced, because dragging a
        // spin row in prefs fires a burst of `changed` and a full rebuild
        // re-creates async D-Bus proxies and flickers the panel each time.
        this._idChanged = this._settings.connect('changed', () => this._queueRebuild());
        this._build();
    }

    _queueRebuild() {
        if (this._rebuildTimer)
            GLib.Source.remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 150, () => {
            this._rebuildTimer = 0;
            this._rebuild();
            return GLib.SOURCE_REMOVE;
        });
    }

    _build() {
        const s = this._settings;
        this._slots = new SlotManager(s);
        try {
            this._panel = new PanelController(s);
        } catch (e) {
            this._panel = null;
            logError(e, 'EventBar: panel controller failed');
        }
        this._sources = [];
        // Each entry: a settings key gating the source, and a factory for it.
        const factories = [
            ['cpu-enabled', () => new CpuSource(this._slots, s)],
            ['mem-enabled', () => new MemSource(this._slots, s)],
            ['disk-enabled', () => new DiskSource(this._slots, s)],
            ['volume-enabled', () => new VolumeSource(this._slots, s)],
            ['wifi-enabled', () => new NetworkSource(this._slots, s)],
            ['workspace-enabled', () => new WorkspaceSource(this._slots, s)],
            ['clock-enabled', () => new ClockSource(this._slots, s)],
            ['brightness-enabled', () => new BrightnessSource(this._slots, s)],
            ['battery-enabled', () => new BatterySource(this._slots, s)],
            ['mic-enabled', () => new MicSource(this._slots, s)],
        ];
        for (const [key, make] of factories) {
            if (!s.get_boolean(key))
                continue;
            try {
                this._sources.push(make());
            } catch (e) {
                logError(e, 'EventBar: a source failed to start');
            }
        }
    }

    _teardown() {
        // restore the panel first, so a source error can never leave it hidden
        if (this._panel) {
            try {
                this._panel.destroy();
            } catch (e) {
                logError(e, 'EventBar: panel controller failed to restore');
            }
            this._panel = null;
        }
        for (const s of this._sources) {
            try {
                s.destroy();
            } catch (e) {
                logError(e, 'EventBar: a source failed to stop');
            }
        }
        this._sources = null;
        this._slots.destroy();
        this._slots = null;
    }

    _rebuild() {
        this._teardown();
        this._build();
    }

    disable() {
        if (this._rebuildTimer) {
            GLib.Source.remove(this._rebuildTimer);
            this._rebuildTimer = 0;
        }
        if (this._idChanged) {
            this._settings.disconnect(this._idChanged);
            this._idChanged = 0;
        }
        this._teardown();
        this._settings = null;
    }
}
