import sqlite3
from datetime import datetime, timezone

SCHEMA = """
CREATE TABLE IF NOT EXISTS providers (
  provider_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  access TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS instruments (
  instrument_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  asset_class TEXT NOT NULL,
  market TEXT,
  currency TEXT,
  unit TEXT NOT NULL,
  price_kind TEXT NOT NULL,
  frequency TEXT NOT NULL,
  note TEXT,
  UNIQUE (provider_id, symbol, price_kind)
);
CREATE TABLE IF NOT EXISTS observations (
  instrument_id TEXT NOT NULL,
  obs_date TEXT NOT NULL,
  price_kind TEXT NOT NULL,
  vintage_date TEXT NOT NULL DEFAULT '',
  open REAL,
  high REAL,
  low REAL,
  close REAL,
  adjusted_close REAL,
  volume REAL,
  value REAL,
  available_at TEXT,
  collected_at TEXT NOT NULL,
  status TEXT NOT NULL,
  PRIMARY KEY (instrument_id, obs_date, price_kind, vintage_date)
);
CREATE TABLE IF NOT EXISTS collection_runs (
  run_id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  command TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS source_issues (
  issue_id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER,
  provider_id TEXT NOT NULL,
  instrument_id TEXT,
  code TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
"""


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Store:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.row_factory = sqlite3.Row
        self.connection.executescript(SCHEMA)

    def close(self):
        self.connection.close()

    def start_run(self, command):
        cursor = self.connection.execute(
            "INSERT INTO collection_runs (started_at, command, status) VALUES (?, ?, 'running')",
            (utc_now(), command),
        )
        self.connection.commit()
        return cursor.lastrowid

    def finish_run(self, run_id, status):
        self.connection.execute(
            "UPDATE collection_runs SET finished_at = ?, status = ? WHERE run_id = ?",
            (utc_now(), status, run_id),
        )
        self.connection.commit()

    def ensure_provider(self, provider_id, name, access):
        self.connection.execute(
            "INSERT INTO providers (provider_id, name, access) VALUES (?, ?, ?) "
            "ON CONFLICT(provider_id) DO UPDATE SET name = excluded.name, access = excluded.access",
            (provider_id, name, access),
        )

    def ensure_instrument(self, instrument):
        self.connection.execute(
            """
            INSERT INTO instruments (
              instrument_id, provider_id, symbol, name, asset_class, market, currency,
              unit, price_kind, frequency, note
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(instrument_id) DO UPDATE SET
              name = excluded.name, unit = excluded.unit, note = excluded.note
            """,
            (
                instrument["instrument_id"],
                instrument["provider_id"],
                instrument["symbol"],
                instrument["name"],
                instrument["asset_class"],
                instrument.get("market"),
                instrument.get("currency"),
                instrument["unit"],
                instrument["price_kind"],
                instrument["frequency"],
                instrument.get("note"),
            ),
        )

    def latest_date(self, instrument_id):
        row = self.connection.execute(
            "SELECT MAX(obs_date) AS obs_date FROM observations WHERE instrument_id = ?",
            (instrument_id,),
        ).fetchone()
        return row["obs_date"] if row else None

    def upsert(self, rows):
        inserted = updated = unchanged = 0
        collected_at = utc_now()
        for row in rows:
            current = self.connection.execute(
                """
                SELECT open, high, low, close, adjusted_close, volume, value, available_at, status
                FROM observations
                WHERE instrument_id = ? AND obs_date = ? AND price_kind = ? AND vintage_date = ?
                """,
                (row.instrument_id, row.obs_date, row.price_kind, row.vintage_date),
            ).fetchone()
            values = (
                row.open,
                row.high,
                row.low,
                row.close,
                row.adjusted_close,
                row.volume,
                row.value,
                row.available_at,
                row.status,
            )
            if current is None:
                self.connection.execute(
                    """
                    INSERT INTO observations (
                      instrument_id, obs_date, price_kind, vintage_date, open, high, low, close,
                      adjusted_close, volume, value, available_at, status, collected_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (row.instrument_id, row.obs_date, row.price_kind, row.vintage_date, *values, collected_at),
                )
                inserted += 1
            elif tuple(current) == values:
                unchanged += 1
            else:
                self.connection.execute(
                    """
                    UPDATE observations
                    SET open = ?, high = ?, low = ?, close = ?, adjusted_close = ?, volume = ?,
                        value = ?, available_at = ?, status = ?, collected_at = ?
                    WHERE instrument_id = ? AND obs_date = ? AND price_kind = ? AND vintage_date = ?
                    """,
                    (*values, collected_at, row.instrument_id, row.obs_date, row.price_kind, row.vintage_date),
                )
                updated += 1
        self.connection.commit()
        return {"inserted": inserted, "updated": updated, "unchanged": unchanged}

    def add_issue(self, run_id, issue):
        self.connection.execute(
            """
            INSERT INTO source_issues (run_id, provider_id, instrument_id, code, message, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (run_id, issue.provider_id, issue.instrument_id, issue.code, issue.message, utc_now()),
        )
        self.connection.commit()

    def count_observations(self):
        return self.connection.execute("SELECT COUNT(*) FROM observations").fetchone()[0]

    def observations(self, instrument_id):
        return self.connection.execute(
            "SELECT * FROM observations WHERE instrument_id = ? ORDER BY obs_date, vintage_date",
            (instrument_id,),
        ).fetchall()

    def instruments(self):
        return self.connection.execute("SELECT * FROM instruments ORDER BY instrument_id").fetchall()

    def latest_issues(self):
        run = self.connection.execute("SELECT MAX(run_id) AS run_id FROM collection_runs").fetchone()
        if not run or run["run_id"] is None:
            return []
        return self.connection.execute(
            "SELECT * FROM source_issues WHERE run_id = ? ORDER BY issue_id",
            (run["run_id"],),
        ).fetchall()
