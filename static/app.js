let trendChart = null;
let activeMetric = "temp";
let activeRange = "24h";
const historyCache = {};
const HISTORY_TTL_MS = 5 * 60 * 1000;

let activeRecordsPeriod = "all";
const recordsCache = {};
const RECORDS_TTL_MS = 10 * 60 * 1000;

let sunTargetEpoch = null;
let sunCountdownLabel = "Daylight left";

let camIsNight = false;
let camResumeText = null;

let loadedTimelapseVersion = null;
let pendingTimelapseVersion = null;
let lastFallbackReloadDate = null;

let forecastData = null;
let activeForecastView = "7d";

const RECORDS_TITLES = {
  all: "All-Time Station Records",
  year: "This Year's Station Records",
  month: "This Month's Station Records",
};

const METRIC_CONFIG = {
  temp: {
    label: "Temperature (°C)",
    color: "#fb923c",
    bg: "rgba(251, 146, 60, 0.14)",
    type: "line",
    beginAtZero: false,
  },
  barometer: {
    label: "Barometer (hPa)",
    color: "#38bdf8",
    bg: "rgba(56, 189, 248, 0.14)",
    type: "line",
    beginAtZero: false,
  },
  rain: {
    label: "Rainfall (mm)",
    color: "#60a5fa",
    bg: "rgba(96, 165, 250, 0.55)",
    type: "bar",
    beginAtZero: true,
  },
  co2: {
    label: "CO₂ (ppm)",
    color: "#34d399",
    bg: "rgba(52, 211, 153, 0.14)",
    type: "line",
    beginAtZero: false,
    suggestedMax: 850,
    thresholds: [
      { value: 800, label: "Good ≤ 800", color: "#34d399" },
      { value: 1000, label: "Fair ≤ 1000", color: "#fbbf24" },
      { value: 1500, label: "Poor ≤ 1500", color: "#fb923c" },
    ],
  },
  pm10: {
    label: "PM10 (µg/m³)",
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.14)",
    type: "line",
    beginAtZero: true,
    suggestedMax: 30,
    thresholds: [
      { value: 25, label: "Good ≤ 25", color: "#34d399" },
      { value: 50, label: "Fair ≤ 50", color: "#fbbf24" },
      { value: 100, label: "Poor ≤ 100", color: "#fb923c" },
    ],
  },
  lightning: {
    label: "Lightning Strikes",
    color: "#fbbf24",
    bg: "rgba(251, 191, 36, 0.65)",
    type: "bar",
    beginAtZero: true,
    suggestedMax: 5,
    integerTicks: true,
  },
};

const thresholdLinesPlugin = {
  id: "thresholdLines",
  afterDatasetsDraw(chart, _args, pluginOptions) {
    const lines = pluginOptions?.lines;
    if (!lines || !lines.length) return;

    const { ctx, chartArea, scales } = chart;
    const yScale = scales.y;
    if (!yScale) return;

    ctx.save();
    lines.forEach((line) => {
      const y = yScale.getPixelForValue(line.value);
      if (y < chartArea.top + 2 || y > chartArea.bottom - 2) return;

      ctx.beginPath();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = line.color;
      ctx.moveTo(chartArea.left, y);
      ctx.lineTo(chartArea.right, y);
      ctx.stroke();

      ctx.setLineDash([]);
      ctx.font = "600 11px system-ui, -apple-system, sans-serif";
      const padX = 6;
      const textW = ctx.measureText(line.label).width;
      const boxW = textW + padX * 2;
      const boxH = 18;
      const boxX = chartArea.right - boxW - 6;
      const boxY = Math.max(chartArea.top + 2, y - boxH - 3);

      ctx.fillStyle = "rgba(15, 23, 42, 0.85)";
      if (typeof ctx.roundRect === "function") {
        ctx.beginPath();
        ctx.roundRect(boxX, boxY, boxW, boxH, 5);
        ctx.fill();
      } else {
        ctx.fillRect(boxX, boxY, boxW, boxH);
      }

      ctx.fillStyle = line.color;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(line.label, boxX + padX, boxY + boxH / 2 + 0.5);
    });
    ctx.restore();
  },
};

