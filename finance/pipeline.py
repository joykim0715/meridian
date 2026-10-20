from finance.config import env
from finance.http_client import HttpClient, redact
from finance.models import SourceIssue
from finance.sources.cboe import CboeSource
from finance.sources.ecos import EcosSource
from finance.sources.fmp import FmpSource
from finance.sources.fred import FredSource
from finance.sources.kis import KisSource
from finance.sources.krx import KrxSource
from finance.storage.db import Store
from finance.validation.checks import row_problems


def build_sources(http, store, mode, since):
    return [
        FredSource(http, api_key=env("FRED_API_KEY"), store=store, mode=mode),
        CboeSource(http),
        KrxSource(http, api_key=env("KRX_API_KEY"), mode=mode, store=store, since=since),
        FmpSource(http, api_key=env("FMP_API_KEY"), mode=mode),
        KisSource(http, app_key=env("KIS_APP_KEY"), app_secret=env("KIS_APP_SECRET"), base_url=env("KIS_BASE_URL") or "https://openapi.koreainvestment.com:9443"),
        EcosSource(http, api_key=env("ECOS_API_KEY")),
    ]


def is_active(source):
    if source.provider_id in ("fred", "cboe"):
        return True
    if source.provider_id in ("krx", "fmp", "ecos"):
        return bool(getattr(source, "api_key", ""))
    if source.provider_id == "kis":
        return bool(source.app_key and source.app_secret)
    return False


def check_sources(store):
    http = HttpClient()
    lines = []
    public_ok = True
    for source in build_sources(http, store, "update", None):
        store.ensure_provider(source.provider_id, source.name, "active" if is_active(source) else "auth_required")
        if is_active(source):
            for instrument in source.instruments():
                store.ensure_instrument(instrument)
        result = source.check()
        failed = any(issue.code in ("HTTP_ERROR",) for issue in result.issues)
        if source.provider_id in ("fred", "cboe") and (failed or not result.probed.get("csv")):
            public_ok = False
        lines.append(
            {
                "provider_id": source.provider_id,
                "probed": result.probed,
                "issues": [issue.__dict__ for issue in result.issues],
                "constraints": result.constraints,
            }
        )
    store.connection.commit()
    return lines, public_ok


def collect(store, command, since=None):
    http = HttpClient()
    run_id = store.start_run(command)
    totals = {"inserted": 0, "updated": 0, "unchanged": 0, "rejected": 0}
    try:
        for source in build_sources(http, store, command, since):
            store.ensure_provider(source.provider_id, source.name, "active" if is_active(source) else "auth_required")
            if is_active(source):
                for instrument in source.instruments():
                    store.ensure_instrument(instrument)
            result = source.collect()
            accepted = []
            for row in result.observations:
                problems = row_problems(row)
                if problems:
                    totals["rejected"] += 1
                    store.add_issue(
                        run_id,
                        SourceIssue(source.provider_id, "REJECTED", ",".join(problems), row.instrument_id),
                    )
                    continue
                accepted.append(row)
            counts = store.upsert(accepted)
            for key in ("inserted", "updated", "unchanged"):
                totals[key] += counts[key]
            for issue in result.issues:
                store.add_issue(run_id, issue)
        store.finish_run(run_id, "completed")
    except Exception as error:
        store.add_issue(run_id, SourceIssue("finance", "PIPELINE_ERROR", redact(error)))
        store.finish_run(run_id, "failed")
        raise
    return totals
