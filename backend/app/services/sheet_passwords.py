"""
Transition Round passwords live in a Google Sheet ("Project Chronos - Password List"), one tab
per zone (PAST / PRESENT / FUTURE - PASSWORDS) with a Status checkbox per password.

The sheet is reached through a small Google Apps Script web app bound to the sheet
(backend/tools/google_sheet_password_service.gs). The backend never holds Google credentials:
it POSTs {secret, action, zone, password, team_id, team_name} and the script, under a lock,
finds the password in that zone's tab, ticks its Status checkbox and answers {ok: true}. A
password whose Status is already ticked, or that is not in the zone's tab, answers {ok: false}.
So a password works exactly once, and ticking Status is what "used" means.

Reliability rules
  * Only a definite answer counts. A timeout, a network error, a non-JSON page (for example
    Google's sign-in page when the deployment is not "Anyone") or {error: ...} raises
    PasswordServiceError, so the caller never counts that attempt against the team.
  * One automatic retry on a transient failure. The script treats a repeated request from the
    same team for a password it already used as success, so a lost answer cannot turn a correct
    password into a "wrong" one.

Settings (environment or .env, see config.py):
  TRANSITION_SHEET_URL     the web app's /exec URL
  TRANSITION_SHEET_SECRET  shared secret, also stored in the script's Script Properties
"""

import json
import time
import urllib.error
import urllib.request
from typing import Optional

from ..config import setting

REQUEST_TIMEOUT_SECONDS = 20
RETRIES = 1
RETRY_DELAY_SECONDS = 0.8


class PasswordServiceError(Exception):
    """The password sheet could not be reached or answered with an error."""


def _post(url: str, payload: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    # Apps Script answers a POST with a redirect to the result; urllib follows it.
    with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS) as response:
        raw = response.read().decode("utf-8", errors="replace")
    try:
        data = json.loads(raw)
    except ValueError as err:
        raise PasswordServiceError(
            "Password sheet returned a non-JSON answer (is the deployment set to "
            f"'Anyone' and the URL the /exec one?): {raw[:80]!r}"
        ) from err
    if not isinstance(data, dict):
        raise PasswordServiceError("Password sheet returned an unexpected answer.")
    return data


def consume_password(
    zone: str,
    password: str,
    team_id: Optional[int] = None,
    team_name: Optional[str] = None,
) -> bool:
    """
    True when `password` is a valid, unused password of `zone`; it is marked used in the
    sheet as part of the same call. False when it is wrong or already used.
    Raises PasswordServiceError when the sheet cannot give a definite answer (so the caller
    must not count the attempt).
    """
    url = setting("TRANSITION_SHEET_URL")
    secret = setting("TRANSITION_SHEET_SECRET")
    if not url or not secret:
        raise PasswordServiceError(
            "Password sheet is not configured (TRANSITION_SHEET_URL / TRANSITION_SHEET_SECRET)."
        )

    payload = {"secret": secret, "action": "consume", "zone": zone, "password": password}
    if team_id is not None:
        payload["team_id"] = team_id
    if team_name:
        payload["team_name"] = team_name

    last_error: Optional[Exception] = None
    data: Optional[dict] = None
    for attempt in range(RETRIES + 1):
        try:
            data = _post(url, payload)
        except PasswordServiceError as err:
            last_error = err  # a bad page will not fix itself, but one retry is cheap
        except (urllib.error.URLError, TimeoutError, OSError) as err:
            last_error = PasswordServiceError(f"Password sheet unreachable: {err}")
        else:
            error = data.get("error")
            if not error:
                break
            # "busy" is transient; anything else (bad secret, no tab) is a configuration error.
            last_error = PasswordServiceError(f"Password sheet error: {error}")
            if "busy" not in str(error).lower():
                data = None
                break
            data = None
        if attempt < RETRIES:
            time.sleep(RETRY_DELAY_SECONDS)

    if data is None:
        raise last_error or PasswordServiceError("Password sheet gave no answer.")

    # `ok` is the contract; `valid` / `success` are accepted from older script versions.
    for key in ("ok", "valid", "success"):
        if key in data:
            return bool(data[key])
    raise PasswordServiceError("Password sheet answer has no ok/valid field.")
