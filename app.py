import os
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pathlib import Path

load_dotenv()

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_NAME = os.getenv("DB_NAME", "weewx")
DB_USER = os.getenv("DB_USER", "weatherwall")
DB_PASS = os.getenv("DB_PASS", "")
TIMEZONE = ZoneInfo(os.getenv("TIMEZONE", "Australia/Brisbane"))

CAM_IMAGE_DIR = os.path.expanduser(os.getenv("CAM_IMAGE_DIR", ""))
TIMELAPSE_VIDEO_PATH = os.path.expanduser(os.getenv("TIMELAPSE_VIDEO_PATH", ""))

app = FastAPI(title="Weather Wall API")


def get_db():
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASS,
        database=DB_NAME,
        cursorclass=pymysql.cursors.DictCursor,
        connect_timeout=5,
    )


def to_metric(val, kind: str, us_units: int):
    """Normalize WeeWX archive values to °C, km/h, hPa, and mm."""
    if val is None:
        return None
    val = float(val)

    if kind == "temp":
        return round((val - 32.0) * 5.0 / 9.0, 1) if us_units == 1 else round(val, 1)
    if kind == "pressure":
        return round(val * 33.8639, 1) if us_units == 1 else round(val, 1)
    if kind == "wind":
        if us_units == 1:
            return round(val * 1.60934, 1)
        if us_units == 17:
            return round(val * 3.6, 1)
        return round(val, 1)
    if kind == "rain":
        if us_units == 1:
            return round(val * 25.4, 2)
        if us_units == 16:
            return round(val * 10.0, 2)
        return round(val, 2)
    return round(val, 1)


