/*
 * Kobra UI - full-screen console for OctoPrint + Klipper (see docs/…-kobra-ui-design.md).
 *
 * Data: OctoPrint's fromCurrentData (job, temps, progress), this plugin's Klipper
 * watcher (layer, pause state, mesh, offsets, config), OctoPrint's files API,
 * and the plugin's console capture. One view model drives every screen.
 */
$(function () {
    var PLUGIN = "kobra_ui";
    var TOOL_MAX = 280, BED_MAX = 120;
    var MESH_POS = [42, 94, 158], MESH_NEG = [42, 94, 158];

    function store(key, value) {
        try {
            if (value === undefined) return window.localStorage.getItem("kobra_ui." + key);
            window.localStorage.setItem("kobra_ui." + key, value);
        } catch (e) {
            return null;
        }
    }
    function esc(s) {
        return String(s === undefined || s === null ? "" : s).replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }
    function num(s) { return '<span class="num">' + esc(s) + "</span>"; }
    function bnum(s) { return '<b class="num">' + esc(s) + "</b>"; }
    function pad2(n) { return ("0" + n).slice(-2); }
    function merge(dst, src) {
        Object.keys(src).forEach(function (k) {
            var v = src[k];
            if (v && typeof v === "object" && !Array.isArray(v) && dst[k] && typeof dst[k] === "object" && !Array.isArray(dst[k])) merge(dst[k], v);
            else dst[k] = v;
        });
    }
    function shortName(n) {
        if (!n) return "";
        n = n.replace(/\.(gcode|gco|g|bgcode)$/i, "");
        n = n.replace(/_\d+(\.\d+)?mm_[A-Za-z0-9+-]+_.*$/, "");
        return n.replace(/^Part Studio \d+ - /, "");
    }
    function layerHeight(n) { var m = /_(\d+(?:\.\d+)?)mm_/.exec(n || ""); return m ? m[1] : null; }
    function material(n) { var m = /_\d+(?:\.\d+)?mm_([A-Za-z0-9+-]+)_/.exec(n || ""); return m ? m[1] : null; }

    function KobraUiViewModel(parameters) {
        var self = this;
        self.settings = parameters[0];
        self.loginState = parameters[1];
        self.connectionVM = parameters[2];
        self.prettyVM = parameters[3];
        self.gcodeVM = parameters[4];
        self.klipperVM = parameters[5];

        /* ====================== OctoPrint state ====================== */
        self.flags = ko.observable({});
        self.toolActual = ko.observable(0); self.toolTarget = ko.observable(0);
        self.bedActual = ko.observable(0); self.bedTarget = ko.observable(0);
        self.progress = ko.observable(0);
        self.printTime = ko.observable(null);
        self.timeLeft = ko.observable(null);
        self.fileName = ko.observable("");
        self.filePath = ko.observable("");
        self.fileOrigin = ko.observable("local");
        self.now = ko.observable(Date.now());
        var lastTick = 0;
        setInterval(function () {
            var t = Date.now(), busy = self.isPrinting && (self.isPrinting() || self.isPaused());
            if (busy || t - lastTick >= 15000) { lastTick = t; self.now(t); }
        }, 1000);

        self.isConnected = ko.pureComputed(function () { var f = self.flags(); return !!(f.operational || f.printing || f.paused); });
        self.isPrinting = ko.pureComputed(function () { var f = self.flags(); return !!(f.printing || f.resuming || f.finishing); });
        self.isPaused = ko.pureComputed(function () { var f = self.flags(); return !!(f.paused || f.pausing); });
        self.userName = ko.pureComputed(function () { return (self.loginState && self.loginState.username && self.loginState.username()) || "—"; });

        /* ====================== Klipper state ======================= */
        self.kstat = ko.observable({});
        self.kconnected = ko.observable(false);
        self.kinfo = ko.observable({});
        self.readySince = ko.observable(null);
        self.kcommands = [];
        self.hostLoad = ko.observable(null);
        function k(obj, key, dflt) { var o = self.kstat()[obj]; return o && o[key] !== undefined && o[key] !== null ? o[key] : dflt; }
        self.klipperState = ko.pureComputed(function () { return self.kconnected() ? k("webhooks", "state", "startup") : "offline"; });
        self.klipperReady = ko.pureComputed(function () { return self.klipperState() === "ready"; });
        self.klipperState.subscribe(function (st) {
            if (st === "shutdown" || st === "error") self.notify("Klipper " + st, k("webhooks", "state_message", "The printer stopped."), "kui-klipper");
        });
        self.isOperational = ko.pureComputed(function () { return self.isConnected() && self.klipperReady(); });
        self.kLayerCurrent = ko.pureComputed(function () { return (k("print_stats", "info", {}) || {}).current_layer || 0; });
        self.kLayerTotal = ko.pureComputed(function () { return (k("print_stats", "info", {}) || {}).total_layer || 0; });
        // layers read from the loaded G-code file (works before printing and for files without tracking)
        self.fileLayers = ko.observable({ path: "", total: 0, z: [], tracking: false });
        self.layerTracking = ko.pureComputed(function () { return !!self.fileLayers().tracking; });
        self.layerFromZ = ko.pureComputed(function () {
            var z = self.fileLayers().z, p = k("gcode_move", "gcode_position", [0, 0, 0]), h = (p && p[2]) || 0;
            if (!z.length || h <= 0) return 0;
            var lo = 0, hi = z.length - 1;               // last layer whose height is <= the nozzle height
            if (h < z[0] - 0.001) return 0;
            while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (z[mid] <= h + 0.001) lo = mid; else hi = mid - 1; }
            return lo + 1;
        });
        self.layerTotal = ko.pureComputed(function () {
            var live = self.flags().printing || self.flags().paused || self.flags().pausing || self.flags().resuming;
            if (live && self.layerTracking() && self.kLayerTotal() > 0) return self.kLayerTotal();
            return self.fileLayers().total || 0;
        });
        self.layerCurrent = ko.pureComputed(function () {
            var live = self.flags().printing || self.flags().paused || self.flags().pausing || self.flags().resuming;
            if (!live) return 0;
            if (self.layerTracking() && self.kLayerTotal() > 0) return self.kLayerCurrent();
            return self.layerFromZ();
        });
        self.layerEstimated = ko.pureComputed(function () { return self.layerCurrent() > 0 && !(self.layerTracking() && self.kLayerTotal() > 0); });
        self.layerStarted = ko.observable(null);
        self.lastLayerSecs = ko.observable(null);
        self.layerCurrent.subscribe(function (n) {
            var t = Date.now();
            if (self.layerStarted() && n > 1) self.lastLayerSecs((t - self.layerStarted()) / 1000);
            self.layerStarted(n > 0 ? t : null);
            if (!n) self.lastLayerSecs(null);
        });
        self.layerTime = ko.pureComputed(function () {
            var st = self.layerStarted();
            return st ? (self.now() - st) / 1000 : null;
        });
        self.kPaused = ko.pureComputed(function () { return !!k("pause_resume", "is_paused", false); });
        self.pauseReason = ko.pureComputed(function () { return k("gcode_macro PAUSE", "reason", "none"); });
        self.pauseTemp = ko.pureComputed(function () { return k("gcode_macro PAUSE", "extruder_temp", 0) || self.toolTarget(); });
        self.zOffset = ko.pureComputed(function () { var o = k("gcode_move", "homing_origin", [0, 0, 0]); return (o && o[2]) || 0; });
        self.zNow = ko.pureComputed(function () { var p = k("gcode_move", "gcode_position", [0, 0, 0]); return ((p && p[2]) || 0).toFixed(2); });
        self.homedZ = ko.pureComputed(function () { return (k("toolhead", "homed_axes", "") || "").indexOf("z") >= 0; });
        self.fanSpeed = ko.pureComputed(function () { return k("fan", "speed", 0) || 0; });

        self.canJog = ko.pureComputed(function () { return self.isOperational() && !self.isPrinting(); });
        self.canFilament = self.canJog;
        self.canHeat = self.canJog;
        self.canMachine = ko.pureComputed(function () { return self.isOperational() && !self.isPrinting() && !self.isPaused(); });
        self.canStartAny = self.canMachine;
        self.canStart = ko.pureComputed(function () { return self.canMachine() && !!self.filePath(); });

        self.stateLabel = ko.pureComputed(function () {
            if (!self.isConnected()) return "Printer offline";
            var s = self.klipperState();
            return s === "ready" ? "Klipper ready" : "Klipper " + s;
        });
        self.stateClass = ko.pureComputed(function () {
            if (!self.isConnected()) return "bad";
            var s = self.klipperState();
            return s === "ready" ? "" : (s === "error" || s === "shutdown" ? "bad" : "warn");
        });

        /* ====================== formatting ========================== */
        self.shortName = shortName;
        self.pct = function (v, max) { return Math.max(0, Math.min(100, (v / max) * 100)).toFixed(1) + "%"; };
        self.fmtDur = function (s) {
            if (s === null || s === undefined || isNaN(s)) return "—";
            var m = Math.round(s / 60);
            return Math.floor(m / 60) + ":" + pad2(m % 60);
        };
        self.fmtDurS = function (s) {
            if (s === null || s === undefined || isNaN(s)) return "—";
            s = Math.max(0, Math.round(s));
            return Math.floor(s / 3600) + ":" + pad2(Math.floor(s % 3600 / 60)) + ":" + pad2(s % 60);
        };
        self.fmtSigned = function (v, d) { v = Number(v) || 0; return (v >= 0 ? "+" : "−") + Math.abs(v).toFixed(d); };
        self.fmtSize = function (b) {
            if (!b && b !== 0) return "—";
            if (b >= 1e9) return num((b / 1e9).toFixed(1)) + "&nbsp;GB";
            if (b >= 1e8) return num(Math.round(b / 1e6)) + "&nbsp;MB";
            if (b >= 1e6) return num((b / 1e6).toFixed(1)) + "&nbsp;MB";
            return num((b / 1e3).toFixed(1)) + "&nbsp;KB";
        };
        var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
        self.fmtDay = function (ts) { var d = new Date(ts * 1000); return d.getDate() + " " + MONTHS[d.getMonth()]; };
        self.fmtClock = function (ts) { var d = new Date(ts * 1000); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
        self.fmtDateTime = function (ts) { return ts ? self.fmtDay(ts) + " " + self.fmtClock(ts) : "—"; };
        self.fmtWhen = function (ts) {
            var d = new Date(ts * 1000), today = new Date(self.now());
            if (d.toDateString() === today.toDateString()) return "Today " + num(self.fmtClock(ts));
            return num(self.fmtDay(ts));
        };
        self.finishClock = ko.pureComputed(function () {
            var s = self.timeLeft();
            if (s === null || s === undefined) return "—";
            return self.fmtClock(self.now() / 1000 + s);
        });

        /* ====================== commands ============================ */
        self.gcode = function (cmd) { OctoPrint.control.sendGcode(cmd); };
        self.pausePrint = function () { OctoPrint.job.pause(); };
        self.resumePrint = function () {
            if (self.flags().paused) OctoPrint.job.resume(); else self.gcode("RESUME");
            self.popupDismissed(true);
        };
        self.cancelPrint = function () {
            self.confirm("Cancel the print?", "The print stops, the heaters turn off and the head moves away. This can't be undone.", "Cancel print", true, function () { OctoPrint.job.cancel(); });
        };
        self.startPrint = function () { if (self.filePath()) OctoPrint.job.start(); };
        self.emergencyStop = function () {
            // straight to Klipper over its socket, and M112 over serial as a fallback
            OctoPrint.simpleApiCommand(PLUGIN, "estop", {}).fail(function () { self.gcode("M112"); });
            self.gcode("M112");
            self.toast("Emergency stop sent. Use Firmware restart to recover.", "bad");
        };
        self.firmwareRestart = function () {
            self.confirm("Firmware restart?", "Restarts Klipper and the printer board. A running print is lost.", "Restart", true, function () { self.gcode("FIRMWARE_RESTART"); });
        };
        self.hostRestart = function () {
            self.confirm("Restart Klipper?", "Reloads printer.cfg and macros.cfg. A running print is lost.", "Restart", true, function () { self.gcode("RESTART"); });
        };
        self.confirmGcode = function (title, text, button, cmd) { self.confirm(title, text, button, false, function () { self.gcode(cmd); }); };
        self.meshCalibrate = function () {
            self.confirm("Probe a new bed mesh?", "Heats the bed to 60 °C, homes, probes 7×7 points and saves the mesh. Klipper restarts at the end.", "Probe", false, function () { self.gcode("MESH_CALIBRATE"); });
        };
        self.jogSteps = [0.1, 1, 10, 100];
        self.jogStep = ko.observable(parseFloat(store("jogStep")) || 10);
        self.jogStep.subscribe(function (v) { store("jogStep", v); });
        self.jog = function (axis, dir) { var d = {}; d[axis] = dir * self.jogStep(); OctoPrint.printer.jog(d); };
        self.home = function (axes) { OctoPrint.printer.home(axes); };
        self.adjustZ = function (delta) { self.gcode("SET_GCODE_OFFSET Z_ADJUST=" + delta + (self.homedZ() ? " MOVE=1" : "")); };
        self.resetZ = function () { self.gcode("SET_GCODE_OFFSET Z=0" + (self.homedZ() ? " MOVE=1" : "")); };
        self.klipperDialog = function (fn) { if (self.klipperVM && self.klipperVM[fn]) self.klipperVM[fn](); };
        self.hasKlipperVM = ko.pureComputed(function () { return !!self.klipperVM; });

        /* pause at layer */
        self.pauseLayerInput = ko.observable("");
        self.pauseMacro = ko.observable(store("pauseMacro") || "PAUSE");
        self.pauseMacro.subscribe(function (v) { store("pauseMacro", v); });
        self.setPauseAtLayer = function () {
            var n = parseInt(self.pauseLayerInput(), 10);
            if (!(n > 0)) { self.toast("Type a layer number first.", "bad"); return; }
            self.gcode("SET_PAUSE_AT_LAYER LAYER=" + n + " MACRO=" + self.pauseMacro());
        };
        self.pauseLayerKey = function (d, e) { if (e.key === "Enter") { self.setPauseAtLayer(); return false; } return true; };
        self.setPauseNextLayer = function () { self.gcode("SET_PAUSE_NEXT_LAYER MACRO=" + self.pauseMacro()); };
        self.clearPauseLayer = function () { self.gcode("SET_PAUSE_AT_LAYER ENABLE=0"); self.gcode("SET_PAUSE_NEXT_LAYER ENABLE=0"); };
        self.pauseAtLayerClick = function (layer) {
            if (!self.layerTracking()) { self.toast("This file was sliced without layer tracking. Re-slice it in Orca to pause at a layer.", "bad"); return; }
            if (!self.isOperational() || layer <= self.layerCurrent()) return;
            self.pauseLayerInput(String(layer));
            self.gcode("SET_PAUSE_AT_LAYER LAYER=" + layer + " MACRO=" + self.pauseMacro());
        };
        self.armed = ko.pureComputed(function () {
            var at = k("gcode_macro SET_PRINT_STATS_INFO", "pause_at_layer", {}) || {};
            var next = k("gcode_macro SET_PRINT_STATS_INFO", "pause_next_layer", {}) || {};
            if (next.enable) return { kind: next.call === "M600" ? "Filament change" : "Pause", layer: self.layerCurrent() + 1, next: true };
            if (at.enable) return { kind: at.call === "M600" ? "Filament change" : "Pause", layer: at.layer, next: false };
            return null;
        });
        self.armedText = ko.pureComputed(function () {
            var a = self.armed();
            if (!a) return "";
            if (a.next) return esc(a.kind) + " at the next layer";
            var eta = "";
            var cur = self.layerCurrent(), tot = self.layerTotal(), pt = self.printTime();
            if (self.isPrinting() && cur > 1 && a.layer > cur && pt) eta = ", in about " + num(self.fmtDur(pt / cur * (a.layer - cur)));
            return esc(a.kind) + " at layer " + bnum(a.layer) + eta;
        });
        self.armedTrackText = ko.pureComputed(function () {
            var a = self.armed();
            if (!a) return "";
            return (a.kind === "Pause" ? "Pauses" : "Filament change") + " at layer " + bnum(a.layer);
        });
        // pauses that already happened in this print, for the colour-coded track
        self.pauseHistory = ko.observableArray([]);
        self.kPaused.subscribe(function (p) {
            if (p && self.layerCurrent() > 0) self.pauseHistory.push({ layer: self.layerCurrent(), kind: self.pauseReason() === "m600" ? "m600" : "pause" });
        });
        self.layerTotal.subscribe(function () { self.pauseHistory([]); });
        self.layerInfo = function (i) {
            var cur = self.layerCurrent(), a = self.armed(), past = self.pauseHistory().filter(function (h) { return h.layer === i; })[0];
            var bits = [];
            if (i === cur) bits.push("printing now");
            else if (i < cur) bits.push("printed");
            if (a && a.layer === i) bits.push((a.kind === "Pause" ? "pause" : "filament change") + " armed");
            if (past) bits.push(past.kind === "m600" ? "filament changed here" : "paused here");
            if (!self.layerTracking()) { if (i === 1) bits.push("re-slice to pause at a layer"); }
            else if (i > cur && !(a && a.layer === i) && self.isOperational()) bits.push("click to " + (self.pauseMacro() === "M600" ? "change filament" : "pause") + " here");
            var zl = self.fileLayers().z[i - 1];
            if (zl !== undefined) bits.unshift("Z " + zl.toFixed(2) + " mm");
            return bits;
        };
        self.layerCells = ko.pureComputed(function () {
            var tot = self.layerTotal(), cur = self.layerCurrent(), a = self.armed(), out = [];
            var past = {}; self.pauseHistory().forEach(function (h) { past[h.layer] = h.kind; });
            for (var i = 1; i <= tot; i++) {
                var cls = i < cur ? "done" : (i === cur ? "now" : "");
                if (a && a.layer === i && i >= cur) cls = a.kind === "Pause" ? "pause" : "m600";
                if (past[i]) cls += " was-" + past[i];
                out.push({ layer: i, cls: cls, title: "Layer " + i + ", " + self.layerInfo(i).join(", ") });
            }
            return out;
        });
        // Dock-style magnifier on the real bars, transforms only (no layout work per frame):
        // every bar's scale follows a Gaussian of its distance to the exact pointer position, and the bars are laid
        // out analytically so the bar under the pointer stays under it (left side spreads left, right side right)
        var trackFrame = null, trackX = 0, trackHover = false, trackRect = null, barLefts = null, barW = 0, lastHot = -1, settleTimer = null;
        function measureTrack(el) {
            trackRect = el.getBoundingClientRect();
            barLefts = Array.prototype.map.call(el.children, function (b) { return b.getBoundingClientRect().left - trackRect.left; });
            barW = el.children.length ? el.children[0].getBoundingClientRect().width : 0;
        }
        function magnify() {
            trackFrame = null;
            var el = document.getElementById("kui-layers"), tip = document.getElementById("kui-laytip");
            if (!el || !el.children.length) return;
            var bars = el.children, n = bars.length;
            if (!trackRect || !barLefts || barLefts.length !== n) measureTrack(el);
            el.classList.remove("settling");
            var x = Math.max(0, Math.min(trackRect.width - 0.01, trackX - trackRect.left));
            var lo = 0, hi = n - 1;                                   // bar under the pointer (unmagnified layout)
            while (lo < hi) { var mid = (lo + hi + 1) >> 1; if (barLefts[mid] <= x) lo = mid; else hi = mid - 1; }
            var hot = lo, pitch = n > 1 ? barLefts[1] - barLefts[0] : trackRect.width;
            var sigma = Math.max(2.2, Math.min(6, n / 34)) * pitch, AMP = Math.min(5, Math.max(2.5, 12 / Math.max(pitch, 0.5)));
            // magnified pitch of every bar, cumulative position, and the shift that pins the hovered point
            var sc = new Array(n), left = new Array(n), acc = 0;
            for (var i = 0; i < n; i++) {
                var c = barLefts[i] + pitch / 2, d = (c - x) / sigma, g = Math.exp(-d * d / 2);
                sc[i] = 1 + AMP * g; left[i] = acc; acc += pitch * sc[i];
            }
            // pin the pointer onto the bar itself (a pointer in the 1 px gap counts as the bar's right edge)
            var bw = barW || pitch, frac = Math.max(0, Math.min(1, (x - barLefts[hot]) / bw));
            var shift = x - (left[hot] + frac * bw * sc[hot]);
            for (var j = 0; j < n; j++) {
                var dx = left[j] + shift - barLefts[j], sy = 1 + 0.6 * (sc[j] - 1) / AMP;
                bars[j].style.transform = "translateX(" + dx.toFixed(2) + "px) scale(" + sc[j].toFixed(3) + "," + sy.toFixed(3) + ")";
            }
            if (hot !== lastHot) {
                if (lastHot >= 0 && bars[lastHot]) bars[lastHot].classList.remove("hot");
                bars[hot].classList.add("hot");
                var info = self.layerInfo(hot + 1);
                tip.innerHTML = "Layer " + num(hot + 1) + (info.length ? " · " + esc(info.join(" · ")) : "");
                lastHot = hot;
            }
            tip.style.transform = "translateX(" + x.toFixed(1) + "px) translateX(-50%)";
            tip.classList.add("show");
        }
        self.layerCells.subscribe(function () { lastHot = -1; barLefts = null; if (trackHover && !trackFrame) trackFrame = requestAnimationFrame(magnify); });
        $(window).on("resize", function () { trackRect = null; barLefts = null; });
        document.addEventListener("scroll", function () { trackRect = null; }, true);
        self.trackMove = function (d, e) {
            if (!trackHover) { trackHover = true; trackRect = null; clearTimeout(settleTimer); }
            trackX = (e.originalEvent || e).clientX;
            if (!trackFrame) trackFrame = requestAnimationFrame(magnify);
            return true;
        };
        // a click arms the layer shown in the label and lens (bars are under 2 px wide; the browser's pixel-snapped
        // hit test can land on the neighbour at a boundary)
        self.trackClick = function (layer) { self.pauseAtLayerClick(trackHover && lastHot >= 0 ? lastHot + 1 : layer); };
        self.trackLeave = function () {
            trackHover = false;
            var el = document.getElementById("kui-layers"), tip = document.getElementById("kui-laytip");
            if (trackFrame) { cancelAnimationFrame(trackFrame); trackFrame = null; }
            if (tip) tip.classList.remove("show");
            if (!el) return true;
            if (lastHot >= 0 && el.children[lastHot]) el.children[lastHot].classList.remove("hot");
            lastHot = -1;
            el.classList.add("settling");                              // ease the bars back
            Array.prototype.forEach.call(el.children, function (b) { b.style.transform = ""; });
            clearTimeout(settleTimer); settleTimer = setTimeout(function () { el.classList.remove("settling"); }, 260);
            return true;
        };
        self.layerTicks = ko.pureComputed(function () {
            var t = self.layerTotal();
            if (!t) return [];
            if (t < 8) return [1, t];
            return [1, Math.round(t / 4), Math.round(t / 2), Math.round(3 * t / 4), t];
        });

        /* ====================== objects (exclude_object) ============= */
        self.objects = ko.pureComputed(function () {
            var eo = self.kstat().exclude_object || {}, skipped = eo.excluded_objects || [], cur = eo.current_object;
            return (eo.objects || []).map(function (o) {
                var poly = (o.polygon || []).map(function (p) { return p[0].toFixed(1) + "," + (220 - p[1]).toFixed(1); }).join(" ");
                return { name: o.name, label: shortName(o.name.replace(/_id_\d+_copy_\d+$/, "").replace(/\.stl$/i, "").replace(/_/g, " ")),
                         skipped: skipped.indexOf(o.name) >= 0, current: o.name === cur, points: poly };
            });
        });
        self.objectsActive = ko.pureComputed(function () { return self.objects().filter(function (o) { return !o.skipped; }).length; });
        self.skipObject = function (o) {
            self.openMenu(null);
            if (!(self.isPrinting() || self.isPaused())) return;
            if (self.objectsActive() <= 1 && !o.skipped) {
                self.inform("This is the only object left", "Skipping it would leave nothing to print. To stop this print, use Cancel print instead.");
                return;
            }
            self.confirm("Skip " + o.label + "?", "Klipper stops printing this object for the rest of the job. The other objects carry on. This can't be undone.", "Skip object", true, function () {
                self.gcode("EXCLUDE_OBJECT NAME=" + o.name);
            });
        };

        /* ====================== printer view text =================== */
        self.printerFinding = ko.pureComputed(function () {
            if (!self.isConnected()) return "Not connected to the printer. Check that Klipper is running.";
            if (!self.klipperReady()) return "Klipper is " + esc(self.klipperState()) + ". " + esc(k("webhooks", "state_message", ""));
            var name = "<b>" + esc(shortName(self.fileName())) + "</b>";
            var layer = self.layerTotal() > 0 ? ", layer " + bnum(self.layerCurrent()) + " of " + num(self.layerTotal()) : "";
            if (self.isPaused()) return "Paused " + name + layer + ".";
            if (self.isPrinting()) return "Printing " + name + layer + ", done at " + bnum(self.finishClock());
            return "Idle. Nozzle " + bnum(Math.round(self.toolActual())) + "&nbsp;°C, bed " + bnum(Math.round(self.bedActual())) + "&nbsp;°C.";
        });
        self.jobFile = ko.pureComputed(function () {
            var p = self.filePath();
            return p ? self.allFiles().filter(function (f) { return f.path === p; })[0] : null;
        });
        self.jobThumb = ko.pureComputed(function () { var f = self.jobFile(); return f ? f.thumb : null; });
        self.jobSubline = ko.pureComputed(function () {
            var f = self.jobFile(), n = self.fileName(), parts = [];
            var lh = layerHeight(n), mat = material(n);
            if (lh) parts.push(num(lh) + "&nbsp;mm");
            if (mat) parts.push(esc(mat));
            if (f && f.dims) parts.push(num(f.dims) + "&nbsp;mm");
            if (!parts.length && f && f.printTime) parts.push(num(self.fmtDur(f.printTime)) + " estimated");
            return parts.join(" · ");
        });
        self.jobAside = ko.pureComputed(function () {
            if ((self.isPrinting() || self.isPaused()) && self.printTime() !== null) return "Started " + num(self.fmtClock(self.now() / 1000 - self.printTime()));
            var f = self.jobFile();
            return f && f.printTime ? "Takes about " + num(self.fmtDur(f.printTime)) : "";
        });
        self.zOffsetText = ko.pureComputed(function () { return self.fmtSigned(self.zOffset(), 3); });

        /* ====================== dialogs ============================= */
        self.confirmVisible = ko.observable(false);
        self.confirmTitle = ko.observable(""); self.confirmText = ko.observable(""); self.confirmButton = ko.observable("OK");
        self.confirmDanger = ko.observable(false);
        var confirmAction = null;
        self.confirm = function (title, text, button, danger, action) {
            self.confirmTitle(title); self.confirmText(text); self.confirmButton(button); self.confirmDanger(!!danger);
            confirmAction = action; self.confirmVisible(true);
        };
        self.confirmYes = function () { self.confirmVisible(false); var a = confirmAction; confirmAction = null; if (a) a(); };
        self.confirmNo = function () { self.confirmVisible(false); confirmAction = null; };
        // a message with one OK button (no action to confirm)
        self.confirmInfo = ko.observable(false);
        self.inform = function (title, text) { self.confirm(title, text, "", false, null); self.confirmInfo(true); };
        self.confirmVisible.subscribe(function (v) { if (!v) self.confirmInfo(false); });

        self.promptVisible = ko.observable(false);
        self.promptTitle = ko.observable(""); self.promptLabel = ko.observable(""); self.promptButton = ko.observable("OK");
        self.promptIcon = ko.observable("fa-pen"); self.promptValue = ko.observable(""); self.promptOptions = ko.observableArray([]);
        var promptAction = null;
        self.prompt = function (o) {
            self.promptTitle(o.title); self.promptLabel(o.label); self.promptButton(o.button); self.promptIcon(o.icon || "fa-pen");
            self.promptOptions(o.options || []); self.promptValue(o.value || ""); promptAction = o.action; self.promptVisible(true);
            setTimeout(function () { $("#kui-prompt-in").trigger("focus").trigger("select"); }, 30);
        };
        self.promptYes = function () { var v = (self.promptValue() || "").trim(); self.promptVisible(false); if (promptAction) promptAction(v); promptAction = null; };
        self.promptNo = function () { self.promptVisible(false); promptAction = null; };

        self.offsetVisible = ko.observable(false);

        self.popupDismissed = ko.observable(false);
        self.kPaused.subscribe(function (p) { if (p) self.popupDismissed(false); });
        self.popupIsM600 = ko.pureComputed(function () { return self.pauseReason() === "m600"; });
        self.popupVisible = ko.pureComputed(function () {
            return self.kPaused() && !self.popupDismissed() && (self.pauseReason() === "m600" || self.pauseReason() === "layer");
        });
        self.popupTitle = ko.pureComputed(function () {
            return (self.popupIsM600() ? "Filament change" : "Paused") + (self.layerTotal() > 0 ? " at layer " + self.layerCurrent() : "");
        });
        self.dismissPopup = function () { self.popupDismissed(true); };

        // desktop notifications (need HTTPS or localhost, and permission)
        self.notifyPref = ko.observable(store("notify") !== "0");
        self.notifyPerm = ko.observable(window.Notification ? Notification.permission : "unsupported");
        self.notifyOn = ko.pureComputed(function () { return self.notifyPref() && self.notifyPerm() === "granted"; });
        self.notifyLabel = ko.pureComputed(function () {
            if (!window.Notification) return "Desktop notifications: not supported here";
            if (!window.isSecureContext) return "Desktop notifications: need the https:// address";
            if (self.notifyPerm() === "denied") return "Desktop notifications: blocked in the browser";
            return self.notifyOn() ? "Desktop notifications: on" : "Turn on desktop notifications";
        });
        self.toggleNotify = function () {
            if (!window.Notification || !window.isSecureContext) { self.toast("Desktop notifications need the https:// address of OctoPrint (your Tailscale name).", "bad"); return; }
            if (self.notifyOn()) { self.notifyPref(false); store("notify", "0"); return; }
            self.notifyPref(true); store("notify", "1");
            Notification.requestPermission().then(function (p) { self.notifyPerm(p); if (p === "granted") self.notify("Notifications are on", "You'll hear about pauses, filament changes and finished prints.", "kui-test"); });
        };
        self.notify = function (title, body, tag) {
            if (!self.notifyOn()) return;
            try { var n = new Notification(title, { body: body, tag: tag || "kobra-ui", icon: BASEURL + "static/img/tentacle-32x32.png" }); n.onclick = function () { window.focus(); n.close(); }; } catch (e) { /* ignore */ }
        };
        // ask once, on the first click anywhere, so the browser shows its permission prompt
        $(document).one("click", function () {
            if (window.Notification && window.isSecureContext && Notification.permission === "default" && store("notify") !== "0")
                Notification.requestPermission().then(function (p) { self.notifyPerm(p); });
        });
        self.popupVisible.subscribe(function (v) {
            if (v) self.notify(self.popupTitle(), self.popupIsM600() ? "Unload, insert the new filament, load, then Resume." : "The print is paused and waiting for Resume.", "kui-pause");
        });
        self.onEventPrintDone = function (p) {
            self.loadFiles();
            self.notify("Print finished", shortName(p && (p.name || p.path)) + " is done" + (p && p.time ? " after " + self.fmtDur(p.time) : "") + ".", "kui-done");
        };
        self.onEventPrintFailed = function (p) {
            self.loadFiles();
            self.notify("Print stopped", shortName(p && (p.name || p.path)) + (p && p.reason === "cancelled" ? " was cancelled." : " failed."), "kui-done");
        };

        self.toastText = ko.observable(""); self.toastKind = ko.observable("");
        var toastTimer = null;
        self.toast = function (text, kind) {
            self.toastText(text); self.toastKind(kind || "");
            clearTimeout(toastTimer); toastTimer = setTimeout(function () { self.toastText(""); }, 5000);
        };

        self.openMenu = ko.observable(null);
        self.toggleMenu = function (name) { self.openMenu(self.openMenu() === name ? null : name); };
        $(document).on("click", function (e) {
            if (!$(e.target).closest(".pop, .tile .menu, .kebab").length) self.openMenu(null);
        });

        self.systemCommands = ko.observableArray([]);
        self.loadSystemCommands = function () {
            OctoPrint.system.getCommands().done(function (r) {
                var icons = { restart: "fa-rotate", reboot: "fa-power-off", shutdown: "fa-plug-circle-xmark" };
                self.systemCommands((r.core || []).map(function (c) { return { name: c.name, action: c.action, source: "core", icon: icons[c.action] || "fa-gear", confirm: c.confirm }; }));
            });
        };
        self.runSystemCommand = function (c) {
            self.openMenu(null);
            self.confirm(c.name + "?", c.confirm || "Runs “" + c.name + "” on the Cubie.", c.name, c.action !== "restart", function () {
                OctoPrint.system.executeCommand(c.source, c.action);
            });
        };
        self.openSettings = function () {
            self.openMenu(null);
            if (self.settings && self.settings.show) self.settings.show(); else $("#navbar_show_settings").trigger("click");
        };
        self.logout = function () { self.openMenu(null); if (self.loginState && self.loginState.logout) self.loginState.logout(); };
        self.classicUi = function () {
            self.openMenu(null);
            store("classic", "1");
            $("html").removeClass("kui-on");
            $("#kui-back").show();
        };

        /* ====================== routing ============================= */
        self.route = ko.observable("printer");
        // OctoPrint owns location.hash for its tabs, so the app routes on ?kui=<view>[&cfg=<file>]
        var ROUTES = ["printer", "files", "mesh", "klipper", "editor"];
        function readUrl() {
            var q = new URLSearchParams(window.location.search);
            var r = q.get("kui");
            return { route: ROUTES.indexOf(r) >= 0 ? r : "printer", cfg: q.get("cfg") || "printer.cfg" };
        }
        function urlFor(route, cfg) { return "?kui=" + route + (route === "editor" ? "&cfg=" + encodeURIComponent(cfg) : ""); }
        self.go = function (route, cfg, replace) {
            var cur = { route: self.route(), cfg: self.edName() };
            if (route === cur.route && (route !== "editor" || cfg === cur.cfg)) return;
            if (cur.route === "editor" && !self.leaveEditorOk(function () { self.go(route, cfg, replace); })) return;
            if (route === "editor") self.loadEditor(cfg);
            history[replace ? "replaceState" : "pushState"]({ kui: route, cfg: cfg }, "", urlFor(route, cfg));
            self.route(route);
        };
        self.nav = function (d, e) {
            var href = e.currentTarget.getAttribute("href") || "";
            var q = new URLSearchParams(href.replace(/^.*\?/, ""));
            self.go(q.get("kui") || "printer", q.get("cfg") || "printer.cfg");
            return false;
        };
        $(window).on("popstate", function () {
            var u = readUrl();
            if (self.route() === "editor" && self.edDirty() && !(u.route === "editor" && u.cfg === self.edName())) {
                history.pushState(null, "", urlFor("editor", self.edName()));
                self.leaveEditorOk(function () { self.go(u.route, u.cfg); });
                return;
            }
            if (u.route === "editor" && u.cfg !== self.edName()) self.loadEditor(u.cfg);
            self.route(u.route);
        });
        function applyUrl() {
            var u = readUrl();
            if (u.route === "editor") self.loadEditor(u.cfg);
            self.route(u.route);
        }
        self.route.subscribe(function (r) {
            self.syncViewer();
            if (r === "printer") setTimeout(self.pack, 30);
            setTimeout(self.measureBars, 30);
            self.showTop(false);
            if (r === "mesh") setTimeout(function () { self.drawMesh3d(true); }, 50);
            if (r === "klipper" || r === "editor") self.refreshExtras();
            document.title = { printer: "Kobra 2 Neo", files: "Files", mesh: "Bed mesh", klipper: "Klipper", editor: self.edName() }[r] + " · OctoPrint";
        });

        /* ====================== files =============================== */
        self.allEntries = ko.observableArray([]);
        self.storageFree = ko.observable(null); self.storageTotal = ko.observable(null);
        self.allFiles = ko.pureComputed(function () { return self.allEntries().filter(function (e) { return e.type !== "folder"; }); });
        self.fileCount = ko.pureComputed(function () { return self.allFiles().length; });
        self.folders = ko.pureComputed(function () {
            return self.allEntries().filter(function (e) { return e.type === "folder"; }).map(function (f) {
                return { path: f.path, count: self.allFiles().filter(function (x) { return x.path.indexOf(f.path + "/") === 0; }).length };
            });
        });
        function toEntry(f) {
            if (f.type === "folder") return { type: "folder", name: f.name, path: f.path, size: f.size || 0, count: (f.children || []).length };
            var a = f.gcodeAnalysis || {}, last = (f.prints || {}).last || null;
            var est = a.estimatedPrintTime || null, pt = last && last.printTime ? last.printTime : est;
            var dims = a.dimensions ? Math.round(a.dimensions.width) + "×" + Math.round(a.dimensions.depth) + "×" + Math.round(a.dimensions.height) : null;
            var fil = a.filament && a.filament.tool0 ? a.filament.tool0.length : null;
            var e = {
                type: "file", name: f.display || f.name, path: f.path, origin: f.origin || "local", size: f.size || 0, date: f.date || 0,
                thumb: f.thumbnail ? BASEURL + f.thumbnail.replace(/^\//, "") : null,
                printTime: pt, estimated: est, filament: fil, dims: dims, layer: layerHeight(f.display || f.name),
                last: last, download: f.refs && f.refs.download
            };
            e.short = shortName(e.name);
            var when = last ? self.fmtDay(last.date) : null;
            e.metaLine = num(pt ? self.fmtDur(pt) : "—") + (last ? " · " + (last.success ? "printed " : "failed ") + esc(when) : " · not printed yet");
            e.lastLine = last ? num(self.fmtDay(last.date)) + " · " + (last.success ? "finished" : "failed or cancelled") : "Not printed yet";
            return e;
        }
        self.loadFiles = function () {
            return OctoPrint.files.list(true).done(function (r) {
                var out = [];
                (function walk(items) {
                    (items || []).forEach(function (f) {
                        if (f.origin && f.origin !== "local") return;
                        out.push(toEntry(f));
                        if (f.type === "folder") walk(f.children);
                    });
                })(r.files);
                self.allEntries(out);
                self.storageFree(r.free); self.storageTotal(r.total);
                setTimeout(self.pack, 50);
            });
        };
        self.onEventUpdatedFiles = function () { self.loadFiles(); };
        self.onEventFileAdded = function () { self.loadFiles(); };
        self.onEventFileRemoved = function () { self.loadFiles(); };

        self.recentFiles = ko.pureComputed(function () {
            return self.allFiles().slice().sort(function (a, b) { return b.date - a.date; }).slice(0, 4);
        });
        var FORTNIGHT = 14 * 24 * 3600;
        self.recentCount = ko.pureComputed(function () { var t = self.now() / 1000; return self.allFiles().filter(function (f) { return f.last && t - f.last.date < FORTNIGHT; }).length; });
        self.failedCount = ko.pureComputed(function () { return self.allFiles().filter(function (f) { return f.last && !f.last.success; }).length; });
        self.filesFinding = ko.pureComputed(function () {
            var used = self.allFiles().reduce(function (s, f) { return s + f.size; }, 0);
            return bnum(self.fileCount()) + " files · " + self.fmtSize(used) + (self.storageFree() !== null ? " · " + self.fmtSize(self.storageFree()) + " free" : "");
        });
        self.storagePct = ko.pureComputed(function () {
            var t = self.storageTotal(), f = self.storageFree();
            return t ? ((t - f) / t * 100).toFixed(1) + "%" : "0%";
        });
        self.storageLine = ko.pureComputed(function () {
            var t = self.storageTotal(), f = self.storageFree();
            if (!t) return "";
            var g = self.allFiles().reduce(function (s, x) { return s + x.size; }, 0);
            return self.fmtSize(t - f) + " used of " + self.fmtSize(t) + " · G-code " + self.fmtSize(g);
        });

        self.fileQuery = ko.observable("");
        self.fileSort = ko.observable(store("fileSort") || "date");
        self.fileSort.subscribe(function (v) { store("fileSort", v); });
        self.fileList = ko.observable("all");
        self.folder = ko.observable("");
        self.openList = function (list, folder) { self.fileList(list); self.folder(folder || ""); self.selectedPath(null); };
        self.tiles = ko.pureComputed(function () {
            var q = self.fileQuery().trim().toLowerCase(), list = self.fileList(), folder = self.folder();
            var t = self.now() / 1000, items;
            if (q) items = self.allFiles().filter(function (f) { return f.name.toLowerCase().indexOf(q) >= 0; });
            else if (list === "recent") items = self.allFiles().filter(function (f) { return f.last && t - f.last.date < FORTNIGHT; });
            else if (list === "failed") items = self.allFiles().filter(function (f) { return f.last && !f.last.success; });
            else items = self.allEntries().filter(function (e) {
                var parent = e.path.indexOf("/") >= 0 ? e.path.slice(0, e.path.lastIndexOf("/")) : "";
                return parent === folder;
            });
            var sort = self.fileSort();
            var cmp = sort === "name" ? function (a, b) { return a.short.localeCompare(b.short); }
                : sort === "time" ? function (a, b) { return (b.printTime || 0) - (a.printTime || 0); }
                : function (a, b) { return b.date - a.date; };
            var folders = items.filter(function (e) { return e.type === "folder"; }), files = items.filter(function (e) { return e.type !== "folder"; });
            return folders.sort(function (a, b) { return a.name.localeCompare(b.name); }).concat(files.sort(cmp));
        });
        self.selectedPath = ko.observable(null);
        self.selectedFile = ko.pureComputed(function () {
            var p = self.selectedPath(), t = self.tiles().filter(function (x) { return x.type !== "folder"; });
            return (p && self.allFiles().filter(function (f) { return f.path === p; })[0]) || t[0] || null;
        });
        self.selectMode = ko.observable(false);
        self.pickedPaths = ko.observableArray([]);
        self.picked = ko.pureComputed(function () { var s = self.pickedPaths(); return self.allFiles().filter(function (f) { return s.indexOf(f.path) >= 0; }); });
        self.pickedSize = ko.pureComputed(function () { return self.picked().reduce(function (s, f) { return s + f.size; }, 0); });
        self.isPicked = function (f) { return self.pickedPaths.indexOf(f.path) >= 0; };
        self.toggleSelectMode = function () { self.selectMode(!self.selectMode()); self.pickedPaths([]); };
        self.tileClick = function (e) {
            if (e.type === "folder") { self.openList("all", e.path); return; }
            if (self.selectMode()) {
                if (self.isPicked(e)) self.pickedPaths.remove(e.path); else self.pickedPaths.push(e.path);
            } else self.selectedPath(e.path);
        };
        self.printFile = function (f) {
            self.openMenu(null);
            if (!self.canStartAny()) { self.toast("The printer is busy. Wait for the current print to finish.", "bad"); return; }
            self.confirm("Print " + f.short + "?", "Selects the file and starts the print right away" + (f.printTime ? " (about " + self.fmtDur(f.printTime) + ")" : "") + ". Make sure the bed is clear.", "Start print", false, function () {
                OctoPrint.files.select(f.origin, f.path, true).fail(function (x) { self.toast("Couldn't start the print: " + (x.responseJSON && x.responseJSON.error || x.statusText), "bad"); });
            });
        };
        self.previewFile = function (f) {
            self.openMenu(null);
            if (!f || f.type === "folder") return;
            if (!self.canStartAny()) { self.toast("A print is running. Files can be previewed once it has finished.", "bad"); return; }
            OctoPrint.files.select(f.origin, f.path, false).done(function () {
                self.go("printer");
                if (self.viewMode() === "webcam") self.setViewMode("3d"); else self.syncViewer();
                self.toast("Loaded " + f.short + ". Check the preview, then Start print.", "good");
                setTimeout(function () { var m = document.getElementById("kui-main"); if (m) m.scrollTo({ top: 0 }); }, 50);
            }).fail(function (x) { self.toast("Couldn't load the file: " + (x.responseJSON && x.responseJSON.error || x.statusText), "bad"); });
        };
        function folderOf(p) { return p.indexOf("/") >= 0 ? p.slice(0, p.lastIndexOf("/")) : ""; }
        self.renameFile = function (f) {
            self.openMenu(null);
            self.prompt({ title: "Rename file", label: "New name", button: "Rename", icon: "fa-pen", value: f.name, action: function (name) {
                if (!name || name === f.name) return;
                if (!/\.(gcode|gco|g|bgcode)$/i.test(name)) name += ".gcode";
                var dest = (folderOf(f.path) ? folderOf(f.path) + "/" : "") + name;
                OctoPrint.files.move(f.origin, f.path, dest).done(function () { self.toast("Renamed to " + name + ".", "good"); self.selectedPath(dest); self.loadFiles(); })
                    .fail(function (x) { self.toast("Couldn't rename: " + (x.responseJSON && x.responseJSON.error || x.statusText), "bad"); });
            } });
        };
        self.moveFiles = function (files) {
            self.openMenu(null);
            if (!files.length) return;
            var opts = [{ label: "Top level", value: "" }].concat(self.folders().map(function (d) { return { label: d.path, value: d.path }; }));
            self.prompt({ title: files.length === 1 ? "Move " + files[0].short : "Move " + files.length + " files", label: "Folder", button: "Move", icon: "fa-folder-open", options: opts, value: "", action: function (dest) {
                var jobs = files.filter(function (f) { return folderOf(f.path) !== dest; }).map(function (f) { return OctoPrint.files.move(f.origin, f.path, dest ? dest : "/"); });
                $.when.apply($, jobs).done(function () { self.toast("Moved " + jobs.length + (jobs.length === 1 ? " file." : " files."), "good"); self.pickedPaths([]); self.loadFiles(); })
                    .fail(function () { self.toast("Some files couldn't be moved.", "bad"); self.loadFiles(); });
            } });
        };
        self.downloadFiles = function (files) {
            self.openMenu(null);
            files.forEach(function (f, i) {
                if (!f.download) return;
                setTimeout(function () { var a = document.createElement("a"); a.href = f.download; a.download = f.name; document.body.appendChild(a); a.click(); a.remove(); }, i * 400);
            });
        };
        self.deleteFiles = function (files) {
            self.openMenu(null);
            if (!files.length) return;
            var busy = files.filter(function (f) { return f.path === self.filePath() && (self.isPrinting() || self.isPaused()); });
            if (busy.length) { self.toast("The file being printed can't be deleted.", "bad"); return; }
            self.confirm(files.length === 1 ? "Delete " + files[0].short + "?" : "Delete " + files.length + " files?", "The G-code is removed from the Cubie. This can't be undone.", files.length === 1 ? "Delete file" : "Delete " + files.length + " files", true, function () {
                var jobs = files.map(function (f) { return OctoPrint.files["delete"](f.origin, f.path); });
                $.when.apply($, jobs).done(function () { self.toast("Deleted " + files.length + (files.length === 1 ? " file." : " files."), "good"); })
                    .fail(function () { self.toast("Some files couldn't be deleted.", "bad"); })
                    .always(function () { self.pickedPaths([]); self.selectedPath(null); self.loadFiles(); });
            });
        };
        self.newFolder = function () {
            self.prompt({ title: "New folder", label: "Folder name", button: "Create folder", icon: "fa-folder-plus", value: "", action: function (name) {
                if (!name) return;
                OctoPrint.files.createFolder("local", name, self.folder() || undefined).done(function () { self.toast("Folder " + name + " created.", "good"); self.loadFiles(); })
                    .fail(function (x) { self.toast("Couldn't create the folder: " + (x.responseJSON && x.responseJSON.error || x.statusText), "bad"); });
            } });
        };
        self.pickUpload = function () { $("#kui-upload").val("").trigger("click"); };
        self.uploadPicked = function (d, e) { self.uploadFiles(Array.prototype.slice.call(e.target.files || [])); };
        self.uploadFiles = function (files) {
            files = files.filter(function (f) { return /\.(gcode|gco|g|bgcode)$/i.test(f.name); });
            if (!files.length) { self.toast("Only G-code files (.gcode) can be uploaded.", "bad"); return; }
            var done = 0;
            self.toast("Uploading " + files.length + (files.length === 1 ? " file…" : " files…"));
            files.forEach(function (f) {
                OctoPrint.files.upload("local", f, self.folder() ? { path: self.folder() } : {})
                    .done(function () { done++; if (done === files.length) { self.toast("Uploaded " + done + (done === 1 ? " file." : " files."), "good"); self.loadFiles(); } })
                    .fail(function () { self.toast("Upload of " + f.name + " failed.", "bad"); });
            });
        };
        self.dropping = ko.observable(false);
        var dragCount = 0;
        $(document).on("dragenter", function (e) {
            if (!$("html").hasClass("kui-on") || self.route() !== "files") return;
            var dt = e.originalEvent.dataTransfer;
            if (dt && Array.prototype.indexOf.call(dt.types || [], "Files") >= 0) { dragCount++; self.dropping(true); }
        }).on("dragleave", function () { if (dragCount > 0 && --dragCount === 0) self.dropping(false); })
          .on("dragover", function (e) { if (self.dropping()) e.preventDefault(); })
          .on("drop", function (e) {
            if (!self.dropping()) return;
            e.preventDefault(); dragCount = 0; self.dropping(false);
            self.uploadFiles(Array.prototype.slice.call(e.originalEvent.dataTransfer.files || []));
        });
        // drag a tile onto a folder tile to move it
        self.dragStart = function (d, e) { e.originalEvent.dataTransfer.setData("text/x-kui-path", d.path); return true; };
        self.dragOverTile = function (d, e) { if (d.type === "folder") { e.originalEvent.preventDefault(); return false; } return true; };
        self.dropOnTile = function (d, e) {
            var p = e.originalEvent.dataTransfer.getData("text/x-kui-path");
            if (d.type !== "folder" || !p) return true;
            var f = self.allFiles().filter(function (x) { return x.path === p; })[0];
            if (f) OctoPrint.files.move(f.origin, f.path, d.path).done(function () { self.toast("Moved " + f.short + " to " + d.path + ".", "good"); self.loadFiles(); });
            return false;
        };

        /* ====================== mesh ================================ */
        self.meshMode = ko.observable(store("meshMode") || "map");
        self.setMeshMode = function (m) { self.meshMode(m); store("meshMode", m); if (m === "3d") setTimeout(function () { self.drawMesh3d(true); }, 30); };
        self.meshInfo = ko.pureComputed(function () {
            var bm = self.kstat().bed_mesh || {};
            var vars = (self.kstat().save_variables || {}).variables || {};
            var active = bm.probed_matrix && bm.probed_matrix.length > 1 && bm.probed_matrix[0].length > 1;
            if (active) return { z: bm.probed_matrix, min: bm.mesh_min, max: bm.mesh_max, name: bm.profile_name || "adaptive", active: true, temp: vars.mesh_bed_temp };
            var prof = (bm.profiles || {})["default"];
            if (prof && prof.points && prof.points.length > 1) {
                var mp = prof.mesh_params || {};
                return { z: prof.points, min: [mp.min_x, mp.min_y], max: [mp.max_x, mp.max_y], name: "default", active: false, temp: vars.mesh_bed_temp };
            }
            return { z: [], min: [0, 0], max: [0, 0], name: "", active: false };
        });
        self.meshRows = ko.pureComputed(function () { return self.meshInfo().z; });
        self.meshCols = ko.pureComputed(function () { var z = self.meshRows(); return z.length ? z[0].length : 0; });
        function meshFlat() { return [].concat.apply([], self.meshRows()); }
        self.meshMin = ko.pureComputed(function () { var v = meshFlat(); return v.length ? Math.min.apply(null, v) : 0; });
        self.meshMax = ko.pureComputed(function () { var v = meshFlat(); return v.length ? Math.max.apply(null, v) : 0; });
        function meshAt(which) {
            var z = self.meshRows(), info = self.meshInfo(), best = null;
            z.forEach(function (row, r) { row.forEach(function (v, c) { if (!best || (which === "max" ? v > best.v : v < best.v)) best = { v: v, r: r, c: c }; }); });
            if (!best) return null;
            var rows = z.length, cols = z[0].length;
            best.x = Math.round(info.min[0] + (info.max[0] - info.min[0]) * best.c / (cols - 1));
            best.y = Math.round(info.min[1] + (info.max[1] - info.min[1]) * best.r / (rows - 1));
            var fy = best.r / (rows - 1), fx = best.c / (cols - 1);
            best.where = (fy < 0.34 ? "front" : fy > 0.66 ? "back" : "middle") + " " + (fx < 0.34 ? "left" : fx > 0.66 ? "right" : "centre");
            best.where = best.where.replace("middle centre", "centre");
            return best;
        }
        self.meshFinding = ko.pureComputed(function () {
            var hi = meshAt("max"), lo = meshAt("min");
            if (!hi) return "No mesh saved yet.";
            var w = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
            return w(hi.where) + " is " + bnum(Math.abs(hi.v).toFixed(2)) + "&nbsp;mm " + (hi.v >= 0 ? "high" : "low") + ", " + lo.where + " " + bnum(Math.abs(lo.v).toFixed(2)) + "&nbsp;mm " + (lo.v >= 0 ? "high" : "low") + ". A " + bnum((hi.v - lo.v).toFixed(2)) + "&nbsp;mm spread.";
        });
        self.meshStat = function (which) {
            var info = self.meshInfo();
            if (!info.z.length) return "—";
            if (which === "spread") return esc((self.meshMax() - self.meshMin()).toFixed(2)) + "<small> mm</small>";
            if (which === "size") return esc(self.meshCols() + "×" + info.z.length) + (info.temp !== undefined ? "<small> at " + esc(Math.round(info.temp)) + " °C</small>" : "<small> " + esc(info.name) + "</small>");
            var p = meshAt(which);
            return esc(self.fmtSigned(p.v, 2)) + "<small> mm · X" + p.x + " Y" + p.y + "</small>";
        };
        function mix(a, b, t) { return "rgb(" + a.map(function (v, i) { return Math.round(v + (b[i] - v) * t); }).join(",") + ")"; }
        self.meshCells = ko.pureComputed(function () {
            var z = self.meshRows(), hi = self.meshMax(), lo = self.meshMin(), out = [], info = self.meshInfo();
            var mid = [31, 42, 54], up = [232, 121, 47], down = [42, 94, 158];
            for (var r = z.length - 1; r >= 0; r--) {
                z[r].forEach(function (v, c) {
                    var t = v >= 0 ? (hi > 0 ? v / hi : 0) : (lo < 0 ? v / lo : 0);
                    out.push({ t: self.fmtSigned(v, 2), bg: mix(mid, v >= 0 ? up : down, t), ink: Math.abs(t) > 0.6 ? "#111" : "#e8e8ea",
                               title: "X" + Math.round(info.min[0] + (info.max[0] - info.min[0]) * c / (z[r].length - 1)) + " Y" + Math.round(info.min[1] + (info.max[1] - info.min[1]) * r / (z.length - 1)) + ": " + v.toFixed(3) + " mm" });
                });
            }
            return out;
        });
        var lastMeshKey = null;
        self.drawMesh3d = function (force) {
            var el = document.getElementById("kui-mesh3d"), info = self.meshInfo();
            if (!el || self.meshMode() !== "3d" || typeof Plotly === "undefined" || !info.z.length) return;
            var key = JSON.stringify([info.z, info.min, info.max]);
            if (!force && key === lastMeshKey) return;
            lastMeshKey = key;
            var rows = info.z.length, cols = info.z[0].length, xs = [], ys = [], i;
            for (i = 0; i < cols; i++) xs.push(info.min[0] + (info.max[0] - info.min[0]) * i / (cols - 1));
            for (i = 0; i < rows; i++) ys.push(info.min[1] + (info.max[1] - info.min[1]) * i / (rows - 1));
            var lo = self.meshMin(), hi = self.meshMax(), zero = hi > lo ? (0 - lo) / (hi - lo) : 0.5;
            var axis = { gridcolor: "#2a2930", zerolinecolor: "#3a3a3e", color: "#8a8c92", backgroundcolor: "#0d0c10", showbackground: true };
            Plotly.react(el, [{ type: "surface", x: xs, y: ys, z: info.z, showscale: false,
                colorscale: [[0, "#2a5e9e"], [Math.max(0, Math.min(1, zero)), "#1f2a36"], [1, "#e8792f"]] }], {
                paper_bgcolor: "#131217", plot_bgcolor: "#131217", margin: { l: 0, r: 0, t: 0, b: 0 }, font: { color: "#8a8c92", family: "Public Sans" },
                scene: { xaxis: $.extend({ title: "X" }, axis), yaxis: $.extend({ title: "Y" }, axis), zaxis: $.extend({ title: "mm" }, axis),
                         aspectmode: "manual", aspectratio: { x: 1, y: 1, z: 0.35 }, camera: { eye: { x: -1.2, y: -1.5, z: 0.9 } } }
            }, { displaylogo: false, responsive: true, modeBarButtonsToRemove: ["toImage", "sendDataToCloud"] });
        };
        self.meshProfiles = ko.pureComputed(function () {
            var bm = self.kstat().bed_mesh || {}, out = [], info = self.meshInfo();
            Object.keys(bm.profiles || {}).forEach(function (name) {
                var p = bm.profiles[name], pts = p.points || [];
                var line = (pts.length ? pts[0].length + "×" + pts.length : "empty");
                if (name === "default" && info.temp !== undefined) line += " · " + Math.round(info.temp) + " °C";
                var loaded = bm.profile_name === name;
                out.push({ name: name, line: line, side: loaded ? '<span class="state">Loaded</span>' : '<span class="state" style="background:var(--raised);color:var(--muted)">Saved</span>' });
            });
            var start = (((self.kstat().configfile || {}).settings || {})["gcode_macro _printer_settings"] || {}).variable_start_mesh;
            out.push({ name: "adaptive", line: "Probed at each print start, print area only", side: '<span class="sub">' + (String(start || "").indexOf("adaptive") >= 0 ? "Used by START_PRINT" : "Off") + "</span>" });
            return out;
        });
        self.probeSettings = ko.pureComputed(function () {
            var s = ((self.kstat().configfile || {}).settings) || {}, bm = s.bed_mesh || {}, pr = s.probe || {};
            var out = [];
            if (bm.mesh_min) out.push(["Area", "X" + bm.mesh_min[0] + "–" + bm.mesh_max[0] + " · Y" + bm.mesh_min[1] + "–" + bm.mesh_max[1]]);
            if (bm.probe_count) out.push(["Points", bm.probe_count.join("×")]);
            if (pr.samples) out.push(["Samples per point", pr.samples + ", " + (pr.samples_result || "average") + "d"]);
            if (pr.x_offset !== undefined) out.push(["Probe offset", "X" + pr.x_offset + " Y" + pr.y_offset + " · Z" + Number(pr.z_offset).toFixed(3)]);
            return out;
        });

        /* ====================== klipper view ======================== */
        self.klipperStateWord = ko.pureComputed(function () { var s = self.klipperState(); return s.charAt(0).toUpperCase() + s.slice(1); });
        self.klipperFinding = ko.pureComputed(function () {
            if (!self.kconnected()) return "Can't reach Klipper on the Cubie. Check that the klipper service is running.";
            if (self.klipperReady()) return "Ready since " + bnum(self.readySince() ? self.fmtClock(self.readySince()) : "—") + ". Config loaded with no errors.";
            return esc(k("webhooks", "state_message", "Klipper is " + self.klipperState() + "."));
        });
        self.klipperVersionHtml = ko.pureComputed(function () {
            var v = self.kinfo().version || "";
            var m = /^(v[\d.]+)(-\d+)?/.exec(v);
            return m ? esc(m[1]) + (m[2] ? "<small>" + esc(m[2]) + "</small>" : "") : (esc(v) || "—");
        });
        self.boardHtml = ko.pureComputed(function () {
            var mcu = (self.kinfo().mcu || "").toUpperCase().replace(/XE$|XB$|XC$/, "");
            var t = k("temperature_sensor mcu_temp", "temperature", null);
            return (esc(mcu) || "—") + (t !== null ? "<small> · " + t.toFixed(1) + " °C</small>" : "");
        });
        self.hostHtml = ko.pureComputed(function () {
            var h = self.kinfo().hostname || "—", l = self.hostLoad();
            return esc(h) + (l !== null ? "<small> · load " + l.toFixed(2) + "</small>" : "");
        });

        /* ====================== console ============================= */
        self.consoleLines = ko.observableArray([]);
        function conEntry(e) {
            var d = new Date(e.t * 1000);
            var text = e.k === "send" ? "› " + e.x : (e.k === "err" ? "!! " + e.x : e.x);
            return { t: e.t, k: e.k, raw: e.x, ts: pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()), text: text, cls: e.k };
        }
        self.addConsole = function (entries) {
            var arr = self.consoleLines();
            entries.forEach(function (e) { arr.push(conEntry(e)); });
            if (arr.length > 400) arr.splice(0, arr.length - 400);
            self.consoleLines.valueHasMutated();
            if (self.dockOpen()) setTimeout(function () { var el = document.getElementById("kui-lines"); if (el) el.scrollTop = el.scrollHeight; }, 0);
        };
        self.consoleView = ko.pureComputed(function () { return self.consoleLines().slice(-200); });
        self.lastReply = ko.pureComputed(function () {
            var a = self.consoleLines();
            for (var i = a.length - 1; i >= 0; i--) if (a[i].k !== "send") return a[i];
            return { text: "—", cls: "" };
        });
        self.messagesCleared = ko.observable(0);
        self.messages = ko.pureComputed(function () {
            var since = self.messagesCleared();
            return self.consoleLines().filter(function (e) { return (e.k === "info" || e.k === "err") && e.t > since; }).slice(-60).reverse().map(function (e) {
                var ok = /ready|connected|finished|loaded/i.test(e.raw) && e.k !== "err";
                var warn = e.k === "err" || /too cold|error|failed|not homed/i.test(e.raw);
                return { ts: e.ts, text: e.raw, cls: warn ? "warn" : (ok ? "ok" : ""), icon: warn ? "fa-triangle-exclamation" : (ok ? "fa-circle-check" : "fa-circle-info") };
            });
        });
        self.clearMessages = function () { self.messagesCleared(Date.now() / 1000); };
        self.copyMessages = function () {
            var text = self.messages().slice().reverse().map(function (m) { return m.ts + "  " + m.text; }).join("\n");
            if (navigator.clipboard) navigator.clipboard.writeText(text).then(function () { self.toast("Messages copied.", "good"); });
        };
        self.dockOpen = ko.observable(store("dock") === "1");
        self.dockOpen.subscribe(function (v) {
            store("dock", v ? "1" : "0");
            if (v) setTimeout(function () { var el = document.getElementById("kui-lines"); if (el) el.scrollTop = el.scrollHeight; }, 0);
        });
        self.toggleDock = function () { self.dockOpen(!self.dockOpen()); };
        // drag the dock's top edge to resize the console; the height is remembered
        self.conH = ko.observable(Math.max(120, parseInt(store("conH"), 10) || 260));
        function applyConsoleVars() {
            var root = document.getElementById("kui");
            if (!root) return;
            root.style.setProperty("--conh", self.conH() + "px");
            root.style.setProperty("--conh-open", self.dockOpen() ? (self.conH() + "px") : "0px");
        }
        self.conH.subscribe(applyConsoleVars); self.dockOpen.subscribe(applyConsoleVars);
        self.gripDown = function (d, e) {
            var ev = e.originalEvent || e, grip = ev.currentTarget, startY = ev.clientY;
            var startH = self.dockOpen() ? self.conH() : 0;
            grip.setPointerCapture && grip.setPointerCapture(ev.pointerId);
            $(grip).addClass("dragging");
            function move(m) {
                var h = Math.round(Math.max(0, Math.min(window.innerHeight * 0.7, startH + (startY - m.clientY))));
                if (h < 80) { if (self.dockOpen()) self.dockOpen(false); return; }
                if (!self.dockOpen()) self.dockOpen(true);
                self.conH(Math.max(120, h));
            }
            function up() {
                grip.removeEventListener("pointermove", move); grip.removeEventListener("pointerup", up); grip.removeEventListener("pointercancel", up);
                $(grip).removeClass("dragging"); store("conH", self.conH());
            }
            grip.addEventListener("pointermove", move); grip.addEventListener("pointerup", up); grip.addEventListener("pointercancel", up);
            return false;
        };
        // "Back to top" appears once you reach the bottom of a long screen
        self.showTop = ko.observable(false);
        self.mainScroll = function (d, e) {
            var m = e.target;
            self.showTop(m.scrollTop > Math.min(600, m.clientHeight * 0.6));
            return true;
        };
        self.scrollTop = function () {
            var m = document.getElementById("kui-main");
            m.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
            self.showTop(false);
        };
        self.cmdText = ko.observable("");
        var cmdHistory = [], cmdIndex = -1;
        try { cmdHistory = JSON.parse(store("cmdHistory") || "[]"); } catch (e) { cmdHistory = []; }
        self.cmdCompletion = ko.pureComputed(function () {
            var t = self.cmdText();
            if (!t || /\s/.test(t)) return "";
            var up = t.toUpperCase();
            var hit = self.kcommandsObs().filter(function (c) { return c.indexOf(up) === 0 && c !== up; })[0];
            return hit || "";
        });
        self.kcommandsObs = ko.observableArray([]);
        self.cmdGhost = ko.pureComputed(function () { var c = self.cmdCompletion(), t = self.cmdText(); return c ? t + c.slice(t.length) : ""; });
        self.cmdKey = function (d, e) {
            if (e.key === "Tab") { var c = self.cmdCompletion(); if (c) self.cmdText(c + " "); return false; }
            if (e.key === "Enter") {
                var cmd = self.cmdText().trim();
                if (cmd) {
                    self.gcode(cmd);
                    cmdHistory = cmdHistory.filter(function (h) { return h !== cmd; }); cmdHistory.push(cmd);
                    cmdHistory = cmdHistory.slice(-50); store("cmdHistory", JSON.stringify(cmdHistory));
                }
                cmdIndex = -1; self.cmdText(""); return false;
            }
            if (e.key === "ArrowUp") { if (cmdHistory.length) { cmdIndex = cmdIndex < 0 ? cmdHistory.length - 1 : Math.max(0, cmdIndex - 1); self.cmdText(cmdHistory[cmdIndex]); } return false; }
            if (e.key === "ArrowDown") { if (cmdIndex >= 0) { cmdIndex++; if (cmdIndex >= cmdHistory.length) { cmdIndex = -1; self.cmdText(""); } else self.cmdText(cmdHistory[cmdIndex]); } return false; }
            if (e.key === "Escape") { $(e.target).trigger("blur"); self.dockOpen(false); return false; }
            if (e.key === "`" && !self.cmdText()) { self.dockOpen(false); $(e.target).trigger("blur"); return false; }
            return true;
        };
        self.keysVisible = ko.observable(false);
        self.shortcutGroups = [
            { title: "Anywhere", keys: [
                { k: ["`"], d: "Open or close the console" }, { k: ["?"], d: "Show these shortcuts" },
                { k: ["1"], d: "Printer" }, { k: ["2"], d: "Files" }, { k: ["3"], d: "Mesh" }, { k: ["4"], d: "Klipper" },
                { k: ["/"], d: "Search files" }, { k: ["Esc"], d: "Close a dialog, menu or the console" },
                { k: ["Ctrl", "Shift", "E"], d: "Emergency stop" } ] },
            { title: "Printing", keys: [
                { k: ["Shift", "P"], d: "Pause or resume" }, { k: ["Shift", "M"], d: "Change filament now (M600)" },
                { k: ["Shift", "N"], d: "Pause at the next layer" }, { k: ["Shift", "C"], d: "Cancel the print…" },
                { k: ["V"], d: "Switch Webcam / 3D / 2D" } ] },
            { title: "Machine", keys: [
                { k: ["Shift", "H"], d: "Home all axes" }, { k: ["Shift", "L"], d: "Load filament" },
                { k: ["Shift", "U"], d: "Unload filament" }, { k: ["Shift", "O"], d: "Z offset…" } ] },
            { title: "Console & editor", keys: [
                { k: ["Tab"], d: "Complete a command" }, { k: ["↑", "↓"], d: "Command history" },
                { k: ["Ctrl", "S"], d: "Save the config" }, { k: ["Ctrl", "Shift", "S"], d: "Save & restart Klipper" },
                { k: ["Ctrl", "F"], d: "Find in the config" } ] },
            { title: "Files", keys: [
                { k: ["Enter"], d: "Preview the selected file" }, { k: ["Ctrl", "A"], d: "Select all (in Select mode)" },
                { k: ["Delete"], d: "Delete the selected files…" } ] }
        ];
        function anyDialog() { return self.confirmVisible() || self.promptVisible() || self.diffVisible() || self.offsetVisible() || self.keysVisible() || self.popupVisible(); }
        $(document).on("keydown.kui", function (ev) {
            if (!$("html").hasClass("kui-on") || $(".modal.in:visible").length) return;
            var e = ev.originalEvent || ev, key = e.key, tag = (e.target.tagName || "").toLowerCase();
            var typing = tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable;
            if (key === "Escape") {
                if (self.keysVisible()) { self.keysVisible(false); return false; }
                return self.onKeyDown(null, e);
            }
            if ((e.ctrlKey || e.metaKey) && e.shiftKey && key.toLowerCase() === "e") { self.emergencyStop(); return false; }
            if (self.route() === "editor" && (e.ctrlKey || e.metaKey) && e.shiftKey && key.toLowerCase() === "s") { self.saveConfig(true); return false; }
            if (typing || e.ctrlKey && key.toLowerCase() !== "a" || e.metaKey || e.altKey) {
                if (key === "`" && e.target.id === "kui-cmd" && !self.cmdText()) { self.dockOpen(false); $(e.target).trigger("blur"); return false; }
                return true;
            }
            if (anyDialog() && key !== "?") return true;
            var k2 = key.length === 1 ? key.toLowerCase() : key;
            switch (e.shiftKey && key.length === 1 ? "S-" + k2 : k2) {
                case "`": self.dockOpen(!self.dockOpen()); if (self.dockOpen()) setTimeout(function () { $("#kui-cmd").trigger("focus"); }, 0); return false;
                case "?": case "S-?": self.keysVisible(!self.keysVisible()); return false;
                case "1": self.go("printer"); return false;
                case "2": self.go("files"); return false;
                case "3": self.go("mesh"); return false;
                case "4": self.go("klipper"); return false;
                case "/": self.go("files"); setTimeout(function () { $("#kui .search input").trigger("focus"); }, 30); return false;
                case "v": var modes = ["webcam", "3d", "2d"]; self.setViewMode(modes[(modes.indexOf(self.viewMode()) + 1) % 3]); return false;
                case "S-p": if (self.isPaused()) self.resumePrint(); else if (self.isPrinting()) self.pausePrint(); return false;
                case "S-m": if (self.isPrinting()) self.gcode("M600"); return false;
                case "S-n": if (self.isOperational()) self.setPauseNextLayer(); return false;
                case "S-c": if (self.isPrinting() || self.isPaused()) self.cancelPrint(); return false;
                case "S-h": if (self.canMachine()) self.gcode("G28"); return false;
                case "S-l": if (self.canFilament()) self.gcode("LOAD_FILAMENT"); return false;
                case "S-u": if (self.canFilament()) self.gcode("UNLOAD_FILAMENT"); return false;
                case "S-o": if (self.isOperational()) self.offsetVisible(true); return false;
                case "a": if (e.ctrlKey && self.route() === "files" && self.selectMode()) { self.pickedPaths(self.tiles().filter(function (t) { return t.type !== "folder"; }).map(function (t) { return t.path; })); return false; } return true;
                case "Enter": if (self.route() === "files" && self.selectedFile()) { self.previewFile(self.selectedFile()); return false; } return true;
                case "Delete": if (self.route() === "files") { var sel = self.selectMode() ? self.picked() : (self.selectedFile() ? [self.selectedFile()] : []); if (sel.length) self.deleteFiles(sel); return false; } return true;
            }
            return true;
        });
        self.onKeyDown = function (d, e) {
            var tag = (e.target.tagName || "").toLowerCase();
            if (e.key === "Escape") {
                if (self.confirmVisible()) { self.confirmNo(); return false; }
                if (self.promptVisible()) { self.promptNo(); return false; }
                if (self.diffVisible()) { self.diffVisible(false); return false; }
                if (self.offsetVisible()) { self.offsetVisible(false); return false; }
                if (self.openMenu()) { self.openMenu(null); return false; }
            }
            if (e.key === "Escape" && self.dockOpen()) { self.dockOpen(false); $("#kui-cmd").trigger("blur"); return false; }
            return true;
        };

        /* ====================== config files & editor ================ */
        self.configFiles = ko.observableArray([]);
        self.configLine = function (f) {
            var what = { "printer.cfg": "Hardware, probe, mesh", "macros.cfg": (f.macros || 0) + " macros", "variables.cfg": "Saved values, written by Klipper" }[f.name] || "Config";
            return what + " · edited " + (new Date(f.mtime * 1000).toDateString() === new Date(self.now()).toDateString() ? "today " + self.fmtClock(f.mtime) : self.fmtDay(f.mtime));
        };
        self.configShort = function (f) { return { "printer.cfg": "Hardware, probe, mesh", "macros.cfg": (f.macros || 0) + " macros", "variables.cfg": "Saved values, written by Klipper" }[f.name] || "Config"; };
        self.refreshExtras = function () {
            OctoPrint.simpleApiGet(PLUGIN).done(function (r) { self.configFiles(r.configs || []); self.hostLoad(r.load); });
        };
        setInterval(function () { if (self.route() === "klipper") self.refreshExtras(); }, 15000);

        self.edName = ko.observable("printer.cfg");
        self.edText = ko.observable("");
        self.edOrig = ko.observable("");
        self.edBusy = ko.observable(false);
        self.edLoaded = ko.observable(false);
        self.edHistory = ko.observableArray([]);
        self.edLine = ko.observable(1); self.edCol = ko.observable(1);
        self.edRestarting = ko.observable(false);
        self.edError = ko.observable("");
        self.edReadOnly = ko.pureComputed(function () { return self.edName() === "variables.cfg"; });
        self.edDirty = ko.pureComputed(function () { return self.edLoaded() && self.edText() !== self.edOrig(); });
        // which lines of the edited text are new or changed (LCS on lines)
        self.edChanged = ko.pureComputed(function () {
            var a = self.edOrig().split("\n"), b = self.edText().split("\n"), n = a.length, m = b.length, mark = new Array(m);
            if (!self.edDirty()) return mark;
            if (n * m > 4e6) { for (var q = 0; q < m; q++) mark[q] = a[q] !== b[q]; return mark; }
            var dp = [], i, j;
            for (i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
            for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            i = 0; j = 0;
            while (j < m) {
                if (i < n && a[i] === b[j]) { i++; j++; }
                else if (i < n && dp[i + 1][j] >= dp[i][j + 1]) i++;
                else { mark[j] = true; j++; }
            }
            return mark;
        });
        self.edChangedCount = ko.pureComputed(function () {
            var c = self.edChanged().filter(Boolean).length;
            if (!c && self.edDirty()) c = 1; // only deletions
            return c;
        });
        self.edGutter = ko.pureComputed(function () {
            var mark = self.edChanged();
            return self.edText().split("\n").map(function (l, i) { return { n: i + 1, chg: !!mark[i] }; });
        });
        self.edHighlight = ko.pureComputed(function () {
            var mark = self.edChanged();
            return self.edText().split("\n").map(function (l, i) {
                var h;
                if (l.indexOf("#*#") === 0) h = '<span class="ro">' + esc(l) + "</span>";
                else if (/^\s*[#;]/.test(l)) h = '<span class="cm">' + esc(l) + "</span>";
                else if (/^\[/.test(l)) h = '<span class="sec">' + esc(l) + "</span>";
                else {
                    var m = /^([A-Za-z0-9_]+)(\s*[:=])(.*)$/.exec(l);
                    if (m) {
                        var val = m[3], ci = val.search(/\s[#;]/);
                        h = '<span class="key">' + esc(m[1]) + "</span>" + esc(m[2]) + (ci >= 0 ? esc(val.slice(0, ci)) + '<span class="cm">' + esc(val.slice(ci)) + "</span>" : esc(val));
                    } else h = esc(l);
                }
                return '<span class="l' + (mark[i] ? " chg" : "") + '">' + (h || " ") + "</span>";
            }).join("");
        });
        self.edScroll = function (d, e) {
            var t = e.target;
            $("#kui-hl").scrollTop(t.scrollTop).scrollLeft(t.scrollLeft);
            $("#kui-gutter").scrollTop(t.scrollTop);
        };
        self.edCaret = function (d, e) {
            var t = e.target, pos = t.selectionStart, before = t.value.slice(0, pos);
            self.edLine(before.split("\n").length); self.edCol(pos - before.lastIndexOf("\n"));
            return true;
        };
        self.edKey = function (d, e) {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { self.saveConfig(false); return false; }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") { self.toggleFind(); return false; }
            if (e.key === "Tab") {
                var t = e.target, s = t.selectionStart;
                t.setRangeText("    ", s, t.selectionEnd, "end"); self.edText(t.value); return false;
            }
            return true;
        };
        self.edStatusHtml = ko.pureComputed(function () {
            if (self.edRestarting()) return '<i class="fa-solid fa-spinner fa-spin"></i> Restarting Klipper to check the config…';
            if (self.edError()) return '<span class="bad"><i class="fa-solid fa-circle-exclamation"></i> ' + esc(self.edError()) + "</span>";
            if (self.klipperReady()) return '<span class="good"><i class="fa-solid fa-circle-check"></i> Checked by Klipper, no errors</span>';
            return '<span class="bad"><i class="fa-solid fa-circle-exclamation"></i> Klipper is ' + esc(self.klipperState()) + "</span>";
        });
        self.editorFinding = ko.pureComputed(function () {
            var f = self.configFiles().filter(function (x) { return x.name === self.edName(); })[0];
            var bits = ["Klipper / Config files"];
            if (f) bits.push(self.fmtSize(f.size));
            if (self.edReadOnly()) bits.push("written by Klipper, read-only here");
            else if (self.edDirty()) bits.push(bnum(self.edChangedCount()) + " unsaved " + (self.edChangedCount() === 1 ? "change" : "changes"));
            else bits.push("no unsaved changes");
            return bits.join(" · ");
        });
        self.loadEditor = function (name) {
            self.edName(name); self.edLoaded(false); self.edError("");
            OctoPrint.get("plugin/" + PLUGIN + "/config/" + encodeURIComponent(name)).done(function (r) {
                self.edOrig(r.content); self.edText(r.content); self.edLoaded(true);
                setTimeout(function () { var t = document.getElementById("kui-ed"); if (t) { t.scrollTop = 0; self.edScroll(null, { target: t }); } }, 0);
            }).fail(function () { self.toast("Couldn't open " + name + ".", "bad"); });
            self.loadHistory(name);
        };
        self.openEditor = function (name) { self.go("editor", name); };
        self.loadHistory = function (name) {
            OctoPrint.get("plugin/" + PLUGIN + "/config/" + encodeURIComponent(name) + "/history").done(function (r) { self.edHistory(r.versions || []); });
        };
        var pendingLeave = null;
        self.leaveEditorOk = function (retry) {
            if (self.route() !== "editor" || !self.edDirty()) return true;
            self.confirm("Leave without saving?", "Your " + self.edChangedCount() + " unsaved changes to " + self.edName() + " will be lost.", "Discard changes", true, function () {
                self.edText(self.edOrig()); retry();
            });
            return false;
        };
        $(window).on("beforeunload", function () { if (self.edDirty()) return "You have unsaved config changes."; });
        self.discardEdits = function () {
            self.confirm("Discard your changes?", "The editor goes back to the version saved on the Cubie.", "Discard", true, function () { self.edText(self.edOrig()); });
        };
        self.saveConfig = function (restart) {
            if (self.edReadOnly() || self.edBusy()) return;
            if (restart && (self.isPrinting() || self.isPaused())) { self.toast("Klipper can't restart during a print. Use Save, then restart after the print.", "bad"); return; }
            self.edBusy(true); self.edError("");
            OctoPrint.postJson("plugin/" + PLUGIN + "/config/" + encodeURIComponent(self.edName()), { content: self.edText(), restart: !!restart })
                .done(function (r) {
                    self.edOrig(r.content); self.edText(r.content);
                    self.toast(r.saved ? "Saved " + self.edName() + (restart ? ". Restarting Klipper…" : ".") : "No changes to save" + (restart ? ". Restarting Klipper…" : "."), "good");
                    self.loadHistory(self.edName()); self.refreshExtras();
                    if (restart) { self.edRestarting(true); watchRestart(); }
                })
                .fail(function (x) { self.toast("Couldn't save: " + (x.status === 403 ? "you need admin rights" : x.statusText), "bad"); })
                .always(function () { self.edBusy(false); });
        };
        function watchRestart() {
            var started = Date.now(), sawDown = false;
            var sub = self.klipperState.subscribe(function (s) {
                if (s !== "ready") sawDown = true;
                if (sawDown && s === "ready") { finish(""); }
                if (s === "error") finish(k("webhooks", "state_message", "Klipper reported a config error."));
            });
            var timer = setInterval(function () { if (Date.now() - started > 45000) finish(self.klipperReady() ? "" : "Klipper didn't come back within 45 s."); }, 1000);
            function finish(err) { clearInterval(timer); sub.dispose(); self.edRestarting(false); self.edError(err); if (!err) self.toast("Klipper restarted with no errors.", "good"); }
        }
        self.findOpen = ko.observable(false);
        self.findText = ko.observable("");
        self.findInfo = ko.observable("");
        self.toggleFind = function () { self.findOpen(!self.findOpen()); if (self.findOpen()) setTimeout(function () { $("#kui-find").trigger("focus").trigger("select"); }, 0); };
        self.findNext = function () {
            var q = self.findText(); if (!q) return;
            var t = document.getElementById("kui-ed"), v = t.value.toLowerCase(), from = t.selectionEnd || 0, i = v.indexOf(q.toLowerCase(), from);
            if (i < 0) i = v.indexOf(q.toLowerCase());
            if (i < 0) { self.findInfo("Not found"); return; }
            var count = v.split(q.toLowerCase()).length - 1;
            t.focus(); t.setSelectionRange(i, i + q.length);
            var line = v.slice(0, i).split("\n").length;
            t.scrollTop = Math.max(0, (line - 6) * 21);
            self.edScroll(null, { target: t }); self.edLine(line);
            self.findInfo(count + (count === 1 ? " match" : " matches"));
        };
        self.findKey = function (d, e) { if (e.key === "Enter") { self.findNext(); return false; } if (e.key === "Escape") { self.toggleFind(); return false; } return true; };

        self.diffVisible = ko.observable(false);
        self.diffTitle = ko.observable("");
        self.diffLines = ko.observableArray([]);
        var diffContent = "";
        self.compareVersion = function (v) {
            OctoPrint.get("plugin/" + PLUGIN + "/config/" + encodeURIComponent(self.edName()) + "/history/" + encodeURIComponent(v.id)).done(function (r) {
                diffContent = r.content;
                self.diffTitle(self.edName() + ": " + v.source.toLowerCase() + ", " + self.fmtDateTime(v.time));
                self.diffLines(lineDiff(r.content.split("\n"), self.edText().split("\n")));
                self.diffVisible(true);
            });
        };
        self.restoreVersion = function () { self.edText(diffContent); self.diffVisible(false); self.toast("Older version is in the editor. Save to keep it.", ""); };
        function lineDiff(a, b) {
            var n = a.length, m = b.length, out = [], i, j;
            if (n * m > 4e6) return [{ t: "Files are too large to compare here.", c: "gap" }];
            var dp = []; for (i = 0; i <= n; i++) dp.push(new Uint16Array(m + 1));
            for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
            var rows = []; i = 0; j = 0;
            while (i < n || j < m) {
                if (i < n && j < m && a[i] === b[j]) { rows.push({ t: "  " + a[i], c: "" }); i++; j++; }
                else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) { rows.push({ t: "+ " + b[j], c: "add" }); j++; }
                else { rows.push({ t: "- " + a[i], c: "del" }); i++; }
            }
            // keep 3 lines of context around changes
            var keep = rows.map(function () { return false; });
            rows.forEach(function (r, x) { if (r.c) for (var y = Math.max(0, x - 3); y <= Math.min(rows.length - 1, x + 3); y++) keep[y] = true; });
            var gap = false;
            rows.forEach(function (r, x) { if (keep[x]) { out.push(r); gap = false; } else if (!gap) { out.push({ t: "  …", c: "gap" }); gap = true; } });
            return out.length && rows.some(function (r) { return r.c; }) ? out : [{ t: "No differences.", c: "gap" }];
        }

        /* ====================== live view ========================== */
        self.has3d = ko.observable(false);
        self.has2d = ko.observable(false);
        self.viewMode = ko.observable(store("viewMode") || "3d");
        self.webcamUrl = ko.pureComputed(function () {
            var s = self.settings.settings, cw = s.plugins && s.plugins.classicwebcam;
            return (cw && cw.stream && cw.stream()) || (s.webcam && s.webcam.streamUrl && s.webcam.streamUrl()) || "";
        });
        self.setViewMode = function (m) { self.viewMode(m); store("viewMode", m); self.syncViewer(); };
        self.syncViewer = function () {
            var live = $("html").hasClass("kui-on") && self.route() === "printer", mode = self.viewMode();
            var img = document.getElementById("kui-webcam");
            if (img) {
                var want = live && mode === "webcam" ? self.webcamUrl() : "";
                if (want && img.getAttribute("data-src") !== want) { img.src = want + (want.indexOf("?") >= 0 ? "&" : "?") + "_kui=" + Date.now(); img.setAttribute("data-src", want); }
                else if (!want && img.getAttribute("data-src")) { img.removeAttribute("src"); img.removeAttribute("data-src"); }
            }
            try {
                if (self.prettyVM && self.prettyVM.onTabChange) self.prettyVM.onTabChange(live && mode === "3d" ? "#tab_plugin_prettygcode" : "#kui", live && mode === "3d" ? "#kui" : "#tab_plugin_prettygcode");
                if (self.gcodeVM && self.gcodeVM.onTabChange) self.gcodeVM.onTabChange(live && mode === "2d" ? "#gcode" : "#kui", "#kui");
            } catch (e) { /* a viewer failing must not break the app */ }
            window.dispatchEvent(new Event("resize"));
            setTimeout(self.fit2d, 60);
        };
        // size the 2D canvas to the pane and let the renderer re-fit the bed (fills the card, no letterboxing)
        var last2d = "";
        self.fit2d = function () {
            var pane = document.getElementById("kui-v-2d"), canvas = document.getElementById("gcode_canvas"), cc = document.getElementById("canvas_container");
            if (!pane || !canvas || !cc || self.viewMode() !== "2d" || !pane.clientWidth) return;
            var W = Math.floor(pane.clientWidth - 20 - 26), H = Math.floor(pane.clientHeight - 20 - 26);
            if (W < 100 || H < 100) return;
            var key = W + "x" + H;
            var vs = cc.querySelector("#gcode_layer_slider, .slider-vertical"), hs = cc.querySelector("#gcode_command_slider, .slider-horizontal");
            if (vs) vs.style.height = H + "px";
            if (hs) hs.style.width = W + "px";
            cc.style.width = (W + 26) + "px";
            if (key === last2d) return;
            last2d = key;
            var pr = window.devicePixelRatio || 1;
            canvas.style.width = W + "px"; canvas.style.height = H + "px";
            canvas.width = Math.round(W * pr); canvas.height = Math.round(H * pr);
            try {
                var r = window.GCODE && GCODE.renderer;
                if (r && r.getOptions && r.setOption) r.setOption({ bed: $.extend({}, r.getOptions().bed) }); // new object: re-runs resetViewport + render
            } catch (e) { /* the viewer may not be initialised yet */ }
        };
        self.theme2d = function () {
            try {
                // colours are pre-inverted: the canvas is shown through invert(.94) hue-rotate(180deg)
                if (window.GCODE && GCODE.renderer && GCODE.renderer.setOption) GCODE.renderer.setOption({
                    colorLine: ["#5c2a0b", "#0d3a66", "#6b1020", "#0f5236", "#5c4300"]
                });
            } catch (e) { /* the viewer may not be ready yet */ }
        };

        /* ====================== masonry ============================ */
        self.pack = function () {
            var g = document.getElementById("kui-canvas");
            if (!g || self.route() !== "printer") return;
            var cols = getComputedStyle(g).gridTemplateColumns.split(" ").filter(Boolean).length, row = 4, gap = 24;
            // cards are align-self:start, so their height is their content height whatever their span:
            // measure in place and only touch spans that change (resetting them collapsed the page and
            // threw the scroll position back to the top while printing)
            var main = document.getElementById("kui-main"), keep = main ? main.scrollTop : 0;
            Array.prototype.forEach.call(g.children, function (c) {
                if ($(c).hasClass("wide")) {
                    var span = cols >= 6 ? "span 3" : (cols >= 2 ? "span 2" : "auto");
                    if (c.style.gridColumn !== span) c.style.gridColumn = span;
                }
                var want = "span " + Math.ceil((c.getBoundingClientRect().height + gap) / row);
                if (c.style.gridRowEnd !== want) c.style.gridRowEnd = want;
            });
            if (main && main.scrollTop !== keep) main.scrollTop = keep;
        };
        self.measureBars = function () {
            var root = document.getElementById("kui");
            if (!root) return;
            var top = $("#kui-main > section:visible > .top").outerHeight(), fb = $("#kui-filebar:visible").outerHeight();
            if (top) root.style.setProperty("--topbar", Math.round(top) + "px");
            if (fb) root.style.setProperty("--filebar", Math.round(fb) + "px");
        };
        var packTimer = null;
        function schedulePack() { clearTimeout(packTimer); packTimer = setTimeout(function () { self.pack(); self.measureBars(); self.fit2d(); }, 60); }
        $(window).on("resize", schedulePack);

        /* ====================== data in ============================ */
        self.fromCurrentData = function (data) {
            if (data.state) self.flags(data.state.flags || {});
            if (data.temps && data.temps.length) {
                var t = data.temps[data.temps.length - 1];
                if (t.tool0) { self.toolActual(t.tool0.actual || 0); self.toolTarget(t.tool0.target || 0); }
                if (t.bed) { self.bedActual(t.bed.actual || 0); self.bedTarget(t.bed.target || 0); }
            }
            if (data.progress) { self.progress(data.progress.completion || 0); self.printTime(data.progress.printTime); self.timeLeft(data.progress.printTimeLeft); }
            if (data.job && data.job.file) {
                var changed = self.filePath() !== (data.job.file.path || "");
                self.fileName(data.job.file.display || data.job.file.name || ""); self.filePath(data.job.file.path || ""); self.fileOrigin(data.job.file.origin || "local");
                if (changed) schedulePack();
            }
        };
        self.fromHistoryData = self.fromCurrentData;
        self.loadFileLayers = function (path) {
            if (!path) { self.fileLayers({ path: "", total: 0, z: [], tracking: false }); return; }
            if (self.fileLayers().path === path) return;
            OctoPrint.get("plugin/" + PLUGIN + "/layers?path=" + encodeURIComponent(path)).done(function (r) {
                if (self.filePath() === path) self.fileLayers({ path: path, total: r.total || 0, z: r.z || [], tracking: !!r.tracking });
            }).fail(function () { self.fileLayers({ path: path, total: 0, z: [], tracking: false }); });
        };
        self.filePath.subscribe(self.loadFileLayers);
        self.applyKlipper = function (p) {
            if (!p) return;
            if (p.connected !== undefined) self.kconnected(!!p.connected);
            if (p.ready_since !== undefined) self.readySince(p.ready_since);
            if (p.info) self.kinfo(p.info);
            if (p.commands) self.kcommandsObs(p.commands);
            if (p.status) self.kstat(p.status);
            if (p.delta) { var s = self.kstat(); merge(s, p.delta); self.kstat.valueHasMutated(); }
            if (self.route() === "mesh") self.drawMesh3d(false);
        };
        self.onDataUpdaterPluginMessage = function (plugin, data) {
            if (plugin !== PLUGIN) return;
            if (data.klipper) self.applyKlipper(data.klipper);
            if (data.console) self.addConsole(data.console);
        };
        self.layerTotal.subscribe(schedulePack);
        self.armed.subscribe(schedulePack);
        self.isPrinting.subscribe(schedulePack);
        self.isPaused.subscribe(schedulePack);

        /* ====================== start ============================== */
        self.onStartupComplete = function () {
            // the viewers live inside the Live view card from now on
            var pg = $("#pg-container"); if (pg.length) { pg.appendTo("#kui-v-3d"); self.has3d(true); }
            var cc = $("#canvas_container"); if (cc.length) { cc.appendTo("#kui-v-2d"); self.has2d(true); self.theme2d(); setTimeout(self.theme2d, 2000); }
            $("body").append('<button id="kui-back" type="button" style="display:none;position:fixed;right:16px;bottom:16px;z-index:2000;height:40px;padding:0 18px;border-radius:999px;border:0;background:#e8792f;color:#1a0d04;font:600 14px system-ui">Back to Kobra UI</button>');
            $("#kui-back").on("click", function () { store("classic", "0"); $("html").addClass("kui-on"); $(this).hide(); self.syncViewer(); schedulePack(); });
            if (store("classic") === "1") $("#kui-back").show(); else $("html").addClass("kui-on");
            OctoPrint.simpleApiGet(PLUGIN).done(function (r) {
                self.applyKlipper(r.klipper); self.addConsole(r.console || []); self.configFiles(r.configs || []); self.hostLoad(r.load);
            });
            self.loadFiles();
            self.loadSystemCommands();
            applyUrl();
            self.syncViewer();
            if (window.ResizeObserver) {
                var ro = new ResizeObserver(schedulePack);
                $("#kui-canvas > .card").each(function () { ro.observe(this); });
            }
            applyConsoleVars();
            setTimeout(function () { self.pack(); self.measureBars(); }, 300);
            if (document.fonts && document.fonts.ready) document.fonts.ready.then(self.pack);
        };
    }

    OCTOPRINT_VIEWMODELS.push({
        construct: KobraUiViewModel,
        dependencies: ["settingsViewModel", "loginStateViewModel", "connectionViewModel",
                       "prettyGCodeViewModel", "gcodeViewModel", "klipperViewModel"],
        optional: ["prettyGCodeViewModel", "gcodeViewModel", "klipperViewModel"],
        elements: ["#kui"]
    });
});
