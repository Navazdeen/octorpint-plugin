# Live tuning and calibration wizards: design

Date: 2026-10-21. Status: approved in brainstorming (3 parts), awaiting spec review.
Visual reference: the "2 · Live tuning + wizards" screen at https://claude.ai/artifact/NR3HsX9dUvmqE6GWJf1eDp.
Builds on branch `macro-deck` (reuses its run path, toasts, safety net and motion helpers).

## Goal

Tune the printer while it prints and keep good values: live sliders for the settings Klipper can change
at run time, one "Save to config" that writes them safely, and three guided calibrations (Z offset,
PID, rotation distance) that replace typing console commands.

Out of scope here (next project): tower wizards for pressure advance, temperature and input shaper
(ringing), with generated G-code.

## What the user decided

- Two projects: this one first (sliders + Save to config + Z offset, PID graph, rotation distance),
  then the tower wizards.
- Saving: write immediately (backup + confirmed diff), restart Klipper automatically once the printer
  is idle, never mid-print.
- Parts 1–3 of the design approved as presented.

## 1. Values and saving

### 1.1 Live values

Read from Klipper's subscribed objects (`gcode_move`, `extruder`, `toolhead`, `configfile`). The
watcher's subscription gains `extruder: [pressure_advance, smooth_time]`,
`toolhead: [max_accel, square_corner_velocity]`, `gcode_move: [speed_factor, extrude_factor, homing_origin]`,
`configfile: [save_config_pending, save_config_pending_items]`.

| key | label | live command | range | step buttons | saved to |
|---|---|---|---|---|---|
| `speed` | Speed | `M220 S<v>` (percent) | 10–300 % | ±5, ±10 | never (print-time only) |
| `flow` | Flow | `M221 S<v>` | 50–150 % | ±1, ±2 | never |
| `pa` | Pressure advance | `SET_PRESSURE_ADVANCE ADVANCE=<v>` | 0–1 | ±0.001, ±0.005 | file `[extruder] pressure_advance` |
| `pa_smooth` | Smooth time | `SET_PRESSURE_ADVANCE SMOOTH_TIME=<v>` | 0–0.2 s | ±0.005 | file `[extruder] pressure_advance_smooth_time` |
| `accel` | Acceleration | `SET_VELOCITY_LIMIT ACCEL=<v>` | 100–20000 mm/s² | ±500, ±1000 | file `[printer] max_accel` |
| `scv` | Square corner velocity | `SET_VELOCITY_LIMIT SQUARE_CORNER_VELOCITY=<v>` | 1–20 mm/s | ±0.5, ±1 | file `[printer] square_corner_velocity` |
| `zoff` | Z offset (babystep) | `SET_GCODE_OFFSET Z_ADJUST=<d> MOVE=1` (when homed) | −2–2 mm | ±0.01, ±0.05 | Klipper `Z_OFFSET_APPLY_PROBE`, then `SAVE_CONFIG` |

Each row shows its config value (from `configfile.settings`; the Klipper default when not set:
`square_corner_velocity` 5, `pressure_advance_smooth_time` 0.04) as a tick on the track. A row whose live
value differs from config is orange.

Sending: on slider release or step press, never continuously while dragging. Commands go through the
existing `run` path (Klipper API socket, result toast on error). A failed command snaps the row back to
Klipper's reported value.

### 1.2 Saving

`POST /plugin/kobra_ui/tune/save` (SETTINGS permission), body `{changes: {key: value}}`:

- Only keys from the table with a "file" target are accepted; values are range-checked.
- Writes go through a new pure function `set_options(text, {section: {option: value}}) -> text` in
  `kobra_ui/cfgedit.py`:
  - replaces `option: value` / `option = value` inside `[section]` (first match, keeps any trailing
    comment), or adds `option: value` after the section's last option line when missing;
  - never touches the `#*#` block; refuses (ValueError) an option that the `#*#` block also sets for
    that section (it would be overridden);
  - refuses a missing section.
- The previous file goes into the existing config history (`.kui_history/printer.cfg/<ts>.cfg`), as the
  config editor does.
- `GET /plugin/kobra_ui/tune/preview?changes=…` returns the unified diff for the confirm dialog.
- Z offset saves call `Z_OFFSET_APPLY_PROBE` through the run path; Klipper then holds it as a pending
  SAVE_CONFIG item.

### 1.3 Restart when idle

A plugin thread (`RestartQueue`) keeps a flag `file_changed` (set by tune/save) and reads Klipper's
`configfile.save_config_pending`. Every 2 s it decides with a pure function
`restart_action(state) -> "none" | "save_config" | "restart"`:

- `none` unless all hold: Klipper ready; `print_stats.state` not in {printing, paused}; `idle_timeout.state`
  not `Printing`; no wizard active (plugin flag set by the UI); not cancelled by the user.
- `save_config` when Klipper has pending items (SAVE_CONFIG also re-reads the file edits); otherwise
  `restart` when `file_changed`.

