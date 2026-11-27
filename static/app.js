let trendChart = null;
let activeMetric = "temp";
let activeRange = "24h";
const historyCache = {};
const HISTORY_TTL_MS = 5 * 60 * 1000;

let activeRecordsPeriod = "all";
const recordsCache = {};
const RECORDS_TTL_MS = 10 * 60 * 1000;

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
  setText("cam-timestamp", new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
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

  // Initial data fetches & refresh schedules
  fetchWeather();
  fetchHistory(activeRange, true);
  refreshCam();
  fetchRecords(activeRecordsPeriod, true);
  fetchCapitals();

  setInterval(fetchWeather, 60 * 1000);
  setInterval(refreshCam, 5 * 60 * 1000);
  setInterval(() => fetchHistory(activeRange, true), HISTORY_TTL_MS);
  setInterval(() => fetchRecords(activeRecordsPeriod, true), 15 * 60 * 1000);
  setInterval(fetchCapitals, 15 * 60 * 1000);
});