const http = require('http');
const https = require('https');
const os = require('os');

// ── Prometheus metrics ────────────────────────────────────────────────────────
let requestsByStatus = { '200': 0, '404': 0, '500': 0 };
let requestDurationBuckets = { '0.005': 0, '0.01': 0, '0.025': 0, '0.05': 0, '0.1': 0, '0.25': 0, '0.5': 0, '1': 0, '2.5': 0, '5': 0, '10': 0, '+Inf': 0 };
let requestDurationSum = 0;
let requestDurationCount = 0;
let weatherApiCalls = 0;
let weatherApiErrors = 0;
let weatherApiDurationSum = 0;
let lastTemperature = null;
let lastHumidity = null;
let lastWindSpeed = null;
const startTime = Date.now();

function recordRequest(status, durationSec) {
  requestsByStatus[String(status)] = (requestsByStatus[String(status)] || 0) + 1;
  requestDurationSum += durationSec;
  requestDurationCount++;
  for (const le of Object.keys(requestDurationBuckets)) {
    if (le === '+Inf' || durationSec <= parseFloat(le)) requestDurationBuckets[le]++;
  }
}

function metricsPage() {
  const uptime = (Date.now() - startTime) / 1000;
  const mem = process.memoryUsage();
  let out = '';

  out += '# HELP http_requests_total Total HTTP requests\n# TYPE http_requests_total counter\n';
  for (const [status, count] of Object.entries(requestsByStatus)) {
    out += `http_requests_total{status="${status}",service="demo-app"} ${count}\n`;
  }

  out += '# HELP http_request_duration_seconds HTTP request duration\n# TYPE http_request_duration_seconds histogram\n';
  for (const [le, count] of Object.entries(requestDurationBuckets)) {
    out += `http_request_duration_seconds_bucket{le="${le}",service="demo-app"} ${count}\n`;
  }
  out += `http_request_duration_seconds_sum{service="demo-app"} ${requestDurationSum.toFixed(6)}\n`;
  out += `http_request_duration_seconds_count{service="demo-app"} ${requestDurationCount}\n`;

  out += '# HELP weather_api_calls_total Total calls to Open-Meteo API\n# TYPE weather_api_calls_total counter\n';
  out += `weather_api_calls_total{service="demo-app"} ${weatherApiCalls}\n`;

  out += '# HELP weather_api_errors_total Failed calls to Open-Meteo API\n# TYPE weather_api_errors_total counter\n';
  out += `weather_api_errors_total{service="demo-app"} ${weatherApiErrors}\n`;

  out += '# HELP weather_api_duration_seconds_sum Total time spent calling Open-Meteo\n# TYPE weather_api_duration_seconds_sum gauge\n';
  out += `weather_api_duration_seconds_sum{service="demo-app"} ${weatherApiDurationSum.toFixed(3)}\n`;

  if (lastTemperature !== null) {
    out += '# HELP weather_temperature_celsius Current temperature in Madrid\n# TYPE weather_temperature_celsius gauge\n';
    out += `weather_temperature_celsius{city="madrid",service="demo-app"} ${lastTemperature}\n`;
    out += '# HELP weather_humidity_percent Current relative humidity in Madrid\n# TYPE weather_humidity_percent gauge\n';
    out += `weather_humidity_percent{city="madrid",service="demo-app"} ${lastHumidity}\n`;
    out += '# HELP weather_wind_speed_kmh Current wind speed in Madrid\n# TYPE weather_wind_speed_kmh gauge\n';
    out += `weather_wind_speed_kmh{city="madrid",service="demo-app"} ${lastWindSpeed}\n`;
  }

  out += '# HELP process_uptime_seconds Uptime in seconds\n# TYPE process_uptime_seconds gauge\n';
  out += `process_uptime_seconds{service="demo-app"} ${uptime.toFixed(2)}\n`;
  out += '# HELP process_resident_memory_bytes Resident memory\n# TYPE process_resident_memory_bytes gauge\n';
  out += `process_resident_memory_bytes{service="demo-app"} ${mem.rss}\n`;

  return out;
}

