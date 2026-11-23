// prometheus metrics at /metrics, collected by the platform when PROMETHEUS_METRICS=true.
// request counts and timings come for free; count() records the app's own events.
const client = require('prom-client');

const registry = new client.Registry();
client.collectDefaultMetrics({ register: registry, prefix: 'app_' });

const requests = new client.Counter({
  name: 'app_http_requests_total',
  help: 'requests served, by method, route and status',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});
const duration = new client.Histogram({
  name: 'app_http_request_duration_seconds',
  help: 'time to answer a request, by method and route',
  labelNames: ['method', 'route'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [registry],
});

// route is the express pattern (/api/items/:id), never the raw url, so ids can't explode the series count
function middleware(req, res, next) {
  const start = process.hrtime.bigint();
  let route = 'unmatched';
  // taken when express matches a route, while baseUrl is still the router's mount (/api);
  // by 'finish', or in an error handler, express has reset it and /api/items would read as /items.
  let matched;
  Object.defineProperty(req, 'route', {
    configurable: true,
    enumerable: true,
    get: () => matched,
    set: (r) => { matched = r; if (r) route = (req.baseUrl || '') + r.path; },
  });
  res.on('finish', () => {
    if (req.path === '/metrics' || req.path === '/health') return;
    const secs = Number(process.hrtime.bigint() - start) / 1e9;
    requests.inc({ method: req.method, route, status: String(res.statusCode) });
    duration.observe({ method: req.method, route }, secs);
  });
  next();
}

// the platform scrapes the pod directly; through the public url ingress adds these headers, so answer 404
async function handler(req, res) {
  if (req.get('x-forwarded-for') || req.get('x-real-ip')) return res.status(404).end();
  res.set('Content-Type', registry.contentType);
  res.end(await registry.metrics());
}

const counters = new Map();
// count('orders_created_total', 'orders placed') at the moment the thing happens; labels must be a small fixed set
function count(name, help = name, labels = {}) {
  let c = counters.get(name);
  if (!c) {
    c = new client.Counter({ name, help, labelNames: Object.keys(labels), registers: [registry] });
    counters.set(name, c);
  }
  c.inc(labels);
}

module.exports = { middleware, handler, count };
