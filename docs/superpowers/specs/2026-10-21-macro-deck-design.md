# Macro deck and command palette: design

Date: 2026-10-21. Status: approved in brainstorming, awaiting spec review.
Visual reference: the "1 · Macro deck + palette" screen at https://claude.ai/artifact/NR3HsX9dUvmqE6GWJf1eDp
(private draft, mock data).

## Goal

Make every Klipper macro usable from Kobra UI without typing: a deck of tiles built from the live
Klipper config, with parameter forms, saved presets, pins on the Printer screen, and a Ctrl+K palette
that searches and runs anything. It should feel like a native tool for this printer rather than a
generic web app, with smooth motion that shows what changed.

This is the first of three projects. Live tuning + wizards, and charts + history + rules, get their
own specs later and are out of scope here.

## What the user asked for

- Macro deck + palette as drafted, then live tuning, then charts/history/rules.
- More customisation, built around Klipper.
- Smooth transition animations wherever they look good.

## 1. Data

### 1.1 Reading macros (plugin, Python)

Source: Klipper's `configfile.settings`, which the plugin's `KlippyWatcher` already subscribes to.
Each `gcode_macro <name>` section has `gcode` (template text) and an optional `description`.

New module `kobra_ui/macros.py`, pure functions (no I/O) so they are unit-testable:

`parse_macros(settings) -> list[Macro]` where `Macro` is a dict:

| field | meaning |
|---|---|
| `name` | upper-case macro name as Klipper registers it |
| `description` | the `description:` option, or "" |
| `params` | ordered list of `Param` (below) |
| `hints` | subset of `heats`, `homes`, `restarts`, `printing_only`, `paused_only` |
| `internal` | true for names starting with `_` |
| `slicer` | true for `START_PRINT`, `PRINT_END`, `SET_PRINT_STATS_INFO` (hidden by default) |

`Param`: `{name, default, source, kind, choices}`

- Found with the regex `params\.([A-Z_][A-Z0-9_]*)` plus an optional `|default(<expr>)`, in order of
  first use. `params['X']` and `params["X"]` forms are also matched.
- `default`:
  - a literal number or quoted string → that value
  - `s.<var>` / `printer['gcode_macro _PRINTER_SETTINGS'].<var>` → the value of `variable_<var>`
    in the `gcode_macro _printer_settings` section, with `source: "_PRINTER_SETTINGS <var>"`
  - anything else (expressions, `printer.…` state) → `default: null`, shown as "auto"
- `kind`: `number` if the default parses as a float or the template applies `|float` / `|int` to it,
  otherwise `text`.
- `choices`: when the template compares the parameter against string literals
  (`MATERIAL == 'PLA'`, or a dict literal keyed by strings indexed by it), those strings,
  e.g. PREHEAT `MATERIAL` → `PLA, PETG, ABS, TPU`.
- Hints, matched on the template text:
  - `heats`: `M104|M109|M140|M190|SET_HEATER_TEMPERATURE|_HEAT`
  - `homes`: `G28|_ENSURE_HOMED`
  - `restarts`: `SAVE_CONFIG|RESTART|FIRMWARE_RESTART`
  - `printing_only` / `paused_only`: a top-level guard on `print_stats.state` /
    `pause_resume.is_paused` that ends in an error or a do-nothing branch.
  The hints are advisory labels only; they never block anything on their own.

The parsed list is cached and rebuilt whenever `configfile.settings` changes (that is, after every
Klipper restart). It is served by `GET /plugin/kobra_ui/macros` together with the deck (1.2).

### 1.2 Deck file (plugin data folder)

`<plugin data folder>/deck.json`, shared by every device:

```json
{
  "version": 7,
  "groups": [
    {"id": "filament", "name": "Filament", "items": ["LOAD_FILAMENT", "preset:p1", "UNLOAD_FILAMENT"]}
  ],
  "pinned": ["LOAD_FILAMENT", "preset:p1", "CLEAN_NOZZLE", "PARK"],
  "hidden": ["START_PRINT", "PRINT_END", "SET_PRINT_STATS_INFO"],
  "colors": {"LOAD_FILAMENT": "orange"},
  "confirm": ["MESH_CALIBRATE"],
  "presets": {"p1": {"name": "Load PETG", "macro": "LOAD_FILAMENT", "params": {"TEMP": "240", "PURGE": "35"}}},
  "usage": {"LOAD_FILAMENT": 12}
}
```

- Colours come from a fixed set: `orange`, `blue`, `green`, `red`, or none.
- If there is no file yet, a default deck is generated: groups worked out from hints and names
  (Filament: LOAD/UNLOAD/PURGE/M600/DRY; Maintenance: CLEAN_NOZZLE, MESH_CALIBRATE, PID_*;
  Motion & heat: PARK, PREHEAT, COOLDOWN; Other: the rest), with nothing pinned.
- Macros that aren't in any group appear in "Other". Entries naming a macro that no longer exists
  stay in place and render as "missing".