def deg_to_cardinal(deg):
    if deg is None:
        return "--"
    dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
            "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
    return dirs[int((float(deg) + 11.25) // 22.5) % 16]


@app.get("/api/weather")
def get_current_weather():
    now_local = datetime.now(TIMEZONE)
    midnight_local = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    midnight_epoch = int(midnight_local.timestamp())
    three_hours_ago = int((now_local - timedelta(hours=3)).timestamp())

    try:
        conn = get_db()
        with conn.cursor() as cur:
            # 1. Most recent archive record
            cur.execute("""
                SELECT dateTime, usUnits, outTemp, outHumidity, dewpoint,
                       barometer, windSpeed, windDir, windGust, rainRate,
                       heatindex, windchill, UV, radiation
                FROM archive
                ORDER BY dateTime DESC
                LIMIT 1
            """)
            latest = cur.fetchone()
            if not latest:
                raise HTTPException(status_code=404, detail="No WeeWX records found")

            units = latest["usUnits"]

            # 2. Today's extremes and total rainfall
            cur.execute("""
                SELECT MIN(outTemp) AS min_temp,
                       MAX(outTemp) AS max_temp,
                       MAX(windGust) AS max_gust,
                       SUM(rain) AS total_rain
                FROM archive
                WHERE dateTime >= %s
            """, (midnight_epoch,))
            today = cur.fetchone() or {}

            # 3. Barometer reading ~3 hours ago for pressure trend
            cur.execute("""
                SELECT barometer, usUnits
                FROM archive
                WHERE dateTime <= %s
                ORDER BY dateTime DESC
                LIMIT 1
            """, (three_hours_ago,))
            past = cur.fetchone()
        conn.close()
    except pymysql.MySQLError as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")

    temp_c = to_metric(latest["outTemp"], "temp", units)
    heat_c = to_metric(latest["heatindex"], "temp", units)
    chill_c = to_metric(latest["windchill"], "temp", units)

    # Pick apparent temperature based on warm vs cool conditions
    feels_like = temp_c
    if temp_c is not None:
        if temp_c >= 26.0 and heat_c is not None:
            feels_like = heat_c
        elif temp_c <= 10.0 and chill_c is not None:
            feels_like = chill_c

    baro_now = to_metric(latest["barometer"], "pressure", units)
    baro_trend = "Steady"
    baro_delta = 0.0
    if past and past["barometer"] is not None and baro_now is not None:
        baro_past = to_metric(past["barometer"], "pressure", past["usUnits"])
        baro_delta = round(baro_now - baro_past, 1)
        if baro_delta >= 0.8:
            baro_trend = "Rising"
        elif baro_delta <= -0.8:
            baro_trend = "Falling"

    obs_time = datetime.fromtimestamp(latest["dateTime"], tz=TIMEZONE)
    age_minutes = max(0, int((now_local - obs_time).total_seconds() // 60))

    return {
        "updated_iso": obs_time.isoformat(),
        "updated_display": obs_time.strftime("%a %d %b, %I:%M %p"),
        "age_minutes": age_minutes,
        "temp": temp_c,
        "feels_like": feels_like,
        "temp_high": to_metric(today.get("max_temp"), "temp", units),
        "temp_low": to_metric(today.get("min_temp"), "temp", units),
        "dewpoint": to_metric(latest["dewpoint"], "temp", units),
        "humidity": round(float(latest["outHumidity"]), 0) if latest["outHumidity"] is not None else None,
        "barometer": baro_now,
        "barometer_trend": baro_trend,
        "barometer_delta": baro_delta,
        "wind_speed": to_metric(latest["windSpeed"], "wind", units),
        "wind_gust": to_metric(latest["windGust"], "wind", units),
        "wind_max_gust": to_metric(today.get("max_gust"), "wind", units),
        "wind_dir_deg": round(float(latest["windDir"]), 0) if latest["windDir"] is not None else 0,
        "wind_dir_cardinal": deg_to_cardinal(latest["windDir"]),
        "rain_today": to_metric(today.get("total_rain") or 0.0, "rain", units),
        "rain_rate": to_metric(latest["rainRate"] or 0.0, "rain", units),
        "uv": round(float(latest["UV"]), 1) if latest["UV"] is not None else None,
        "solar": round(float(latest["radiation"]), 0) if latest["radiation"] is not None else None,
    }


@app.get("/api/history")
def get_24h_history():
    since_epoch = int((datetime.now(TIMEZONE) - timedelta(hours=24)).timestamp())
    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute("""
                SELECT dateTime, usUnits, outTemp, barometer, rain
                FROM archive
                WHERE dateTime >= %s
                ORDER BY dateTime ASC
            """, (since_epoch,))
            rows = cur.fetchall()
        conn.close()
    except pymysql.MySQLError as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")

    # Downsample slightly if archive interval is very short (keep ~96 points max)
    step = max(1, len(rows) // 96)
    labels, temps, pressures, rains = [], [], [], []

    for i in range(0, len(rows), step):
        r = rows[i]
        u = r["usUnits"]
        dt = datetime.fromtimestamp(r["dateTime"], tz=TIMEZONE)
        labels.append(dt.strftime("%H:%M"))
        temps.append(to_metric(r["outTemp"], "temp", u))
        pressures.append(to_metric(r["barometer"], "pressure", u))
        # Sum rainfall across the bucket so rain totals stay accurate
        bucket_rain = sum((rows[j]["rain"] or 0.0) for j in range(i, min(i + step, len(rows))))
        rains.append(to_metric(bucket_rain, "rain", u))

    return {
        "labels": labels,
        "temp": temps,
        "barometer": pressures,
        "rain": rains,
    }

@app.get("/api/cam/latest")
def get_latest_cam():
    cam_dir = Path(CAM_IMAGE_DIR)
    if not CAM_IMAGE_DIR or not cam_dir.is_dir():
        return JSONResponse({"error": "Webcam directory not found"}, status_code=404)

    snapshots = [
        p for p in cam_dir.glob("capture_*.jpg")
        if p.is_file() and p.stat().st_size > 0
    ]
    if not snapshots:
        return JSONResponse({"error": "No webcam snapshots found"}, status_code=404)

    latest_img = max(snapshots, key=lambda p: p.stat().st_mtime)
    return FileResponse(
        latest_img,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "X-Cam-File": latest_img.name,
        },
    )

@app.get("/api/cam/timelapse")
def get_timelapse():
    if not TIMELAPSE_VIDEO_PATH or not os.path.isfile(TIMELAPSE_VIDEO_PATH):
        return JSONResponse({"error": "Timelapse video not found"}, status_code=404)
    return FileResponse(
        TIMELAPSE_VIDEO_PATH,
        media_type="video/mp4",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# Serve static frontend files at the root path
app.mount("/", StaticFiles(directory="static", html=True), name="static")
