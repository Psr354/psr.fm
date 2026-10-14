from mutagen import File

def extract_duration(filepath):
    try:
        audio = File(filepath)
        if not audio or not audio.info or not audio.info.length:
            return 0
        return int(audio.info.length)
    except Exception:
        return 0
