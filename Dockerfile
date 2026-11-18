FROM python:3.12-slim

# Install ffmpeg for yt-dlp audio conversion and gosu for safe privilege drop
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg gosu && rm -rf /var/lib/apt/lists/*

# Create non-root user and group
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -s /bin/bash -m appuser

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Prepare entrypoint and runtime directories
RUN chmod +x /app/docker-entrypoint.sh && \
    mkdir -p data/downloads/library data/album_art logs && \
    chown -R appuser:appuser /app

# Expose port 5000
EXPOSE 5000

ENTRYPOINT ["/app/docker-entrypoint.sh"]

# Run the application with production WSGI server.
# IMPORTANT: Keep --workers 1 because download_queue, in-memory rate limiters,
# storage cache, and Flask-SocketIO rooms live in-process.
CMD ["gunicorn", "--worker-class", "gthread", "--threads", "100", "--workers", "1", "--bind", "0.0.0.0:5000", "app:app"]
