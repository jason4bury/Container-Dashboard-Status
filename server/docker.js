// Read-only access to the Docker Engine API of each machine (from Settings, or HOSTS in .env).
// A machine is reached through its Docker socket (unix:///var/run/docker.sock, mounted read-only),
// a Windows named pipe (npipe:////./pipe/docker_engine, when running outside Docker), or a
// read-only socket proxy over the network (http://address:2375), or SSH with a key
// (ssh://user@address:port, which runs "docker system dial-stdio" on that machine, as the docker
// command itself does for ssh:// hosts). Only GET requests are ever made.
const http = require('http');
const https = require('https');
const { Client } = require('ssh2');
const store = require('./store');

const TIMEOUT_MS = 10000;

// "This PC=unix:///var/run/docker.sock, NAS=http://192.168.1.20:2375" -> [{ name, url }]
function parseHosts(text) {
  const hosts = [];
  for (const part of String(text || '').split(/[,;\n]/)) {
    const item = part.trim();
    if (!item) continue;
    const at = item.indexOf('=');
    const name = at > 0 ? item.slice(0, at).trim() : `Machine ${hosts.length + 1}`;
    const url = (at > 0 ? item.slice(at + 1) : item).trim();
    hosts.push(toHost(name, url, `HOSTS: "${item}"`));
  }
  return hosts;
}

// One machine: checks its address and works out the SSH details. label starts any error message.
function toHost(name, url, label) {
  name = String(name || '').trim();
  url = String(url || '').trim();
  label = label || `"${name}"`;
  if (!name) throw new Error('Every machine needs a name');
  if (!/^(unix|npipe|https?|tcp|ssh):\/\//i.test(url)) throw new Error(`${label} needs an address starting unix://, npipe://, http://, https:// or ssh://`);
  const host = { name, url: url.replace(/^tcp:\/\//i, 'http://') };
  if (/^ssh:/i.test(url)) host.ssh = parseSsh(label, url);
  return host;
}

// ssh://user@address:port/path/to/docker -> { username, host, port, docker }. The path is optional:
// some machines (Synology among them) keep docker at /usr/local/bin/docker, outside the SSH PATH.
function parseSsh(label, url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`${label}: that address can't be read`); }
  if (!u.username) throw new Error(`${label} needs a user name, such as ssh://admin@192.168.1.20:22`);
  const docker = decodeURIComponent(u.pathname || '').replace(/^\/$/, '') || 'docker';
  if (!/^[\w./-]+$/.test(docker)) throw new Error(`${label}: the docker path can only have letters, numbers and . _ / -`);
  return { username: decodeURIComponent(u.username), host: u.hostname, port: Number(u.port) || 22, docker };
}

// One SSH connection per machine, kept open between refreshes; each request is its own channel.
const sshClients = new Map();
// Close every SSH connection, so the next refresh uses a new key or changed machines.
function resetSsh() {
  for (const p of sshClients.values()) p.then((c) => c.end(), () => {});
  sshClients.clear();
}
function sshClient(host) {
  const id = host.url;
  const known = sshClients.get(id);
  if (known) return known;
  const pin = (process.env.SSH_FINGERPRINTS || '').split(/[,;\s]+/).filter(Boolean);
  const p = new Promise((resolve, reject) => {
    const key = store.keyForSsh(); // throws a friendly message when there's no key yet
    const c = new Client();
    let seen = '';
    const forget = () => { if (sshClients.get(id) === p) sshClients.delete(id); };
    c.on('ready', () => resolve(c));
    c.on('error', (e) => { forget(); reject(new Error(friendlySsh(e, seen, pin))); });
    c.on('close', forget);
    c.connect({
      host: host.ssh.host, port: host.ssh.port, username: host.ssh.username,
      privateKey: key.privateKey, passphrase: key.passphrase || undefined,
      readyTimeout: TIMEOUT_MS, keepaliveInterval: 30000,
      // With SSH_FINGERPRINTS set, only a machine whose host key matches one of them is trusted.
      hostHash: 'sha256',
      hostVerifier: (hash) => { seen = 'SHA256:' + Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, ''); return !pin.length || pin.includes(seen); },
    });
  });
  sshClients.set(id, p);
  p.catch(() => { if (sshClients.get(id) === p) sshClients.delete(id); }); // try afresh next time
  return p;
}
function friendlySsh(e, seen, pin) {
  if (pin.length && seen && !pin.includes(seen)) return `The machine's SSH host key (${seen}) isn't one in SSH_FINGERPRINTS`;
  if (e.level === 'client-authentication') return 'SSH refused the key (add the public key from Settings to ~/.ssh/authorized_keys for that user)';
  if (/timed out/i.test(e.message)) return "The machine didn't answer SSH within 10 seconds";
  return friendlyError(e);
}
function sshAgent(host) {
  const agent = new http.Agent({ keepAlive: false, maxSockets: 6 });
  agent.createConnection = (_opts, done) => {
    sshClient(host).then((c) => c.exec(`${host.ssh.docker} system dial-stdio`, (err, stream) => {
      if (err) return done(err);
      let errText = '';
      stream.stderr.on('data', (d) => { errText += d; });
      // docker on the other machine failed (not found, no permission): keep its reason for get() to report.
      stream.on('exit', (code) => { if (code) host.dialError = code === 127 ? friendlyDialError("not found") : friendlyDialError(errText || `docker stopped with code ${code}`); });
      // An SSH channel isn't a network socket: give it the few socket methods http calls.
      let timer = null;
      stream.setTimeout = (ms, cb) => {
        clearTimeout(timer);
        if (cb) stream.once('timeout', cb);
        if (ms) timer = setTimeout(() => stream.emit('timeout'), ms);
        return stream;
      };
      stream.once('close', () => clearTimeout(timer));
      stream.setNoDelay = stream.setKeepAlive = stream.ref = stream.unref = () => stream;
      done(null, stream);
    }), done);
  };
  return agent;
}
function friendlyDialError(text) {
  if (/not found/i.test(text)) return "docker wasn't found over SSH (add its path, such as ssh://user@address:22/usr/local/bin/docker)";
  if (/permission denied/i.test(text)) return "The SSH user isn't allowed to use Docker (add it to the docker group on that machine)";
  return text.trim().split(/\r?\n/).pop();
}

