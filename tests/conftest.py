import json
import os
import sys

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "kobra_ui"))


def load_fixture():
    with open(os.path.join(HERE, "fixtures", "configfile_settings.json")) as f:
        return json.load(f)
