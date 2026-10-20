import json
import re
import time
import urllib.error
import urllib.request

from finance.config import USER_AGENT


class HttpError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def redact(text):
    hidden = re.sub(
        r"(api_key|apikey|apiKey|AUTH_KEY|appsecret|appkey|secret)=([^&\s]+)",
        r"\1=***",
        str(text),
        flags=re.IGNORECASE,
    )
    return re.sub(r"(Bearer\s+)[A-Za-z0-9._\-]+", r"\1***", hidden)


class HttpClient:
    def __init__(self, timeout=30, retries=3, sleep=time.sleep):
        self.timeout = timeout
        self.retries = retries
        self.sleep = sleep

    def get_bytes(self, url, headers=None):
        last_error = None
        for attempt in range(self.retries):
            request = urllib.request.Request(url, headers=self._headers(headers))
            try:
                with urllib.request.urlopen(request, timeout=self.timeout) as response:
                    payload = response.read()
                    if len(payload) > 20_000_000:
                        raise HttpError(200, "response too large")
                    return payload
            except HttpError:
                raise
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", "replace")[:300]
                last_error = HttpError(error.code, redact(body or error.reason))
                if error.code not in (429, 500, 502, 503, 504) or attempt == self.retries - 1:
                    raise last_error
            except urllib.error.URLError as error:
                last_error = HttpError(0, redact(error.reason))
                if attempt == self.retries - 1:
                    raise last_error
            self.sleep(min(4, 2**attempt))
        raise last_error

    def get_text(self, url, headers=None):
        return self.get_bytes(url, headers).decode("utf-8-sig")

    def get_json(self, url, headers=None):
        return json.loads(self.get_text(url, headers))

    def post_json(self, url, payload, headers=None):
        data = json.dumps(payload).encode("utf-8")
        merged = {"Content-Type": "application/json", **(headers or {})}
        request = urllib.request.Request(url, data=data, headers=self._headers(merged), method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            body = error.read().decode("utf-8", "replace")[:300]
            raise HttpError(error.code, redact(body or error.reason))

    def _headers(self, headers):
        merged = {"User-Agent": USER_AGENT, "Accept": "*/*"}
        if headers:
            merged.update(headers)
        return merged
