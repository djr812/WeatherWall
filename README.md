# Weather Wall

Live Bento-grid weather dashboard powered by FastAPI, Chart.js, and WeeWX MySQL telemetry (`weather.djrogers.net.au`).

## Features
- Live WeeWX telemetry with automatic metric conversion and 3-hour pressure trend
- Rotating SVG wind compass and daily temperature/gust extremes
- 24-hour interactive temperature, pressure, and rainfall charts
- Auto-refreshing 5-minute webcam snapshot (`capture_HHMM.jpg`) and daily timelapse playback

## Setup
1. Copy `.env.example` to `.env` and populate database and media paths.
2. Create a Python virtual environment and install dependencies: 3. Run locally with `uvicorn app:app --host 0.0.0.0 --port 8050`.
