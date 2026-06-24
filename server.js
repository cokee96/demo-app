const http = require('http');
const os = require('os');

// Simple in-memory counters for Prometheus metrics
let requestsTotal = 0;
let requestsByStatus = { '200': 0, '404': 0, '500': 0 };
let requestDurationBuckets = { '0.005': 0, '0.01': 0, '0.025': 0, '0.05': 0, '0.1': 0, '0.25': 0, '0.5': 0, '1': 0, '2.5': 0, '5': 0, '10': 0, '+Inf': 0 };
let requestDurationSum = 0;
let requestDurationCount = 0;
const startTime = Date.now();

function recordRequest(status, durationSec) {
  requestsTotal++;
  requestsByStatus[String(status)] = (requestsByStatus[String(status)] || 0) + 1;
  requestDurationSum += durationSec;
  requestDurationCount++;
  for (const le of Object.keys(requestDurationBuckets)) {
    if (le === '+Inf' || durationSec <= parseFloat(le)) {
      requestDurationBuckets[le]++;
    }
  }
}

function metricsPage() {
  const uptime = (Date.now() - startTime) / 1000;
  const mem = process.memoryUsage();
  let out = '';

  out += '# HELP http_requests_total Total HTTP requests\n';
  out += '# TYPE http_requests_total counter\n';
  for (const [status, count] of Object.entries(requestsByStatus)) {
    out += `http_requests_total{status="${status}",service="demo-app"} ${count}\n`;
  }

  out += '# HELP http_request_duration_seconds HTTP request duration\n';
  out += '# TYPE http_request_duration_seconds histogram\n';
  for (const [le, count] of Object.entries(requestDurationBuckets)) {
    out += `http_request_duration_seconds_bucket{le="${le}",service="demo-app"} ${count}\n`;
  }
  out += `http_request_duration_seconds_sum{service="demo-app"} ${requestDurationSum.toFixed(6)}\n`;
  out += `http_request_duration_seconds_count{service="demo-app"} ${requestDurationCount}\n`;

  out += '# HELP process_uptime_seconds Uptime in seconds\n';
  out += '# TYPE process_uptime_seconds gauge\n';
  out += `process_uptime_seconds{service="demo-app"} ${uptime.toFixed(2)}\n`;

  out += '# HELP process_resident_memory_bytes Resident memory\n';
  out += '# TYPE process_resident_memory_bytes gauge\n';
  out += `process_resident_memory_bytes{service="demo-app"} ${mem.rss}\n`;

  return out;
}

const server = http.createServer((req, res) => {
  const start = Date.now();

  if (req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', hostname: os.hostname(), uptime: process.uptime() }));
    recordRequest(200, (Date.now() - start) / 1000);
    return;
  }

  if (req.url === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
    res.end(metricsPage());
    // Don't count /metrics in request metrics to avoid noise
    return;
  }

  if (req.url === '/') {
    // Simulate variable latency
    const delay = Math.random() * 50;
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        message: 'Hello from demo-app',
        hostname: os.hostname(),
        version: process.env.APP_VERSION || '1.0.0',
        env: process.env.APP_ENV || 'local',
      }));
      recordRequest(200, (Date.now() - start) / 1000);
    }, delay);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found', path: req.url }));
  recordRequest(404, (Date.now() - start) / 1000);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`demo-app listening on :${PORT}`);
  console.log(`  GET /        → JSON response`);
  console.log(`  GET /healthz → health check`);
  console.log(`  GET /metrics → Prometheus metrics`);
});