- `usage` counts runs from the UI and drives the "Most used" order.

API (BlueprintPlugin):

| route | permission | behaviour |
|---|---|---|
| `GET /macros` | CONTROL | `{macros: [...], deck: {...}}` |
| `POST /deck` | SETTINGS | body `{base_version, deck}`. If `base_version` ≠ the stored version → `409` with the current deck. Otherwise the deck is validated (schema, sizes: ≤ 200 presets, names ≤ 60 chars), written atomically (temp file + rename), the previous version is kept in `deck.history/<ts>.json` (last 20), the version is bumped and the new deck returned |

A corrupt `deck.json` falls back to the newest readable file in `deck.history`, or else the
generated default, and logs a warning.

### 1.3 Running

Tiles, presets and the palette all go through the existing `run` SimpleApi command (Klipper API
socket, result pushed as `{"run": {...}}`).

The script is built on the server, not in the browser. The new SimpleApi command
`run_macro {macro, params, id}`:

- `macro` must be a name in the parsed list (it cannot be arbitrary text).
- Each param name must be one the parser found for that macro. Values must match
  `^[A-Za-z0-9_.+\-]{1,40}$` (a number, or a single word). Anything else → `400` with a message
  naming the parameter. Empty values are left out (so the macro's own default applies).
- The plugin builds `NAME K=V …` and runs it through the same path as `run`. `usage` is bumped
  (written lazily, at most once per 30 s).
- Raw G-code from the palette's `>` prefix uses the existing `run` command, unchanged.

## 2. Screens and interaction

### 2.1 Macros view (new rail entry, `?kui=macros`)

- **Deck card**: tiles in groups.
  - Header: tabs Groups / A–Z / Most used, and an "Edit deck" button.
  - Tile: icon (from group / hint), name in mono, first line of the description, parameter chips
    with their defaults ("auto" for computed ones), hint icons (heats / homes / asks first), a pin mark.
  - Click selects the tile; double-click or Enter runs it with the current values.
- **Panel** (right, sticky; a bottom sheet under 760 px):
  - name, description
  - one field per parameter (number field or choice segment; the "auto" placeholder explains the
    source, e.g. "From _PRINTER_SETTINGS load_length")
  - "Sends" preview of the exact command
  - one plain sentence on what it will do now, from the hints and the state, e.g. "Printer is idle,
    so this homes if needed, heats, then purges at the tower."
  - buttons: Run, Save as preset, Open in macros.cfg (jumps to the editor at that section's line)
- **Disabled states**:
  - Klipper not ready → all Run buttons disabled with the reason.
  - `printing_only` while idle → disabled with "Only while printing".

### 2.2 Quick macros on the Printer screen

A new fixed-width card, "Quick macros": the pinned items as compact buttons (icon + short name).
Presets show their own name. Hidden when nothing is pinned. A preset with `TEMP` shows the value
as a small chip.

### 2.3 Edit deck mode

- Toggled by the "Edit deck" button; Esc leaves it.
- Drag with the mouse or touch (Pointer Events, no library) to reorder within a group or move to
  another group. Dropping on "New group" creates one, named inline.
- Tile menu: Pin / Unpin, Hide / Show, Colour, Always ask first, Rename / Delete (presets only).
- Hidden tiles show dimmed and dashed in edit mode only.
- Every change saves immediately (optimistic UI) and shows an "Undo" toast for 6 s; Undo posts the
  previous deck. A `409` reloads the deck and re-applies the local change on top, with the toast
  "The deck changed on another device. Reloaded; your change is kept."

### 2.4 Ctrl+K palette

- Opens with Ctrl+K / Cmd+K anywhere, and `/` when focus isn't in a text field (the console's
  backtick shortcut is unchanged).
- Sources, ranked by fuzzy match (subsequence with bonuses for word starts and prefixes), then by
  usage:
  - Run: macros and presets
  - Go to: config sections (`[section]` headers from the files the editor lists, with line numbers,
    via a new `GET /config/outline` returning `{file, section, line}`), `_PRINTER_SETTINGS`
    variables (opens the editor at that line), files (name match against the loaded file list),
    and the views (Printer, Files, Mesh, Klipper, Macros)
- Keys:
  - ↑/↓ move
  - Enter runs or opens
  - Tab expands the selected macro's parameter fields inline (Enter in a field runs, Esc collapses)
  - Esc closes
- A query starting with `>` shows a single "Send raw G-code" row and uses `run`.
- Matched characters are highlighted. At most 8 rows per group.

### 2.5 Safety confirmations

- An "Always ask first" item, or any item with the `restarts` or `homes` hint while a print is
  running or paused, opens the existing confirm dialog before running.
- Its text names the risk:
  - restarts: "MESH_CALIBRATE restarts Klipper. The running print would be lost."
  - homes: "PARK homes first if needed, which would ruin the running print."

## 3. Motion

Transform and opacity only. Two curves:
- enter: `cubic-bezier(.2,.8,.2,1)`
- exit: `cubic-bezier(.4,0,1,1)`

Reorders use FLIP (measure → change → invert → play, with the Web Animations API).

| moment | animation | duration |
|---|---|---|
| Macros view first open | tiles fade + rise 6 px, 15 ms stagger, total ≤ 300 ms | 220 ms |
| Select tile | panel content cross-fade; selection outline slides to the new tile (FLIP) | 180 ms |
| Groups / A–Z / Most used | tiles glide to their new positions (FLIP) | 260 ms |
| Enter edit mode | grips slide in from the left; one gentle wiggle | 200 ms |
| Drag | lifted tile scale 1.03 + deeper shadow, follows the pointer 1:1; neighbours slide apart (FLIP); drop settles with a slight overshoot | 160 ms |
| Pin / unpin | pin icon pop (scale 1 → 1.25 → 1) | 240 ms |
| Hide | tile scales to 0.9 and fades; the others close the gap (FLIP) | 200 ms |
| Run | press scale 0.97; icon → spinner; done: green check flash; fail: 3-cycle 4 px shake + red outline | 120 / 400 ms |
| Palette | backdrop fade; panel drops 8 px + scales from 0.98; highlight bar slides between rows; results reorder with FLIP | 160 ms |
| Tab parameters | row height expands (grid-template-rows 0fr → 1fr) | 200 ms |
| Bottom sheet (phone) | slides up; drag down to close, follows the finger 1:1 | 240 ms |

Rules:
- Anything tied to the pointer is never eased.
- No animation while the user types.
- `prefers-reduced-motion: reduce` turns every entry above into an opacity fade of 80 ms or less.

## 4. Errors and edge cases

- Klipper not ready: the deck renders from the last parsed macro list with Run disabled, plus a
  banner with the Klipper state message. The palette still opens files and config sections.
- `run_macro` validation failure: inline field error, nothing sent.
- Klipper error from a run: the tile shakes, the toast carries Klipper's message (first line, at
  most 200 chars). No automatic retry.
