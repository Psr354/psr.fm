from routes.auth import auth_bp
from routes.playlists import playlists_bp
from routes.songs import songs_bp
from routes.lyrics import lyrics_bp
from routes.recap import recap_bp
from routes.user_settings import user_settings_bp

__all__ = [
    'auth_bp',
    'playlists_bp',
    'songs_bp',
    'lyrics_bp',
    'recap_bp',
    'user_settings_bp',
]
