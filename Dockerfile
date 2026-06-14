FROM python:3.12-slim

# Install ffmpeg for yt-dlp audio conversion
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY . .

# Ensure runtime directories exist
RUN mkdir -p downloads static/album_art logs

# Expose port 5000
EXPOSE 5000

# Run the application
CMD ["python", "app.py"]
