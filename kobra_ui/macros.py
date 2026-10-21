"""Macros for the deck, read from Klipper's configfile.settings.

Pure functions only (no OctoPrint, no I/O) so they can be tested on their own.
"""

import re

SETTINGS_SECTION = "gcode_macro _printer_settings"
SLICER_MACROS = {"START_PRINT", "PRINT_END", "SET_PRINT_STATS_INFO"}
# hints that the template alone doesn't show: M600 parks and waits, which only makes sense mid-print
STATE_OVERRIDES = {"M600": "printing_only"}

_PARAM = re.compile(r"""params(?:\.([A-Z_][A-Z0-9_]*)|\[['"]([A-Z_][A-Z0-9_]*)['"]\])(\s*\|\s*default\(((?:[^()]|\([^()]*\))*)\))?([^}%]*)""")
_SETTING_REF = re.compile(r"""^(?:s|printer\[['"]gcode_macro _PRINTER_SETTINGS['"]\])\.([a-z_][a-z0-9_]*)$""")
_NUMBER = re.compile(r"^-?\d+(\.\d+)?$")
_SET_FROM_PARAM = re.compile(r"""\{%-?\s*set\s+(\w+)\s*=\s*params(?:\.(\w+)|\[['"](\w+)['"]\])""")
_SET_DICT = re.compile(r"""\{%-?\s*set\s+(\w+)\s*=\s*\{(.*?)\}\s*-?%\}""", re.S)
_DICT_KEY = re.compile(r"""['"]([^'"]+)['"]\s*:""")
_FIRST_IF = re.compile(r"""\{%-?\s*if\s+(.*?)\s*-?%\}(.*?)\{%-?\s*(?:elif|else|endif)\b""", re.S)
_HINTS = {
    "heats": re.compile(r"\b(M104|M109|M140|M190|SET_HEATER_TEMPERATURE)\b|\b_HEAT"),
    "homes": re.compile(r"\bG28\b|\b_ENSURE_HOMED\b"),
    "restarts": re.compile(r"\b(SAVE_CONFIG|RESTART|FIRMWARE_RESTART)\b"),
}


def _resolve_default(expr, settings):
    """(value, source) for a default() expression; value None when it is computed at run time."""
    expr = expr.strip()
    if len(expr) >= 2 and expr[0] == expr[-1] and expr[0] in "'\"" and expr[0] not in expr[1:-1]:
        return expr[1:-1], None
    if _NUMBER.match(expr):
        return expr, None
    m = _SETTING_REF.match(expr)
    if m:
        value = settings.get(SETTINGS_SECTION, {}).get("variable_" + m.group(1))
        if value is not None:
            value, _ = _resolve_default(str(value), {})  # variable_ values are Jinja literals: 'adaptive', 40.0
            if value is not None:
                return value, "_PRINTER_SETTINGS " + m.group(1)
    return None, None


def _choices(name, gcode):
    """String values a parameter is checked against: == 'X' tests or the keys of a dict it indexes."""
    names = {name}
    for m in _SET_FROM_PARAM.finditer(gcode):
        if (m.group(2) or m.group(3)) == name:
            names.add(m.group(1))
    found = []
    for var in names:
        for lit in re.findall(r"\b%s\s*==\s*['\"]([^'\"]+)['\"]" % re.escape(var), gcode):
            found.append(lit)
    for m in _SET_DICT.finditer(gcode):
        dict_name, body = m.group(1), m.group(2)
        if any(re.search(r"\b%s\[\s*%s\s*\]|\b%s\s+in\s+%s\b" % (re.escape(dict_name), re.escape(v), re.escape(v), re.escape(dict_name)), gcode) for v in names):
            found.extend(_DICT_KEY.findall(body))
    out = []
    for f in found:
        if f not in out:
            out.append(f)
    return out


