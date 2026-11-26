import asyncio
import json
import os
import time
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo
from typing import Literal

import httpx
import pymysql
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

load_dotenv()

DB_HOST = os.getenv("DB_HOST", "127.0.0.1")
DB_PORT = int(os.getenv("DB_PORT", "3306"))
DB_NAME = os.getenv("DB_NAME", "weewx")
DB_USER = os.getenv("DB_USER", "weatherwall")
DB_PASS = os.getenv("DB_PASS", "")
TIMEZONE = ZoneInfo(os.getenv("TIMEZONE", "Australia/Brisbane"))

CAM_IMAGE_DIR = os.path.expanduser(os.getenv("CAM_IMAGE_DIR", ""))
TIMELAPSE_VIDEO_PATH = os.path.expanduser(os.getenv("TIMELAPSE_VIDEO_PATH", ""))

WEATHERAPI_KEY = os.getenv("WEATHERAPI_KEY", "").strip()
CAPITALS_CACHE_TTL = int(os.getenv("CAPITALS_CACHE_TTL", "900"))
CAPITALS_CACHE_FILE = Path("/tmp/weatherwall_capitals_cache.json")

# Adjust these only if Step 1 showed different column names in your archive table
AQ_CO2_COL = "co2"
AQ_PM10_COL = "pm10_0"

AUSTRALIAN_CAPITALS = [
    {"name": "Brisbane", "state": "QLD", "query": "Brisbane,Queensland,Australia"},
    {"name": "Sydney", "state": "NSW", "query": "Sydney,New South Wales,Australia"},
    {"name": "Melbourne", "state": "VIC", "query": "Melbourne,Victoria,Australia"},
    {"name": "Canberra", "state": "ACT", "query": "Canberra,Australian Capital Territory,Australia"},
    {"name": "Adelaide", "state": "SA", "query": "Adelaide,South Australia,Australia"},
    {"name": "Perth", "state": "WA", "query": "Perth,Western Australia,Australia"},
    {"name": "Hobart", "state": "TAS", "query": "Hobart,Tasmania,Australia"},
    {"name": "Darwin", "state": "NT", "query": "Darwin,Northern Territory,Australia"},
]

app = FastAPI(title="Weather Wall API")

