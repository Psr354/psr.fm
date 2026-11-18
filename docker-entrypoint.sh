#!/bin/sh
set -eu

mkdir -p /app/data/downloads/library /app/data/album_art /app/logs

if [ "$(id -u)" = "0" ]; then
    chown -R appuser:appuser /app/data /app/logs
    exec gosu appuser "$@"
fi

exec "$@"
