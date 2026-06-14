from mutagen.mp3 import MP3

def extract_duration(filepath):
    try:
        audio = MP3(filepath)
        return int(audio.info.length)
    except Exception:
        return 0
