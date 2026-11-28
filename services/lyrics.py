import base64
import json
import re
import threading
import time
import xml.etree.ElementTree as ET
from urllib.parse import urlencode

import requests
try:
    import yaml
except ImportError:  # Optional until the container rebuild installs PyYAML.
    yaml = None

LRCLIB_BASE_URL = 'https://lrclib.net/api'
BETTER_LYRICS_URL = 'https://lyrics-api.boidu.dev/getLyrics'
LYRICS_PLUS_URL = 'https://lyricsplus.prjktla.my.id/v2/lyrics/get'
KUGOU_SEARCH_URL = 'https://lyrics.kugou.com/search'
KUGOU_DOWNLOAD_URL = 'https://lyrics.kugou.com/download'
REQUEST_TIMEOUT_SECONDS = 10
REQUEST_INTERVAL_SECONDS = 1.0
USER_AGENT = 'psr.fm v1.0 (https://github.com/psr354/psr.fm)'

_request_lock = threading.Lock()
_next_request_time = 0.0


_BRACKETED_SUFFIX_RE = re.compile(r'\s*[\[(](?:official|video|lyrics?|audio|mv|clean|explicit|visualizer|hd|4k)[^\])]*[\])]', re.IGNORECASE)
_FEAT_RE = re.compile(r'\s*(?:\(|\[)?\b(?:feat\.?|ft\.?|featuring)\b[^\])]*', re.IGNORECASE)
_WHITESPACE_RE = re.compile(r'\s+')
_LRC_TIMESTAMP_RE = re.compile(r'\[(\d{1,2}):(\d{2})(?:\.(\d{1,3}))?\]')
_ARTIST_TITLE_RE = re.compile(r'^\s*(?P<artist>[^-–—:|]+)\s*[-–—:|]\s*(?P<title>.+?)\s*$')
# Splits a multi-artist credit ("A / B", "A & B", "A, B feat. C", "A x B")
# into individual names so each can be searched separately on LRCLIB, which
# usually indexes a single primary artist.
_ARTIST_SPLIT_RE = re.compile(r'\s*(?:/|,|&|\bx\b|\bvs\.?\b|\bfeat\.?\b|\bft\.?\b|\bwith\b|\band\b|\+)\s*', re.IGNORECASE)


def _throttled_request(method, url, **kwargs):
    global _next_request_time
    # Reserve the next rate-limit slot under the lock, then release before
    # sleeping and executing network I/O so slow upstream responses do not
    # serialize all other callers behind the global lock.
    with _request_lock:
        now = time.monotonic()
        scheduled_at = max(now, _next_request_time)
        _next_request_time = scheduled_at + REQUEST_INTERVAL_SECONDS
    wait_seconds = scheduled_at - now
    if wait_seconds > 0:
        time.sleep(wait_seconds)
    return requests.request(
        method,
        url,
        timeout=kwargs.pop('timeout', REQUEST_TIMEOUT_SECONDS),
        headers={
            'User-Agent': USER_AGENT,
            **kwargs.pop('headers', {}),
        },
        **kwargs,
    )


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
        matches = list(_LRC_TIMESTAMP_RE.finditer(line))
        if not matches:
            continue
        text = line[matches[-1].end():].strip()
        for match in matches:
            minutes = int(match.group(1))
            seconds = int(match.group(2))
            fraction = match.group(3) or '0'
            milliseconds = int(fraction.ljust(3, '0')[:3])
            timestamp = minutes * 60 + seconds + milliseconds / 1000
            lines.append({'timestamp': timestamp, 'text': text})
    return sorted(lines, key=lambda item: item['timestamp'])


def _split_artists(artist):
    if not artist:
        return []
    parts = [clean_text(part) for part in _ARTIST_SPLIT_RE.split(str(artist))]
    return [part for part in parts if part]