function fmt(val, fallback = "--") {
  return val === null || val === undefined ? fallback : val;
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderMoonSvg(phaseVal, phaseName) {
  if (phaseVal === null || phaseVal === undefined) return "";
  const t = (((Number(phaseVal) % 28) + 28) % 28) / 28;
  const r = 9;
  const cx = 12;
  const cy = 12;
  const illumRatio = (1 - Math.cos(t * 2 * Math.PI)) / 2;

  let litShape = "";
  if (illumRatio > 0.98) {
    litShape = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#e2e8f0" />`;
  } else if (illumRatio >= 0.02) {
    // Southern Hemisphere orientation: waxing lit on LEFT, waning lit on RIGHT
    const waxing = t < 0.5;
    const gibbous = t > 0.25 && t < 0.75;
    const rx = Math.abs(Math.cos(t * 2 * Math.PI)) * r;
    const outerSweep = waxing ? 0 : 1;
    const innerSweep = waxing === gibbous ? 0 : 1;
    const terminator = rx < 0.2
      ? `L ${cx} ${cy - r}`
      : `A ${rx.toFixed(2)} ${r} 0 0 ${innerSweep} ${cx} ${cy - r}`;
    litShape = `<path d="M ${cx} ${cy - r} A ${r} ${r} 0 0 ${outerSweep} ${cx} ${cy + r} ${terminator} Z" fill="#e2e8f0" />`;
  }

  return `
    <svg viewBox="0 0 24 24" role="img" aria-label="${phaseName || "Moon phase"}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#1e293b" stroke="#64748b" stroke-width="1.2" />
      ${litShape}
    </svg>
  `;
}

function updateSunCountdown() {
  if (!sunTargetEpoch) return;
  const diffSec = Math.max(0, Math.floor(sunTargetEpoch - Date.now() / 1000));
  const hrs = Math.floor(diffSec / 3600);
  const mins = Math.floor((diffSec % 3600) / 60);
  const formatted = hrs > 0 ? `${hrs}h ${String(mins).padStart(2, "0")}m` : `${mins}m`;
  setText("sun-countdown-label", sunCountdownLabel);
  setText("sun-countdown-value", formatted);
}

function rateAirMetric(type, val) {
  if (val === null || val === undefined) return { label: "--", cls: "" };
  const n = Number(val);
  if (type === "co2") {
    if (n <= 800) return { label: "Good", cls: "lvl-good" };
    if (n <= 1000) return { label: "Fair", cls: "lvl-fair" };
    if (n <= 1500) return { label: "Poor", cls: "lvl-poor" };
    return { label: "High", cls: "lvl-bad" };
  }
  if (n <= 25) return { label: "Good", cls: "lvl-good" };
  if (n <= 50) return { label: "Fair", cls: "lvl-fair" };
  if (n <= 100) return { label: "Poor", cls: "lvl-poor" };
  return { label: "Very Poor", cls: "lvl-bad" };
}

function setAqiBadge(id, rating) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = rating.label;
  el.className = `aqi-pill ${rating.cls}`;
}

function formatRelativeAge(ageMin, fallbackText) {
  if (ageMin === null || ageMin === undefined) return "No strikes in last 30 days";
  if (ageMin < 1) return "Just now";
  if (ageMin < 60) return `${ageMin}m ago (${fallbackText})`;
  if (ageMin < 1440) {
    const hrs = Math.floor(ageMin / 60);
    const mins = ageMin % 60;
    return `${hrs}h ${mins}m ago (${fallbackText})`;
  }
  return fallbackText || "--";
}

function rateLightning(ageMin, distKm) {
  if (ageMin === null || ageMin === undefined || ageMin > 60) {
    return { label: "All Clear", cls: "lvl-good" };
  }
  if (ageMin <= 30 && distKm !== null && distKm !== undefined && distKm <= 10) {
    return { label: "Storm Nearby", cls: "lvl-bad" };
  }
  if (ageMin <= 30 && distKm !== null && distKm !== undefined && distKm <= 25) {
    return { label: "Active", cls: "lvl-poor" };
  }
  return { label: "Distant", cls: "lvl-fair" };
}

