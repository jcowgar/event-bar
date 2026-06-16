# Event Bar

A GNOME Shell status bar that **stays out of your way**.

Most status bars are always on screen, showing information you rarely need —
CPU, memory, clock, network, volume. Event Bar inverts that idea: the bar is
**invisible by default**. A small indicator only **drops down from the
top-center** of your screen when something actually happens — your CPU spikes,
you change the volume, you switch workspaces — and then it slides away again.
Multiple events **stack side-by-side**.

It also (optionally) hides the standard GNOME top panel and reclaims that strip
of screen for your windows, with a hover-to-reveal so the panel is still there
when you want it.

> **Requires GNOME Shell 50** on Wayland.

---

## What it shows

Each indicator appears only on a meaningful event and disappears on its own.

| Indicator | Appears when… | Behavior |
|-----------|----------------|----------|
| **CPU** | usage goes above 75% | stays while high; turns red above 90% |
| **Memory** | usage goes above 80% | stays while high; turns red above 92% |
| **Disk** | the `/` filesystem is over 90% full | stays while high; turns red above 95% |
| **Volume** | you change volume or mute | flashes for ~1.5s; red when muted |
| **Wi-Fi / Network** | the connection changes | flashes for ~2.5s; red if connectivity drops |
| **Workspace** | you switch workspaces | flashes for ~1.2s |
| **Workspace alert** | a window on another workspace demands attention | red, stays until you visit that workspace |
| **Clock** | every 5 minutes, on the clock (`:00`, `:05`, …) | drops for 10s |
| **Brightness** | you change screen brightness | flashes for ~1.5s *(needs a backlight)* |
| **Battery** | you plug/unplug, or the battery runs low | flashes on AC change; red while low/critical *(laptops)* |
| **Microphone** | an app is recording from your mic | red, stays while recording |

Brightness only appears on devices with a controllable backlight, and battery
only on devices with a battery — they stay silent otherwise.

---

## The hidden top panel (optional)

By default Event Bar hides GNOME's top bar and gives that space back to your
windows (a maximized window now uses the full screen height).

- **Reveal it:** push your mouse to the very top edge of the screen — the panel
  slides down as an overlay (it floats over your windows, so you never lose the
  reclaimed height). It retracts when you move away.
- **Quick Settings still work:** while the panel is revealed, opening Quick
  Settings (Wi-Fi, Bluetooth, power) keeps it down until you close the menu.
- **Overview:** the Activities overview opens without the bar.

Prefer to keep the normal GNOME panel? Turn off **Hide the top panel** in the
extension's settings (see Configuration).

---

## Installation

Event Bar installs like any GNOME extension — its folder lives in your
extensions directory under its UUID, `event-bar@cowgar.com`.

```bash
# from the project directory:
ln -s "$PWD" ~/.local/share/gnome-shell/extensions/event-bar@cowgar.com
glib-compile-schemas schemas/   # build the settings schema
```

Then **log out and back in** (Wayland can't reload the shell in place), and
enable it:

```bash
gnome-extensions enable event-bar@cowgar.com
```

To turn it off again (this also restores the normal top panel):

```bash
gnome-extensions disable event-bar@cowgar.com
```

---

## Configuration

Open the settings from **GNOME Extensions** / **Extension Manager** (the gear
icon next to Event Bar), or run:

```bash
gnome-extensions prefs event-bar@cowgar.com
```

Changes apply **live** — the bar reconfigures itself the moment you change a
value, no reload needed. The preferences window has two pages:

- **Indicators** — one section per indicator (CPU, Memory, Disk, Volume,
  Network, Workspace, Clock, Brightness, Battery, Microphone). Each has an
  **Enabled** switch plus its own knobs:

  | Setting | Default | Meaning |
  |---------|---------|---------|
  | CPU / Memory / Disk **Threshold** | `75` / `80` / `90` | % above which the pill shows |
  | Disk **Path** | `/` | filesystem the disk pill watches |
  | CPU / Memory / Disk **Click command** | empty | shell command run when you click that pill (e.g. `gnome-system-monitor`); empty leaves the pill non-clickable |
  | **Poll interval** | per source | how often a meter is sampled |
  | **Linger** | per source | how long a transient pill stays on screen |
  | Clock **Interval** | `300` s | how often the clock drops (use `900` for every 15 min) |
  | Clock **Format** | `%H:%M` | clock format (strftime) |
  | Battery **Low** / **Critical** | `20` / `10` | low / critical battery % |
  | Workspace **Disable GNOME workspace popup** | off | suppress GNOME's built-in switcher popup (the dots) so only our pill shows |

- **Appearance** — slide animation duration and pill travel distance; a
  **Theme** section for the pill's colors, shape, and font; plus the
  hidden-top-panel behavior (**Hide the top panel**, reveal-strip height, and the
  pointer-poll cadence while it's revealed).

> The clock interval ships at **5 minutes** so you can see it working quickly.
> Set it to `900` for the calmer 15-minute cadence.

### Theming

By default the pills **adopt your GNOME theme** — they reuse the same surface
style as the system volume/brightness popups, so they follow your light / dark /
high-contrast choice and accent automatically. You don't have to configure
anything to look native.

The **Appearance → Theme** section lets you override any of it:

| Setting | Default | Meaning |
|---------|---------|---------|
| **Background / Text / Border color** | theme | pill colors; the picker includes **transparency** (alpha) |
| **Alert background color** | red | background of the red "alert" pills (CPU critical, mute, …) |
| **Corner radius** | `0` (theme) | pill corner rounding in px; non-zero squares the top edge |
| **Font size / weight** | `0` (theme) | pill text size and weight |

Each color picker has a **clear** button that resets it back to the theme
default. Anything you set wins over the theme; anything left at empty / `0`
keeps following it.

---

## Uninstall

```bash
gnome-extensions disable event-bar@cowgar.com
rm ~/.local/share/gnome-shell/extensions/event-bar@cowgar.com
```

---

## License

GPL-3 -- see LICENSE file.
