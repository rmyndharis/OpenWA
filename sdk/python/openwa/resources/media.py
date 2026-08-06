"""Media resource — server-side conversion into the formats WhatsApp plays.

Backed by ``src/modules/media/media.controller.ts``.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Optional

from .._http import quote_segment
from ..types import ConvertedMedia, MediaConversionAvailability

if TYPE_CHECKING:
    from .._http import HttpExecutor


class MediaResource:
    def __init__(self, http: "HttpExecutor") -> None:
        self._http = http

    def conversion_status(self, session_id: str) -> MediaConversionAvailability:
        """Report whether conversion is switched on here AND the ffmpeg binary can be run.

        Worth checking once: against a server without it, a caller must convert on its own
        side rather than take an error per request.
        """
        return self._http.request("GET", f"/api/sessions/{quote_segment(session_id)}/media/convert")

    def convert_voice(
        self, session_id: str, *, url: Optional[str] = None, base64: Optional[str] = None
    ) -> ConvertedMedia:
        """Convert audio into a WhatsApp voice note (Ogg/Opus, mono, tuned for speech).

        WhatsApp shows a playable mic bubble only for this format — MP3 bytes sent with
        ``ptt=True`` produce a voice note that will not play. Pass the returned ``base64``
        to ``send_audio(..., ptt=True)``. Requires an OPERATOR-level key.
        """
        return self._http.request(
            "POST",
            f"/api/sessions/{quote_segment(session_id)}/media/convert/voice",
            body=_conversion_body(url, base64),
        )

    def convert_video(
        self, session_id: str, *, url: Optional[str] = None, base64: Optional[str] = None
    ) -> ConvertedMedia:
        """Convert video into an MP4 every WhatsApp client accepts.

        Baseline H.264 with AAC audio, long edge bounded at 1280, index moved to the front
        for immediate playback. Requires an OPERATOR-level key.
        """
        return self._http.request(
            "POST",
            f"/api/sessions/{quote_segment(session_id)}/media/convert/video",
            body=_conversion_body(url, base64),
        )


def _conversion_body(url: Optional[str], base64: Optional[str]) -> dict:
    """Send only the field that was given: a blank one reads as supplied-but-empty."""
    body = {}
    if url is not None:
        body["url"] = url
    if base64 is not None:
        body["base64"] = base64
    return body
