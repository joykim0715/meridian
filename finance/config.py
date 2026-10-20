import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "finance" / "data"
OUTPUT_DIR = ROOT / "finance" / "output"
DB_PATH = Path(os.environ.get("FINANCE_DB", DATA_DIR / "market.sqlite"))
SNAPSHOT_PATH = Path(os.environ.get("FINANCE_SNAPSHOT", OUTPUT_DIR / "finance_snapshot.json"))

USER_AGENT = "sbhnews-finance/1.0"


def env(name):
    value = os.environ.get(name, "")
    return value.strip()


def database_path():
    return Path(os.environ.get("FINANCE_DB", DB_PATH))


def snapshot_path():
    return Path(os.environ.get("FINANCE_SNAPSHOT", SNAPSHOT_PATH))
