"""Kobra UI - a full-screen console for the Kobra 2 Neo on OctoPrint + Klipper.

Live Klipper state comes straight from Klipper's API socket; console traffic
is captured from OctoPrint's serial hooks; config files are read and saved
here (with a backup of every previous version).
"""

import datetime
import json
import os
import re
import shutil
import socket
import threading
import time

import flask
import octoprint.plugin
from octoprint.access.permissions import Permissions

from . import macros as kmacros
from .deck_store import Conflict, DeckStore

KLIPPY_SOCKET = os.path.expanduser("~/printer_data/comms/klippy.sock")
KLIPPY_LOG = os.path.expanduser("~/printer_data/logs/klippy.log")
CONFIG_DIR = os.path.expanduser("~/printer_data/config")
HISTORY_DIR = os.path.join(CONFIG_DIR, ".kui_history")
UPLOADS_DIR = os.path.expanduser("~/.octoprint/uploads")
_LAYER_CACHE = {}
SAVE_CONFIG_MARK = "#*#"
MAX_CONFIG_BYTES = 1024 * 1024
CONSOLE_LINES = 300
RUN_TIMEOUT = 30 * 60  # longest a button command may run (heat soak + mesh fits easily)

SUBSCRIBE_OBJECTS = {
    "webhooks": ["state", "state_message"],
    "idle_timeout": ["state"],
    "print_stats": ["info", "state"],
    "pause_resume": ["is_paused"],
    "gcode_macro PAUSE": ["reason", "m600", "extruder_temp"],
    "gcode_macro SET_PRINT_STATS_INFO": ["pause_next_layer", "pause_at_layer"],
    "bed_mesh": ["profile_name", "probed_matrix", "mesh_min", "mesh_max", "profiles"],
    "save_variables": ["variables"],
    "toolhead": ["homed_axes"],
    "gcode_move": ["homing_origin", "gcode_position"],
    "fan": ["speed"],
    "temperature_sensor mcu_temp": ["temperature"],
    "configfile": ["settings"],
    "exclude_object": ["objects", "excluded_objects", "current_object"],
}

# serial chatter that is not worth showing in the console
QUIET_RECEIVED = re.compile(r"^\s*(ok\s*)?(T:|B:|T0:|wait\b)|^\s*$")
# polling and OctoPrint's connection handshake
QUIET_SENT = {"M105", "M27", "M155", "M114", "M110", "M115", "M21", "M20"}


def _merge(dst, src):
    for key, value in src.items():
        if isinstance(value, dict) and isinstance(dst.get(key), dict):
            _merge(dst[key], value)
        else:
            dst[key] = value


class KlippyWatcher(threading.Thread):
    """objects/subscribe on Klipper's socket, reconnecting after restarts.

    on_update(delta) gets only the objects that changed, so the browser is not
    sent the whole config file every half second."""

    def __init__(self, logger, on_update):
        super().__init__(daemon=True, name="kobra_ui-klippy")
        self._logger = logger
        self._on_update = on_update
        self._lock = threading.Lock()
        self.status = {}
        self.connected = False
        self.ready_since = None
        self.info = {}
        self.commands = []

    def snapshot(self):
        with self._lock:
            return {"connected": self.connected, "status": json.loads(json.dumps(self.status)),
                    "ready_since": self.ready_since, "info": dict(self.info), "commands": list(self.commands)}

    def run(self):
        while True:
            try:
                self._session()
            except Exception as exc:  # klippy restarting, not ready yet, socket gone
                self._logger.debug("klippy watcher: %s", exc)
            with self._lock:
                self.connected = False
                self.ready_since = None
            self._on_update({"connected": False, "ready_since": None})
            time.sleep(2)

    def _session(self):
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(30)
        sock.connect(KLIPPY_SOCKET)
        reader = _Reader(sock)
        info = reader.call("info", {})
        if info.get("state") != "ready":
            raise RuntimeError("klippy %s" % info.get("state"))
        mcu = reader.call("objects/query", {"objects": {"mcu": ["mcu_version", "mcu_constants"]}})
        help_ = reader.call("gcode/help", {})
        status = reader.call("objects/subscribe", {"objects": SUBSCRIBE_OBJECTS, "response_template": {}})["status"]
        constants = (mcu.get("status", {}).get("mcu", {}) or {}).get("mcu_constants", {}) or {}
        with self._lock:
            self.status = status
            self.connected = True
            self.ready_since = _klippy_started() or time.time()
            self.info = {"version": info.get("software_version", ""), "hostname": info.get("hostname", ""),
                         "mcu": constants.get("MCU", ""),
                         "mcu_version": (mcu.get("status", {}).get("mcu", {}) or {}).get("mcu_version", "")}
            self.commands = sorted(help_.keys())
        self._on_update(self.snapshot())
        pending, last = {}, 0.0
        while True:
            msg = reader.next()
            if msg is None:
                continue
            if "params" in msg and "status" in msg["params"]:
                with self._lock:
                    _merge(self.status, msg["params"]["status"])
                _merge(pending, msg["params"]["status"])
            now = time.monotonic()
            if pending and now - last >= 0.5:
                last = now
                self._on_update({"delta": pending})
                pending = {}


