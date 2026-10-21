/* Kobra UI: macro deck, quick macros, edit mode and Ctrl+K palette. Extends KobraUiViewModel via KobraDeck(self). */
window.KobraDeck = function (self, h) {
    "use strict";
    var PLUGIN = h.PLUGIN, VALUE_RE = /^[A-Za-z0-9_.+\-]{1,40}$/;
    var GROUP_ICON = { filament: "fa-arrow-down", maintenance: "fa-broom", motion: "fa-square-parking", other: "fa-terminal" };
    var MACRO_ICON = {
        LOAD_FILAMENT: "fa-arrow-down", UNLOAD_FILAMENT: "fa-arrow-up", PURGE_FILAMENT: "fa-droplet", M600: "fa-arrows-rotate",
        DRY_FILAMENT: "fa-sun", STOP_DRYING: "fa-circle-stop", CLEAN_NOZZLE: "fa-broom", MESH_CALIBRATE: "fa-table-cells",
        PID_HOTEND: "fa-wave-square", PID_BED: "fa-wave-square", PARK: "fa-square-parking", PREHEAT: "fa-fire-flame-curved",
        COOLDOWN: "fa-snowflake", PAUSE: "fa-pause", RESUME: "fa-play", CANCEL_PRINT: "fa-stop", Z_ENDSTOP_HIT: "fa-crosshairs"
    };

    /* ------------------------------ data ------------------------------ */
    self.macros = ko.observableArray([]);
    self.deck = ko.observable(null);
    self.deckLoaded = ko.observable(false);
    self.deckView = ko.observable(h.store("deckView") || "groups");
    self.deckView.subscribe(function (v) { h.store("deckView", v); });
    self.deckEdit = ko.observable(false);
    self.canEditDeck = ko.pureComputed(function () {
        var ls = self.loginState;
        try { return !!(ls && ls.hasPermission && window.PERMISSIONS && ls.hasPermission(PERMISSIONS.SETTINGS)) || !!(ls && ls.isAdmin && ls.isAdmin()); }
        catch (e) { return false; }
    });
    self.macroMap = ko.pureComputed(function () {
        var m = {}; self.macros().forEach(function (x) { m[x.name] = x; }); return m;
    });

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function presetOf(key) { var d = self.deck(); return key.indexOf("preset:") === 0 && d ? d.presets[key.slice(7)] || null : null; }

    // one tile per deck entry (a macro name or "preset:<id>")
    self.tileModel = function (key, groupId) {
        var d = self.deck() || { pinned: [], hidden: [], colors: {}, confirm: [] }, preset = presetOf(key);
        var name = preset ? preset.macro : key, m = self.macroMap()[name];
        var params = m ? m.params : [];
        var chips = params.map(function (p) {
            var v = preset && preset.params[p.name] !== undefined ? preset.params[p.name] : displayDefault(p);
            return { k: p.name, v: v };
        });
        return {
            key: key, macro: name, label: preset ? preset.name : name, preset: preset,
            short: preset ? preset.name : name.toLowerCase().replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }),
            desc: preset ? "Your preset of " + name : (m ? firstLine(m.description) : "Not in the Klipper config any more"),
            chips: chips, hints: m ? m.hints : [], missing: !m,
            icon: preset ? "fa-bookmark" : (MACRO_ICON[name] || GROUP_ICON[groupId] || "fa-terminal"),
            color: d.colors[key] || (preset ? "blue" : ""),
            pinned: d.pinned.indexOf(key) >= 0, hidden: d.hidden.indexOf(key) >= 0, confirm: d.confirm.indexOf(key) >= 0
        };
    };
    function firstLine(s) { s = (s || "").split(/\n/)[0]; return s.replace(/\s*[A-Z_]+ \[.*$/, "").replace(/\s*\[[A-Z_]+=.*$/, "").trim(); }
    function displayDefault(p) {
        if (p.default === null || p.default === undefined) return "auto";
        if (p.name === "TEMP" && Number(p.default) === 0) return "auto";   // the macros treat 0 as "pick for me"
        return String(p.default).replace(/\.0+$/, "");
    }

    // every visible macro is in some group: anything the deck doesn't place goes to "Other"
    function placedGroups() {
        var d = self.deck(); if (!d) return [];
        var seen = {}, groups = d.groups.map(function (g) { g.items.forEach(function (i) { seen[i] = 1; }); return { id: g.id, name: g.name, items: g.items.slice() }; });
        var other = groups.filter(function (g) { return g.id === "other"; })[0];
        if (!other) { other = { id: "other", name: "Other", items: [] }; groups.push(other); }
        var editing = self.deckEdit();
        self.macros().forEach(function (m) { if (!m.internal && !seen[m.name] && (!m.slicer || editing || d.hidden.indexOf(m.name) < 0)) other.items.push(m.name); });
        Object.keys(d.presets).forEach(function (id) { if (!seen["preset:" + id]) other.items.push("preset:" + id); });
        return groups;
    }
    self.deckSections = ko.pureComputed(function () {
        var d = self.deck(); if (!d) return [];
        var groups = placedGroups(), view = self.deckView();
        if (view === "groups") return groups.map(function (g) { return { id: g.id, name: g.name, tiles: g.items.map(function (k) { return self.tileModel(k, g.id); }) }; })
            .filter(function (s) { return s.tiles.length; });
        var all = []; groups.forEach(function (g) { g.items.forEach(function (k) { all.push(self.tileModel(k, g.id)); }); });
        if (view === "az") all.sort(function (a, b) { return a.label.localeCompare(b.label); });
        else all.sort(function (a, b) { return ((d.usage[b.key] || 0) - (d.usage[a.key] || 0)) || a.label.localeCompare(b.label); });
        return [{ id: "all", name: view === "az" ? "All macros" : "Most used first", tiles: all }];
    });
    self.deckCount = ko.pureComputed(function () {
        var n = 0; self.deckSections().forEach(function (s) { s.tiles.forEach(function (t) { if (!t.hidden) n++; }); }); return n;
    });
    self.quickItems = ko.pureComputed(function () {
        var d = self.deck(); return d ? d.pinned.map(function (k) { return self.tileModel(k, ""); }) : [];
    });
    self.macrosFinding = ko.pureComputed(function () {
        var d = self.deck(); if (!d) return "Reading macros from Klipper…";
        return h.num(self.deckCount()) + " macros from the Klipper config · " + h.num(d.pinned.length) + " pinned to the Printer screen";
    });

    self.loadDeck = function () {
        return OctoPrint.get("plugin/" + PLUGIN + "/macros").done(function (r) {
            self.macros(r.macros || []); self.deck(r.deck); self.deckLoaded(true);
            var sel = self.selMacro();
            if (!sel || !tileExists(sel)) { var first = self.deckSections()[0]; if (first && first.tiles[0]) self.selectTile(first.tiles[0]); }
            else self.selectTile(self.tileModel(sel, ""), true);
        });
    };
    function tileExists(key) { return self.deckSections().some(function (s) { return s.tiles.some(function (t) { return t.key === key; }); }); }

    // optimistic save; a 409 (another device saved first) re-applies the change on top of theirs once
    self.saveDeck = function (mutator, note) {
        var before = self.deck(), next = clone(before); mutator(next);
        self.deck(next);
        var dfd = $.Deferred();
        function post(base, body, retry) {
            OctoPrint.postJson("plugin/" + PLUGIN + "/deck", { base_version: base, deck: body }).done(function (saved) {
                self.deck(saved); dfd.resolve(saved);
            }).fail(function (x) {
                if (x.status === 409 && retry && x.responseJSON && x.responseJSON.current) {
                    var cur = x.responseJSON.current, again = clone(cur); mutator(again);
                    self.deck(again); post(cur.version, again, false);
                    self.toast("The deck changed on another device", "info", "Reloaded; your change is kept.");
                    return;
                }
                self.deck(before);
                self.toast("Couldn't save the deck", "bad", (x.responseJSON && (x.responseJSON.error)) || x.statusText || "No answer from OctoPrint.");
                dfd.reject(x);
            });
        }
        post(before.version, next, true);
        return dfd.promise();
    };

    /* ------------------------------ panel ------------------------------ */
    self.selMacro = ko.observable(null);
    self.selTile = ko.observable(null);
    self.selParams = ko.observableArray([]);
    self.selectTile = function (t, keepValues) {
        if (!t) return;
        var prev = {}; if (keepValues) self.selParams().forEach(function (f) { prev[f.name] = f.value(); });
        var m = self.macroMap()[t.macro];
        self.selMacro(t.key); self.selTile(t);
        self.selParams((m ? m.params : []).map(function (p) {
            var start = keepValues && prev[p.name] !== undefined ? prev[p.name] : (t.preset && t.preset.params[p.name] !== undefined ? t.preset.params[p.name] : "");
            var f = { name: p.name, kind: p.kind, choices: p.choices || [], value: ko.observable(start),
                      placeholder: displayDefault(p), hint: paramHint(p) };
            f.err = ko.pureComputed(function () { var v = String(f.value() || "").trim(); return v && !VALUE_RE.test(v) ? "Use a number or a single word (letters, digits, . _ + -)" : ""; });
            return f;
        }));
        return true;
    };
    function paramHint(p) {
        if (p.source) return "From " + p.source;
        if (p.name === "TEMP" && (p.default === null || Number(p.default) === 0)) return "Blank uses the paused print's temperature, or your filament default";
        if (p.default === null) return "Blank lets the macro decide";
        return "";
    }
    self.selValues = function () {
        var out = {}; self.selParams().forEach(function (f) { var v = String(f.value() || "").trim(); if (v) out[f.name] = v; }); return out;
    };
    self.selPreview = ko.pureComputed(function () {
        var t = self.selTile(); if (!t) return "";
        var parts = [t.macro]; self.selParams().forEach(function (f) { var v = String(f.value() || "").trim(); if (v) parts.push(f.name + "=" + v); });
        return parts.join(" ");
    });
    self.selInvalid = ko.pureComputed(function () { return self.selParams().some(function (f) { return !!f.err(); }); });
    self.selBlock = ko.pureComputed(function () { var t = self.selTile(); return t ? blockReason(t) : ""; });
    self.selRunEnabled = ko.pureComputed(function () { return !!self.selTile() && !self.selInvalid() && !self.selBlock(); });
    function blockReason(t) {
        if (t.missing) return t.macro + " isn't in the Klipper config any more.";
        if (!self.klipperReady()) return "Klipper is " + self.klipperState() + ". " + (h.k("webhooks", "state_message", "") || "");
        if (t.hints.indexOf("printing_only") >= 0 && !self.isPrinting() && !self.isPaused()) return "Only while printing.";
        if (t.hints.indexOf("paused_only") >= 0 && !self.isPaused()) return "Only while paused.";
        return "";
    }
    self.selSentence = ko.pureComputed(function () {
        var t = self.selTile(); if (!t || t.missing) return "";
        var out = [];
        if (t.hints.indexOf("homes") >= 0) out.push("Homes first if needed.");
        if (t.hints.indexOf("heats") >= 0) out.push("Heats up as needed.");
        if (t.hints.indexOf("restarts") >= 0) out.push("Klipper restarts at the end.");
        out.push(self.isPaused() ? "The print is paused." : (self.isPrinting() ? "A print is running." : "Printer is idle."));
        return out.filter(Boolean).join(" ");
    });

    function needsConfirm(t) {
        var busy = self.isPrinting() || self.isPaused();
        if (busy && t.hints.indexOf("restarts") >= 0) return t.macro + " restarts Klipper. The running print would be lost.";
        if (busy && t.hints.indexOf("homes") >= 0) return t.macro + " homes first if needed, which would ruin the running print.";
        if (t.confirm) return "Run " + t.label + " now?";
        return "";
    }
    // run a deck entry; the plugin builds and checks the command line
    self.runMacro = function (name, params, tile) {
        var id = self.newRunId(), shown = [name].concat(Object.keys(params || {}).map(function (k) { return k + "=" + params[k]; })).join(" ");
        var el = tile ? document.querySelector('#kui .tile[data-name="' + tile.key + '"]') : null;
        self.runFeedback(id, shown, function (good) { flash(el, good); });
        OctoPrint.simpleApiCommand(PLUGIN, "run_macro", { macro: name, params: params || {}, id: id, preset: tile && tile.preset ? tile.key.slice(7) : undefined })
            .fail(function (x) {
                self.runAbort(id, "Couldn't run " + name, (x.responseJSON && x.responseJSON.error) || x.statusText || "No answer from OctoPrint.");
            });
    };
    function flash(el, good) {
        if (!el) return;
        el.classList.remove("ran-ok", "ran-bad"); void el.offsetWidth;
        el.classList.add(good ? "ran-ok" : "ran-bad");
        setTimeout(function () { el.classList.remove("ran-ok", "ran-bad"); }, 400);
    }
    self.runTile = function (t, params) {
        var why = blockReason(t);
        if (why) { self.toast("Can't run " + t.label, "bad", why); return; }
        var go = function () { self.runMacro(t.macro, params || (t.preset ? t.preset.params : {}), t); };
        var ask = needsConfirm(t);
        if (ask) self.confirm("Run " + t.label + "?", ask, "Run", ask.indexOf("lost") >= 0 || ask.indexOf("ruin") >= 0, go); else go();
    };
    self.runSelected = function () { var t = self.selTile(); if (t && self.selRunEnabled()) self.runTile(t, self.selValues()); };
    self.tileClick = function (t) { if (!self.deckEdit()) self.selectTile(t); return true; };
    self.tileDblClick = function (t) { if (!self.deckEdit()) { self.selectTile(t); self.runSelected(); } };
    self.tileKey = function (t, e) { if (e.key === "Enter") { self.selectTile(t); self.runSelected(); return false; } return true; };
    self.quickRun = function (t) { self.runTile(t, null); };
    self.quickBlocked = function (t) { return !!blockReason(t); };
    self.tileClass = function (t) {
        return "tile" + (self.selMacro() === t.key ? " sel" : "") + (t.color ? " c-" + t.color : "") + (t.hidden ? " is-hidden" : "") + (t.missing ? " missing" : "");
    };
    self.hasHint = function (t, hint) { return t.hints.indexOf(hint) >= 0; };

    self.savePreset = function () {
        var t = self.selTile(); if (!t || t.missing) return;
        self.prompt({ title: "Save as preset", label: "Name", button: "Save preset", icon: "fa-bookmark",
            value: t.preset ? t.preset.name : t.macro.toLowerCase().replace(/_/g, " ").replace(/^\w/, function (c) { return c.toUpperCase(); }),
            action: function (name) {
                if (!name) return;
                var id = "p" + Date.now().toString(36), values = self.selValues();
                self.saveDeck(function (d) {
                    d.presets[id] = { name: name.slice(0, 60), macro: t.macro, params: values };
                    var g = d.groups.filter(function (x) { return x.items.indexOf(t.key) >= 0; })[0] || d.groups[0];
                    if (g) g.items.splice(g.items.indexOf(t.key) + 1, 0, "preset:" + id);
                }).done(function () { self.toast("Saved preset " + name, "good"); self.selectTile(self.tileModel("preset:" + id, "")); });
            } });
    };
    self.openMacroSource = function () {
        var t = self.selTile(); if (!t) return;
        OctoPrint.get("plugin/" + PLUGIN + "/config/outline").done(function (rows) {
            var hit = rows.filter(function (r) { return r.section.toUpperCase() === "GCODE_MACRO " + t.macro; })[0];
            if (hit) self.editorGoto(hit.file, hit.line); else self.toast("Couldn't find " + t.macro + " in the config files", "bad", "It may come from an included file outside printer_data/config.");
        });
    };

    /* ------------------------------ edit mode ------------------------------ */
    self.toggleDeckEdit = function () {
        var on = !self.deckEdit();
        if (on && self.deckView() !== "groups") self.setDeckView("groups");
        self.openMenu(null); self.deckEdit(on);
    };
    // every edit saves at once and offers Undo for 6 s (Undo puts the previous layout back)
    function editSave(mutator, message) {
        var prev = clone(self.deck());
        return self.saveDeck(mutator).done(function () {
            self.toast(message, "info", "", { label: "Undo", fn: function () {
                self.saveDeck(function (d) { ["groups", "pinned", "hidden", "colors", "confirm", "presets"].forEach(function (k) { d[k] = prev[k]; }); });
            } });
        });
    }
    function toggleIn(list, key) { var i = list.indexOf(key); if (i >= 0) list.splice(i, 1); else list.push(key); return i < 0; }
    self.tileMenu = function (t) { self.toggleMenu("tile:" + t.key); };
    self.tileMenuOpen = function (t) { return self.openMenu() === "tile:" + t.key; };
    self.tilePin = function (t) { self.openMenu(null); editSave(function (d) { toggleIn(d.pinned, t.key); }, (t.pinned ? "Removed " : "Pinned ") + t.label + (t.pinned ? " from" : " to") + " the Printer screen"); };
    self.tileHide = function (t) { self.openMenu(null); editSave(function (d) { toggleIn(d.hidden, t.key); }, (t.hidden ? "Showing " : "Hid ") + t.label); };
    self.tileConfirm = function (t) { self.openMenu(null); editSave(function (d) { toggleIn(d.confirm, t.key); }, t.confirm ? t.label + " runs without asking" : t.label + " asks before running"); };
    self.tileColor = function (t, color) {
        self.openMenu(null);
        editSave(function (d) { if (color) d.colors[t.key] = color; else delete d.colors[t.key]; }, "Recoloured " + t.label);
    };
    self.tileRename = function (t) {
        self.openMenu(null); if (!t.preset) return;
        self.prompt({ title: "Rename preset", label: "Name", button: "Rename", icon: "fa-pen", value: t.preset.name, action: function (name) {
            if (name) editSave(function (d) { d.presets[t.key.slice(7)].name = name.slice(0, 60); }, "Renamed to " + name);
        } });
    };
    self.tileDelete = function (t) {
        self.openMenu(null); if (!t.preset) return;
        editSave(function (d) {
            delete d.presets[t.key.slice(7)];
            d.groups.forEach(function (g) { g.items = g.items.filter(function (i) { return i !== t.key; }); });
            ["pinned", "hidden", "confirm"].forEach(function (k) { d[k] = d[k].filter(function (i) { return i !== t.key; }); });
            delete d.colors[t.key];
        }, "Deleted " + t.label);
    };
    self.renameGroup = function (g) {
        if (!self.deckEdit() || g.id === "all") return;
        self.prompt({ title: "Rename group", label: "Name", button: "Rename", icon: "fa-pen", value: g.name, action: function (name) {
            if (!name) return;
            editSave(function (d) {
                var hit = d.groups.filter(function (x) { return x.id === g.id; })[0];
                if (hit) hit.name = name.slice(0, 60); else d.groups.push({ id: g.id, name: name.slice(0, 60), items: g.tiles.map(function (t) { return t.key; }) });
            }, "Renamed the group to " + name);
        } });
    };

    // drag to reorder: the lifted tile follows the pointer 1:1, the others slide aside (FLIP), drop saves
    var drag = null;
    function layoutRect(el) { var t = el.style.transform; el.style.transform = ""; var r = el.getBoundingClientRect(); el.style.transform = t; return r; }
    function place(e) {
        drag.el.style.transform = "translate(" + (e.clientX - drag.grabX - drag.home.left) + "px," + (e.clientY - drag.grabY - drag.home.top) + "px) scale(1.03)";
    }
    function pastLast(box, e) {
        var tiles = Array.prototype.filter.call(box.children, function (c) { return c !== drag.el; });
        if (!tiles.length) return true;
        var r = tiles[tiles.length - 1].getBoundingClientRect();
        return e.clientY > r.bottom || (e.clientY >= r.top && e.clientX > r.right);
    }
    function moveTo(e) {
        var under = document.elementFromPoint(e.clientX, e.clientY), deckEl = document.getElementById("kui-deck");
        var zone = under && under.closest && under.closest("#kui .newgroup");
        $("#kui .newgroup").toggleClass("over", !!zone); drag.toNew = !!zone;
        if (zone || !under || !under.closest) return;
        var t = under.closest("#kui-deck .tile"), box = under.closest("#kui-deck .deck");
        var mutate = null;
        if (t && t !== drag.el) {
            var r = t.getBoundingClientRect(), before = e.clientX < r.left + r.width / 2;
            if (before && t.previousElementSibling !== drag.el) mutate = function () { t.parentNode.insertBefore(drag.el, t); };
            else if (!before && t.nextElementSibling !== drag.el) mutate = function () { t.parentNode.insertBefore(drag.el, t.nextElementSibling); };
        } else if (!t && box && box.lastElementChild !== drag.el && pastLast(box, e)) {
            // the gaps between tiles don't count: only past the group's last tile (or an empty group) appends
            mutate = function () { box.appendChild(drag.el); };
        }
        if (mutate) { self.flip(deckEl, mutate, 160); drag.home = layoutRect(drag.el); place(e); }
    }
    function onDown(e) {
        if (!self.deckEdit() || e.button !== 0 || !e.target.closest) return;
        var tile = e.target.closest("#kui-deck .tile");
        if (!tile || e.target.closest(".tpop")) return;
        drag = { el: tile, key: tile.getAttribute("data-name"), x0: e.clientX, y0: e.clientY, started: false, pointer: e.pointerId };
    }
    function onMove(e) {
        if (!drag) return;
        if (!drag.started) {
            if (Math.abs(e.clientX - drag.x0) + Math.abs(e.clientY - drag.y0) < 5) return;
            var r = drag.el.getBoundingClientRect();
            drag.started = true; drag.home = r; drag.grabX = drag.x0 - r.left; drag.grabY = drag.y0 - r.top;
            try { drag.el.setPointerCapture(drag.pointer); } catch (err) { /* synthetic events */ }
            drag.el.classList.add("lifting"); self.openMenu(null);
        }
        e.preventDefault();
        place(e); moveTo(e);
    }
    function onUp() {
        if (!drag) return;
        var d = drag; drag = null;
        if (!d.started) return;
        var from = d.el.style.transform;
        d.el.classList.remove("lifting"); d.el.style.transform = "";
        if (d.el.animate && from) d.el.animate([{ transform: from }, { transform: "scale(.99)", offset: .75 }, { transform: "none" }], { duration: 160, easing: "cubic-bezier(.2,.8,.2,1)" });
        $("#kui .newgroup").removeClass("over");
        var order = Array.prototype.map.call(document.querySelectorAll("#kui-deck .dgroup"), function (g) {
            return { id: g.getAttribute("data-group"), items: Array.prototype.map.call(g.querySelectorAll(".tile"), function (t) { return t.getAttribute("data-name"); }) };
        });
        var tile = self.tileModel(d.key, "");
        editSave(function (dk) {
            var names = {}; dk.groups.forEach(function (g) { names[g.id] = g.name; });
            dk.groups = order.map(function (g) {
                return { id: g.id, name: names[g.id] || (g.id === "other" ? "Other" : "Group"), items: g.items.filter(function (k) { return !d.toNew || k !== d.key; }) };
            });
            if (d.toNew) dk.groups.push({ id: "g" + Date.now().toString(36), name: "New group", items: [d.key] });
        }, d.toNew ? "Made a new group with " + tile.label : "Moved " + tile.label);
    }
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    $(document).on("keydown.kuideck", function (e) { if (e.key === "Escape" && self.deckEdit() && !self.openMenu()) self.deckEdit(false); });

    /* ------------------------------ motion ------------------------------ */
    // FLIP: measure keyed children, change the DOM, then play each from where it was
    self.flip = function (container, mutate, ms) {
        var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        var before = {};
        if (container) $(container).find("[data-flip]").each(function () { if (!this.classList.contains("lifting")) before[this.getAttribute("data-flip")] = this.getBoundingClientRect(); });
        mutate();
        if (!container || reduce || !Element.prototype.animate) return;
        $(container).find("[data-flip]").each(function () {
            if (this.classList.contains("lifting")) return;
            var a = before[this.getAttribute("data-flip")], b = this.getBoundingClientRect();
            if (!a) { this.animate([{ opacity: 0, transform: "scale(.96)" }, { opacity: 1, transform: "none" }], { duration: ms || 260, easing: "cubic-bezier(.2,.8,.2,1)" }); return; }
            var dx = a.left - b.left, dy = a.top - b.top;
            if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
            this.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }], { duration: ms || 260, easing: "cubic-bezier(.2,.8,.2,1)" });
        });
    };
    self.setDeckView = function (v) { self.flip(document.getElementById("kui-deck"), function () { self.deckView(v); }); };

    /* ------------------------------ wiring ------------------------------ */
    var baseMessage = self.onDataUpdaterPluginMessage;
    self.onDataUpdaterPluginMessage = function (plugin, data) {
        if (plugin === PLUGIN && data && data.macros_changed) self.loadDeck();
        return baseMessage.apply(self, arguments);
    };
    var baseStartup = self.onStartupComplete;
    self.onStartupComplete = function () {
        var r = baseStartup ? baseStartup.apply(self, arguments) : undefined;
        self.loadDeck();
        return r;
    };
    self.klipperReady.subscribe(function (v) { if (v && self.deckLoaded()) self.loadDeck(); });
    self.quickItems.subscribe(h.schedulePack);
};
