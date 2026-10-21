# Macro Deck and Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deck of Klipper macro tiles built from the live config, with parameter forms, presets, pins on the Printer screen, an edit mode, and a Ctrl+K palette, all with purposeful motion.

**Architecture:** Pure Python functions in `kobra_ui/macros.py` parse macros out of Klipper's `configfile.settings` and build validated scripts. `kobra_ui/deck_store.py` keeps the shared `deck.json` (versioned, with history). The plugin exposes them through Blueprint routes and a `run_macro` SimpleApi command that reuses the existing `run` path. The frontend lives in a new `static/js/kobra_deck.js`, which extends the existing `KobraUiViewModel` through one hook.

**Tech Stack:** OctoPrint 1.11 plugin (Python 3, Flask Blueprint), Knockout 3 (OctoPrint's bundled copy), plain CSS, Web Animations API, Pointer Events. pytest for Python tests, Playwright (`tools/shot/`) for browser tests.

**Spec:** `docs/superpowers/specs/2026-10-21-macro-deck-design.md`

## Global Constraints

- Source of truth is the repo: `~/kobra-printer/octorpint-plugin/kobra_ui`. After Task 1, `~/kobra-printer/octoprint/kobra_ui` is a symlink to it, and `tools/deploy.sh` follows the link.
- Deploy only with `~/kobra-printer/tools/deploy.sh`, which refuses while printing or paused. Bump `__plugin_version__` in `kobra_ui/__init__.py` on every deploy (current: `2.6.2`; this work starts at `2.7.0`).
- Never start, resume or cancel prints, change the selected file, or run physical commands in tests. Browser tests use only `RESPOND MSG=…` and invalid parameters.
- No new Python or JS dependencies in the plugin. No libraries for drag, animation or fuzzy search.
- Permissions: running needs `Permissions.CONTROL`; changing the deck needs `Permissions.SETTINGS`.
- `run_macro` parameter values must match `^[A-Za-z0-9_.+\-]{1,40}$`.
- Deck limits: ≤ 200 presets, names ≤ 60 chars, colours only `orange|blue|green|red`, history keeps the last 20.
- Motion: transform and opacity only. Enter curve `cubic-bezier(.2,.8,.2,1)`, exit `cubic-bezier(.4,0,1,1)`. Anything following the pointer is 1:1 (no easing). `prefers-reduced-motion: reduce` → opacity fades of 80 ms or less.
- All new CSS is scoped under `#kui` and avoids Bootstrap 2 class names (`.label .caret .close .btn .row .bar .span* .lead .badge .nav .modal`).
- Copy is plain, sentence case, no apologies. Errors say what happened and what to do.
- Commits end with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0166PTFHrQZrdbGKgsgyNZX1
  ```

## Review Focus

1. **Lower-case section names:** Klipper keys macro sections in lower case (`gcode_macro load_filament`). Every name the UI shows, stores or sends must be upper case, and deck entries must match regardless of case. Test in Task 2.
2. **Macros with no parameters and no description** (`COOLDOWN`, `STOP_DRYING`): the tile renders without empty chips, and the panel says "No parameters" and still runs. Tests in Task 2 and Task 6.
3. **A preset whose macro was removed from the config:** it shows as "missing", can't run, `run_macro` returns 400 rather than sending, and Delete works. Tests in Task 4 and Task 7.
4. **Typing in the console, editor or a panel field:** `/` must not open the palette there, while Ctrl+K opens it everywhere, including from the console. Test in Task 8.
5. **A Klipper restart while the Macros view is open:** the macro list refreshes once Klipper is ready again, with no duplicate tiles and the selection kept if that macro still exists. Test in Task 6.

---

## File structure

| file | responsibility |
|---|---|
| `kobra_ui/macros.py` (new) | pure: `parse_macros`, `build_script`, `default_deck`, `validate_deck`, `config_outline` |
| `kobra_ui/deck_store.py` (new) | file I/O for `deck.json`: load with fallback, versioned save, history |
| `kobra_ui/__init__.py` | macro cache, routes `/macros` `/deck` `/config/outline`, `run_macro`, usage counting, asset list |
| `kobra_ui/static/js/kobra_deck.js` (new) | deck, panel, quick macros, edit mode, palette, FLIP helper, bottom sheet |
| `kobra_ui/static/js/kobra_ui.js` | route `macros`, one hook call into `kobra_deck.js` |
| `kobra_ui/static/css/kobra_ui.css` | deck, palette, sheet, motion |
| `kobra_ui/templates/kobra_ui_app.jinja2` | rail entry, Macros view, Quick macros card, palette markup |
| `tests/fixtures/configfile_settings.json` (new) | recorded `configfile.settings` from the printer |
| `tests/test_macros.py`, `tests/test_deck_store.py` (new) | pytest |
| `tools/shot/deck.js` (new, outside the repo in `~/kobra-printer/tools/shot`) | Playwright |

`deck_store.py` is a small addition to the spec's file list: the spec keeps `default_deck` and `validate_deck` pure in `macros.py`, and the file I/O gets its own module so `macros.py` stays free of I/O.

---

### Task 1: Tooling and the macro parser

**Files:**
- Create: `kobra_ui/macros.py`, `tests/fixtures/configfile_settings.json`, `tests/test_macros.py`
- Modify: `~/kobra-printer/tools/deploy.sh` (tar with `-h`), `.gitignore` (add `.venv/`, `__pycache__/`)

**Interfaces:**
- Produces: `parse_macros(settings: dict) -> list[dict]`. Each macro is `{name, description, params, hints, internal, slicer}`; each param is `{name, default, source, kind, choices}`, as in spec §1.1. Sorted by `name`.

- [ ] **Step 1: Make the repo the source of truth.**
  `rm -rf ~/kobra-printer/octoprint/kobra_ui && ln -s ../octorpint-plugin/kobra_ui ~/kobra-printer/octoprint/kobra_ui`.
  In `deploy.sh`, change `tar czf - -C "$ROOT/octoprint" kobra_ui` to `tar czhf - -C "$ROOT/octoprint" --exclude __pycache__ kobra_ui`.
  Verify: `ls -la ~/kobra-printer/octoprint/` shows the link; `tar czhf - -C ~/kobra-printer/octoprint kobra_ui | tar tzf - | grep -c macros` runs without error.

- [ ] **Step 2: Create the venv:** `python3 -m venv ~/kobra-printer/octorpint-plugin/.venv && ~/kobra-printer/octorpint-plugin/.venv/bin/pip install -q pytest`. Expected: `.venv/bin/pytest --version` prints a version.

- [ ] **Step 3: Record the fixture** from the printer (read-only query):
  `ssh octoprint-kobra '~/klippy-env/bin/python /tmp/ktest.py query "{\"configfile\":[\"settings\"]}"'`, then save the `configfile.settings` object as `tests/fixtures/configfile_settings.json`. If `/tmp/ktest.py` is missing, `scp ~/kobra-printer/tools/ktest.py octoprint-kobra:/tmp/` first. Check it has 34 keys starting with `gcode_macro`.

- [ ] **Step 4: Write the failing tests** in `tests/test_macros.py` (load the fixture once with a module-level helper `by_name()` → `{m["name"]: m}`):

```python
def test_names_are_upper_case_and_sorted():
    ms = parse_macros(FIX)
    assert all(m["name"] == m["name"].upper() for m in ms)
    assert [m["name"] for m in ms] == sorted(m["name"] for m in ms)
    assert len(ms) == 34

def test_load_filament_params():
    p = {x["name"]: x for x in by_name()["LOAD_FILAMENT"]["params"]}
    assert list(p) == ["LENGTH", "PURGE", "TEMP"]
    assert p["LENGTH"]["default"] == "40.0" and p["LENGTH"]["source"] == "_PRINTER_SETTINGS load_length"
    assert p["PURGE"]["default"] == "20.0"
    assert p["TEMP"]["default"] == "0" and p["LENGTH"]["kind"] == "number"

def test_preheat_choices():
    p = by_name()["PREHEAT"]["params"][0]
    assert p["name"] == "MATERIAL" and p["default"] == "PLA"
    assert set(p["choices"]) == {"PLA", "PETG", "ABS", "TPU"} and p["kind"] == "text"

def test_hints():
    m = by_name()
    assert {"heats", "homes"} <= set(m["CLEAN_NOZZLE"]["hints"])
    assert "restarts" in m["MESH_CALIBRATE"]["hints"]
    assert "paused_only" in m["RESUME"]["hints"]
    assert "printing_only" in m["M600"]["hints"]

def test_internal_and_slicer_flags():
    m = by_name()
    assert m["_WIPE"]["internal"] and not m["PARK"]["internal"]
    assert m["START_PRINT"]["slicer"] and m["SET_PRINT_STATS_INFO"]["slicer"]

def test_no_params_no_description():           # Review Focus 2
    m = by_name()["STOP_DRYING"]
    assert m["params"] == [] and isinstance(m["description"], str)

def test_computed_default_is_auto():
    p = {x["name"]: x for x in by_name()["PAUSE"]["params"]}
    assert p["REASON"]["default"] is None       # depends on runtime state
```

Note on `TEMP`: `params.TEMP|default(0)` is a literal, so `default == "0"`. The UI shows `0` defaults for `TEMP` as "auto" (Task 6), because the macros treat 0 as "pick for me".

- [ ] **Step 5: Run** `.venv/bin/pytest tests/test_macros.py -q`. Expected: fails with an import error.

- [ ] **Step 6: Implement `parse_macros`** in `kobra_ui/macros.py`.
  - Match `params\.([A-Z_][A-Z0-9_]*)` and `params\[['"]([A-Z_][A-Z0-9_]*)['"]\]`, each optionally followed by `\|default\(([^)]*)\)`. Keep first occurrence order; a later occurrence with a default fills a missing one.
  - Default resolution:
    - a quoted literal → the string unquoted
    - a numeric literal → the string as written
    - `s.<var>` or `printer['gcode_macro _PRINTER_SETTINGS'].<var>` → `settings["gcode_macro _printer_settings"]["variable_<var>"]`, with `source = "_PRINTER_SETTINGS <var>"`
    - anything else → `None`
  - `kind = "number"` when the resolved default parses as a float or `|float` / `|int` follows the default in the template; otherwise `"text"`.
  - `choices`: string literals compared with `== '<X>'` against a variable assigned from that param, or the keys of a `{'X': …}` dict literal that variable indexes. PREHEAT is the case to satisfy.
  - Hints:
    - `heats`, `homes`, `restarts`: the regexes in spec §1.1
    - `paused_only`: the template's first `{% if` condition is exactly `not printer.pause_resume.is_paused` and its branch contains `RESPOND TYPE=error` or `action_raise_error`
    - `printing_only`: the same rule with a `print_stats.state` condition, plus the fixed override `STATE_OVERRIDES = {"M600": "printing_only"}`
  - `internal = name.startswith("_")`. `slicer = name in {"START_PRINT", "PRINT_END", "SET_PRINT_STATS_INFO"}`.

- [ ] **Step 7: Run** `.venv/bin/pytest tests/test_macros.py -q`. Expected: 7 passed.

- [ ] **Step 8: Commit:** `git add -A && git commit -m "Macro parser from Klipper configfile settings"`.

---

### Task 2: Script builder and config outline

**Files:**
- Modify: `kobra_ui/macros.py`
- Test: `tests/test_macros.py`

**Interfaces:**
- Consumes: `parse_macros` output.
- Produces:
  - `build_script(macros: list[dict], name: str, params: dict) -> str`, which raises `ValueError(message)`
  - `config_outline(files: dict[str, str]) -> list[dict]`, where `files` maps a file name to its text, returning `[{file, section, line}]`

- [ ] **Step 1: Write the failing tests:**

```python
def test_build_script_basic():
    assert build_script(MS, "load_filament", {"LENGTH": "60", "PURGE": "", "TEMP": None}) == "LOAD_FILAMENT LENGTH=60"
    assert build_script(MS, "COOLDOWN", {}) == "COOLDOWN"            # Review Focus 2

@pytest.mark.parametrize("bad", ["60 PURGE=1", "1\nM112", "a;b", "x" * 41, "{x}"])
def test_build_script_rejects_values(bad):
    with pytest.raises(ValueError, match="LENGTH"):
        build_script(MS, "LOAD_FILAMENT", {"LENGTH": bad})

def test_build_script_rejects_unknown():
    with pytest.raises(ValueError, match="NOPE"):
        build_script(MS, "NOPE", {})
    with pytest.raises(ValueError, match="SPEED"):
        build_script(MS, "LOAD_FILAMENT", {"SPEED": "5"})

def test_config_outline():
    out = config_outline({"macros.cfg": "# c\n[gcode_macro PARK]\ngcode:\n  G28\n\n[gcode_macro COOLDOWN]\n",
                          "printer.cfg": "[printer]\nkinematics: cartesian\n#*# [bed_mesh default]\n"})
    assert {"file": "macros.cfg", "section": "gcode_macro PARK", "line": 2} in out
    assert {"file": "printer.cfg", "section": "printer", "line": 1} in out
    assert not any(o["section"].startswith("bed_mesh") for o in out)   # SAVE_CONFIG block skipped
```

- [ ] **Step 2: Run** them. Expected: fail (functions not defined).

- [ ] **Step 3: Implement both.**
  - `build_script`: names match case-insensitively and the output is upper case. Empty or `None` values are dropped. The order follows the macro's param order. The error message names the parameter: `"LENGTH: use a number or a single word (letters, digits, . _ + -), at most 40 characters"`.
  - `config_outline`: match lines `^\[([^\]]+)\]\s*$`, skip lines starting with `#*#`, and number lines from 1.

- [ ] **Step 4: Run** `.venv/bin/pytest -q`. Expected: all pass.

- [ ] **Step 5: Commit:** "Script builder with validation, config outline".

---

### Task 3: Deck model (pure)

**Files:**
- Modify: `kobra_ui/macros.py`
- Test: `tests/test_macros.py`

**Interfaces:**
- Produces:
  - `default_deck(macros: list[dict]) -> dict`, shaped as in spec §1.2 with `version: 0`
  - `validate_deck(deck: dict) -> dict`, which returns a normalised copy or raises `ValueError`

- [ ] **Step 1: Write the failing tests:**

```python
def test_default_deck_groups():
    d = default_deck(MS)
    g = {x["id"]: x["items"] for x in d["groups"]}
    assert g["filament"][:3] == ["LOAD_FILAMENT", "UNLOAD_FILAMENT", "PURGE_FILAMENT"]
    assert {"CLEAN_NOZZLE", "MESH_CALIBRATE", "PID_HOTEND", "PID_BED"} <= set(g["maintenance"])
    assert {"PARK", "PREHEAT", "COOLDOWN"} <= set(g["motion"])
    assert not any(i.startswith("_") for items in g.values() for i in items)
    assert set(d["hidden"]) == {"START_PRINT", "PRINT_END", "SET_PRINT_STATS_INFO"}
    assert d["pinned"] == [] and d["presets"] == {} and d["version"] == 0

def test_validate_deck_normalises_case_and_rejects():
    d = default_deck(MS); d["pinned"] = ["park"]; d["colors"] = {"park": "orange"}
    v = validate_deck(d)
    assert v["pinned"] == ["PARK"] and v["colors"] == {"PARK": "orange"}   # Review Focus 1
    for bad in ({**d, "colors": {"PARK": "pink"}},
                {**d, "presets": {str(i): {"name": "p", "macro": "PARK", "params": {}} for i in range(201)}},
                {**d, "presets": {"p1": {"name": "x" * 61, "macro": "PARK", "params": {}}}}):
        with pytest.raises(ValueError):
            validate_deck(bad)

def test_validate_deck_keeps_missing_macros():  # Review Focus 3: kept, not dropped
    d = default_deck(MS); d["presets"] = {"p1": {"name": "Old", "macro": "GONE_MACRO", "params": {}}}
    assert validate_deck(d)["presets"]["p1"]["macro"] == "GONE_MACRO"
```

- [ ] **Step 2: Run.** Expected: fail.

- [ ] **Step 3: Implement both.**
  - Default groups, in this order:
    - `filament` "Filament": LOAD_FILAMENT, UNLOAD_FILAMENT, PURGE_FILAMENT, M600, DRY_FILAMENT, STOP_DRYING
    - `maintenance` "Maintenance": CLEAN_NOZZLE, MESH_CALIBRATE, PID_HOTEND, PID_BED, Z_ENDSTOP_HIT
    - `motion` "Motion & heat": PARK, PREHEAT, COOLDOWN
    - `other` "Other": every other non-internal, non-slicer macro, sorted
  - Any listed name not in `macros` is skipped.
  - `validate_deck` upper-cases macro names in `groups.items`, `pinned`, `hidden`, `colors`, `confirm`, `presets.*.macro` and `usage` keys. It leaves `preset:<id>` entries as they are. It checks the limits from Global Constraints and that preset param values pass the same value regex as `build_script`.

- [ ] **Step 4: Run** `.venv/bin/pytest -q`. Expected: all pass.

- [ ] **Step 5: Commit:** "Deck model: defaults and validation".

---

### Task 4: Deck store

**Files:**
- Create: `kobra_ui/deck_store.py`, `tests/test_deck_store.py`

**Interfaces:**
- Consumes: `default_deck`, `validate_deck`.
- Produces: `class DeckStore(folder: str, logger)` with:
  - `load(macros) -> dict`
  - `save(deck: dict, base_version: int) -> dict`, which raises `Conflict(current: dict)` (exception class in the same module) and `ValueError` from validation
  - `bump_usage(name: str) -> None`, which writes at most once per 30 s via `flush_usage(force=False)`

- [ ] **Step 1: Write the failing tests** (`tmp_path`):

```python
def test_load_creates_default(tmp_path):
    d = DeckStore(str(tmp_path), log).load(MS)
    assert d["version"] == 0 and (tmp_path / "deck.json").exists()

def test_save_bumps_version_and_keeps_history(tmp_path):
    s = DeckStore(str(tmp_path), log); d = s.load(MS)
    d2 = s.save({**d, "pinned": ["PARK"]}, base_version=0)
    assert d2["version"] == 1 and d2["pinned"] == ["PARK"]
    assert len(list((tmp_path / "deck.history").iterdir())) == 1

def test_conflict(tmp_path):
    s = DeckStore(str(tmp_path), log); d = s.load(MS); s.save(d, 0)
    with pytest.raises(Conflict) as e:
        s.save(d, 0)
    assert e.value.current["version"] == 1

def test_history_pruned_to_20(tmp_path):
    s = DeckStore(str(tmp_path), log); d = s.load(MS)
    for v in range(25):
        d = s.save(d, v)
    assert len(list((tmp_path / "deck.history").iterdir())) == 20

def test_corrupt_falls_back_to_history(tmp_path):
    s = DeckStore(str(tmp_path), log); d = s.load(MS); s.save({**d, "pinned": ["PARK"]}, 0)
    (tmp_path / "deck.json").write_text("{not json")
    d = DeckStore(str(tmp_path), log).load(MS)    # history holds the deck from before the save
    assert d["version"] == 0 and d["pinned"] == []
    assert "warning" in log.calls

def test_usage_flush(tmp_path):
    s = DeckStore(str(tmp_path), log); s.load(MS); s.bump_usage("park"); s.flush_usage(force=True)
    assert s.load(MS)["usage"] == {"PARK": 1}
```

`log` is a small fake that records method names in `.calls`.

- [ ] **Step 2: Run.** Expected: fail.

- [ ] **Step 3: Implement.**
  - Writes are atomic (`tempfile` in the same folder, then `os.replace`), guarded by a `threading.Lock`.
  - History files are named `deck.history/<version>-<unix_ts>.json`, holding the previous deck.
  - `load` order: `deck.json` → the newest parseable history file (logs `warning`) → `default_deck`.
  - `load` doesn't validate macros against the config; missing ones are kept.

- [ ] **Step 4: Run** `.venv/bin/pytest -q`. Expected: all pass.

- [ ] **Step 5: Commit:** "Deck store: atomic versioned saves, history, fallback".

---

### Task 5: Plugin wiring

**Files:**
- Modify: `kobra_ui/__init__.py`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces, over HTTP (base `/plugin/kobra_ui`):
  - `GET /macros` → `{macros, deck, klipper_ready}` (CONTROL)
  - `POST /deck` with body `{base_version, deck}` → the saved deck; `409` → `{current}`; `400` → `{error}` (SETTINGS)
  - `GET /config/outline` → `[{file, section, line}]` (CONTROL)
  - SimpleApi command `run_macro {macro, params, id}` → `{accepted, id}`, or `400 {error}`
  - push message `{"macros_changed": true}` after the macro cache rebuilds

- [ ] **Step 1: Macro cache.**
  - In `_push_klipper`, when the payload carries `status.configfile.settings` or `delta.configfile.settings`, rebuild `self._macros = parse_macros(settings)` under a lock.
  - If the set of names changed, push `{"macros_changed": True}`.
  - The watcher's first snapshot after a Klipper restart re-sends `configfile`, which covers Review Focus 5 on the server side.

- [ ] **Step 2: Routes and the `run_macro` command.**
  - `run_macro` uses `build_script(self._macros, …)`. A `ValueError` → `400` with the message. Then it calls the existing `_run_script(rid, script)` path (add the console line as `run` does) and `self._deck.bump_usage(macro)`.
  - A name not in `self._macros` (for example a removed macro, Review Focus 3) is a `ValueError` → 400.
  - `DeckStore` is created in `on_after_startup` with `self.get_plugin_data_folder()`.
  - `/config/outline` reads the files `_list_configs()` returns (top level only, not the archive folder).

- [ ] **Step 3: Assets.** `get_assets` js becomes `["js/kobra_deck.js", "js/kobra_ui.js"]` (the deck file defines `window.KobraDeck` before the view model is built). Create `static/js/kobra_deck.js` containing only:

```js
/* Kobra UI: macro deck, quick macros, edit mode and Ctrl+K palette. Extends KobraUiViewModel via KobraDeck(self). */
window.KobraDeck = function (self, h) { "use strict"; };
```

  In `kobra_ui.js`, at the end of the constructor, add `if (window.KobraDeck) window.KobraDeck(self, { PLUGIN: PLUGIN, store: store, esc: esc, num: num, k: k, schedulePack: schedulePack });`, and add `"macros"` to `ROUTES`.

- [ ] **Step 4: Bump the version** to `2.7.0`, deploy with `~/kobra-printer/tools/deploy.sh`, and verify with curl, reading the API key from the Orca profile the way `tools/testprint.py` does (`t.api(...)`):
  - `t.api("GET", "/plugin/kobra_ui/macros")` → 34 macros, and `deck.version == 0`
  - `t.api("POST", "/api/plugin/kobra_ui", {"command": "run_macro", "macro": "RESPOND", …})` → 400, because RESPOND isn't a macro
  - `run_macro` with `macro: "PARK", params: {"X": "1;M112"}` → 400 naming X. Nothing is sent: check that the console tail shows no new send line.
  - `/config/outline` contains `gcode_macro PARK`
  - Expected: all as described, and OctoPrint's log has no traceback (`ssh octoprint-kobra 'tail -50 ~/.octoprint/logs/octoprint.log | grep -c Traceback'` → 0).

- [ ] **Step 5: Commit:** "Plugin: macros, deck and outline routes, run_macro".

---

### Task 6: Macros view, panel and Quick macros

**Files:**
- Modify: `kobra_ui/static/js/kobra_deck.js`, `templates/kobra_ui_app.jinja2`, `static/css/kobra_ui.css`
- Create: `~/kobra-printer/tools/shot/deck.js`

**Interfaces:**
- Consumes: the Task 5 HTTP API; `self.toast`, `self.toastSet`, `self.confirm`, `self.go`, `self.openEditor`, `self.route`, `self.klipperReady`, `self.isPrinting`, `self.isPaused`, `self.onDataUpdaterPluginMessage` (wrap it, don't replace it), and `finishRun`-style handling. To reuse the existing busy/done toasts, expose `self.runFeedback(id, cmdText)` from `kobra_ui.js`: it is the existing `runs[id] = …` registration, factored out of `self.gcode`.
- Produces, on the view model:
  - `self.editorGoto(file, line)` (in `kobra_ui.js`)
  - observables `macros`, `deck`, `deckView` (`groups|az|used`), `selMacro`, `selParams`
  - functions `loadDeck()`, `saveDeck(mutator)`, `runMacro(name, params)`, `tileModel(entry)`
  - `flip(container, mutate)` (Task 8 reuses it)

- [ ] **Step 1: Write the Playwright test** `tools/shot/deck.js`. Same session and login setup as `polish.js`, viewport 1600×1000. It snapshots `GET /plugin/kobra_ui/macros` `deck` at the start and restores it at the end via `POST /deck`. Checks:
  - `?kui=macros` renders ≥ 15 tiles; no tile name starts with `_`; `START_PRINT` isn't visible outside edit mode.
  - Clicking `LOAD_FILAMENT` puts `LOAD_FILAMENT` in the panel header, with fields `TEMP`, `LENGTH`, `PURGE`; the TEMP placeholder is "auto"; the LENGTH hint contains "_PRINTER_SETTINGS load_length"; the Sends preview reads `LOAD_FILAMENT`.
  - Typing `60` in LENGTH changes the preview to `LOAD_FILAMENT LENGTH=60`. Nothing is run.
  - `COOLDOWN` panel shows "No parameters" (Review Focus 2).
  - Invalid value: set LENGTH to `6 0` → an inline field error, and the Run button is disabled.
  - Error path with a real round trip: stub nothing; call `vm.runMacro("PARK", {X: "1;2"})` → a toast whose text contains "X:" (the server's 400). The printer doesn't move.
  - Review Focus 5: `vm.onDataUpdaterPluginMessage("kobra_ui", {macros_changed: true})` with `LOAD_FILAMENT` selected → after the reload, the tile count is the same and `selMacro()` is still `LOAD_FILAMENT`.
  - Quick macros: with `pinned = ["PARK", "COOLDOWN"]` saved through `saveDeck`, `?kui=printer` shows a "Quick macros" card with 2 buttons. With `pinned = []`, the card is hidden.

- [ ] **Step 2: Run:** `cd ~/kobra-printer/tools/shot && LD_LIBRARY_PATH=$PWD/libs/root/usr/lib/x86_64-linux-gnu node deck.js`. Expected: FAIL (no route).

- [ ] **Step 3: Implement the view** to match the draft's deck screen (`.superpowers/brainstorm/6027-1792564102/content/next-draft.html`, tab 1), using the existing card, `.kb`, `.seg` and chip styles:
  - rail entry "Macros" (icon `fa-table-cells-large`) between Printer and Files
  - deck card with group labels, tiles (icon by group: filament `fa-arrow-down` / maintenance `fa-broom` / motion `fa-square-parking` / other `fa-terminal`; presets `fa-bookmark`), and the tabs Groups / A–Z / Most used
  - sticky panel
  - Quick macros card in `#kui-canvas`, after Print job
  - Parameter defaults: a `TEMP` default of `0` displays as "auto".
  - The "what it will do now" sentence is built from hints and state:
    - `homes`: "Homes first if needed."
    - `heats`: "Heats the nozzle." / "Heats the bed." (the latter when the template only touches the bed: M140 or M190)
    - `restarts`: "Klipper restarts at the end."
    - append "Printer is idle." / "A print is running." / "The print is paused."
  - Run calls `run_macro`. Before sending, it opens the confirm dialog if the macro is in `deck.confirm`, or has `restarts` or `homes` while printing or paused, with the risk text from spec §2.5.
  - Klipper not ready: Run is disabled and the panel shows `klipperStateWord` + the state message.
  - "Open in macros.cfg" calls a new `self.editorGoto(file, line)` in `kobra_ui.js`: `openEditor(file)`, then after the load scroll the textarea to `(line - 1) * 21` px and place the caret on that line. The line comes from `GET /config/outline`.
  - `printing_only` while idle: disabled with "Only while printing". `paused_only` while not paused: "Only while paused".

- [ ] **Step 4: Run** `deck.js`. Expected: all checks PASS. Also run `polish.js`: still 26/26.

- [ ] **Step 5: Commit**, then deploy as `2.7.1`.

---

### Task 7: Edit deck mode

**Files:**
- Modify: `kobra_deck.js`, `kobra_ui.css`, `kobra_ui_app.jinja2`
- Test: `tools/shot/deck.js` (append)

**Interfaces:**
- Consumes: `saveDeck(mutator)`, `flip(container, mutate)`.
- Produces: `deckEdit` observable; `tileMenu(entry)`; `undoDeck()`.

- [ ] **Step 1: Append the tests:**
  - "Edit deck" shows grips and hidden tiles (dashed).
  - **Pointer drag:** use `page.mouse` down/move in 10 steps/up. Move `PARK` before `PREHEAT`; after reload, the `motion` group order has `PARK` immediately before `PREHEAT`.
  - Menu → Hide on `DRY_FILAMENT` removes it outside edit mode; "Undo" in the toast restores it.
  - Menu → Pin adds the item to the Quick macros card.
  - **Conflict:** a second page saves the deck first. The first page's change still applies after reload, and the toast contains "changed on another device".
  - **Missing preset** (Review Focus 3): save a preset with `macro: "GONE_MACRO"` directly through `POST /deck`. Its tile shows "missing", Run is disabled, and Delete removes it.
  - Without SETTINGS permission: skip (single admin user). Assert in code review that the button binding checks `self.loginState.hasPermission(self.access.permissions.SETTINGS)`.

- [ ] **Step 2: Run.** Expected: new checks FAIL.

- [ ] **Step 3: Implement.**
  - Drag uses Pointer Events with `setPointerCapture`. The lifted tile follows the pointer through `transform` (1:1). The drop target index comes from tile centres measured once at drag start. Neighbours move through `flip()`.
  - Dropping on "New group" creates `{id: "g<ts>", name: "New group", items: [...]}` with the name editable inline.
  - Every change goes through `saveDeck(mutator)`: apply the change locally (optimistic), POST with `base_version`. On 409: replace with `current`, re-run the mutator, POST again once, then toast. On another failure: roll back and toast "Couldn't save the deck: <reason>".
  - Undo keeps the previous deck for 6 s and posts it back.

- [ ] **Step 4: Run** `deck.js`. Expected: all PASS.

- [ ] **Step 5: Commit**, then deploy as `2.7.2`.

---

### Task 8: Ctrl+K palette

**Files:**
- Modify: `kobra_deck.js`, `kobra_ui.css`, `kobra_ui_app.jinja2`, `kobra_ui.js` (keyboard handler: open on Ctrl/Cmd+K and `/`)
- Test: `tools/shot/deck.js` (append)

**Interfaces:**
- Consumes: `macros`, `deck`, `runMacro`, `self.files` (the loaded file list; use the existing observable that holds it), `GET /config/outline`, `self.editorGoto(name, line)` (Task 6).
- Produces: `paletteOpen`, `paletteQuery`, `paletteRows` (pure computed), and `fuzzyScore(query, text) -> {score, hits} | null`, exposed on `self` for tests.

- [ ] **Step 1: Append the tests:**
  - Ctrl+K opens the palette from the Printer view, from inside the console prompt, and from the config editor textarea. `/` opens it from the page body only, not when typed in the console, the editor or a panel field (Review Focus 4: the typed `/` stays in the field).
  - Query `pur` → the first Run row is `PURGE_FILAMENT`, with `PUR` highlighted. The Go to group has `gcode_macro PURGE_FILAMENT` from `macros.cfg`.
  - ↓ moves the highlight. Esc closes and returns focus to where it was.
  - Tab on `PURGE_FILAMENT` expands a `LENGTH` field. Typing `5x` shows an inline error, and Enter doesn't send.
  - `>RESPOND MSG=palette-test` + Enter → one `run` with `ok: true` (hook `onDataUpdaterPluginMessage` as in `polish.js`).
  - Choosing a config section opens `?kui=editor&cfg=macros.cfg` with the textarea scrolled so the section line is visible.
  - `vm.fuzzyScore("ld", "LOAD_FILAMENT")` beats `vm.fuzzyScore("ld", "COOLDOWN")`; `fuzzyScore("zz", "PARK") === null`.

- [ ] **Step 2: Run.** Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `fuzzyScore`: case-insensitive subsequence match. Score: +10 per matched char, +15 when a match is at the start or after `_`, space, `/` or `.`, +5 for consecutive matches, −1 per skipped char.
  - Rows are grouped Run (macros + presets) and Go to (outline sections, `_PRINTER_SETTINGS` variables from `configfile.settings`, files, views), at most 8 per group, ties broken by `deck.usage`.
  - `>` mode shows a single row.
  - The outline is fetched once per palette open and cached until `macros_changed`.

- [ ] **Step 4: Run.** Expected: all PASS.

- [ ] **Step 5: Commit**, then deploy as `2.7.3`.

---

### Task 9: Motion, phone sheet, wrap-up

**Files:**
- Modify: `kobra_deck.js`, `kobra_ui.css`
- Test: `tools/shot/deck.js` (append)
- Modify: `~/kobra-printer/docs/ledger.md`, `docs/ledger.md`

**Interfaces:**
- Consumes: `flip()` and everything above.

- [ ] **Step 1: Append the tests:**
  - **Animation timing:** for each motion in spec §3, trigger it and read `document.getAnimations()` / computed transitions. Durations must match the table (220, 180, 260, 200, 160, 240, 200, 120/400, 160, 200, 240 ms) within ±20 ms, and there must be no `left/top/width/height` transitions in the deck CSS (grep the stylesheet in the test).
  - **Frame pacing:** with a `PerformanceObserver('longtask')`, switching Groups ↔ A–Z 5 times and one drag produce no long task over 50 ms.
  - **Reduced motion:** a context with `reducedMotion: 'reduce'` → every deck animation is ≤ 80 ms and opacity-only.
  - **Phone (390×844):** selecting a tile opens the bottom sheet. Dragging the sheet's grip down 120 px closes it. No horizontal scroll.
  - Run done/fail feedback: the tile gets class `ran-ok` / `ran-bad` for 400 ms (use the PARK invalid-param path for `ran-bad`).

- [ ] **Step 2: Run.** Expected: new checks FAIL.

- [ ] **Step 3: Implement the motion table** from spec §3 exactly:
  - first-open stagger only once per page load
  - selection outline as one absolutely positioned element moved with FLIP
  - wiggle `@keyframes` on entering edit mode
  - pin pop
  - palette enter, and a highlight bar that slides between rows
  - parameter row expanding via `grid-template-rows: 0fr → 1fr`
  - bottom sheet with drag-to-close that follows the finger 1:1

  All of it goes through CSS custom properties `--ease-in` / `--ease-out` defined once.

- [ ] **Step 4: Run all checks.** Expected: `deck.js` all PASS, `polish.js` 26/26, `probe13.js` 80–81/81 aligned, `cam.js` all PASS.

- [ ] **Step 5: Wrap up.**
  - Add a "Macro deck (2026-10-21)" section to `~/kobra-printer/docs/ledger.md` (status per task) and copy it to the repo's `docs/ledger.md`.
  - Deploy as `2.7.4`, then commit and push.
  - Ask the user to run one pinned `LOAD_FILAMENT` preset on the printer to confirm end to end. Don't run it yourself.