After issuing it pushes `{"tune": {"restarted": "<action>"}}`; on failure the flags stay and an error
is pushed. The UI shows a "Changes waiting for a restart" chip (with "Restart now" only when idle).

## 2. Screens

- **Tune view** (rail entry "Tune", `?kui=tune`): sliders card left, wizards card right (the draft).
- **Printer screen while printing**: a compact Tune card (speed, flow, Z offset) linking to the view.
- **Slider row**: label + command name, track with the config tick, ± step buttons, live value.
  Buttons: "Revert all to config", "Save to config…" (diff confirm dialog).

### 2.1 Wizards

Full-width step card; each physical step is behind a confirm that says what happens (heats / homes /
moves). Wizards are blocked while printing or paused. Cancel at any step aborts and turns off what the
wizard heated. The wizard's step and inputs are kept in `sessionStorage`; on reload it offers
"Continue" or "Abort and cool down". The plugin aborts a `PROBE_CALIBRATE` left open for 10 minutes.

1. **Z offset (paper test)**: heat bed to `save_variables.mesh_bed_temp` (default 60) and nozzle to
   `_PRINTER_SETTINGS probe_nozzle_temp` (150 on this printer) → `G28` → `PROBE_CALIBRATE` → nudge pad −0.1 / −0.025 / +0.025 / +0.1 (`TESTZ Z=`), live
   reading and nozzle/paper picture → "Feels right" = `ACCEPT` → pending SAVE_CONFIG (restart queue).
   Abort = `ABORT` + `TURN_OFF_HEATERS`.
2. **PID with live graph**: heater (hotend/bed) + target (hotend 220, bed 60 by default) →
   `PID_HOTEND TEMP=` / `PID_BED TEMP=` (existing macros) → live chart of that heater (temperature +
   target, from OctoPrint's temperature stream) → on completion show old vs new Kp/Ki/Kd from
   `configfile.save_config_pending_items` → "Save" keeps them pending for the restart queue, "Discard"
   restarts nothing and clears via `RESTART` only when the user confirms.
3. **Rotation distance**: heat to `_PRINTER_SETTINGS filament_temp` (210 on this printer; 220 if missing) → user marks
   120 mm and confirms → `M83` + `G1 E100 F60` → user enters remaining length r → actual = 120 − r →
   `new = old × actual / 100`, shown with old/new; refuse when |actual − 100| > 20 → save writes
   `[extruder] rotation_distance` through 1.2 (allow-listed for this wizard only).

## 3. Motion

Same rules as the deck (transform/opacity, enter `cubic-bezier(.2,.8,.2,1)`, pointer-following 1:1,
reduced motion → ≤ 80 ms fades): wizard steps slide horizontally 220 ms; the Z reading counts to its
new value 180 ms; the PID line draws as data arrives; a saved row flashes once 400 ms; the restart chip
slides in 200 ms.

## 4. Errors and edge cases

- Klipper not ready: sliders/wizards disabled with the reason; restart queue waits.
- Live values changed elsewhere (console, macro, slicer): rows follow Klipper's reported values.
- Out of range or Klipper shut down: request refused with the reason.
- Restart failure: queue kept, error toast.
- Rotation distance: no extrusion unless the nozzle is within 5 °C of target; extrusion capped at 100 mm.

## 5. Files

| file | change |
|---|---|
| `kobra_ui/cfgedit.py` | new, pure: `set_options`, `unified_diff` |
| `kobra_ui/tuning.py` | new, pure: `KNOBS` table, `check_value`, `restart_action`, `rotation_distance` |
| `kobra_ui/__init__.py` | subscription fields, `/tune/save`, `/tune/preview`, `RestartQueue` thread, wizard-active flag |
| `kobra_ui/static/js/kobra_tune.js` | new: Tune view, Printer-screen card, wizards (extends the view model like kobra_deck.js) |
| `kobra_ui/static/css/kobra_ui.css`, `templates/kobra_ui_app.jinja2` | view, card, wizard markup and motion |
| `tests/test_cfgedit.py`, `tests/test_tuning.py` | pytest |
| `tools/shot/tune.js` | Playwright, behind the safety net |

## 6. Testing

- pytest: `set_options` (replace keeps trailing comment, add missing option, untouched `#*#` block,
  refuse option set in `#*#`, refuse missing section, idempotent), range checks, `rotation_distance`
  (7.084 with 120 − 18.7 = 101.3 → 7.176; refuse 75), `restart_action` for each state combination.
- Playwright (safety net blocks everything except allow-listed RESPOND; wizard steps driven by
  simulated Klipper state in the browser): slider sends the right command on release only; orange row
  when changed; Revert; Save diff dialog; restart chip hidden while printing (simulated); each wizard's
  steps and refusals; motion timings; reduced motion; phone layout.
- On the printer with the user: one Z offset paper test and one PID run (save optional).
