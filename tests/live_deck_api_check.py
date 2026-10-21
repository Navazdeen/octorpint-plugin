"""Task 5 checks against the live plugin: macros, deck, outline routes and run_macro validation.
Read-only apart from run_macro calls that must be rejected (nothing reaches Klipper)."""
import json
import sys
import urllib.error

sys.path.insert(0, __file__.rsplit("/", 1)[0])
import testprint as t  # noqa: E402

R = []


def ok(name, cond, detail=""):
    R.append(("PASS " if cond else "FAIL ") + name + (" - " + str(detail)[:200] if detail else ""))


def call(method, path, body=None):
    try:
        return 200, t.api(method, path, body)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, raw[:200]


code, r = call("GET", "/plugin/kobra_ui/macros")
ok("GET /macros", code == 200 and len(r.get("macros", [])) == 34 and "version" in r.get("deck", {}), (code, str(r)[:120]))
code, r2 = call("POST", "/api/plugin/kobra_ui", {"command": "run_macro", "macro": "RESPOND", "params": {}, "id": "t1"})
ok("run_macro unknown macro -> 400", code == 400 and "RESPOND" in str(r2), (code, r2))
console_before = t.api("GET", "/api/plugin/kobra_ui")["console"][-1:]
code, r3 = call("POST", "/api/plugin/kobra_ui", {"command": "run_macro", "macro": "COOLDOWN", "params": {"X": "1;2"}, "id": "t2"})
console_after = t.api("GET", "/api/plugin/kobra_ui")["console"][-1:]
ok("run_macro bad value -> 400 naming X, nothing sent", code == 400 and "X:" in str(r3) and console_before == console_after, (code, r3))
code, r4 = call("GET", "/plugin/kobra_ui/config/outline")
ok("GET /config/outline", code == 200 and any(o["section"] == "gcode_macro PARK" and o["file"] == "macros.cfg" for o in r4), (code, str(r4)[:120]))
if code == 200 and isinstance(r, dict) and "deck" in r:
    d = r["deck"]
    code, c = call("POST", "/plugin/kobra_ui/deck", {"base_version": d["version"] + 99, "deck": d})
    ok("POST /deck stale version -> 409 with current", code == 409 and c.get("current", {}).get("version") == d["version"], (code, str(c)[:120]))
    code, c = call("POST", "/plugin/kobra_ui/deck", {"base_version": d["version"], "deck": {**d, "colors": {"PARK": "pink"}}})
    ok("POST /deck invalid -> 400", code == 400 and "colour" in str(c), (code, c))
print("\n".join(R))
sys.exit(0 if all(x.startswith("PASS") for x in R) else 1)
