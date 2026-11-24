require('dotenv').config();
const path = require('path');
const express = require('express');
const { settingsProblems, requireAuth, login, logout, signInOff } = require('./auth');
const { parseHosts, toHost, readAll, readHost, resetSsh } = require('./docker');
const store = require('./store');
const { DISPLAY_VERSION } = require('./version');

const APP = 'Container Dashboard Status';

// Refuse to start with missing sign-in settings or a HOSTS line that can't be read, saying what to fix.
const problems = settingsProblems();
let startHosts = [];
try { startHosts = parseHosts(process.env.HOSTS); } catch (e) { problems.push(e.message); }
if (problems.length) {
  console.error(`${APP} cannot start:\n  - ` + problems.join('\n  - '));
  console.error('Set these in your .env file (see .env.example), then start the container again.');
  process.exit(1);
}

// The machines: as saved in Settings, or HOSTS from .env until something is saved there.
function machines() {
  const saved = store.getMachines();
  if (!saved) return startHosts;
  const list = [];
  for (const m of saved) { try { list.push(toHost(m.name, m.url)); } catch { /* skip one that no longer reads */ } }
  return list;
}

const PORT = Number(process.env.PORT) || 3040;
const REFRESH = Math.max(10, Number(process.env.REFRESH_SECONDS) || 30);

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.json({ limit: '20kb' }));

// Unauthenticated: the sign-in page and its endpoints, and a health check for Docker and monitors.
app.get('/healthz', (_req, res) => res.type('text').send('ok'));
app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'login.html')));
app.post('/api/login', login);
app.post('/api/logout', logout);
app.use('/css', express.static(path.join(__dirname, '..', 'public', 'css')));
app.use('/favicon.ico', express.static(path.join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/apple-touch-icon.png', express.static(path.join(__dirname, '..', 'public', 'apple-touch-icon.png')));

app.use(requireAuth);

// Changes must come as JSON from this page: a form on another site can't send that.
function jsonOnly(req, res, next) {
  if (!req.is('application/json')) return res.status(415).json({ error: 'Send JSON' });
  next();
}

// The status of every machine, read at most once per REFRESH seconds however many browsers ask.
let last = null;
let pending = null;
async function status(force) {
  if (!force && last && Date.now() - last.at < (REFRESH - 2) * 1000) return last;
  if (!pending) {
    pending = readAll(machines())
      .then((list) => { last = { at: Date.now(), machines: list }; return last; })
      .finally(() => { pending = null; });
  }
  return pending;
}
function changed() { last = null; resetSsh(); }

app.get('/api/status', async (req, res) => {
  try {
    const s = await status(req.query.fresh === '1');
    res.json({ app: APP, version: DISPLAY_VERSION, refreshSeconds: REFRESH, signIn: !signInOff, checkedAt: new Date(s.at).toISOString(), machines: s.machines });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
app.get('/api/about', (_req, res) => res.json({ app: APP, version: DISPLAY_VERSION, signIn: !signInOff }));

// --- Settings: the machines and the SSH key ---
app.get('/api/settings', (_req, res) => {
  res.json({ machines: machines().map((h) => ({ name: h.name, url: h.url })), fromHosts: !store.getMachines(), key: store.keyInfo() });
});

app.put('/api/settings/machines', jsonOnly, (req, res) => {
  const list = Array.isArray(req.body && req.body.machines) ? req.body.machines : null;
  if (!list) return res.status(400).json({ error: 'No machines sent' });
  if (list.length > 50) return res.status(400).json({ error: 'That is more than 50 machines' });
  try {
    const hosts = list.map((m) => toHost(m.name, m.url));
    const names = new Set();
    for (const h of hosts) {
      if (names.has(h.name.toLowerCase())) throw new Error(`Two machines are called "${h.name}"`);
      names.add(h.name.toLowerCase());
    }
    store.saveMachines(hosts);
    changed();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// Try one machine without saving it.
app.post('/api/settings/test', jsonOnly, async (req, res) => {
  try {
    const host = toHost((req.body && req.body.name) || 'Test', req.body && req.body.url);
    const r = await readHost(host);
    res.json({ ok: true, containers: r.containers.length, running: r.containers.filter((c) => c.state === 'running').length, docker: r.machine.docker, hostname: r.machine.hostname });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/settings/key/make', jsonOnly, (_req, res) => {
  try { const key = store.makeKey(); changed(); res.json({ ok: true, key }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/settings/key', jsonOnly, (req, res) => {
  try {
    const key = store.saveKey(req.body && req.body.privateKey, req.body && req.body.passphrase);
    changed();
    res.json({ ok: true, key });
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/settings/key', (_req, res) => { store.removeKey(); changed(); res.json({ ok: true, key: store.keyInfo() }); });

app.use(express.static(path.join(__dirname, '..', 'public'), { index: 'index.html' }));

app.listen(PORT, () => {
  const list = machines();
  console.log(`${APP} v${DISPLAY_VERSION} on port ${PORT}: ${list.length ? list.map((h) => h.name).join(', ') : 'no machines yet (add them in Settings)'}${signInOff ? ' (sign-in is off)' : ''}`);
  console.log(`Settings and the SSH key are kept in ${store.DIR}`);
});
