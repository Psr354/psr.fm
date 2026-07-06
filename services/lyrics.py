import re
import threading
import time
from urllib.parse import urlencode

import requests

LRCLIB_BASE_URL = 'https://lrclib.net/api'
REQUEST_TIMEOUT_SECONDS = 10
REQUEST_INTERVAL_SECONDS = 1.0
USER_AGENT = 'psr.fm v1.0 (https://github.com/psr354/psr.fm)'

_request_lock = threading.Lock()
_last_request_time = 0.0


_BRACKETED_SUFFIX_RE = re.compile(r'\s*[\[(](?:official|video|lyrics?|audio|mv|clean|explicit|visualizer|hd|4k)[^\])]*[\])]', re.IGNORECASE)
_FEAT_RE = re.compile(r'\s*(?:\(|\[)?\b(?:feat\.?|ft\.?|featuring)\b[^\])]*', re.IGNORECASE)
_WHITESPACE_RE = re.compile(r'\s+')
_LRC_LINE_RE = re.compile(r'^\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]\s*(.*)$')


def _throttled_request(method, url, **kwargs):
    global _last_request_time
    with _request_lock:
        elapsed = time.monotonic() - _last_request_time
        if elapsed < REQUEST_INTERVAL_SECONDS:
            time.sleep(REQUEST_INTERVAL_SECONDS - elapsed)
        response = requests.request(
            method,
            url,
            timeout=kwargs.pop('timeout', REQUEST_TIMEOUT_SECONDS),
            headers={
                'User-Agent': USER_AGENT,
                **kwargs.pop('headers', {}),
            },
            **kwargs,
        )
        _last_request_time = time.monotonic()
        return response


def clean_text(text):
    if not text:
        return ''

    value = str(text)
    value = re.sub(r'\s*[-–—:]\s*(?:official|lyrics?|audio|video|visualizer|mv)\b.*$', '', value, flags=re.IGNORECASE)
    value = _BRACKETED_SUFFIX_RE.sub('', value)
    value = _FEAT_RE.sub('', value)
    value = re.sub(r'\s*\([^)]*\b(?:official|lyrics?|audio|video|visualizer|mv)\b[^)]*\)', '', value, flags=re.IGNORECASE)
    value = value.replace('“', '"').replace('”', '"').replace("’", "'")
    value = _WHITESPACE_RE.sub(' ', value).strip(' -_\t\n\r')
    return value


def parse_lrc(lrc_content):
    if not lrc_content:
        return []

    lines = []
    for raw_line in str(lrc_content).splitlines():
        line = raw_line.strip()
        if not line:
            continue
        match = _LRC_LINE_RE.match(line)
        if not match:
            continue
        minutes = int(match.group(1))
        seconds = int(match.group(2))
        fraction = match.group(3) or '0'
        milliseconds = int(fraction.ljust(3, '0')[:3])
        timestamp = minutes * 60 + seconds + milliseconds / 1000
        text = match.group(4).strip()
        lines.append({'timestamp': timestamp, 'text': text})
    return lines


def _normalize_lyrics_record(record):
    if not isinstance(record, dict):
        return None

    plain_lyrics = record.get('plainLyrics') or record.get('plain_lyrics') or ''
    synced_lyrics = record.get('syncedLyrics') or record.get('synced_lyrics') or ''
    if not plain_lyrics and not synced_lyrics:
        return None

    return {
        'lyrics': plain_lyrics.strip(),
        'synced_lyrics': synced_lyrics.strip(),
    }


def _score_candidate(candidate, title, artist, duration):
    candidate_title = clean_text(candidate.get('trackName') or candidate.get('track_name') or '')
    candidate_artist = clean_text(candidate.get('artistName') or candidate.get('artist_name') or '')
    candidate_duration = candidate.get('duration') or 0

    duration_diff = abs(int(candidate_duration or 0) - int(duration or 0))
    title_score = 0 if candidate_title.lower() == title.lower() else 1
    artist_score = 0 if not artist or candidate_artist.lower() == artist.lower() else 1

    return (duration_diff, title_score, artist_score)


def search_lyrics(title, artist, duration):
    clean_title = clean_text(title)
    clean_artist = clean_text(artist)
    if not clean_title:
        return None

    params = {'track_name': clean_title, 'duration': int(duration or 0)}
    if clean_artist:
        params['artist_name'] = clean_artist

    response = _throttled_request(
        'GET',
        f"{LRCLIB_BASE_URL}/get-cached?{urlencode(params)}",
    )
    if response.ok:
        record = _normalize_lyrics_record(response.json())
        if record:
            return record

    search_params = {'track_name': clean_title}
    if clean_artist:
        search_params['artist_name'] = clean_artist
    search_params['q'] = f"{clean_title} {clean_artist}".strip()

    response = _throttled_request(
        'GET',
        f"{LRCLIB_BASE_URL}/search?{urlencode(search_params)}",
    )
    if not response.ok:
        return None

    try:
        candidates = response.json()
    except ValueError:
        return None

    if not isinstance(candidates, list) or not candidates:
        return None

    best_candidate = None
    best_score = None
    for candidate in candidates:
        if not isinstance(candidate, dict):
            continue
        score = _score_candidate(candidate, clean_title, clean_artist, duration)
        if best_score is None or score < best_score:
            best_score = score
            best_candidate = candidate

    if best_candidate is None:
        return None

    duration_diff = abs(int(best_candidate.get('duration') or 0) - int(duration or 0))
    if duration and duration_diff > 5:
        return None

    return _normalize_lyrics_record(best_candidate)