def _build_search_variants(title, artist):
    clean_title = clean_text(title)
    clean_artist = clean_text(artist)
    variants = []

    if clean_title:
        variants.append((clean_title, clean_artist))

    match = _ARTIST_TITLE_RE.match(str(title or ''))
    if match:
        split_artist = clean_text(match.group('artist'))
        split_title = clean_text(match.group('title'))
        if split_title:
            variants.append((split_title, split_artist or clean_artist))

    # Multi-artist credits ("Gerald Timotheus / Skyline") rarely match LRCLIB's
    # single-artist index, so try each individual artist, then fall back to a
    # title+duration-only search (still guarded by the ±5s duration check).
    if clean_title:
        individual = _split_artists(clean_artist)
        if len(individual) > 1:
            variants.extend((clean_title, name) for name in individual)
        variants.append((clean_title, ''))

    unique = []
    seen = set()
    for variant_title, variant_artist in variants:
        key = (variant_title.lower(), variant_artist.lower())
        if variant_title and key not in seen:
            seen.add(key)
            unique.append((variant_title, variant_artist))
    return unique


def _normalize_lyrics_record(record):
    if not isinstance(record, dict):
        return None

    plain_lyrics = record.get('plainLyrics') or record.get('plain_lyrics') or ''
    synced_lyrics = record.get('syncedLyrics') or record.get('synced_lyrics') or ''
    word_synced_lyrics = _parse_word_synced_lyrics(record.get('lyricsfile'))
    if not plain_lyrics and not synced_lyrics and not word_synced_lyrics:
        return None

    return {
        'lyrics': plain_lyrics.strip(),
        'synced_lyrics': synced_lyrics.strip(),
        'word_synced_lyrics': json.dumps(word_synced_lyrics, ensure_ascii=False) if word_synced_lyrics else '',
    }


def _parse_word_synced_lyrics(lyricsfile):
    if not lyricsfile or yaml is None:
        return []
    try:
        document = yaml.safe_load(lyricsfile)
    except (TypeError, yaml.YAMLError):
        return []

    normalized_lines = []
    for line in (document or {}).get('lines', []) if isinstance(document, dict) else []:
        words = []
        for word in line.get('words', []) if isinstance(line, dict) else []:
            if not isinstance(word, dict):
                continue
            text = word.get('word') or word.get('text') or word.get('syllable') or ''
            start_ms = word.get('start_ms', word.get('startTimeMs', word.get('start')))
            end_ms = word.get('end_ms', word.get('endTimeMs', word.get('end')))
            if not text or start_ms is None or end_ms is None:
                continue
            try:
                words.append({
                    'text': str(text),
                    'start': float(start_ms) / 1000,
                    'end': float(end_ms) / 1000,
                })
            except (TypeError, ValueError):
                continue
        if isinstance(line, dict):
            try:
                line_start = float(line.get('start_ms', 0) or 0) / 1000
                line_end = float(line.get('end_ms', 0) or 0) / 1000
            except (TypeError, ValueError):
                line_start = 0.0
                line_end = 0.0
            normalized_lines.append({
                'text': str(line.get('text') or ''),
                'start': line_start,
                'end': line_end,
                'words': words,
            })
    return normalized_lines if any(line['words'] for line in normalized_lines) else []


def _score_candidate(candidate, title, artist, duration):
    candidate_title = clean_text(candidate.get('trackName') or candidate.get('track_name') or '')
    candidate_artist = clean_text(candidate.get('artistName') or candidate.get('artist_name') or '')
    candidate_duration = candidate.get('duration') or 0

    duration_diff = abs(int(candidate_duration or 0) - int(duration or 0))
    title_score = 0 if candidate_title.lower() == title.lower() else 1
    artist_score = 0 if not artist or candidate_artist.lower() == artist.lower() else 1

    return (duration_diff, title_score, artist_score)


def _search_lyrics_variant(clean_title, clean_artist, duration):

    params = {'track_name': clean_title, 'duration': int(duration or 0)}
    if clean_artist:
        params['artist_name'] = clean_artist

    response = _throttled_request(
        'GET',
        f"{LRCLIB_BASE_URL}/get-cached?{urlencode(params)}",
    )
    if response.ok:
        try:
            payload = response.json()
        except ValueError:
            payload = None
        record = _normalize_lyrics_record(payload)
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


def _format_lrc_timestamp(seconds):
    total_ms = max(0, int(round(float(seconds or 0) * 1000)))
    minutes = total_ms // 60000
    secs = (total_ms % 60000) // 1000
    centis = (total_ms % 1000) // 10
    return f'[{minutes:02d}:{secs:02d}.{centis:02d}]'


