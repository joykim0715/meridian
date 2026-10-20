from datetime import date, timedelta


def parse_number(raw):
    text = str(raw).strip().replace(",", "")
    if text in ("", ".", "null", "None", "NA", "N/A"):
        return None
    return float(text)


def iso_date(value):
    text = str(value).strip()
    if len(text) == 8 and text.isdigit():
        return f"{text[0:4]}-{text[4:6]}-{text[6:8]}"
    if "/" in text:
        month, day, year = text.split("/")
        return f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    return text


def shift_days(iso, days):
    parsed = date.fromisoformat(iso)
    return (parsed + timedelta(days=days)).isoformat()


def available_at(obs_date, frequency, market):
    if frequency == "monthly":
        year, month, _day = [int(part) for part in obs_date.split("-")]
        if month == 12:
            return f"{year + 1}-01-01T00:00:00Z"
        return f"{year}-{month + 1:02d}-01T00:00:00Z"
    if frequency == "weekly":
        return f"{shift_days(obs_date, 1)}T20:00:00Z"
    if market == "KR":
        return f"{obs_date}T07:00:00Z"
    return f"{obs_date}T21:00:00Z"


def business_days(start, end):
    current = date.fromisoformat(start)
    last = date.fromisoformat(end)
    days = []
    while current <= last:
        if current.weekday() < 5:
            days.append(current.isoformat())
        current += timedelta(days=1)
    return days