def _params(gcode, settings):
    out = {}
    for m in _PARAM.finditer(gcode):
        name = m.group(1) or m.group(2)
        has_default, expr, tail = m.group(3), m.group(4), m.group(5) or ""
        if name in out and (out[name]["default"] is not None or not has_default):
            continue
        default, source = _resolve_default(expr, settings) if has_default else (None, None)
        number = default is not None and _NUMBER.match(default.strip()) is not None
        number = number or re.match(r"\s*\|\s*(float|int)\b", tail) is not None
        param = {"name": name, "default": default, "source": source, "kind": "number" if number else "text", "choices": []}
        if name in out:
            param["kind"] = out[name]["kind"] if out[name]["kind"] == "number" else param["kind"]
            out[name].update(param)
        else:
            out[name] = param
    for p in out.values():
        if p["kind"] == "text":
            p["choices"] = _choices(p["name"], gcode)
    return list(out.values())


def _state_hint(gcode):
    """paused_only / printing_only when the template opens by doing nothing (or failing) in the other state."""
    m = _FIRST_IF.search(gcode)
    if not m:
        return None
    cond, branch = m.group(1).strip(), m.group(2)
    lines = [l.strip() for l in branch.strip().splitlines() if l.strip()]
    idle_branch = all(l.startswith("RESPOND") or "action_raise_error" in l or "action_respond_info" in l for l in lines)
    if not idle_branch:
        return None
    if re.fullmatch(r"not\s+printer\.pause_resume\.is_paused", cond):
        return "paused_only"
    if re.search(r"printer\.print_stats\.state\s*(!=|not\s+in)", cond):
        return "printing_only"
    return None


def _commands(gcode):
    """The template without messages and heater-off lines, so hints only see what it really does."""
    keep = []
    for line in gcode.splitlines():
        l = line.strip()
        if l.startswith(("RESPOND", "{action_respond_info", "{ action_respond_info")):
            continue
        if re.match(r"(M104|M140)\s+S0(\.0*)?\s*$", l) or re.match(r"SET_HEATER_TEMPERATURE\s.*TARGET=0(\.0*)?\s*$", l):
            continue
        keep.append(line)
    return "\n".join(keep)


def parse_macros(settings):
    macros = []
    for section, opts in settings.items():
        if not section.startswith("gcode_macro "):
            continue
        name = section[len("gcode_macro "):].strip().upper()
        gcode = opts.get("gcode", "") or ""
        hints = [h for h, rx in _HINTS.items() if rx.search(_commands(gcode))]
        state = STATE_OVERRIDES.get(name) or _state_hint(gcode)
        if state:
            hints.append(state)
        macros.append({
            "name": name,
            "description": "" if (opts.get("description") or "").strip() == "G-Code macro" else opts.get("description") or "",
            "params": _params(gcode, settings),
            "hints": hints,
            "internal": name.startswith("_"),
            "slicer": name in SLICER_MACROS,
        })
    macros.sort(key=lambda m: m["name"])
    return macros


VALUE_RE = re.compile(r"^[A-Za-z0-9_.+\-]{1,40}$")
_SECTION = re.compile(r"^\[([^\]]+)\]\s*$")


def check_value(name, value):
    if not VALUE_RE.match(value):
        raise ValueError("%s: use a number or a single word (letters, digits, . _ + -), at most 40 characters" % name)


def build_script(macros, name, params):
    """The G-code line for a deck run: a known macro and its known parameters, values checked."""
    macro = next((m for m in macros if m["name"] == str(name).upper()), None)
    if macro is None:
        raise ValueError("%s: no such macro in the Klipper config" % str(name).upper())
    known = [p["name"] for p in macro["params"]]
    given = {str(k).upper(): v for k, v in (params or {}).items()}
    for key in given:
        if key not in known:
            raise ValueError("%s: %s doesn't take this parameter" % (key, macro["name"]))
    parts = [macro["name"]]
    for key in known:
        value = given.get(key)
        if value is None or str(value).strip() == "":
            continue
        value = str(value).strip()
        check_value(key, value)
        parts.append("%s=%s" % (key, value))
    return " ".join(parts)