class _Reader:
    def __init__(self, sock):
        self.sock = sock
        self.buf = b""
        self.next_id = 1
        self.queue = []

    def call(self, method, params):
        rid = self.next_id
        self.next_id += 1
        self.sock.sendall(json.dumps({"id": rid, "method": method, "params": params}).encode() + b"\x03")
        while True:
            msg = self._read()
            if msg is None:
                continue
            if msg.get("id") == rid:
                if "error" in msg:
                    raise RuntimeError(msg["error"].get("message", method + " failed"))
                return msg["result"]
            self.queue.append(msg)

    def next(self):
        if self.queue:
            return self.queue.pop(0)
        return self._read()

    def _read(self):
        while b"\x03" not in self.buf:
            try:
                chunk = self.sock.recv(65536)
            except socket.timeout:
                return None
            if not chunk:
                raise ConnectionError("klippy closed the socket")
            self.buf += chunk
        raw, self.buf = self.buf.split(b"\x03", 1)
        return json.loads(raw)


class KobraUiPlugin(octoprint.plugin.StartupPlugin,
                    octoprint.plugin.TemplatePlugin,
                    octoprint.plugin.AssetPlugin,
                    octoprint.plugin.SimpleApiPlugin,
                    octoprint.plugin.BlueprintPlugin):

    def __init__(self):
        self._watcher = None
        self._console = []
        self._console_pending = []
        self._console_lock = threading.Lock()
        self._awaiting_ok = 0
        self._macros = []
        self._macros_lock = threading.Lock()
        self._deck = None

    # --- startup ----------------------------------------------------------
    def on_after_startup(self):
        self._deck = DeckStore(self.get_plugin_data_folder(), self._logger)
        self._watcher = KlippyWatcher(self._logger, self._push_klipper)
        self._watcher.start()
        threading.Thread(target=self._console_flusher, daemon=True, name="kobra_ui-console").start()

    def _push_klipper(self, payload):
        self._plugin_manager.send_plugin_message(self._identifier, {"klipper": payload})
        for part in ("status", "delta"):
            settings = ((payload.get(part) or {}).get("configfile") or {}).get("settings")
            if settings:
                self._refresh_macros(settings)

    def _refresh_macros(self, settings):
        """Rebuild the deck's macro list; Klipper re-sends configfile after every restart."""
        try:
            parsed = kmacros.parse_macros(settings)
        except Exception:
            self._logger.exception("Couldn't read the macros from Klipper's config")
            return
        with self._macros_lock:
            changed = [m["name"] for m in parsed] != [m["name"] for m in self._macros]
            self._macros = parsed
        if changed:
            self._plugin_manager.send_plugin_message(self._identifier, {"macros_changed": True})

    # --- console capture --------------------------------------------------
    def _add_console(self, kind, text):
        entry = {"t": time.time(), "k": kind, "x": text}
        with self._console_lock:
            self._console.append(entry)
            del self._console[:-CONSOLE_LINES]
            self._console_pending.append(entry)

    def _console_flusher(self):
        while True:
            time.sleep(0.4)
            with self._console_lock:
                batch, self._console_pending = self._console_pending, []
            if batch:
                self._plugin_manager.send_plugin_message(self._identifier, {"console": batch})

    def on_gcode_sent(self, comm, phase, cmd, cmd_type, gcode, *args, **kwargs):
        tags = kwargs.get("tags") or set()
        if "source:file" in tags or (gcode or "").upper() in QUIET_SENT or (cmd or "").strip().upper() in QUIET_SENT:
            return
        self._awaiting_ok += 1
        self._add_console("send", cmd)

    def on_gcode_received(self, comm, line, *args, **kwargs):
        text = line.rstrip()
        if text.startswith("ok"):
            if self._awaiting_ok > 0:
                self._awaiting_ok -= 1
                self._add_console("ok", "ok")
            return line
        if QUIET_RECEIVED.match(text):
            return line
        if text.startswith("!!"):
            self._add_console("err", text[2:].strip())
        elif text.startswith("//"):
            self._add_console("info", text[2:].strip())
        else:
            self._add_console("info", text.strip())
        return line

    # --- api: initial state ------------------------------------------------
    def is_api_protected(self):
        return True

    def get_api_commands(self):
        return {"estop": [], "run": ["script"], "run_macro": ["macro"]}

    def on_api_command(self, command, data):
        if command == "estop":
            # straight to Klipper: does not wait behind queued serial lines
            sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            sock.settimeout(3)
            try:
                sock.connect(KLIPPY_SOCKET)
                sock.sendall(json.dumps({"id": 1, "method": "emergency_stop", "params": {}}).encode() + b"\x03")
            finally:
                sock.close()
            self._logger.warning("Emergency stop requested from the Kobra UI")
            return flask.jsonify({"sent": True})
        if command == "run_macro":
            return self._run_macro(data)
        if command == "run":
            # A button's G-code goes straight to Klipper so the UI learns when it finished and why it failed
            # (gcode/script answers only once the script is done, with Klipper's own error text). It runs in
            # a thread and the result is pushed, so a 3-minute mesh probe never holds an HTTP worker.
            if not Permissions.CONTROL.can():
                return flask.abort(403)
            script = str(data.get("script") or "").strip()
            rid = str(data.get("id") or "")[:40]
            if not script or len(script) > 2000:
                return flask.abort(400)
            if not os.path.exists(KLIPPY_SOCKET):
                return flask.make_response(flask.jsonify({"error": "Klipper's API socket is missing"}), 503)
            self._add_console("send", script)
            threading.Thread(target=self._run_script, args=(rid, script), daemon=True, name="kobra_ui-run").start()
            return flask.jsonify({"accepted": True, "id": rid})

    def _run_macro(self, data):
        if not Permissions.CONTROL.can():
            return flask.abort(403)
        with self._macros_lock:
            known = list(self._macros)
        try:
            script = kmacros.build_script(known, data.get("macro"), data.get("params") or {})
        except ValueError as exc:
            return flask.make_response(flask.jsonify({"error": str(exc)}), 400)
        rid = str(data.get("id") or "")[:40]
        self._add_console("send", script)
        threading.Thread(target=self._run_script, args=(rid, script), daemon=True, name="kobra_ui-run").start()
        if self._deck:
            self._deck.bump_usage(str(data.get("preset") and "preset:" + str(data["preset"]) or script.split(" ", 1)[0]))
        return flask.jsonify({"accepted": True, "id": rid})

    def _run_script(self, rid, script):
        started = time.time()
        result = {"id": rid, "ok": False, "error": None}
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(1.0)
        try:
            sock.connect(KLIPPY_SOCKET)
            reader = _Reader(sock)
            rid_sock = reader.next_id
            reader.next_id += 1
            sock.sendall(json.dumps({"id": rid_sock, "method": "gcode/script", "params": {"script": script}}).encode() + b"\x03")
            while time.time() - started < RUN_TIMEOUT:
                msg = reader.next()
                if msg is None or msg.get("id") != rid_sock:
                    continue
                if "error" in msg:
                    result["error"] = (msg["error"] or {}).get("message") or "Klipper rejected the command"
                else:
                    result["ok"] = True
                break
            else:
                result["error"] = "No answer from Klipper after %d minutes" % (RUN_TIMEOUT // 60)
        except (OSError, ConnectionError, ValueError) as exc:
            result["error"] = "Klipper's API socket closed (%s)" % exc
        finally:
            sock.close()
        result["secs"] = round(time.time() - started, 1)
        if result["error"]:
            self._add_console("err", result["error"])
        self._plugin_manager.send_plugin_message(self._identifier, {"run": result})

    def on_api_get(self, request):
        with self._console_lock:
            console = list(self._console)
        klipper = self._watcher.snapshot() if self._watcher else {"connected": False, "status": {}}
        try:
            load = os.getloadavg()[0]
        except OSError:
            load = None
        return flask.jsonify({"klipper": klipper, "console": console, "load": load, "configs": _list_configs()})

    # --- config files -------------------------------------------------------
    def is_blueprint_csrf_protected(self):
        return True

    def is_blueprint_protected(self):
        return True

    # --- macro deck ------------------------------------------------------------
    @octoprint.plugin.BlueprintPlugin.route("/macros", methods=["GET"])
    def macros_get(self):
        if not Permissions.CONTROL.can():
            flask.abort(403)
        with self._macros_lock:
            known = list(self._macros)
        ready = bool(self._watcher and self._watcher.snapshot().get("status", {}).get("webhooks", {}).get("state") == "ready")
        return flask.jsonify({"macros": known, "deck": self._deck.load(known), "klipper_ready": ready})

    @octoprint.plugin.BlueprintPlugin.route("/deck", methods=["POST"])
    def deck_save(self):
        if not Permissions.SETTINGS.can():
            flask.abort(403)
        body = flask.request.get_json(silent=True) or {}
        try:
            return flask.jsonify(self._deck.save(body.get("deck") or {}, int(body.get("base_version", -1))))
        except Conflict as exc:
            return flask.make_response(flask.jsonify({"current": exc.current}), 409)
        except (ValueError, TypeError) as exc:
            return flask.make_response(flask.jsonify({"error": str(exc)}), 400)

    @octoprint.plugin.BlueprintPlugin.route("/config/outline", methods=["GET"])
    def config_outline(self):
        files = {}
        for item in _list_configs():
            if item.get("folder"):
                continue
            try:
                with open(os.path.join(CONFIG_DIR, item["name"]), encoding="utf-8") as f:
                    files[item["name"]] = f.read()
            except OSError:
                continue
        return flask.jsonify(kmacros.config_outline(files))

    @octoprint.plugin.BlueprintPlugin.route("/config", methods=["GET"])
    def config_list(self):
        return flask.jsonify({"files": _list_configs()})

    @octoprint.plugin.BlueprintPlugin.route("/config/<name>", methods=["GET"])
    def config_get(self, name):
        path = _config_path(name)
        if not path or not os.path.isfile(path):
            flask.abort(404)
        with open(path, encoding="utf-8") as f:
            return flask.jsonify({"name": name, "content": f.read(), "mtime": os.path.getmtime(path)})

    @octoprint.plugin.BlueprintPlugin.route("/config/<name>", methods=["POST"])
    def config_save(self, name):
        if not Permissions.ADMIN.can():
            flask.abort(403)
        path = _config_path(name)
        if not path or not os.path.isfile(path):
            flask.abort(404)
        data = flask.request.get_json(silent=True) or {}
        content = data.get("content")
        if not isinstance(content, str) or len(content.encode("utf-8")) > MAX_CONFIG_BYTES:
            flask.abort(400)
        with open(path, encoding="utf-8") as f:
            old = f.read()
        # the SAVE_CONFIG block belongs to Klipper: keep what is on disk
        keep = _save_config_block(old)
        body = "\n".join(l for l in content.split("\n") if not l.startswith(SAVE_CONFIG_MARK)).rstrip("\n")
        if keep:
            body = re.sub(r"\n#\*# <-+ SAVE_CONFIG -+>.*$", "", body, flags=re.S).rstrip("\n")
            new = body + "\n\n" + keep
        else:
            new = body + "\n"
        if new != old:
            hist = os.path.join(HISTORY_DIR, name)
            os.makedirs(hist, exist_ok=True)
            shutil.copy2(path, os.path.join(hist, datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".cfg"))
            tmp = path + ".kui-tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(new)
            os.replace(tmp, path)
        if data.get("restart"):
            self._printer.commands("RESTART")
        return flask.jsonify({"saved": new != old, "content": new, "mtime": os.path.getmtime(path)})

    @octoprint.plugin.BlueprintPlugin.route("/config/<name>/history", methods=["GET"])
    def config_history(self, name):
        if not _config_path(name):
            flask.abort(404)
        return flask.jsonify({"versions": [{k: v[k] for k in ("id", "time", "source")} for v in _history(name)]})

    @octoprint.plugin.BlueprintPlugin.route("/config/<name>/history/<vid>", methods=["GET"])
    def config_version(self, name, vid):
        for v in _history(name):
            if v["id"] == vid:
                with open(v["path"], encoding="utf-8") as f:
                    return flask.jsonify({"id": vid, "content": f.read()})
        flask.abort(404)

    @octoprint.plugin.BlueprintPlugin.route("/layers", methods=["GET"])
    def file_layers(self):
        """Layer count and heights of an uploaded G-code file, and whether it carries layer tracking."""
        rel = flask.request.args.get("path", "")
        base = os.path.realpath(UPLOADS_DIR)
        path = os.path.realpath(os.path.join(base, rel))
        if not rel or not path.startswith(base + os.sep) or not os.path.isfile(path):
            flask.abort(404)
        key = (path, os.path.getmtime(path))
        if key not in _LAYER_CACHE:
            _LAYER_CACHE.clear()
            _LAYER_CACHE[key] = _scan_layers(path)
        return flask.jsonify(_LAYER_CACHE[key])

    # --- ui -----------------------------------------------------------------
    def is_template_autoescaped(self):
        return True

    def get_assets(self):
        return {"js": ["js/kobra_deck.js", "js/kobra_ui.js"], "css": ["css/kobra_ui.css"]}

    def get_template_configs(self):
        return [{"type": "generic", "template": "kobra_ui_app.jinja2", "custom_bindings": True}]


def _klippy_started():
    """Wall-clock time of Klipper's last start, from the 'Start printer at … (<epoch> …)' log line."""
    try:
        with open(KLIPPY_LOG, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 2 * 1024 * 1024))
            tail = f.read().decode("utf-8", "replace")
        hits = re.findall(r"^Start printer at .*?\((\d+(?:\.\d+)?) ", tail, flags=re.M)
        return float(hits[-1]) if hits else None
    except OSError:
        return None


