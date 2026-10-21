import pytest

from deck_store import Conflict, DeckStore
from macros import parse_macros
from tests.conftest import load_fixture

MS = parse_macros(load_fixture())


class Log:
    def __init__(self):
        self.calls = []

    def __getattr__(self, name):
        return lambda *a, **k: self.calls.append(name)


@pytest.fixture
def log():
    return Log()


def test_load_creates_default(tmp_path, log):
    d = DeckStore(str(tmp_path), log).load(MS)
    assert d["version"] == 0 and (tmp_path / "deck.json").exists()


def test_save_bumps_version_and_keeps_history(tmp_path, log):
    s = DeckStore(str(tmp_path), log)
    d = s.load(MS)
    d2 = s.save({**d, "pinned": ["PARK"]}, base_version=0)
    assert d2["version"] == 1 and d2["pinned"] == ["PARK"]
    assert len(list((tmp_path / "deck.history").iterdir())) == 1


def test_conflict(tmp_path, log):
    s = DeckStore(str(tmp_path), log)
    d = s.load(MS)
    s.save(d, 0)
    with pytest.raises(Conflict) as e:
        s.save(d, 0)
    assert e.value.current["version"] == 1


def test_history_pruned_to_20(tmp_path, log):
    s = DeckStore(str(tmp_path), log)
    d = s.load(MS)
    for v in range(25):
        d = s.save(d, v)
    assert len(list((tmp_path / "deck.history").iterdir())) == 20


def test_corrupt_falls_back_to_history(tmp_path, log):
    s = DeckStore(str(tmp_path), log)
    d = s.load(MS)
    s.save({**d, "pinned": ["PARK"]}, 0)
    (tmp_path / "deck.json").write_text("{not json")
    d = DeckStore(str(tmp_path), log).load(MS)  # history holds the deck from before the save
    assert d["version"] == 0 and d["pinned"] == []
    assert "warning" in log.calls


def test_usage_flush(tmp_path, log):
    s = DeckStore(str(tmp_path), log)
    s.load(MS)
    s.bump_usage("park")
    s.flush_usage(force=True)
    assert s.load(MS)["usage"] == {"PARK": 1}
