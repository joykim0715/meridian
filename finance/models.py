from dataclasses import dataclass, field


@dataclass
class Observation:
    instrument_id: str
    obs_date: str
    price_kind: str
    close: float | None = None
    open: float | None = None
    high: float | None = None
    low: float | None = None
    adjusted_close: float | None = None
    volume: float | None = None
    value: float | None = None
    vintage_date: str = ""
    available_at: str | None = None
    status: str = "ok"


@dataclass
class SourceIssue:
    provider_id: str
    code: str
    message: str
    instrument_id: str | None = None


@dataclass
class SourceResult:
    provider_id: str
    observations: list = field(default_factory=list)
    issues: list = field(default_factory=list)
    constraints: list = field(default_factory=list)
    probed: dict = field(default_factory=dict)