// ── Open-Meteo API ────────────────────────────────────────────────────────────
const OPEN_METEO_URL =
  'https://api.open-meteo.com/v1/forecast' +
  '?latitude=40.4168&longitude=-3.7038' +
  '&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,precipitation_probability,weather_code' +
  '&daily=temperature_2m_max,temperature_2m_min,sunrise,sunset' +
  '&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code,precipitation' +
  '&timezone=Europe%2FMadrid&forecast_days=1';

const WMO_CODES = {
  0: 'Despejado', 1: 'Mayormente despejado', 2: 'Parcialmente nublado', 3: 'Nublado',
  45: 'Niebla', 48: 'Niebla con escarcha',
  51: 'Llovizna ligera', 53: 'Llovizna moderada', 55: 'Llovizna intensa',
  61: 'Lluvia ligera', 63: 'Lluvia moderada', 65: 'Lluvia fuerte',
  71: 'Nieve ligera', 73: 'Nieve moderada', 75: 'Nevada intensa',
  80: 'Chubascos ligeros', 81: 'Chubascos', 82: 'Chubascos fuertes',
  95: 'Tormenta', 96: 'Tormenta con granizo', 99: 'Tormenta fuerte con granizo',
};

const WMO_EMOJI = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌦️', 55: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '❄️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

function fetchWeather() {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    weatherApiCalls++;
    https.get(OPEN_METEO_URL, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        weatherApiDurationSum += (Date.now() - t0) / 1000;
        try {
          const data = JSON.parse(body);
          const cur = data.current;
          const hourly = data.hourly;
          const daily = data.daily;
          const now = new Date();
          const currentHour = now.getHours();

          // Current conditions
          lastTemperature = cur.temperature_2m;
          lastHumidity = cur.relative_humidity_2m;
          lastWindSpeed = cur.wind_speed_10m;

          // Hourly forecast (next 24h, grouped every 3h for readability)
          const hourlyForecast = [];
          for (let i = 0; i < 24; i += 3) {
            const idx = hourly.time.findIndex(t => t.endsWith(`T${String(i).padStart(2,'0')}:00`));
            if (idx !== -1) {
              hourlyForecast.push({
                hour: `${String(i).padStart(2,'0')}:00`,
                temp: hourly.temperature_2m[idx],
                humidity: hourly.relative_humidity_2m[idx],
                wind: hourly.wind_speed_10m[idx],
                rain_prob: hourly.precipitation_probability[idx],
                code: hourly.weather_code[idx],
                emoji: WMO_EMOJI[hourly.weather_code[idx]] || '🌡️',
                condition: WMO_CODES[hourly.weather_code[idx]] || 'Variable',
              });
            }
          }

          resolve({
            city: 'Madrid',
            updated: now.toISOString(),
            current: {
              temp: cur.temperature_2m,
              humidity: cur.relative_humidity_2m,
              wind: cur.wind_speed_10m,
              precipitation: cur.precipitation,
              code: cur.weather_code,
              emoji: WMO_EMOJI[cur.weather_code] || '🌡️',
              condition: WMO_CODES[cur.weather_code] || 'Variable',
            },
            daily: {
              max: daily.temperature_2m_max[0],
              min: daily.temperature_2m_min[0],
              sunrise: daily.sunrise[0],
              sunset: daily.sunset[0],
            },
            hourly: hourlyForecast,
          });
        } catch (e) {
          weatherApiErrors++;
          reject(e);
        }
      });
    }).on('error', (e) => {
      weatherApiErrors++;
      weatherApiDurationSum += (Date.now() - t0) / 1000;
      reject(e);
    });
  });
}

// ── Cache de 5 minutos para no saturar Open-Meteo ─────────────────────────────
let weatherCache = null;
let weatherCacheTime = 0;

