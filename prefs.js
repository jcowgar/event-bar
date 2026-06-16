// SPDX-FileCopyrightText: 2026 Jeremy Cowgar <jeremy@cowgar.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Preferences UI for Event Bar. Every row binds directly to a GSettings key, so
 * the running extension picks changes up live (it rebuilds on `changed`). Layout
 * mirrors the schema: one group per source on the Indicators page, plus an
 * Appearance page for animation and the hidden-panel behavior.
 */
export default class EventBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const indicators = new Adw.PreferencesPage({
            title: _('Indicators'),
            icon_name: 'view-grid-symbolic',
        });
        window.add(indicators);

        // --- system meters -----------------------------------------------
        indicators.add(this._group(settings, _('CPU'), [
            this._toggle('cpu-enabled', _('Enabled')),
            this._spin('cpu-threshold', _('Threshold (%)'), 1, 100, 1),
            this._spin('cpu-poll-seconds', _('Poll interval (s)'), 1, 60, 1),
            this._entry('cpu-click-command', _('Click command')),
        ]));

        indicators.add(this._group(settings, _('Memory'), [
            this._toggle('mem-enabled', _('Enabled')),
            this._spin('mem-threshold', _('Threshold (%)'), 1, 100, 1),
            this._spin('mem-poll-seconds', _('Poll interval (s)'), 1, 120, 1),
            this._entry('mem-click-command', _('Click command')),
        ]));

        indicators.add(this._group(settings, _('Disk'), [
            this._toggle('disk-enabled', _('Enabled')),
            this._entry('disk-path', _('Path to watch')),
            this._spin('disk-threshold', _('Threshold (% full)'), 1, 100, 1),
            this._spin('disk-poll-seconds', _('Poll interval (s)'), 5, 3600, 5),
            this._entry('disk-click-command', _('Click command')),
        ]));

        // --- event indicators --------------------------------------------
        indicators.add(this._group(settings, _('Volume'), [
            this._toggle('volume-enabled', _('Enabled')),
            this._spin('volume-linger-ms', _('Linger (ms)'), 200, 10000, 100),
        ]));

        indicators.add(this._group(settings, _('Network'), [
            this._toggle('wifi-enabled', _('Enabled')),
            this._spin('wifi-linger-ms', _('Linger (ms)'), 200, 10000, 100),
        ]));

        indicators.add(this._group(settings, _('Workspace'), [
            this._toggle('workspace-enabled', _('Enabled')),
            this._spin('workspace-linger-ms', _('Linger (ms)'), 200, 10000, 100),
            this._toggle('workspace-disable-popup',
                _('Disable GNOME workspace popup')),
        ]));

        indicators.add(this._group(settings, _('Clock'), [
            this._toggle('clock-enabled', _('Enabled')),
            this._entry('clock-format', _('Format (strftime)')),
            this._spin('clock-interval-seconds', _('Interval (s)'), 60, 3600, 60),
            this._spin('clock-linger-ms', _('Linger (ms)'), 500, 60000, 500),
        ]));

        indicators.add(this._group(settings, _('Brightness'), [
            this._toggle('brightness-enabled', _('Enabled')),
            this._spin('brightness-linger-ms', _('Linger (ms)'), 200, 10000, 100),
        ]));

        indicators.add(this._group(settings, _('Battery'), [
            this._toggle('battery-enabled', _('Enabled')),
            this._spin('battery-low', _('Low (%)'), 1, 100, 1),
            this._spin('battery-critical', _('Critical (%)'), 1, 100, 1),
            this._spin('battery-linger-ms', _('Linger (ms)'), 200, 10000, 100),
        ]));

        indicators.add(this._group(settings, _('Microphone'), [
            this._toggle('mic-enabled', _('Enabled')),
        ]));

        // --- appearance page ---------------------------------------------
        const appearance = new Adw.PreferencesPage({
            title: _('Appearance'),
            icon_name: 'applications-graphics-symbolic',
        });
        window.add(appearance);

        appearance.add(this._group(settings, _('Animation'), [
            this._spin('slide-ms', _('Slide duration (ms)'), 0, 2000, 10),
            this._spin('pill-travel', _('Travel distance (px)'), 0, 400, 1),
        ]));

        appearance.add(this._group(settings, _('Theme'), [
            this._color('pill-bg-color', _('Background color')),
            this._color('pill-text-color', _('Text color')),
            this._color('pill-border-color', _('Border color')),
            this._color('alert-bg-color', _('Alert background color')),
            this._spin('pill-border-radius', _('Corner radius (px, 0 = theme)'), 0, 32, 1),
            this._spin('pill-font-size', _('Font size (px, 0 = theme)'), 0, 32, 1),
            this._spin('pill-font-weight', _('Font weight (0 = theme)'), 0, 900, 100),
        ]));

        appearance.add(this._group(settings, _('Top panel'), [
            this._toggle('hide-panel', _('Hide the top panel')),
            this._spin('panel-hover-trigger-px', _('Reveal-strip height (px)'), 1, 20, 1),
            this._spin('panel-watch-ms', _('Pointer poll while revealed (ms)'), 50, 2000, 10),
        ]));
    }

    /** Build a group from row-factory closures, binding each to `settings`. */
    _group(settings, title, rowMakers) {
        const group = new Adw.PreferencesGroup({title});
        for (const make of rowMakers)
            group.add(make(settings));
        return group;
    }

    _toggle(key, title) {
        return (settings) => {
            const row = new Adw.SwitchRow({title});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
    }

    _spin(key, title, lower, upper, step) {
        return (settings) => {
            const row = new Adw.SpinRow({
                title,
                adjustment: new Gtk.Adjustment({
                    lower, upper,
                    step_increment: step,
                    page_increment: step * 10,
                }),
            });
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
    }

    _entry(key, title) {
        return (settings) => {
            const row = new Adw.EntryRow({title});
            settings.bind(key, row, 'text', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
    }

    /**
     * Color row bound to a string key holding a CSS color (e.g.
     * `rgba(20,20,20,0.85)`). The picker includes alpha, so transparency is
     * part of the color. An empty string means "inherit the GNOME theme"; the
     * reset button clears back to that default. `set_string` round-trips can't
     * use `settings.bind` (string ⇄ Gdk.RGBA), so we sync both ways manually
     * and guard the loop with `syncing`.
     */
    _color(key, title) {
        return (settings) => {
            const row = new Adw.ActionRow({title});
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: true}),
                valign: Gtk.Align.CENTER,
            });
            const reset = new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                tooltip_text: _('Use theme default'),
                valign: Gtk.Align.CENTER,
                has_frame: false,
            });

            let syncing = false;
            const pull = () => {
                syncing = true;
                const str = settings.get_string(key);
                const rgba = new Gdk.RGBA();
                button.set_rgba(rgba.parse(str) ? rgba : new Gdk.RGBA());
                reset.sensitive = str !== '';
                syncing = false;
            };

            button.connect('notify::rgba', () => {
                if (!syncing)
                    settings.set_string(key, button.get_rgba().to_string());
            });
            reset.connect('clicked', () => settings.reset(key));
            const id = settings.connect(`changed::${key}`, () => pull());
            row.connect('destroy', () => settings.disconnect(id));
            pull();

            row.add_suffix(button);
            row.add_suffix(reset);
            return row;
        };
    }
}
