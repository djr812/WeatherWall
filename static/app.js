let trendChart = null;
let cachedHistory = null;
let activeMetric = "temp";

const METRIC_CONFIG = {
  temp: { label: "Temperature (°C)", color: "#fb923c", type: "line" },
  barometer: { label: "Barometer (hPa)", color: "#38bdf8", type: "line" },
  rain: { label: "Rainfall (mm)", color: "#60a5fa", type: "bar" },
};

function fmt(val, fallback = "--") {
  return val === null || val === undefined ? fallback : val;
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
  if (!cachedHistory) return;
  activeMetric = metricKey;
  const cfg = METRIC_CONFIG[metricKey];
  const ctx = document.getElementById("trend-chart").getContext("2d");

  if (trendChart) trendChart.destroy();

  trendChart = new Chart(ctx, {
    type: cfg.type,
    data: {
      labels: cachedHistory.labels,
      datasets: [{
        label: cfg.label,
        data: cachedHistory[metricKey],
        borderColor: cfg.color,
        backgroundColor: cfg.type === "bar" ? "rgba(96, 165, 250, 0.55)" : "rgba(56, 189, 248, 0.12)",
        fill: cfg.type === "line",
        tension: 0.35,
        pointRadius: 0,
        borderWidth: 2,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { color: "rgba(148,163,184,0.08)" } },
        y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.08)" } },
      },
    },
  });
}

async function fetchHistory() {
  try {
    const res = await fetch("/api/history", { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    cachedHistory = await res.json();
    renderChart(activeMetric);
  } catch (err) {
    console.error("History fetch failed:", err);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  fetchWeather();
  fetchHistory();
  refreshCam();

  // Telemetry every 60s, Webcam and Charts every 5 minutes
  setInterval(fetchWeather, 60 * 1000);
  setInterval(refreshCam, 5 * 60 * 1000);
  setInterval(fetchHistory, 5 * 60 * 1000);

  document.getElementById("btn-refresh-cam").addEventListener("click", refreshCam);
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      renderChart(btn.dataset.metric);
    });
  });
});
