// SPDX-FileCopyrightText: 2026 Jeremy Cowgar <jeremy@cowgar.com>
// SPDX-License-Identifier: GPL-3.0-or-later

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {EventBar} from './eventbar.js';

export default class EventBarExtension extends Extension {
    enable() {
        this._impl = new EventBar(this);
        this._impl.enable();
    }

    disable() {
        this._impl?.disable();
        this._impl = null;
    }
}