def _parse_ttml_time(value):
    if value is None:
        return None
    raw = str(value).strip()
    if not raw:
        return None
    if raw.endswith('ms'):
        try:
            return float(raw[:-2]) / 1000.0
        except ValueError:
            return None
    if raw.endswith('s'):
        try:
            return float(raw[:-1])
        except ValueError:
            return None
    parts = raw.split(':')
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None
    return None


def _local_tag(tag):
    return tag.rsplit('}', 1)[-1] if '}' in tag else tag


def _parse_ttml_lyrics(ttml_xml):
    if not ttml_xml or not isinstance(ttml_xml, str):
        return None
    try:
        root = ET.fromstring(ttml_xml)
    except ET.ParseError:
        return None

    plain_lines = []
    synced_lines = []
    word_lines = []

    for elem in root.iter():
        if _local_tag(elem.tag) != 'p':
            continue
        p_begin = _parse_ttml_time(elem.attrib.get('begin'))
        p_end = _parse_ttml_time(elem.attrib.get('end'))
        words = []
        text_parts = []
        for child in elem:
            if _local_tag(child.tag) != 'span':
                continue
            role = None
            for k, v in child.attrib.items():
                if _local_tag(k) == 'role':
                    role = v
                    break
            if role in ('x-translation', 'x-roman'):
                continue
            word_text = ''.join(child.itertext())
            if not word_text:
                continue
            tail_text = child.tail or ''
            text_parts.append(word_text)
            if tail_text:
                text_parts.append(tail_text)
            has_trailing_space = bool(tail_text and tail_text[0].isspace()) or word_text[-1].isspace()
            stored_word = word_text if word_text[-1].isspace() else (f'{word_text} ' if has_trailing_space else word_text)
            w_begin = _parse_ttml_time(child.attrib.get('begin'))
            w_end = _parse_ttml_time(child.attrib.get('end'))
            if w_begin is not None:
                words.append({
                    'text': stored_word,
                    'start': w_begin,
                    'end': w_end if w_end is not None else w_begin,
                })

        line_text = ''.join(text_parts).strip() if text_parts else ''.join(elem.itertext()).strip()
        if not line_text:
            continue
        plain_lines.append(line_text)
        if p_begin is not None:
            synced_lines.append(f'{_format_lrc_timestamp(p_begin)} {line_text}')
            if words:
                word_lines.append({
                    'text': line_text,
                    'start': p_begin,
                    'end': p_end if p_end is not None else words[-1]['end'],
                    'words': words,
                })

    if not plain_lines and not synced_lines:
        return None
    return {
        'lyrics': '\n'.join(plain_lines).strip(),
        'synced_lyrics': '\n'.join(synced_lines).strip(),
        'word_synced_lyrics': json.dumps(word_lines, ensure_ascii=False) if word_lines else '',
    }


def _search_better_lyrics(clean_title, clean_artist, duration):
    if not clean_title or not clean_artist:
        return None
    params = {'s': clean_title, 'a': clean_artist}
    if duration:
        params['d'] = int(duration)
    try:
        response = _throttled_request('GET', BETTER_LYRICS_URL, params=params)
        if not response.ok:
            return None
        payload = response.json()
    except (requests.RequestException, ValueError):
        return None
    if not isinstance(payload, dict):
        return None
    return _parse_ttml_lyrics(payload.get('ttml'))


def _search_lyrics_plus(clean_title, clean_artist, duration):
    if not clean_title or not clean_artist:
        return None
    params = {'title': clean_title, 'artist': clean_artist}
    if duration:
        params['duration'] = int(duration)
    try:
        response = _throttled_request('GET', LYRICS_PLUS_URL, params=params)
        if not response.ok:
            return None
        payload = response.json()
    except (requests.RequestException, ValueError):
        return None
    if not isinstance(payload, dict):
        return None

    items = payload.get('lyrics')
    if not isinstance(items, list) or not items:
        return None

    plain_lines = []
    synced_lines = []
    word_lines = []
    for item in items:
        if not isinstance(item, dict):
            continue
        text = str(item.get('text') or '').strip()
        if not text:
            continue
        plain_lines.append(text)
        start_ms = item.get('time')
        dur_ms = item.get('duration') or 0
        if start_ms is not None:
            start_s = float(start_ms) / 1000.0
            end_s = start_s + (float(dur_ms) / 1000.0)
            synced_lines.append(f'{_format_lrc_timestamp(start_s)} {text}')
            syllabus = item.get('syllabus')
            if isinstance(syllabus, list) and syllabus:
                words = []
                for syl in syllabus:
                    if not isinstance(syl, dict):
                        continue
                    syl_text = str(syl.get('text') or '')
                    if not syl_text:
                        continue
                    w_start = float(syl.get('time', start_ms)) / 1000.0
                    w_end = w_start + float(syl.get('duration') or 0) / 1000.0
                    words.append({'text': syl_text, 'start': w_start, 'end': w_end})
                if words:
                    word_lines.append({'text': text, 'start': start_s, 'end': end_s, 'words': words})

    if not plain_lines and not synced_lines:
        return None
    return {
        'lyrics': '\n'.join(plain_lines).strip(),
        'synced_lyrics': '\n'.join(synced_lines).strip(),
        'word_synced_lyrics': json.dumps(word_lines, ensure_ascii=False) if word_lines else '',
    }