function get(host, path) {
  return new Promise((resolve, reject) => {
    const opts = { method: 'GET', path, headers: { Accept: 'application/json' }, timeout: TIMEOUT_MS };
    let lib = http;
    if (/^unix:\/\//i.test(host.url)) opts.socketPath = host.url.replace(/^unix:\/\//i, '');
    else if (/^npipe:\/\//i.test(host.url)) opts.socketPath = host.url.replace(/^npipe:\/\//i, '').replace(/\//g, '\\');
    else if (host.ssh) { host.agent = host.agent || sshAgent(host); opts.agent = host.agent; opts.host = 'docker'; }
    else {
      const u = new URL(host.url);
      lib = u.protocol === 'https:' ? https : http;
      opts.hostname = u.hostname; opts.port = u.port || (u.protocol === 'https:' ? 443 : 80);
      opts.path = (u.pathname.replace(/\/$/, '') || '') + path;
    }
    const req = lib.request(opts, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Docker answered ${res.statusCode} for ${path.split('?')[0]}${res.statusCode === 403 ? ' (the socket proxy needs CONTAINERS=1 and IMAGES=1)' : ''}`));
        try { resolve(body ? JSON.parse(body) : null); } catch { reject(new Error('Docker sent something that isn\'t JSON')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('No answer within 10 seconds')));
    req.on('error', (e) => {
      // A failed SSH channel shows up here only as "socket hang up"; give docker's own reason instead.
      const why = host.dialError;
      host.dialError = null;
      reject(new Error(why || friendlyError(e)));
    });
    req.end();
  });
}

function friendlyError(e) {
  if (e.code === 'ENOENT' || e.code === 'EACCES') return 'The Docker socket isn\'t there or can\'t be read (is it mounted?)';
  if (e.code === 'ECONNREFUSED') return 'Nothing is answering at that address (is Docker, or the socket proxy, running there?)';
  if (e.code === 'EHOSTUNREACH' || e.code === 'ENETUNREACH' || e.code === 'ETIMEDOUT') return 'The machine can\'t be reached';
  if (e.code === 'ENOTFOUND') return 'That machine name isn\'t known on the network';
  return e.message;
}

// Run fn over items, a few at a time, so a machine with many containers isn't flooded.
async function eachLimited(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Memory as `docker stats` shows it: usage without the page cache that can be freed.
function memoryOf(stats) {
  const m = stats && stats.memory_stats;
  if (!m || !m.usage) return null;
  const s = m.stats || {};
  const cache = s.inactive_file ?? s.total_inactive_file ?? s.cache ?? 0;
  return { used: Math.max(0, m.usage - cache), limit: m.limit || null };
}

const imageCache = new Map(); // machine + image id -> { created, pulled }; each machine pulled it at its own time

async function readHost(host) {
  const started = Date.now();
  const info = await get(host, '/info');
  const list = await get(host, '/containers/json?all=1');
  const containers = await eachLimited(list || [], 6, async (c) => {
    const name = ((c.Names && c.Names[0]) || c.Id.slice(0, 12)).replace(/^\//, '');
    const row = {
      name,
      image: c.Image,
      state: c.State,              // running, exited, paused, restarting, created, dead
      status: c.Status,            // "Up 3 days (healthy)", "Exited (0) 2 hours ago"
      created: c.Created ? new Date(c.Created * 1000).toISOString() : null, // when the container was (re)made
      project: (c.Labels && c.Labels['com.docker.compose.project']) || '',
      health: /\(healthy\)/.test(c.Status) ? 'healthy' : /\(unhealthy\)/.test(c.Status) ? 'unhealthy' : '',
      memory: null, imageCreated: null, imagePulled: null,
    };
    try {
      if (!imageCache.has(`${host.url} ${c.ImageID}`)) {
        const im = await get(host, `/images/${encodeURIComponent(c.ImageID)}/json`);
        const tagged = im && im.Metadata && im.Metadata.LastTagTime;
        imageCache.set(`${host.url} ${c.ImageID}`, { created: (im && im.Created) || null, pulled: tagged && !tagged.startsWith('0001') ? tagged : null });
      }
      const ic = imageCache.get(`${host.url} ${c.ImageID}`);
      row.imageCreated = ic.created; row.imagePulled = ic.pulled;
    } catch { /* an image that's gone or not allowed: leave the dates blank */ }
    if (c.State === 'running') {
      try { row.memory = memoryOf(await get(host, `/containers/${c.Id}/stats?stream=false&one-shot=true`)); } catch { /* stopped meanwhile */ }
    }
    return row;
  });
  containers.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return {
    name: host.name,
    ok: true,
    machine: { hostname: info.Name, os: info.OperatingSystem, docker: info.ServerVersion, memory: info.MemTotal || null, cpus: info.NCPU || null },
    containers,
    took: Date.now() - started,
  };
}

async function readAll(hosts) {
  if (imageCache.size > 5000) imageCache.clear(); // old images pile up over months of updates
  return Promise.all(hosts.map((h) => readHost(h).catch((e) => ({ name: h.name, ok: false, error: e.message, containers: [] }))));
}

module.exports = { parseHosts, toHost, readAll, readHost, memoryOf, resetSsh };