async function fetchWeather() {
  const pill = document.getElementById("status-pill");
  const statusText = document.getElementById("status-text");

  try {
    const res = await fetch("/api/weather", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    setText("temp-value", fmt(d.temp));
    setText("feels-like", fmt(d.feels_like));
    setText("dewpoint-value", fmt(d.dewpoint));
    setText("temp-high", `${fmt(d.temp_high)}°C`);
    setText("temp-low", `${fmt(d.temp_low)}°C`);

    setText("humidity-value", fmt(d.humidity));
    setText("barometer-value", fmt(d.barometer));
    const deltaSign = d.barometer_delta > 0 ? "+" : "";
    setText("barometer-trend", `${d.barometer_trend} (${deltaSign}${d.barometer_delta} hPa)`);

    setText("rain-today", fmt(d.rain_today, "0.0"));
    setText("rain-rate", fmt(d.rain_rate, "0.0"));
    setText("uv-value", fmt(d.uv));
    setText("solar-value", fmt(d.solar));

    setText("wind-speed", fmt(d.wind_speed, "0"));
    setText("wind-gust", fmt(d.wind_gust, "0"));
    setText("wind-max-gust", fmt(d.wind_max_gust, "0"));
    setText("wind-dir-text", `${d.wind_dir_cardinal} (${d.wind_dir_deg}°)`);
    document.getElementById("wind-arrow")?.setAttribute(
      "transform",
      `rotate(${d.wind_dir_deg} 60 60)`
    );

    // Air Quality (CO2 & PM10)
    setText("co2-value", fmt(d.co2));
    setText("co2-max", fmt(d.co2_max));
    setText("pm10-value", fmt(d.pm10_0));
    setText("pm10-max", fmt(d.pm10_0_max));

    const rCo2 = rateAirMetric("co2", d.co2);
    const rPm10 = rateAirMetric("pm10", d.pm10_0);
    setAqiBadge("co2-status", rCo2);
    setAqiBadge("pm10-status", rPm10);

    const severity = ["", "lvl-good", "lvl-fair", "lvl-poor", "lvl-bad"];
    const worst = [rCo2, rPm10].reduce((a, b) =>
      severity.indexOf(b.cls) > severity.indexOf(a.cls) ? b : a
    );
    const overall = document.getElementById("aqi-overall");
    if (overall) {
      overall.textContent = worst.label;
      overall.className = `badge aqi-badge ${worst.cls}`;
    }

    // Lightning Activity
    const lgtRating = rateLightning(d.lightning_last_age_min, d.lightning_last_dist);
    const lgtStatus = document.getElementById("lgt-status");
    if (lgtStatus) {
      lgtStatus.textContent = lgtRating.label;
      lgtStatus.className = `badge aqi-badge ${lgtRating.cls}`;
    }

    setText("lgt-last-dist", fmt(d.lightning_last_dist));
    setText("lgt-last-time", formatRelativeAge(d.lightning_last_age_min, d.lightning_last_time));
    setText("lgt-today", fmt(d.lightning_today, "0"));
    setText("lgt-1h", fmt(d.lightning_1h, "0"));
    setText(
      "lgt-closest",
      d.lightning_closest_today !== null && d.lightning_closest_today !== undefined
        ? `${d.lightning_closest_today} km`
        : "--"
    );

    const marker = document.getElementById("lgt-marker");
    if (marker) {
      if (d.lightning_last_dist !== null && d.lightning_last_dist !== undefined) {
        const pct = Math.min(100, Math.max(0, (Number(d.lightning_last_dist) / 40) * 100));
        marker.style.left = `${pct}%`;
        marker.hidden = false;
        marker.classList.toggle("dimmed", d.lightning_last_age_min === null || d.lightning_last_age_min > 60);
      } else {
        marker.hidden = true;
      }
    }

    // Ferny Grove Sunrise, Sunset, Countdown & Moon Phase pill
    setText("sunrise-time", fmt(d.sunrise));
    setText("sunset-time", fmt(d.sunset));

    sunTargetEpoch = d.sun_target_epoch || null;
    sunCountdownLabel = d.sun_countdown_label || "Daylight left";
    const countdownWrap = document.getElementById("sun-countdown-wrap");
    if (countdownWrap) {
      countdownWrap.classList.toggle("is-night", d.sun_is_daylight === false);
    }
    if (sunTargetEpoch) {
      updateSunCountdown();
    } else {
      setText("sun-countdown-label", sunCountdownLabel);
      setText("sun-countdown-value", fmt(d.sun_countdown));
    }

    const moonIcon = document.getElementById("moon-icon");
    if (moonIcon && d.moon_phase !== null && d.moon_phase !== undefined) {
      moonIcon.innerHTML = renderMoonSvg(d.moon_phase, d.moon_phase_name);
    }
    setText("moon-label", d.moon_phase_name || "--");

    const moonItem = document.getElementById("moon-item");
    if (moonItem && d.moon_phase_name) {
      const illumTxt = d.moon_illumination !== undefined ? ` · ${d.moon_illumination}% lit` : "";
      moonItem.title = `${d.moon_phase_name}${illumTxt} (Southern Hemisphere view)`;
    }

    const sunPill = document.getElementById("sun-pill");
    if (sunPill && d.daylight) {
      sunPill.title = `Ferny Grove daylight: ${d.daylight}`;
    }

    const nextCamNight = Boolean(d.cam_is_night);
    const camModeChanged = nextCamNight !== camIsNight;
    camIsNight = nextCamNight;
    camResumeText = d.cam_resume || null;
    if (camIsNight) {
      setText(
        "cam-timestamp",
        camResumeText ? `Night mode · Resumes ${camResumeText}` : "Night mode"
      );
    }
    if (camModeChanged) refreshCam();

    checkTimelapseUpdate(d.timelapse_mtime);
    if (d.timelapse_updated) {
      setText("timelapse-updated", d.timelapse_updated);
    }

    setText("last-updated", d.updated_display);

    if (pill && statusText) {
      if (d.age_minutes > 15) {
        pill.classList.add("stale");
        statusText.textContent = `Delayed (${d.age_minutes}m ago)`;
      } else {
        pill.classList.remove("stale");
        statusText.textContent = "Live";
      }
    }
  } catch (err) {
    if (pill) pill.classList.add("stale");
    if (statusText) statusText.textContent = "Offline";
    console.error("Weather fetch failed:", err);
  }
}

function refreshCam() {
  const img = document.getElementById("cam-image");
  if (img) img.src = `/api/cam/latest?t=${Date.now()}`;
  if (camIsNight) {
    setText(
      "cam-timestamp",
      camResumeText ? `Night mode · Resumes ${camResumeText}` : "Night mode"
    );
  } else {
    setText("cam-timestamp", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }
}

function getTimelapseBaseUrl(video) {
  const source = video.querySelector("source");
  const raw = (
    source?.getAttribute("src") ||
    video.getAttribute("src") ||
    "/api/timelapse"
  ).split("?")[0];
  return raw || "/api/timelapse";
}

function applyTimelapseVersion(version) {
  const video =
    document.getElementById("timelapse-video") ||
    document.querySelector(".card-timelapse video");
  if (!video || !version) return;

  const versionStr = String(version);

  // Defer reload if someone is actively watching the current timelapse
  const isPlaying = !video.paused && !video.ended && video.readyState > 2;
  if (isPlaying) {
    if (pendingTimelapseVersion !== versionStr) {
      pendingTimelapseVersion = versionStr;
      video.addEventListener(
        "ended",
        () => {
          if (pendingTimelapseVersion) {
            const next = pendingTimelapseVersion;
            pendingTimelapseVersion = null;
            applyTimelapseVersion(next);
          }
        },
        { once: true }
      );
    }
    return;
  }

  const baseUrl = getTimelapseBaseUrl(video);
  const nextUrl = `${baseUrl}?v=${encodeURIComponent(versionStr)}`;
  const source = video.querySelector("source");

  if (source) {
    source.setAttribute("src", nextUrl);
    video.removeAttribute("src");
  } else {
    video.setAttribute("src", nextUrl);
  }

  loadedTimelapseVersion = versionStr;
  pendingTimelapseVersion = null;
  video.load();
}

function checkTimelapseUpdate(timelapseMtime) {
  // Primary path: reload automatically whenever latest_tl.mp4 gets a new mtime
  if (timelapseMtime !== null && timelapseMtime !== undefined) {
    const version = String(timelapseMtime);
    if (loadedTimelapseVersion !== version) {
      applyTimelapseVersion(version);
    }
    return;
  }

  // Fallback path (if app.py omits timelapse_mtime): reload once after 8:10 PM Brisbane time
  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Brisbane",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date());

  const getPart = (type) => parts.find((p) => p.type === type)?.value || "00";
  const todayKey = `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
  const minutesNow = Number(getPart("hour")) * 60 + Number(getPart("minute"));

  if (minutesNow >= 20 * 60 + 10 && lastFallbackReloadDate !== todayKey) {
    lastFallbackReloadDate = todayKey;
    applyTimelapseVersion(Date.now());
  }
}

function renderChart(metricKey) {
  const entry = historyCache[activeRange];
  const cfg = METRIC_CONFIG[metricKey];
  const canvas = document.getElementById("trend-chart");
  if (!entry || !cfg || !canvas) return;

  activeMetric = metricKey;
  const ctx = canvas.getContext("2d");

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: cfg.type,
    plugins: [thresholdLinesPlugin],
    data: {
      labels: entry.data.labels,
      datasets: [{
        label: cfg.label,
        data: entry.data[metricKey],
        borderColor: cfg.color,
        backgroundColor: cfg.bg,
        fill: cfg.type === "line",
        spanGaps: true,
        tension: 0.35,
        pointRadius: 0,
        pointHoverRadius: 4,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        thresholdLines: { lines: cfg.thresholds || [] },
      },
      scales: {
        x: {
          ticks: {
            color: "#94a3b8",
            autoSkip: true,
            maxTicksLimit: activeRange === "7d" ? 7 : 8,
            maxRotation: 0,
          },
          grid: { color: "rgba(148,163,184,0.08)" },
        },
        y: {
          beginAtZero: cfg.beginAtZero,
          suggestedMax: cfg.suggestedMax,
          ticks: {
            color: "#94a3b8",
            ...(cfg.integerTicks ? { precision: 0 } : {}),
          },
          grid: { color: "rgba(148,163,184,0.08)" },
        },
      },
    },
  });
}

async function fetchHistory(range = activeRange, force = false) {
  const cached = historyCache[range];
  const isFresh = cached && (Date.now() - cached.fetchedAt) < HISTORY_TTL_MS;

  if (!force && isFresh) {
    if (range === activeRange) renderChart(activeMetric);
    return;
  }

  try {
    const res = await fetch(`/api/history?range=${encodeURIComponent(range)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    historyCache[range] = { data, fetchedAt: Date.now() };
    if (range === activeRange) renderChart(activeMetric);
  } catch (err) {
    console.error(`History (${range}) fetch failed:`, err);
  }
}

function renderRecords(data) {
  const grid = document.getElementById("records-grid");
  const summary = document.getElementById("records-summary");
  if (!grid || !summary) return;

  const parts = [];
  if (data.period_label) parts.push(data.period_label);
  if (data.period_rain_mm !== null && data.period_rain_mm !== undefined) {
    const label = data.rain_label || "Rain";
    parts.push(`${label}: ${Number(data.period_rain_mm).toLocaleString()} mm`);
  }
  summary.textContent = parts.join(" · ") || "WeeWX summary";

  grid.innerHTML = "";
  data.items.forEach((item) => {
    const tile = document.createElement("div");
    tile.className = "record-tile";

    const label = document.createElement("div");
    label.className = "record-label";
    label.textContent = item.label;

    const value = document.createElement("div");
    value.className = `record-value tone-${item.tone || "accent"}`;
    value.textContent = item.value;

    tile.append(label, value);

    if (item.sub) {
      const sub = document.createElement("div");
      sub.className = "record-sub";
      sub.textContent = item.sub;
      tile.appendChild(sub);
    }

    const meta = document.createElement("div");
    meta.className = "record-meta";
    meta.textContent = item.meta;
    tile.appendChild(meta);

    grid.appendChild(tile);
  });
}

async function fetchRecords(period = activeRecordsPeriod, force = false) {
  const cached = recordsCache[period];
  const isFresh = cached && (Date.now() - cached.fetchedAt) < RECORDS_TTL_MS;

  if (!force && isFresh) {
    if (period === activeRecordsPeriod) renderRecords(cached.data);
    return;
  }

  try {
    const res = await fetch(`/api/records?period=${encodeURIComponent(period)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    recordsCache[period] = { data, fetchedAt: Date.now() };
    if (period === activeRecordsPeriod) renderRecords(data);
  } catch (err) {
    console.error(`Records (${period}) fetch failed:`, err);
    if (period === activeRecordsPeriod) {
      setText("records-summary", "Unavailable");
      const grid = document.getElementById("records-grid");
      if (grid) grid.innerHTML = `<div class="muted small">Unable to load station records.</div>`;
    }
  }
}

function renderForecastIcon(iconKey, isDay = true) {
  const sunCircle = `<circle cx="32" cy="32" r="11" fill="#fbbf24" />`;
  const sunRays = `
    <g stroke="#fbbf24" stroke-width="3" stroke-linecap="round">
      <line x1="32" y1="8" x2="32" y2="14" />
      <line x1="32" y1="50" x2="32" y2="56" />
      <line x1="8" y1="32" x2="14" y2="32" />
      <line x1="50" y1="32" x2="56" y2="32" />
      <line x1="15" y1="15" x2="19.5" y2="19.5" />
      <line x1="44.5" y1="44.5" x2="49" y2="49" />
      <line x1="49" y1="15" x2="44.5" y2="19.5" />
      <line x1="19.5" y1="44.5" x2="15" y2="49" />
    </g>
  `;
  const moonCrescent = `<path d="M36 16a14 14 0 1 0 11 22 11 11 0 1 1-11-22z" fill="#e2e8f0" />`;
  const smallSun = `<circle cx="43" cy="21" r="9" fill="#fbbf24" />`;
  const smallMoon = `<path d="M44 13a9 9 0 1 0 7 14 7 7 0 1 1-7-14z" fill="#e2e8f0" />`;
  const cloudLight = `
    <path d="M21 44h23a9 9 0 0 0 1.4-17.9A12 12 0 0 0 22.5 23a10 10 0 0 0-1.5 21z" fill="#cbd5e1" />
  `;
  const cloudDark = `
    <path d="M20 40h24a8.5 8.5 0 0 0 1.3-16.9A11.5 11.5 0 0 0 23.2 20a9.5 9.5 0 0 0-3.2 20z" fill="#94a3b8" />
  `;

  let inner = cloudLight;
  switch (iconKey) {
    case "clear":
      inner = isDay ? `${sunRays}${sunCircle}` : moonCrescent;
      break;
    case "mostly-clear":
    case "partly-cloudy":
      inner = `${isDay ? smallSun : smallMoon}${cloudLight}`;
      break;
    case "cloudy":
      inner = cloudDark;
      break;
    case "fog":
      inner = `
        ${cloudDark}
        <g stroke="#94a3b8" stroke-width="3" stroke-linecap="round">
          <line x1="14" y1="47" x2="50" y2="47" />
          <line x1="19" y1="53" x2="45" y2="53" />
        </g>
      `;
      break;
    case "drizzle":
      inner = `
        ${cloudDark}
        <g stroke="#60a5fa" stroke-width="2.6" stroke-linecap="round">
          <line x1="23" y1="46" x2="21" y2="51" />
          <line x1="33" y1="46" x2="31" y2="51" />
          <line x1="43" y1="46" x2="41" y2="51" />
        </g>
      `;
      break;
    case "rain":
    case "showers":
      inner = `
        ${iconKey === "showers" && isDay ? smallSun : ""}
        ${cloudDark}
        <g stroke="#38bdf8" stroke-width="3" stroke-linecap="round">
          <line x1="22" y1="45" x2="18" y2="54" />
          <line x1="32" y1="45" x2="28" y2="54" />
          <line x1="42" y1="45" x2="38" y2="54" />
        </g>
      `;
      break;
    case "snow":
      inner = `
        ${cloudLight}
        <g fill="#e0f2fe">
          <circle cx="22" cy="50" r="2.5" />
          <circle cx="32" cy="52" r="2.5" />
          <circle cx="42" cy="50" r="2.5" />
        </g>
      `;
      break;
    case "storm":
      inner = `
        ${cloudDark}
        <polygon points="34,39 25,51 31,51 28,60 40,46 34,46" fill="#fbbf24" />
      `;
      break;
    default:
      inner = cloudLight;
  }

  return `<svg viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
}

function renderForecast() {
  const body = document.getElementById("forecast-body");
  if (!body || !forecastData) return;

  setText(
    "forecast-title",
    activeForecastView === "24h"
      ? "Next 24 Hours — Ferny Grove"
      : "7-Day Forecast — Ferny Grove"
  );

  body.innerHTML = "";

  if (activeForecastView === "24h") {
    const strip = document.createElement("div");
    strip.className = "forecast-hourly-strip";

    (forecastData.hourly || []).forEach((hr, idx) => {
      const tile = document.createElement("div");
      tile.className = `forecast-hour-tile${idx === 0 ? " is-now" : ""}`;
      tile.title = hr.condition;

      const timeEl = document.createElement("div");
      timeEl.className = "fhour-time";
      timeEl.textContent = hr.time_label;

      const iconWrap = document.createElement("div");
      iconWrap.className = "forecast-icon";
      iconWrap.innerHTML = renderForecastIcon(hr.icon, hr.is_day);

      const tempEl = document.createElement("div");
      tempEl.className = "fhour-temp";
      tempEl.textContent = hr.temp_c !== null ? `${Math.round(hr.temp_c)}°` : "--";

      const rainEl = document.createElement("div");
      const hasRain = (hr.rain_chance || 0) >= 15 || (hr.rain_mm || 0) > 0;
      rainEl.className = `fhour-rain${hasRain ? "" : " is-dry"}`;
      rainEl.textContent =
        hr.rain_mm >= 0.2
          ? `${hr.rain_chance}% · ${hr.rain_mm}mm`
          : `${hr.rain_chance}% rain`;

      const gustEl = document.createElement("div");
      gustEl.className = "fhour-gust";
      gustEl.textContent = hr.wind_gust !== null ? `Gust ${hr.wind_gust} km/h` : "";

      tile.append(timeEl, iconWrap, tempEl, rainEl, gustEl);
      strip.appendChild(tile);
    });

    body.appendChild(strip);
    return;
  }

  // 7-Day Daily View with temperature range bars
  const grid = document.createElement("div");
  grid.className = "forecast-daily-grid";

  const weekMin = Number(forecastData.week_min ?? 0);
  const weekMax = Number(forecastData.week_max ?? 40);
  const weekSpan = Math.max(1, weekMax - weekMin);

  (forecastData.daily || []).forEach((day, idx) => {
    const tile = document.createElement("div");
    tile.className = `forecast-day-tile${idx === 0 ? " is-today" : ""}`;

    const head = document.createElement("div");
    head.className = "fday-head";
    const nameEl = document.createElement("span");
    nameEl.className = "fday-name";
    nameEl.textContent = day.day_label;
    const dateEl = document.createElement("span");
    dateEl.className = "fday-date";
    dateEl.textContent = day.date_short;
    head.append(nameEl, dateEl);

    const iconWrap = document.createElement("div");
    iconWrap.className = "forecast-icon";
    iconWrap.innerHTML = renderForecastIcon(day.icon, true);

    const condEl = document.createElement("div");
    condEl.className = "fday-cond";
    condEl.textContent = day.condition;

    // Temperature range bar scaled across the 7-day min/max window
    const rangeRow = document.createElement("div");
    rangeRow.className = "temp-range-row";

    const lowEl = document.createElement("span");
    lowEl.className = "temp-low-val";
    lowEl.textContent = day.min_c !== null ? `${Math.round(day.min_c)}°` : "--";

    const track = document.createElement("div");
    track.className = "temp-bar-track";

    if (day.min_c !== null && day.max_c !== null) {
      const leftPct = Math.max(0, Math.min(88, ((day.min_c - weekMin) / weekSpan) * 100));
      const rawWidth = ((day.max_c - day.min_c) / weekSpan) * 100;
      const widthPct = Math.max(12, Math.min(100 - leftPct, rawWidth));
      const fill = document.createElement("span");
      fill.className = "temp-bar-fill";
      fill.style.left = `${leftPct.toFixed(1)}%`;
      fill.style.width = `${widthPct.toFixed(1)}%`;
      track.appendChild(fill);
    }

    const highEl = document.createElement("span");
    highEl.className = "temp-high-val";
    highEl.textContent = day.max_c !== null ? `${Math.round(day.max_c)}°` : "--";

    rangeRow.append(lowEl, track, highEl);

    const meta = document.createElement("div");
    meta.className = "fday-meta";

    const rainEl = document.createElement("div");
    const hasRain = (day.rain_chance || 0) >= 20 || (day.rain_mm || 0) >= 0.2;
    rainEl.className = `fday-rain${hasRain ? "" : " is-dry"}`;
    rainEl.textContent =
      day.rain_mm >= 0.2
        ? `Rain: ${day.rain_chance}% (${day.rain_mm} mm)`
        : `Rain: ${day.rain_chance}%`;

    const windUvEl = document.createElement("div");
    const parts = [];
    if (day.wind_gust !== null) parts.push(`Gust ${day.wind_gust} km/h`);
    if (day.uv_max !== null) parts.push(`UV ${Math.round(day.uv_max)}`);
    windUvEl.textContent = parts.join(" · ");

    meta.append(rainEl, windUvEl);

    tile.append(head, iconWrap, condEl, rangeRow, meta);
    grid.appendChild(tile);
  });

  body.appendChild(grid);
}

async function fetchForecast() {
  try {
    const res = await fetch("/api/forecast", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    forecastData = await res.json();
    setText(
      "forecast-updated",
      forecastData.updated_display
        ? `Updated ${forecastData.updated_display} · Open-Meteo`
        : "Open-Meteo"
    );
    renderForecast();
  } catch (err) {
    console.error("Forecast fetch failed:", err);
    setText("forecast-updated", "Unavailable");
    const body = document.getElementById("forecast-body");
    if (body) {
      body.innerHTML = `<div class="muted small">Unable to load Ferny Grove forecast.</div>`;
    }
  }
}

async function fetchCapitals() {
  const grid = document.getElementById("capitals-grid");
  if (!grid) return;

  try {
    const res = await fetch("/api/capitals", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    setText("capitals-updated", data.updated_display || "--");
    grid.innerHTML = "";

    data.cities.forEach((city) => {
      const tile = document.createElement("div");
      tile.className = "capital-tile";

      const top = document.createElement("div");
      top.className = "capital-top";

      const title = document.createElement("div");
      const nameSpan = document.createElement("span");
      nameSpan.className = "capital-name";
      nameSpan.textContent = city.name;
      const stateSpan = document.createElement("span");
      stateSpan.className = "capital-state";
      stateSpan.textContent = city.state;
      title.append(nameSpan, stateSpan);

      const nowWrap = document.createElement("div");
      nowWrap.className = "capital-now";
      if (city.icon) {
        const img = document.createElement("img");
        img.src = city.icon;
        img.alt = city.condition;
        img.loading = "lazy";
        nowWrap.appendChild(img);
      }
      const tempSpan = document.createElement("span");
      tempSpan.className = "capital-temp";
      tempSpan.textContent = `${city.temp_c}°`;
      nowWrap.appendChild(tempSpan);

      top.append(title, nowWrap);

      const cond = document.createElement("div");
      cond.className = "capital-cond";
      cond.textContent = city.condition;

      const forecast = document.createElement("div");
      forecast.className = "capital-forecast";
      const rangeSpan = document.createElement("span");
      rangeSpan.textContent = `Today: ${city.min_c}° / ${city.max_c}°`;
      const rainSpan = document.createElement("span");
      rainSpan.textContent = `Rain: ${city.rain_chance}%`;
      forecast.append(rangeSpan, rainSpan);

      tile.append(top, cond, forecast);
      grid.appendChild(tile);
    });
  } catch (err) {
    console.error("Capitals fetch failed:", err);
    grid.innerHTML = `<div class="muted small">Unable to load capital city forecasts.</div>`;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Attach all UI listeners first so controls are always interactive
  document.getElementById("btn-refresh-cam")?.addEventListener("click", refreshCam);

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextRange = btn.dataset.range;
      if (!nextRange || nextRange === activeRange) return;

      activeRange = nextRange;
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setText("chart-title", nextRange === "7d" ? "7-Day Trends" : "24-Hour Trends");
      fetchHistory(activeRange);
    });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextMetric = btn.dataset.metric;
      if (!nextMetric || !METRIC_CONFIG[nextMetric]) return;

      activeMetric = nextMetric;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderChart(activeMetric);
    });
  });

  document.querySelectorAll(".period-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextPeriod = btn.dataset.period;
      if (!nextPeriod || nextPeriod === activeRecordsPeriod) return;

      activeRecordsPeriod = nextPeriod;
      document.querySelectorAll(".period-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      setText("records-title", RECORDS_TITLES[nextPeriod] || "Station Records");
      fetchRecords(activeRecordsPeriod);
    });
  });

  document.querySelectorAll(".forecast-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextView = btn.dataset.view;
      if (!nextView || nextView === activeForecastView) return;

      activeForecastView = nextView;
      document.querySelectorAll(".forecast-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderForecast();
    });
  });

  // Initial data fetches & refresh schedules
  fetchWeather();
  fetchHistory(activeRange, true);
  refreshCam();
  fetchRecords(activeRecordsPeriod, true);
  fetchCapitals();
  fetchForecast();

  setInterval(fetchWeather, 60 * 1000);
  setInterval(refreshCam, 5 * 60 * 1000);
  setInterval(() => fetchHistory(activeRange, true), HISTORY_TTL_MS);
  setInterval(() => fetchRecords(activeRecordsPeriod, true), 15 * 60 * 1000);
  setInterval(fetchCapitals, 15 * 60 * 1000);
  setInterval(updateSunCountdown, 30 * 1000);
  setInterval(fetchForecast, 30 * 60 * 1000);
});