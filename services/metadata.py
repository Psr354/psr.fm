import wave

from mutagen import File

def extract_duration(filepath):
    try:
        audio = File(filepath)
        if not audio or not audio.info or not audio.info.length:
            raise ValueError('Audio duration is unavailable')
        return max(1, int(audio.info.length))
    except Exception:
        try:
            with wave.open(filepath, 'rb') as audio:
                if not audio.getframerate() or not audio.getnframes():
                    return 0
                return max(1, int(audio.getnframes() / audio.getframerate()))
        except Exception:
            return 0