- Deck save failure (network, 5xx): the change is rolled back with a toast "Couldn't save the deck:
  <reason>".
- `409` conflict: handled as in 2.3.
- Corrupt deck file: handled as in 1.2.
- A macro removed from the config: its tiles show "missing" and can't run; Delete removes them.
- Permissions: CONTROL to run, SETTINGS to change the deck. Without SETTINGS, "Edit deck" is hidden.

## 5. Files

| file | change |
|---|---|
| `kobra_ui/macros.py` | new: `parse_macros`, `build_script`, `default_deck`, `validate_deck` |
| `kobra_ui/__init__.py` | routes `/macros`, `/deck`, `/config/outline`; `run_macro` command; macro cache refresh on configfile change |
| `kobra_ui/static/js/kobra_ui.js` | deck, palette, edit mode, FLIP helper, bottom sheet; route `macros` |
| `kobra_ui/static/css/kobra_ui.css` | deck, tiles, panel, palette, sheet, motion |
| `kobra_ui/templates/kobra_ui_app.jinja2` | Macros view, Quick macros card, palette markup, rail entry |
| `tests/test_macros.py` | new, pytest |
| `tools/shot/deck.js` | new, Playwright |

If `kobra_ui.js` grows past roughly 2,000 lines, the deck and palette code moves into
`static/js/kobra_deck.js`, registered as a second asset of the same view model (a small, focused
split, not a refactor of existing code).

## 6. Testing

- **pytest** (`tests/test_macros.py`), run locally:
  - parser against a recorded copy of the real `configfile.settings` (34 macros):
    `LOAD_FILAMENT` → `LENGTH 40 (_PRINTER_SETTINGS load_length)`, `PURGE 20`, `TEMP auto`;
    `PREHEAT` → `MATERIAL` choices `PLA, PETG, ABS, TPU`; `CLEAN_NOZZLE` hints include heats and
    homes; `MESH_CALIBRATE` includes restarts; `_` helpers are marked internal
  - `build_script`: rejects unknown macros, unknown params, values with spaces, newlines or `;`;
    leaves out empty values
  - deck: default generation, schema validation, version conflict, history pruning, corrupt-file
    fallback
- **Playwright** (`tools/shot/deck.js`) against the deployed plugin, using harmless commands only
  (`RESPOND`, invalid parameters for the error paths):
  - render, select, panel preview text
  - palette: open, search, ↑/↓, Tab parameters, `>` raw
  - edit mode: drag reorder (pointer events), hide, pin, undo, 409 path (simulated with a second
    page)
  - phone width: bottom sheet
  - frame pacing during reorder and drag, with no long tasks over 50 ms
  - reduced motion: transitions become fades
  - the deck written by the tests is restored afterwards
- **On the printer**, by the user: run a pinned `LOAD_FILAMENT` preset once, end to end.

## 7. Out of scope

Live tuning, calibration wizards, charts, print history, rules and phone notifications (later
specs). Editing macro templates from the deck (the existing config editor does that). Macros on
other printers.