def _scan_layers(path):
    """Orca/Prusa style: ';LAYER_CHANGE' then ';Z:<height>'. Falls back to the header's layer count."""
    zs, tracking, pending, total_hint = [], False, False, None
    with open(path, encoding="utf-8", errors="replace") as f:
        for line in f:
            c = line[:1]
            if c == ";":
                if line.startswith(";LAYER_CHANGE"):
                    pending = True
                elif pending and line.startswith(";Z:"):
                    try:
                        zs.append(round(float(line[3:].strip()), 3))
                    except ValueError:
                        pass
                    pending = False
                elif line.startswith("; total layers count") and total_hint is None:
                    try:
                        total_hint = int(line.split("=", 1)[1])
                    except (IndexError, ValueError):
                        pass
            elif c == "S" and line.startswith("SET_PRINT_STATS_INFO CURRENT_LAYER"):
                tracking = True
    return {"total": len(zs) or (total_hint or 0), "z": zs, "tracking": tracking}


def _config_path(name):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+\.(cfg|conf)", name or ""):
        return None
    return os.path.join(CONFIG_DIR, name)


def _save_config_block(text):
    m = re.search(r"^#\*# <-+ SAVE_CONFIG -+>.*$", text, flags=re.S | re.M)
    return m.group(0).rstrip("\n") + "\n" if m else ""