def round_or_none(val, digits: int = 1):
    if val is None:
        return None
    return round(float(val), digits) if digits > 0 else int(round(float(val)))

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
            cur.execute(f"""
                SELECT dateTime, usUnits, outTemp, outHumidity, dewpoint,
                       barometer, windSpeed, windDir, windGust, rainRate,
                       heatindex, windchill, UV, radiation,
                       {AQ_CO2_COL} AS co2,
                       {AQ_PM10_COL} AS pm10_0
                FROM archive
                ORDER BY dateTime DESC
                LIMIT 1
            """)
            latest = cur.fetchone()
            if not latest:
                raise HTTPException(status_code=404, detail="No WeeWX records found")

            units = latest["usUnits"]

            # 2. Today's extremes and total rainfall
            cur.execute(f"""
                SELECT MIN(outTemp) AS min_temp,
                       MAX(outTemp) AS max_temp,
                       MAX(windGust) AS max_gust,
                       SUM(rain) AS total_rain,
                       MAX({AQ_CO2_COL}) AS max_co2,
                       MAX({AQ_PM10_COL}) AS max_pm10_0
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
        "co2": round_or_none(latest.get("co2"), 0),
        "co2_max": round_or_none(today.get("max_co2"), 0),
        "pm10_0": round_or_none(latest.get("pm10_0"), 1),
        "pm10_0_max": round_or_none(today.get("max_pm10_0"), 1),
    }


@app.get("/api/history")
def get_history(
    window: Literal["24h", "7d"] = Query(default="24h", alias="range"),
):
    now_local = datetime.now(TIMEZONE)
    if window == "7d":
        since_epoch = int((now_local - timedelta(days=7)).timestamp())
        max_points = 168
        label_fmt = "%a %H:%M"
    else:
        since_epoch = int((now_local - timedelta(hours=24)).timestamp())
        max_points = 96
        label_fmt = "%H:%M"

    try:
        conn = get_db()
        with conn.cursor() as cur:
            cur.execute(f"""
                SELECT dateTime, usUnits, outTemp, barometer, rain,
                       {AQ_CO2_COL} AS co2,
                       {AQ_PM10_COL} AS pm10_0
                FROM archive
                WHERE dateTime >= %s
                ORDER BY dateTime ASC
            """, (since_epoch,))
            rows = cur.fetchall()
        conn.close()
    except pymysql.MySQLError as exc:
        raise HTTPException(status_code=503, detail=f"Database error: {exc}")

    step = max(1, len(rows) // max_points)
    labels, temps, pressures, rains, co2_vals, pm10_vals = [], [], [], [], [], []

    for i in range(0, len(rows), step):
        bucket = rows[i:i + step]
        mid_row = bucket[len(bucket) // 2]
        dt = datetime.fromtimestamp(mid_row["dateTime"], tz=TIMEZONE)
        labels.append(dt.strftime(label_fmt))

        bucket_temps = [
            to_metric(row["outTemp"], "temp", row["usUnits"])
            for row in bucket if row["outTemp"] is not None
        ]
        temps.append(round(sum(bucket_temps) / len(bucket_temps), 1) if bucket_temps else None)

        bucket_press = [
            to_metric(row["barometer"], "pressure", row["usUnits"])
            for row in bucket if row["barometer"] is not None
        ]
        pressures.append(round(sum(bucket_press) / len(bucket_press), 1) if bucket_press else None)

        bucket_rain = sum(
            to_metric(row["rain"], "rain", row["usUnits"])
            for row in bucket if row["rain"] is not None
        )
        rains.append(round(bucket_rain, 2))

        bucket_co2 = [float(row["co2"]) for row in bucket if row["co2"] is not None]
        co2_vals.append(int(round(sum(bucket_co2) / len(bucket_co2))) if bucket_co2 else None)

        bucket_pm10 = [float(row["pm10_0"]) for row in bucket if row["pm10_0"] is not None]
        pm10_vals.append(round(sum(bucket_pm10) / len(bucket_pm10), 1) if bucket_pm10 else None)

    return {
        "range": window,
        "labels": labels,
        "temp": temps,
        "barometer": pressures,
        "rain": rains,
        "co2": co2_vals,
        "pm10": pm10_vals,
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

async def _fetch_one_capital(client: httpx.AsyncClient, city: dict):
    url = "https://api.weatherapi.com/v1/forecast.json"
    params = {
        "key": WEATHERAPI_KEY,
        "q": city["query"],
        "days": 1,
        "aqi": "no",
        "alerts": "no",
    }
    resp = await client.get(url, params=params)
    resp.raise_for_status()
    data = resp.json()

    cur = data["current"]
    day = data["forecast"]["forecastday"][0]["day"]

    def fix_icon(icon_url: str) -> str:
        if not icon_url:
            return ""
        return f"https:{icon_url}" if icon_url.startswith("//") else icon_url

    return {
        "name": city["name"],
        "state": city["state"],
        "temp_c": round(float(cur["temp_c"]), 1),
        "condition": cur["condition"]["text"],
        "icon": fix_icon(cur["condition"]["icon"]),
        "min_c": round(float(day["mintemp_c"]), 0),
        "max_c": round(float(day["maxtemp_c"]), 0),
        "forecast_condition": day["condition"]["text"],
        "rain_chance": int(day.get("daily_chance_of_rain", 0)),
    }


@app.get("/api/capitals")
async def get_capitals():
    if not WEATHERAPI_KEY:
        raise HTTPException(status_code=503, detail="WEATHERAPI_KEY is not configured")

    now = time.time()
    cached = None

    # Shared file cache so both Uvicorn workers stay within WeatherAPI limits
    if CAPITALS_CACHE_FILE.is_file():
        try:
            cached = json.loads(CAPITALS_CACHE_FILE.read_text(encoding="utf-8"))
            if now - cached.get("fetched_epoch", 0) < CAPITALS_CACHE_TTL:
                return cached
        except (OSError, ValueError):
            cached = None

    async with httpx.AsyncClient(timeout=8.0) as client:
        results = await asyncio.gather(
            *(_fetch_one_capital(client, c) for c in AUSTRALIAN_CAPITALS),
            return_exceptions=True,
        )

    cities = [r for r in results if isinstance(r, dict)]
    if not cities:
        if cached:
            return cached
        raise HTTPException(status_code=502, detail="Unable to fetch Australian capital weather")

    payload = {
        "fetched_epoch": now,
        "updated_display": datetime.now(TIMEZONE).strftime("%I:%M %p"),
        "cities": cities,
    }
    try:
        CAPITALS_CACHE_FILE.write_text(json.dumps(payload), encoding="utf-8")
    except OSError:
        pass

    return payload

# Serve static frontend files at the root path
app.mount("/", StaticFiles(directory="static", html=True), name="static")
