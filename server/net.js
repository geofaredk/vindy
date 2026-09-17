// Shared HTTP agent: keep-alive connection pool + cached DNS. Without this, bursts of
// parallel range requests trigger one DNS lookup per socket, which the macOS resolver
// throttles (ENOTFOUND) and slows everything down.
import dns from 'node:dns';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Agent, setGlobalDispatcher } from 'undici';

const dnsCache = new Map();
function lookup(hostname, options, cb) {
  const key = `${hostname}|${options.family || 0}|${options.all ? 1 : 0}`;
  const hit = dnsCache.get(key);
  if (hit && hit.expires > Date.now()) return process.nextTick(cb, null, ...hit.args);
  dns.lookup(hostname, options, (err, ...args) => {
    if (err) {
      if (hit) return cb(null, ...hit.args); // serve stale on failure
      return cb(err);
    }
    dnsCache.set(key, { args, expires: Date.now() + 5 * 60e3 });
    cb(null, ...args);
  });
}

const agentOptions = { pipelining: 1, keepAliveTimeout: 30e3, keepAliveMaxTimeout: 120e3, connect: { lookup, timeout: 15e3 } };

// Interactive requests (map fields, point forecasts) use the main pool.
setGlobalDispatcher(new Agent({ ...agentOptions, connections: 32 }));

// Background pre-computation runs in its own, smaller pool so a model-run warm-up
// can never starve what a visitor is waiting for.
const backgroundAgent = new Agent({ ...agentOptions, connections: 6 });
const lane = new AsyncLocalStorage();

export const inBackground = fn => lane.run(backgroundAgent, fn);
export const dispatcher = () => lane.getStore();

// Visitors go first: background warm-up waits (briefly) before starting each step while
// API requests from visitors are in flight, so preparing a new model run never makes the
// map feel slow. The wait is capped so warm-up still progresses on a busy server.
let activeRequests = 0;
let idleWaiters = [];
export function trackRequest(res) {
  activeRequests++;
  res.once('close', () => {
    if (--activeRequests === 0) { const w = idleWaiters; idleWaiters = []; w.forEach(r => r()); }
  });
}
export function whenIdle(maxWait = 2000) {
  if (activeRequests === 0) return Promise.resolve();
  return new Promise(resolve => { idleWaiters.push(resolve); setTimeout(resolve, maxWait); });
}
