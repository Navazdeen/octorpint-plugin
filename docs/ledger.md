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
| U15 | Magnified layer line lagged behind / drifted from the cursor (slow and fast moves). Rebuilt as a lens over a fixed track: exact bar edges measured once per hover, ~15 lens bars per frame, GPU transform; 58-59 fps headless, lens within 2 px of the cursor | deployed + verified |
| U16 | Magnifier animation broken after the lens rewrite (no zoom on the bars). Dock effect back on the real bars, transforms only: continuous Gaussian zoom, pointer pinned to its bar (81/81), bars ease back on leave, ~40 fps headless | deployed + verified |
| U7 | Console shortcut (`) sometimes doesn't work; add a full set of keyboard shortcuts | deployed + verified |
| U13 | Skip-object dialog for the last object had two "Back" buttons; now an info dialog with one OK | deployed + verified |
| U14 | Pause-at-layer track empty in preview and for files sliced before layer tracking; layers now read from the G-code file (pre-arm before printing; untracked files show the track with the layer worked out from Z, pausing disabled with a re-slice note) | deployed + verified |

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
| V6 | At sub-pixel bar boundaries a click could arm the neighbouring layer; a click now arms the layer in the label (81/81 clicks matched) | deployed + verified |
| V7 | Deploys no longer need the password: SSH key login to the Cubie, OctoPrint restarted via its API (tools/deploy.sh); password helper deleted | done |
| V5 | deploy.sh only refused to restart while Klipper reported Printing; a paused print would have been killed. Now also refuses while paused | fixed |

## Webcam drops (2026-10-21)

| # | Issue | Status |
|---|---|---|
| W1 | Live webcam sometimes freezes or goes blank, then comes back. Cause: mjpg-streamer itself never crashed (one start per boot, no errors, 8 fps steady over 90 s), but the Cubie's Wi-Fi (AIC8800) ran with power saving on, which holds packets while dozing (ping spikes to 67 ms), and the UI's plain `<img src>` never recovers once an MJPEG connection stalls | fixed: Wi-Fi power save off now (`iwconfig`) and on every boot (`/etc/NetworkManager/conf.d/99-wifi-powersave-off.conf`) |
| W2 | UI webcam had no recovery or status. Now reads the stream with fetch: a stall (no frame for 5 s) or a dropped connection reconnects with backoff (1, 2, 4, 8, 10 s), shows "Reconnecting in N s" with Retry now, a Live + fps chip, and stops streaming while the tab is hidden or another view is shown. Also follows webcam URL changes from Settings | deployed + verified (`tools/shot/cam.js`: stall caught at 5.0 s, live again 1.2 s later) |

## Production polish (2026-10-21)

| # | Issue | Status |
|---|---|---|
| P1 | Live view didn't use big screens (fixed 420 px pane, 640×480 image). The Live card now spans as many card columns as the screen height can feed at the camera's 4:3, keeping two columns for the other cards; the pane height follows and stops at the viewport; the image scales to fill (2560: 1556×1099, 1920: 908×681) | deployed + verified |
| P2 | Config editor, Klipper log and 3D mesh had fixed heights; they now fill the viewport. The mesh map keeps the probed area's real X:Y proportions and fits the screen | deployed + verified |
| P3 | Magnifier animation: strength now eases in (~90 ms) and out (~160 ms) in one rAF loop; the focus stays on the pointer (no lag); re-entering mid-way continues without snapping | deployed + verified (probe13: 80-81/81 aligned, monotonic ease in/out) |
| P4 | Feedback: toast stack (busy → done/failed, hover to hold, dismiss); button G-code runs through Klipper's API socket so the UI knows when it finished and shows Klipper's error text; the clicked button shows a spinner; toasts for print start/pause/resume/finish/cancel, Klipper ready/shutdown/error, and lost/regained OctoPrint connection | deployed + verified (polish.js) |
| P5 | Page could scroll sideways on phones (OctoPrint's hidden navbar was wider than the screen) | deployed + verified |
| P6 | Back/forward into printer.cfg before it had loaded showed an empty editor | deployed + verified |

## Macro deck and Ctrl+K palette (2026-10-21, branch macro-deck)

| # | Item | Status |
|---|---|---|
| D1 | Macros read from Klipper's live config: parameters, defaults (from _PRINTER_SETTINGS), choices, hints | deployed + verified (pytest 33/33) |
| D2 | Shared deck on the Cubie (deck.json): versioned saves, 20-version history, corrupt-file fallback, 409 merge | deployed + verified |
| D3 | run_macro: the plugin builds and checks the command (known macro, known params, numbers for number params) | deployed + verified |
| D4 | Macros view, parameter panel, Quick macros card on the Printer screen | deployed + verified (deck.js) |
| D5 | Edit deck: drag reorder, tile menu (pin, hide, colour, ask first, rename/delete presets), Undo, new groups | deployed + verified |
| D6 | Ctrl+K / "/" palette: macros, presets, config sections, settings, files, views; Tab for parameters; > for raw G-code | deployed + verified |
| D7 | Motion per the spec table; reduced motion = short fades; phone bottom sheet | deployed + verified |
| D8 | Whole-UI speed-up: other plugins' root :has() rules (PrettyGCode) restyled ~37k elements on every DOM change; rewritten to attribute flags (style recalc per deck switch 18 → 4 ms) | deployed + verified (PrettyGCode 3D renders) |
| D9 | INCIDENT during testing: a palette test sent PURGE_FILAMENT LENGTH=5x to the printer (homed, heated to 210 C, purged at the tower). Heater turned off right after. Tests now run behind a network safety net that blocks every command except RESPOND and server-rejected calls | fixed |

Verification: `tools/shot/verify.js` + `probe8.js` (U1, U3–U12 pass; print-only states simulated in the browser only).
