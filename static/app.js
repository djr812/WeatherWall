let trendChart = null;
let activeMetric = "temp";
let activeRange = "24h";

const historyCache = {};

const HISTORY_TTL_MS = 5 * 60 * 1000;

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
  },
  pm10: {
    label: "PM10 (µg/m³)",
    color: "#a78bfa",
    bg: "rgba(167, 139, 250, 0.14)",
    type: "line",
    beginAtZero: true,
  },
};

function fmt(val, fallback = "--") {
  return val === null || val === undefined ? fallback : val;
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
  // pm10
  if (n <= 25) return { label: "Good", cls: "lvl-good" };
  if (n <= 50) return { label: "Fair", cls: "lvl-fair" };
  if (n <= 100) return { label: "Poor", cls: "lvl-poor" };
  return { label: "Very Poor", cls: "lvl-bad" };
}

function setAqiBadge(id, rating) {
  const el = document.getElementById(id);
  el.textContent = rating.label;
  el.className = `aqi-pill ${rating.cls}`;
}

async function fetchWeather() {
  const pill = document.getElementById("status-pill");
  const statusText = document.getElementById("status-text");

  try {
    const res = await fetch("/api/weather", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();

    document.getElementById("temp-value").textContent = fmt(d.temp);
    document.getElementById("feels-like").textContent = fmt(d.feels_like);
    document.getElementById("dewpoint-value").textContent = fmt(d.dewpoint);
    document.getElementById("temp-high").textContent = `${fmt(d.temp_high)}°C`;
    document.getElementById("temp-low").textContent = `${fmt(d.temp_low)}°C`;

    document.getElementById("humidity-value").textContent = fmt(d.humidity);
    document.getElementById("barometer-value").textContent = fmt(d.barometer);
    const deltaSign = d.barometer_delta > 0 ? "+" : "";
    document.getElementById("barometer-trend").textContent =
      `${d.barometer_trend} (${deltaSign}${d.barometer_delta} hPa)`;

    document.getElementById("rain-today").textContent = fmt(d.rain_today, "0.0");
    document.getElementById("rain-rate").textContent = fmt(d.rain_rate, "0.0");
    document.getElementById("uv-value").textContent = fmt(d.uv);
    document.getElementById("solar-value").textContent = fmt(d.solar);

    document.getElementById("co2-value").textContent = fmt(d.co2);
    document.getElementById("co2-max").textContent = fmt(d.co2_max);
    document.getElementById("pm10-value").textContent = fmt(d.pm10_0);
    document.getElementById("pm10-max").textContent = fmt(d.pm10_0_max);

    const rCo2 = rateAirMetric("co2", d.co2);
    const rPm10 = rateAirMetric("pm10", d.pm10_0);
    setAqiBadge("co2-status", rCo2);
    setAqiBadge("pm10-status", rPm10);

    const severity = ["", "lvl-good", "lvl-fair", "lvl-poor", "lvl-bad"];
    const worst = [rCo2, rPm10].reduce((a, b) =>
      severity.indexOf(b.cls) > severity.indexOf(a.cls) ? b : a
    );
    const overall = document.getElementById("aqi-overall");
    overall.textContent = worst.label;
    overall.className = `badge aqi-badge ${worst.cls}`;

    document.getElementById("wind-speed").textContent = fmt(d.wind_speed, "0");
    document.getElementById("wind-gust").textContent = fmt(d.wind_gust, "0");
    document.getElementById("wind-max-gust").textContent = fmt(d.wind_max_gust, "0");
    document.getElementById("wind-dir-text").textContent =
      `${d.wind_dir_cardinal} (${d.wind_dir_deg}°)`;
    document.getElementById("wind-arrow").setAttribute(
      "transform",
      `rotate(${d.wind_dir_deg} 60 60)`
    );

    document.getElementById("last-updated").textContent = d.updated_display;

    if (d.age_minutes > 15) {
      pill.classList.add("stale");
      statusText.textContent = `Delayed (${d.age_minutes}m ago)`;
    } else {
      pill.classList.remove("stale");
      statusText.textContent = "Live";
    }
  } catch (err) {
    pill.classList.add("stale");
    statusText.textContent = "Offline";
    console.error("Weather fetch failed:", err);
  }
}

function refreshCam() {
  const img = document.getElementById("cam-image");
  // Cache-busting timestamp ensures the browser fetches the fresh 5-min snapshot
  img.src = `/api/cam/latest?t=${Date.now()}`;
  document.getElementById("cam-timestamp").textContent =
    new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function renderChart(metricKey) {
  const entry = historyCache[activeRange];
  if (!entry) return;

  activeMetric = metricKey;
  const cfg = METRIC_CONFIG[metricKey];
  const ctx = document.getElementById("trend-chart").getContext("2d");

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: cfg.type,
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
      plugins: { legend: { display: false } },
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
          ticks: { color: "#94a3b8" },
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

async function fetchCapitals() {
  const grid = document.getElementById("capitals-grid");
  try {
    const res = await fetch("/api/capitals", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    document.getElementById("capitals-updated").textContent = data.updated_display || "--";
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
  fetchWeather();
  fetchHistory(activeRange, true);
  refreshCam();
  fetchCapitals();

  setInterval(fetchWeather, 60 * 1000);
  setInterval(refreshCam, 5 * 60 * 1000);
  setInterval(() => fetchHistory(activeRange, true), HISTORY_TTL_MS);
  setInterval(fetchCapitals, 15 * 60 * 1000);

  document.getElementById("btn-refresh-cam")?.addEventListener("click", refreshCam);

  document.querySelectorAll(".range-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nextRange = btn.dataset.range;
      if (nextRange === activeRange) return;

      activeRange = nextRange;
      document.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById("chart-title").textContent =
        nextRange === "7d" ? "7-Day Trends" : "24-Hour Trends";
      fetchHistory(activeRange);
    });
  });

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeMetric = btn.dataset.metric;
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderChart(activeMetric);
    });
  });
});