async function getWeather() {
  if (weatherCache && (Date.now() - weatherCacheTime) < 5 * 60 * 1000) {
    return weatherCache;
  }
  weatherCache = await fetchWeather();
  weatherCacheTime = Date.now();
  return weatherCache;
}

// ── HTML ──────────────────────────────────────────────────────────────────────
function renderHTML(w) {
  const hourlyRows = w.hourly.map(h => `
    <div class="hour-card ${h.rain_prob > 50 ? 'rainy' : ''}">
      <div class="hour-time">${h.hour}</div>
      <div class="hour-emoji">${h.emoji}</div>
      <div class="hour-temp">${h.temp}°</div>
      <div class="hour-detail">💧 ${h.humidity}%</div>
      <div class="hour-detail">🌬️ ${h.wind} km/h</div>
      <div class="hour-detail ${h.rain_prob > 50 ? 'rain-warn' : ''}">🌧️ ${h.rain_prob}%</div>
    </div>`).join('');

  const sunriseTime = w.daily.sunrise ? w.daily.sunrise.split('T')[1] : '--:--';
  const sunsetTime  = w.daily.sunset  ? w.daily.sunset.split('T')[1]  : '--:--';
  const updatedStr  = new Date(w.updated).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tiempo en Madrid — demo-app</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
      min-height: 100vh;
      color: #e0e0e0;
      padding: 2rem 1rem;
    }
    .container { max-width: 860px; margin: 0 auto; }

    .header { text-align: center; margin-bottom: 2rem; }
    .header h1 { font-size: 1.1rem; color: #8ab4f8; letter-spacing: 0.15em; text-transform: uppercase; margin-bottom: 0.5rem; }
    .header .city { font-size: 2.8rem; font-weight: 700; color: #fff; }

    .current-card {
      background: rgba(255,255,255,0.07);
      border: 1px solid rgba(255,255,255,0.12);
      border-radius: 20px;
      padding: 2rem;
      display: flex;
      align-items: center;
      gap: 2rem;
      margin-bottom: 1.5rem;
      backdrop-filter: blur(10px);
    }
    .current-emoji { font-size: 5rem; line-height: 1; }
    .current-temp { font-size: 5rem; font-weight: 200; color: #fff; line-height: 1; }
    .current-info { flex: 1; }
    .current-condition { font-size: 1.4rem; color: #fff; margin-bottom: 0.8rem; }
    .current-details { display: flex; gap: 1.5rem; flex-wrap: wrap; }
    .detail-item { display: flex; flex-direction: column; }
    .detail-label { font-size: 0.75rem; color: #8ab4f8; text-transform: uppercase; letter-spacing: 0.1em; }
    .detail-value { font-size: 1.1rem; color: #fff; font-weight: 500; }

    .stats-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .stat-card {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      padding: 1.2rem;
      text-align: center;
    }
    .stat-icon { font-size: 1.5rem; margin-bottom: 0.3rem; }
    .stat-value { font-size: 1.3rem; font-weight: 600; color: #fff; }
    .stat-label { font-size: 0.75rem; color: #9aa5b4; margin-top: 0.2rem; }

    .section-title {
      font-size: 0.85rem;
      color: #8ab4f8;
      text-transform: uppercase;
      letter-spacing: 0.15em;
      margin-bottom: 1rem;
    }
    .hourly-scroll { display: flex; gap: 0.75rem; overflow-x: auto; padding-bottom: 0.5rem; }
    .hourly-scroll::-webkit-scrollbar { height: 4px; }
    .hourly-scroll::-webkit-scrollbar-track { background: rgba(255,255,255,0.05); border-radius: 2px; }
    .hourly-scroll::-webkit-scrollbar-thumb { background: rgba(138,180,248,0.4); border-radius: 2px; }

    .hour-card {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 14px;
      padding: 1rem 0.8rem;
      text-align: center;
      min-width: 90px;
      flex-shrink: 0;
      transition: background 0.2s;
    }
    .hour-card.rainy { border-color: rgba(100,160,255,0.3); background: rgba(100,160,255,0.08); }
    .hour-time { font-size: 0.8rem; color: #8ab4f8; font-weight: 600; margin-bottom: 0.4rem; }
    .hour-emoji { font-size: 1.6rem; margin-bottom: 0.4rem; }
    .hour-temp { font-size: 1.2rem; font-weight: 600; color: #fff; margin-bottom: 0.4rem; }
    .hour-detail { font-size: 0.75rem; color: #9aa5b4; margin-top: 0.15rem; }
    .rain-warn { color: #8ab4f8; }

    .footer {
      margin-top: 2rem;
      text-align: center;
      font-size: 0.75rem;
      color: #556;
    }
    .footer a { color: #8ab4f8; text-decoration: none; }
    .pod-info { margin-top: 0.5rem; font-family: monospace; }

    @media (max-width: 600px) {
      .current-card { flex-direction: column; text-align: center; gap: 1rem; }
      .current-details { justify-content: center; }
      .stats-row { grid-template-columns: repeat(2, 1fr); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>demo-app · Kubernetes · GitOps</h1>
      <div class="city">☁️ Madrid</div>
    </div>

    <div class="current-card">
      <div class="current-emoji">${w.current.emoji}</div>
      <div class="current-temp">${w.current.temp}°C</div>
      <div class="current-info">
        <div class="current-condition">${w.current.condition}</div>
        <div class="current-details">
          <div class="detail-item">
            <span class="detail-label">Humedad</span>
            <span class="detail-value">${w.current.humidity}%</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Viento</span>
            <span class="detail-value">${w.current.wind} km/h</span>
          </div>
          <div class="detail-item">
            <span class="detail-label">Precipitación</span>
            <span class="detail-value">${w.current.precipitation} mm</span>
          </div>
        </div>
      </div>
    </div>

    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-icon">🌡️</div>
        <div class="stat-value">${w.daily.max}°</div>
        <div class="stat-label">Máxima</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🧊</div>
        <div class="stat-value">${w.daily.min}°</div>
        <div class="stat-label">Mínima</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🌅</div>
        <div class="stat-value">${sunriseTime}</div>
        <div class="stat-label">Amanecer</div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🌇</div>
        <div class="stat-value">${sunsetTime}</div>
        <div class="stat-label">Atardecer</div>
      </div>
    </div>

    <p class="section-title">Previsión por horas</p>
    <div class="hourly-scroll">${hourlyRows}</div>

    <div class="footer">
      Datos: <a href="https://open-meteo.com" target="_blank">Open-Meteo</a> · actualizado a las ${updatedStr}
      <div class="pod-info">pod: ${os.hostname()} · versión: ${process.env.APP_VERSION || '2.0.0'}</div>
    </div>
  </div>
  <script>setTimeout(() => location.reload(), 5 * 60 * 1000);</script>
</body>
</html>`;
}

// ── Servidor ──────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const start = Date.now();
  const url = req.url.split('?')[0];

  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hostname: os.hostname(), uptime: process.uptime() }));
    recordRequest(200, (Date.now() - start) / 1000);
    return;
  }

  if (url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metricsPage());
    return;
  }

  if (url === '/weather') {
    try {
      const w = await getWeather();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(w, null, 2));
      recordRequest(200, (Date.now() - start) / 1000);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Weather API unavailable', detail: e.message }));
      recordRequest(500, (Date.now() - start) / 1000);
    }
    return;
  }

  if (url === '/') {
    try {
      const w = await getWeather();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHTML(w));
      recordRequest(200, (Date.now() - start) / 1000);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Weather API unavailable', detail: e.message }));
      recordRequest(500, (Date.now() - start) / 1000);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: url }));
  recordRequest(404, (Date.now() - start) / 1000);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`demo-app listening on :${PORT}`);
  console.log(`  GET /         → Tiempo en Madrid (HTML)`);
  console.log(`  GET /weather  → Tiempo en Madrid (JSON)`);
  console.log(`  GET /healthz  → health check`);
  console.log(`  GET /metrics  → Prometheus metrics`);
});
