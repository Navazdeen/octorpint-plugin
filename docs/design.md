# Kobra UI: design spec (approved 2026-10-20)

Reference mockups (the source of truth, built 1:1):
`.superpowers/brainstorm/2079-1792507805/content/console-v3.html` (Printer) and `views-v2.html`
(console option A, pause controls, Files, Mesh, Klipper, config editor).

## Style
taste-skill app style `data-terminal` (seed 1900990100), dark. Tokens as in the mockups; the accent is the
filament orange `#e8792f`, used only on live data and the 1px selection line. Public Sans for text, JetBrains Mono
for every figure (both bundled). Font Awesome 6.5.1 (bundled with OctoPrint). Icons always paired with labels.

## Shell
- Full-viewport app replacing OctoPrint's chrome (generic template). OctoPrint dialogs keep working.
- Left rail (76px, icon + label): Printer, Files, Mesh, Klipper; Settings at the bottom. Phone: bottom bar.
- Top bar: h1 + one-line finding; right: Klipper state pill, account menu (logout, classic UI), power menu, **large red Emergency stop** on every screen.
- Bottom console dock (option A) on every screen: last reply + command line; `` ` `` or click expands ~260px history; Tab completes Klipper commands/macros; ↑/↓ history.
- Hash routes: `#printer`, `#files`, `#mesh`, `#klipper`, `#editor/<file>`.

## Printer view
Fixed 300px cards, auto-fill columns centred, masonry-packed (4px row units). Live view spans 2 columns (3 at ≥6).
Cards: Live view (Webcam / 3D PrettyGCode / 2D GCode viewer + layer track), Print job (progress, elapsed/left/done,
Pause/Cancel/Change filament, pause-at-layer with Pause|M600 and armed line), Recent files (span 2, 4 thumbnails),
Temperatures (+preheat), Motion (jog, step, Z offset, fan), Filament, Machine (+tune, restart, small e-stop).

## Files view
Toolbar (search, sort, Select, New folder, Upload), selection bar (move, download, delete), folders column (All,
Printed recently = last 14 days, Failed or cancelled, real folders), storage meter, 196px tiles with thumbnails,
details panel (print now, rename, download, move, delete).

## Mesh view
Finding line, stat strip (spread, highest, lowest, probed), 7×7 heat map (diverging blue/orange) with 3D toggle
(Plotly from Bed Visualizer), profiles + probe settings from Klipper's config.

## Klipper view
Stat strip (state, version, board + MCU temp, host + load), message log, maintenance (Z offset, bed leveling,
PID, offsets, analyse log via OctoKlipper dialogs), config files card → editor.

## Config editor
File list + history; code area with line numbers, syntax colours, changed-line marks; Find, Discard, Save,
Save & restart (then shows Klipper's state/error). `#*#` SAVE_CONFIG block is read-only and preserved by the server.
Every save first copies the old file to `config/.kui_history/<file>/<timestamp>.cfg`. Admin permission required.

## Out of scope / honest gaps
History entries are labelled by source and time (no commit messages). "Checked by Klipper" reflects Klipper's state
after a restart; Klipper reports config errors without line numbers.