def config_outline(files):
    """[section] headers of the config files with 1-based line numbers; the SAVE_CONFIG block is skipped."""
    out = []
    for fname, text in files.items():
        for i, line in enumerate(text.splitlines(), 1):
            if line.startswith("#*#"):
                continue
            m = _SECTION.match(line)
            if m:
                out.append({"file": fname, "section": m.group(1).strip(), "line": i})
    return out


COLORS = {"orange", "blue", "green", "red"}
MAX_PRESETS = 200
MAX_NAME = 60
DEFAULT_GROUPS = [
    ("filament", "Filament", ["LOAD_FILAMENT", "UNLOAD_FILAMENT", "PURGE_FILAMENT", "M600", "DRY_FILAMENT", "STOP_DRYING"]),
    ("maintenance", "Maintenance", ["CLEAN_NOZZLE", "MESH_CALIBRATE", "PID_HOTEND", "PID_BED", "Z_ENDSTOP_HIT"]),
    ("motion", "Motion & heat", ["PARK", "PREHEAT", "COOLDOWN"]),
]


def default_deck(macros):
    names = {m["name"] for m in macros}
    groups, used = [], set()
    for gid, gname, items in DEFAULT_GROUPS:
        present = [n for n in items if n in names]
        used.update(present)
        groups.append({"id": gid, "name": gname, "items": present})
    rest = sorted(m["name"] for m in macros if not m["internal"] and not m["slicer"] and m["name"] not in used)
    groups.append({"id": "other", "name": "Other", "items": rest})
    return {"version": 0, "groups": groups, "pinned": [], "hidden": sorted(SLICER_MACROS),
            "colors": {}, "confirm": [], "presets": {}, "usage": {}}


def _entry(item):
    item = str(item)
    return item if item.startswith("preset:") else item.upper()


def _name(value, what):
    value = str(value or "").strip()
    if not value or len(value) > MAX_NAME:
        raise ValueError("%s: give a name of 1 to %d characters" % (what, MAX_NAME))
    return value


def validate_deck(deck):
    """A normalised copy of a deck sent by the UI; raises ValueError naming the first problem."""
    if not isinstance(deck, dict):
        raise ValueError("The deck must be an object")
    groups = []
    for g in deck.get("groups") or []:
        groups.append({"id": _name(g.get("id"), "Group id"), "name": _name(g.get("name"), "Group name"),
                       "items": [_entry(i) for i in g.get("items") or []]})
    colors = {}
    for key, color in (deck.get("colors") or {}).items():
        if color not in COLORS:
            raise ValueError("%s: colour must be one of %s" % (key, ", ".join(sorted(COLORS))))
        colors[_entry(key)] = color
    presets = deck.get("presets") or {}
    if len(presets) > MAX_PRESETS:
        raise ValueError("Too many presets (at most %d)" % MAX_PRESETS)
    clean_presets = {}
    for pid, p in presets.items():
        params = {}
        for k, v in (p.get("params") or {}).items():
            v = str(v).strip()
            if v:
                check_value(str(k).upper(), v)
                params[str(k).upper()] = v
        clean_presets[_name(pid, "Preset id")] = {"name": _name(p.get("name"), "Preset name"),
                                                  "macro": str(p.get("macro") or "").upper(), "params": params}
    usage = {}
    for k, v in (deck.get("usage") or {}).items():
        usage[_entry(k)] = int(v) if isinstance(v, (int, float)) and v >= 0 else 0
    return {
        "version": int(deck.get("version") or 0),
        "groups": groups,
        "pinned": [_entry(i) for i in deck.get("pinned") or []],
        "hidden": [_entry(i) for i in deck.get("hidden") or []],
        "colors": colors,
        "confirm": [_entry(i) for i in deck.get("confirm") or []],
        "presets": clean_presets,
        "usage": usage,
    }
