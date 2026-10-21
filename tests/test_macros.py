import pytest

from macros import build_script, config_outline, parse_macros
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
