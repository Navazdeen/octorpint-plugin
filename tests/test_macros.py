import pytest

from macros import build_script, config_outline, default_deck, parse_macros, validate_deck
from tests.conftest import load_fixture

FIX = load_fixture()
MS = parse_macros(FIX)


def by_name():
    return {m["name"]: m for m in MS}


def test_names_are_upper_case_and_sorted():
    assert all(m["name"] == m["name"].upper() for m in MS)
    assert [m["name"] for m in MS] == sorted(m["name"] for m in MS)
    assert len(MS) == 34


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
    assert "paused_only" not in m["PAUSE"]["hints"]


def test_internal_and_slicer_flags():
    m = by_name()
    assert m["_WIPE"]["internal"] and not m["PARK"]["internal"]
    assert m["START_PRINT"]["slicer"] and m["SET_PRINT_STATS_INFO"]["slicer"]


def test_no_params_no_description():  # Review Focus 2
    m = by_name()["STOP_DRYING"]
    assert m["params"] == [] and isinstance(m["description"], str)


def test_computed_default_is_auto():
    p = {x["name"]: x for x in by_name()["PAUSE"]["params"]}
    assert p["REASON"]["default"] is None  # depends on runtime state
    assert p["X"]["default"] == "-5.0" and p["PARK"]["kind"] == "number"


def test_hints_ignore_messages_and_heater_off():
    m = by_name()
    assert "restarts" not in m["PID_HOTEND"]["hints"]  # SAVE_CONFIG is only mentioned in a RESPOND message
    assert "heats" not in m["STOP_DRYING"]["hints"]  # M140 S0 turns the bed off


def test_setting_defaults_are_unquoted():
    p = {x["name"]: x for x in by_name()["START_PRINT"]["params"]}
    assert p["MESH"]["default"] == "adaptive" and p["MESH"]["source"] == "_PRINTER_SETTINGS start_mesh"


def test_build_script_basic():
    assert build_script(MS, "load_filament", {"LENGTH": "60", "PURGE": "", "TEMP": None}) == "LOAD_FILAMENT LENGTH=60"
    assert build_script(MS, "COOLDOWN", {}) == "COOLDOWN"  # Review Focus 2


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
    assert not any(o["section"].startswith("bed_mesh") for o in out)  # SAVE_CONFIG block skipped


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
    d = default_deck(MS)
    d["pinned"] = ["park"]
    d["colors"] = {"park": "orange"}
    v = validate_deck(d)
    assert v["pinned"] == ["PARK"] and v["colors"] == {"PARK": "orange"}  # Review Focus 1
    for bad in ({**d, "colors": {"PARK": "pink"}},
                {**d, "presets": {str(i): {"name": "p", "macro": "PARK", "params": {}} for i in range(201)}},
                {**d, "presets": {"p1": {"name": "x" * 61, "macro": "PARK", "params": {}}}},
                {**d, "presets": {"p1": {"name": "x", "macro": "PARK", "params": {"X": "1;M112"}}}}):
        with pytest.raises(ValueError):
            validate_deck(bad)


def test_validate_deck_keeps_missing_macros():  # Review Focus 3: kept, not dropped
    d = default_deck(MS)
    d["presets"] = {"p1": {"name": "Old", "macro": "GONE_MACRO", "params": {}}}
    d["groups"][0]["items"].append("preset:p1")
    v = validate_deck(d)
    assert v["presets"]["p1"]["macro"] == "GONE_MACRO" and "preset:p1" in v["groups"][0]["items"]
