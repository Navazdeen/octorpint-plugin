# Kobra UI

A full-screen OctoPrint console for an Anycubic Kobra 2 Neo running Klipper. It replaces OctoPrint's
tabbed layout with one dark, full-width screen for printing, plus Files, Mesh, Klipper and a config
editor, and keeps every OctoPrint dialog working on top of it.

## What's in it

- **Printer:** live view (webcam / PrettyGCode 3D / OctoPrint 2D layer viewer), a layer track you can
  click to pause at a layer, the print job with pause, resume, cancel, filament change and pause-at-layer
  (Pause or M600), recent files with thumbnails, temperatures and preheat, jog and Z offset, filament
  load, unload and purge, and machine and tuning macros. Fixed-width cards fill any screen width.
- **Files:** thumbnail gallery, search, sort, folders, "printed recently" and "failed" lists,
  select-many to move, download or delete, rename, upload by button or drag and drop, storage use.
- **Mesh:** the bed mesh as a heat map or 3D surface, with spread, high and low points and profiles.
- **Klipper:** state, version, board and host, message log, maintenance tools (OctoKlipper's dialogs)
  and the config files.
- **Config editor:** edit `printer.cfg` and `macros.cfg` with syntax colours and changed-line marks,
  then Save or Save & restart. Every save keeps a backup in `config/.kui_history/`, and History
  compares or restores any version, including Klipper's own `printer-*.cfg` backups.
- **Console dock:** last reply always visible; press `` ` `` to expand, drag its edge to resize, Tab
  completes Klipper commands and macros.
- **Objects:** skip a single object mid-print with Klipper's `EXCLUDE_OBJECT` (Live view → Objects, or click its
  outline on the 2D bed map).
- **Layer track:** hover to magnify (dock-style) with the layer number; armed pauses and filament changes are
  colour coded, earlier pauses marked. Click a layer to pause there.
- **Desktop notifications** for pauses, filament changes, finished or failed prints and Klipper errors (needs the
  `https://` address), and **keyboard shortcuts** for everything (press `?`).
- A large **Emergency stop** on every screen, sent straight to Klipper's API socket as well as over
  serial (M112).

Built from the approved mockups in `docs/design.md`; style: taste-skill app style "data-terminal",
accent in the filament orange.

## Requirements

- OctoPrint 1.11+ talking to Klipper (for example through OctoKlipper and `/tmp/printer`).
- Klipper's API socket at `~/printer_data/comms/klippy.sock` (the KIAUH default).
- The macros in `klipper/macros.cfg` (PAUSE/RESUME with pause reasons, M600, LOAD/UNLOAD/PURGE_FILAMENT,
  PREHEAT, COOLDOWN, PARK, CLEAN_NOZZLE, MESH_CALIBRATE, PID_*, DRY_FILAMENT, SET_PAUSE_AT_LAYER...).
- `[exclude_object]` in `printer.cfg` and "Label objects" in the slicer (replaces the Cancelobject plugin).
- Optional: PrettyGCode (3D view), Bed Visualizer (supplies Plotly for the 3D mesh), OctoKlipper
  (maintenance dialogs), Slicer Thumbnails (file images).

## Install

1. Copy the `kobra_ui` folder into `~/.octoprint/plugins/` and restart OctoPrint.
2. Copy `klipper/macros.cfg` into `~/printer_data/config/`, add `[include macros.cfg]` and an
   `[idle_timeout]` to `printer.cfg`, then run RESTART. Adjust the positions in `_PRINTER_SETTINGS`
   (park spot, purge tower, wiper) to your printer.
3. In OctoPrint Settings → GCODE Scripts, set "After print job is paused" to `PAUSE`, "Before print
   job is resumed" to `RESUME` and "After print job is cancelled" to `CANCEL_PRINT`.
4. In the slicer, start G-code `START_PRINT EXTRUDER_TEMP=... BED_TEMP=...` then
   `SET_PRINT_STATS_INFO TOTAL_LAYER=[total_layer_count]`, and in layer change G-code
   `SET_PRINT_STATS_INFO CURRENT_LAYER={layer_num + 1}`.

Views are linkable: `?kui=printer`, `?kui=files`, `?kui=mesh`, `?kui=klipper`,
`?kui=editor&cfg=printer.cfg`. The account menu has **Classic OctoPrint** to get the stock UI back.
