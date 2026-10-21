"""deck.json in the plugin's data folder: one deck shared by every device, versioned, with history."""

import json
import os
import tempfile
import threading
import time

try:
    from . import macros as _macros
except ImportError:  # loaded on its own by the tests
    import macros as _macros

HISTORY_KEEP = 20
USAGE_FLUSH_SECONDS = 30


class Conflict(Exception):
    """The deck was saved by someone else since base_version."""

    def __init__(self, current):
        Exception.__init__(self, "deck changed")
        self.current = current


class DeckStore:
    def __init__(self, folder, logger):
        self.folder = folder
        self.path = os.path.join(folder, "deck.json")
        self.history = os.path.join(folder, "deck.history")
        self.logger = logger
        self.lock = threading.Lock()
        self.pending_usage = {}
        self.last_flush = 0.0

    # --- reading -------------------------------------------------------------
    def _read(self, path):
        with open(path) as f:
            return _macros.validate_deck(json.load(f))

    def _history_files(self):
        if not os.path.isdir(self.history):
            return []
        files = [f for f in os.listdir(self.history) if f.endswith(".json")]
        return sorted(files, key=lambda f: os.path.getmtime(os.path.join(self.history, f)), reverse=True)

    def load(self, macros):
        with self.lock:
            return self._load(macros)

    def _load(self, macros):
        if os.path.exists(self.path):
            try:
                return self._read(self.path)
            except (OSError, ValueError) as exc:
                self.logger.warning("deck.json is unreadable (%s); using the newest saved version", exc)
                for name in self._history_files():
                    try:
                        return self._read(os.path.join(self.history, name))
                    except (OSError, ValueError):
                        continue
        deck = _macros.default_deck(macros)
        self._write(deck)
        return deck

    # --- writing -------------------------------------------------------------
    def _write(self, deck):
        os.makedirs(self.folder, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.folder, prefix=".deck-", suffix=".json")
        with os.fdopen(fd, "w") as f:
            json.dump(deck, f, indent=1, sort_keys=True)
        os.replace(tmp, self.path)

    def save(self, deck, base_version):
        """Validate and store a new deck made from base_version; returns it with the version bumped."""
        clean = _macros.validate_deck(deck)
        with self.lock:
            current = self._load([])
            if int(base_version) != current["version"]:
                raise Conflict(current)
            os.makedirs(self.history, exist_ok=True)
            with open(os.path.join(self.history, "%d-%d.json" % (current["version"], int(time.time() * 1000))), "w") as f:
                json.dump(current, f, indent=1, sort_keys=True)
            for old in self._history_files()[HISTORY_KEEP:]:
                os.remove(os.path.join(self.history, old))
            clean["version"] = current["version"] + 1
            clean["usage"] = current["usage"]  # counted by the server, not sent back by the UI
            self._write(clean)
            return clean

    # --- usage -----------------------------------------------------------------
    def bump_usage(self, name):
        with self.lock:
            key = name if name.startswith("preset:") else name.upper()
            self.pending_usage[key] = self.pending_usage.get(key, 0) + 1
        self.flush_usage()

    def flush_usage(self, force=False):
        """Write pending run counts, at most every 30 s (they don't change the deck's version)."""
        with self.lock:
            if not self.pending_usage or (not force and time.time() - self.last_flush < USAGE_FLUSH_SECONDS):
                return
            deck = self._load([])
            for key, n in self.pending_usage.items():
                deck["usage"][key] = deck["usage"].get(key, 0) + n
            self.pending_usage = {}
            self.last_flush = time.time()
            self._write(deck)
