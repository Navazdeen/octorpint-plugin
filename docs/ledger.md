# Kobra UI ledger

Status: `open` → `fixed (local)` → `deployed + verified`. Nothing that restarts OctoPrint or
Klipper is deployed while a print is running.

## From the user, during the Assembly test print (2026-10-20)

| # | Issue | Status |
|---|---|---|
| U1 | Cancel object isn't available on the 2D layer view (no way to skip an object) | deployed + verified |
| U2 | Hovering the **3D (PrettyGCode)** segment slider shows info that covers the slider (corrected by the user: not the 2D view) | deployed + verified (PrettyGCode segment tooltip hidden; layer "Z" label kept) |
| U3 | While printing, the Printer screen can't be scrolled: it jumps back to the top | deployed + verified |
| U4 | Clicking a G-code image should load the file and show the 3D/2D preview before printing | deployed + verified |
| U5 | Back to top on Files should appear after scrolling a little, not only at the very bottom | deployed + verified |
| U6 | Pop-ups are good, but also send a system (browser) notification | deployed + verified |
| U8 | Show seconds on Elapsed and Left, and add a Layer time | deployed + verified |
| U9 | Layer track: dock-style magnifier on hover, layer number label, colour-coded pause / filament change (armed and past) with legend | deployed + verified |
| U10 | Cancelobject plugin's bar and overlay land on top of the 2D view (it inserts them next to the moved canvas); hidden inside Kobra UI, objects are skipped via Klipper EXCLUDE_OBJECT instead | deployed + verified |
| U11 | Uninstall the Cancelobject plugin (Klipper's [exclude_object] + Orca's EXCLUDE_OBJECT_DEFINE already cover it) | done: uninstalled |
| U12 | 2D view is a small centred square instead of filling the Live view; resize the canvas to the pane and let the renderer re-fit the bed | deployed + verified |
| U7 | Console shortcut (`) sometimes doesn't work; add a full set of keyboard shortcuts | deployed + verified |

## Found by the runtime test (testprint.py / testprint_cont.py)

| # | Issue | Status |
|---|---|---|
| T1 | SET_PRINT_STATS_INFO override ran the pause before recording the new layer, so for a moment the pause reported the previous layer (14 instead of 15, and 39 instead of 40 for M600) | deployed (Klipper restarted after the print) |
| T2 | Test run so far: START_PRINT + adaptive mesh, pause at layer 15 (reason, park +10 mm, OctoPrint Paused), resume via OctoPrint, M600 at layer 40 (reason m600, park Z 50) all worked. Not yet exercised: LOAD_FILAMENT while paused, OctoPrint Pause button, Z babystep, PRINT_END | PRINT_END verified at the end of the run (parked X20 Y200 Z51, heaters off, motors off); still to exercise on a print: LOAD_FILAMENT while paused, OctoPrint's Pause button, Z babystep |

## Found while verifying (2026-10-21)

| # | Issue | Status |
|---|---|---|
| V1 | Objects menu closed the moment it opened (the outside-click handler didn't count it as a menu) | deployed + verified |
| V2 | Bed map overlapped the 2D canvas corner and segment slider; moved to the top-right corner | deployed + verified |
| V3 | Layer track lost its magnification when the bars re-rendered (once per layer); re-applied on re-render | deployed + verified |
| V4 | Gallery Preview pill overlapped the Print button; Preview centred on the image | deployed + verified |

Verification: `tools/shot/verify.js` + `probe8.js` (U1, U3–U12 pass; print-only states simulated in the browser only).