def _search_kugou_lyrics(clean_title, clean_artist, duration):
    if not clean_title:
        return None
    keyword = f'{clean_artist} - {clean_title}'.strip(' -') if clean_artist else clean_title
    params = {'ver': 1, 'man': 'yes', 'client': 'pc', 'keyword': keyword}
    if duration:
        params['duration'] = int(duration) * 1000
    try:
        search_resp = _throttled_request('GET', KUGOU_SEARCH_URL, params=params)
        if not search_resp.ok:
            return None
        search_data = search_resp.json()
    except (requests.RequestException, ValueError):
        return None

    candidates = search_data.get('candidates') if isinstance(search_data, dict) else None
    if not isinstance(candidates, list) or not candidates:
        return None
    best = candidates[0]
    if not isinstance(best, dict) or not best.get('id') or not best.get('accesskey'):
        return None

    try:
        dl_resp = _throttled_request(
            'GET',
            KUGOU_DOWNLOAD_URL,
            params={
                'ver': 1,
                'client': 'pc',
                'id': best['id'],
                'accesskey': best['accesskey'],
                'fmt': 'lrc',
                'charset': 'utf8',
            },
        )
        if not dl_resp.ok:
            return None
        dl_data = dl_resp.json()
        encoded = dl_data.get('content') if isinstance(dl_data, dict) else None
        if not encoded:
            return None
        lrc_text = base64.b64decode(encoded).decode('utf-8', errors='replace').strip()
    except (requests.RequestException, ValueError):
        return None

    if not lrc_text:
        return None
    parsed = parse_lrc(lrc_text)
    plain = '\n'.join(line['text'] for line in parsed if line.get('text')).strip()
    if not parsed:
        return {'lyrics': lrc_text, 'synced_lyrics': '', 'word_synced_lyrics': ''}
    return {'lyrics': plain, 'synced_lyrics': lrc_text, 'word_synced_lyrics': ''}


def _lyrics_quality_rank(record):
    if not record:
        return 0
    if record.get('word_synced_lyrics'):
        return 3
    if record.get('synced_lyrics'):
        return 2
    if record.get('lyrics'):
        return 1
    return 0


def search_lyrics(title, artist, duration):
    variants = _build_search_variants(title, artist)
    if not variants:
        return None

    best_result = None
    best_rank = 0
    for clean_title, clean_artist in variants:
        result = _search_lyrics_variant(clean_title, clean_artist, duration)
        rank = _lyrics_quality_rank(result)
        if rank >= 3:
            return result
        if rank > best_rank:
            best_result = result
            best_rank = rank
        if rank >= 2:
            # LRCLIB returned line-synced LRC; still check word-synced providers
            # before settling on line-synced lyrics.
            break

    # Try word-synced / fallback providers (BetterLyrics TTML -> LyricsPlus -> KuGou)
    primary_title, primary_artist = variants[0]
    fetchers = (_search_better_lyrics, _search_lyrics_plus) if best_rank >= 2 else (
        _search_better_lyrics, _search_lyrics_plus, _search_kugou_lyrics
    )
    for fetcher in fetchers:
        try:
            fallback = fetcher(primary_title, primary_artist, duration)
        except Exception:
            fallback = None
        rank = _lyrics_quality_rank(fallback)
        if rank >= 3:
            return fallback
        if rank > best_rank:
            best_result = fallback
            best_rank = rank

    return best_result
