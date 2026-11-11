FROM python:3.12-slim

# Install ffmpeg for yt-dlp audio conversion
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

# Create non-root user and group
RUN groupadd -g 1000 appuser && \
    useradd -u 1000 -g appuser -s /bin/bash -m appuser

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Ensure runtime directories exist and set correct ownership
RUN mkdir -p downloads static/album_art logs database.db && \
    chown -R appuser:appuser /app

USER appuser

# Expose port 5000
EXPOSE 5000

# Run the application with production WSGI server
CMD ["gunicorn", "--worker-class", "gthread", "--threads", "100", "--workers", "1", "--bind", "0.0.0.0:5000", "app:app"]
