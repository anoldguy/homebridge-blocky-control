// A tiny stand-in for blocky's blocking API, for local development and tests.
//   node test/fake-blocky.mjs [port]     (default 4000)
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

function parseDuration(value) {
  // supports Go-style durations such as 300s, 5m, 1h, 5m30s
  let total = 0;
  const re = /(\d+(?:\.\d+)?)(h|m|s)/g;
  let match;
  let consumed = '';
  while ((match = re.exec(value)) !== null) {
    consumed += match[0];
    total += Number(match[1]) * { h: 3600, m: 60, s: 1 }[match[2]];
  }
  if (consumed !== value) {
    throw new Error(`invalid duration ${value}`);
  }
  return total;
}

export function startFakeBlocky({ port = 4000, groups = ['ads', 'malware'], log = () => {} } = {}) {
  const state = { enabled: true, disabledGroups: [], until: 0, timer: undefined, requests: [] };

  const enable = () => {
    clearTimeout(state.timer);
    Object.assign(state, { enabled: true, disabledGroups: [], until: 0, timer: undefined });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.requests.push(`${req.method} ${url.pathname}${url.search}`);
    log(`${req.method} ${url.pathname}${url.search}`);
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    switch (url.pathname) {
    case '/api/blocking/status': {
      const autoEnableInSec = state.until ? Math.max(0, Math.round((state.until - Date.now()) / 1000)) : 0;
      return send(200, JSON.stringify({ enabled: state.enabled, disabledGroups: state.disabledGroups, autoEnableInSec }), 'application/json');
    }
    case '/api/blocking/enable':
      enable();
      return send(200, '');
    case '/api/blocking/disable': {
      let seconds;
      try {
        seconds = url.searchParams.get('duration') ? parseDuration(url.searchParams.get('duration')) : 0;
      } catch (e) {
        return send(400, e.message);
      }
      const requested = (url.searchParams.get('groups') || '').split(',').filter(Boolean);
      const unknown = requested.filter((g) => !groups.includes(g));
      if (unknown.length) {
        return send(400, `group '${unknown[0]}' is unknown`);
      }
      clearTimeout(state.timer);
      state.enabled = false;
      state.disabledGroups = requested.length ? requested : [...groups];
      state.until = seconds ? Date.now() + seconds * 1000 : 0;
      state.timer = seconds ? setTimeout(enable, seconds * 1000) : undefined;
      state.timer?.unref();
      return send(200, '');
    }
    default:
      return send(404, 'not found');
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        state,
        port: server.address().port,
        url: `http://127.0.0.1:${server.address().port}`,
        close: () => new Promise((r) => {
          clearTimeout(state.timer);
          server.close(() => r());
        }),
      });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 4000);
  const fake = await startFakeBlocky({ port, log: (line) => console.log(new Date().toISOString(), line) });
  console.log(`fake blocky listening on ${fake.url}`);
}