def _list_configs():
    out = []
    for n in sorted(os.listdir(CONFIG_DIR)):
        p = os.path.join(CONFIG_DIR, n)
        if os.path.isfile(p) and re.fullmatch(r"[A-Za-z0-9_.-]+\.(cfg|conf)", n) and not re.fullmatch(r"printer-\d{8}_\d{6}\.cfg", n):
            item = {"name": n, "size": os.path.getsize(p), "mtime": os.path.getmtime(p)}
            if n == "macros.cfg":
                with open(p, encoding="utf-8") as f:
                    item["macros"] = len(re.findall(r"^\[gcode_macro ", f.read(), flags=re.M))
            out.append(item)
    archive = os.path.join(CONFIG_DIR, "archive")
    if os.path.isdir(archive):
        out.append({"name": "archive", "folder": True, "count": len(os.listdir(archive))})
    return out


def _history(name):
    versions = []
    hist = os.path.join(HISTORY_DIR, name)
    if os.path.isdir(hist):
        for f in os.listdir(hist):
            m = re.fullmatch(r"(\d{8}-\d{6})\.cfg", f)
            if m:
                ts = datetime.datetime.strptime(m.group(1), "%Y%m%d-%H%M%S").timestamp()
                versions.append({"id": "kui-" + m.group(1), "time": ts, "source": "Before an edit here", "path": os.path.join(hist, f)})
    if name == "printer.cfg":
        for d in (CONFIG_DIR, os.path.join(CONFIG_DIR, "archive")):
            if not os.path.isdir(d):
                continue
            for f in os.listdir(d):
                m = re.fullmatch(r"printer-(\d{8}_\d{6})\.cfg", f)
                if m:
                    ts = datetime.datetime.strptime(m.group(1), "%Y%m%d_%H%M%S").timestamp()
                    versions.append({"id": "kl-" + m.group(1), "time": ts, "source": "Before SAVE_CONFIG", "path": os.path.join(d, f)})
    versions.sort(key=lambda v: -v["time"])
    return versions


__plugin_name__ = "Kobra UI"
__plugin_version__ = "2.7.4.3"
__plugin_description__ = "Full-screen console for the Kobra 2 Neo on OctoPrint + Klipper"
__plugin_pythoncompat__ = ">=3.9,<4"
__plugin_implementation__ = KobraUiPlugin()
__plugin_hooks__ = {
    "octoprint.comm.protocol.gcode.sent": __plugin_implementation__.on_gcode_sent,
    "octoprint.comm.protocol.gcode.received": __plugin_implementation__.on_gcode_received,
}
