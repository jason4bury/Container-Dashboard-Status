// Settings kept in DATA_DIR: the machines (settings.json) and the SSH key (ssh-key.json).
// The private key is stored encrypted (AES-256-GCM) and is never sent back to the browser.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { utils } = require('ssh2');

const DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const SETTINGS = path.join(DIR, 'settings.json');
const KEYFILE = path.join(DIR, 'ssh-key.json');
const SECRETFILE = path.join(DIR, '.key-secret');

function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
// Write to a temporary file first, so a crash never leaves half a file.
function writeJson(file, value) {
  ensureDir();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// The encryption key: from SESSION_SECRET, or (with sign-in off and no secret) a random one kept in DATA_DIR.
function cipherKey() {
  let secret = (process.env.SESSION_SECRET || '').trim();
  if (secret.length < 32) {
    secret = readText(SECRETFILE);
    if (!secret) { secret = crypto.randomBytes(32).toString('hex'); ensureDir(); fs.writeFileSync(SECRETFILE, secret, { mode: 0o600 }); }
  }
  return crypto.createHash('sha256').update(`container-dashboard-status key:${secret}`).digest();
}
function readText(file) { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } }
function seal(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', cipherKey(), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.');
}
function unseal(sealed) {
  const [iv, tag, body] = sealed.split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', cipherKey(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(body), d.final()]).toString('utf8');
}

// --- Machines ---
function getMachines() { return readJson(SETTINGS, {}).machines || null; } // null: none saved yet, use HOSTS
function saveMachines(machines) {
  const s = readJson(SETTINGS, {});
  s.machines = machines.map((m) => ({ name: m.name, url: m.url }));
  writeJson(SETTINGS, s);
}

// --- SSH key ---
function describe(parsed, source, created) {
  const pub = parsed.getPublicSSH();
  return {
    type: parsed.type,
    publicKey: `${parsed.type} ${pub.toString('base64')} container-dashboard-status`,
    fingerprint: 'SHA256:' + crypto.createHash('sha256').update(pub).digest('base64').replace(/=+$/, ''),
    source, created,
  };
}
function parse(privateKey, passphrase) {
  const parsed = utils.parseKey(privateKey, passphrase || undefined);
  if (parsed instanceof Error) {
    if (/passphrase|decrypt|encrypted/i.test(parsed.message)) throw new Error(passphrase ? 'The passphrase is wrong for this key.' : 'This key has a passphrase: type it in too.');
    throw new Error('That isn\'t a private key this app can read. Paste the whole key, from -----BEGIN to -----END.');
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey()) throw new Error('That is a public key. Paste the private key (the file without .pub).');
  return key;
}

function makeKey() {
  const pair = utils.generateKeyPairSync('ed25519', { comment: 'container-dashboard-status' });
  return saveKey(pair.private, '', 'made');
}
function saveKey(privateKey, passphrase, source = 'pasted') {
  const text = String(privateKey || '').trim().replace(/\r\n/g, '\n') + '\n';
  const info = describe(parse(text, passphrase), source, new Date().toISOString());
  writeJson(KEYFILE, { ...info, sealed: seal(JSON.stringify({ privateKey: text, passphrase: passphrase || '' })) });
  return info;
}
function removeKey() { try { fs.unlinkSync(KEYFILE); } catch { /* already gone */ } }

// What the page may see: never the private key.
function keyInfo() {
  const k = readJson(KEYFILE, null);
  if (k) return { publicKey: k.publicKey, fingerprint: k.fingerprint, type: k.type, source: k.source, created: k.created };
  const file = process.env.SSH_KEY;
  if (file && fs.existsSync(file)) {
    try { return { ...describe(parse(fs.readFileSync(file, 'utf8'), process.env.SSH_KEY_PASSPHRASE), 'file', null), file }; } catch (e) { return { source: 'file', file, error: e.message }; }
  }
  return null;
}

// For connecting: the saved key, or the SSH_KEY file when none is saved in the app.
function keyForSsh() {
  const k = readJson(KEYFILE, null);
  if (k) {
    try { return JSON.parse(unseal(k.sealed)); } catch { throw new Error('The saved SSH key can\'t be unlocked (was SESSION_SECRET changed?). Make or paste the key again in Settings.'); }
  }
  const file = process.env.SSH_KEY;
  if (file) {
    try { return { privateKey: fs.readFileSync(file, 'utf8'), passphrase: process.env.SSH_KEY_PASSPHRASE || '' }; } catch { /* fall through */ }
  }
  throw new Error('No SSH key yet: make one or paste yours in Settings');
}

module.exports = { DIR, getMachines, saveMachines, makeKey, saveKey, removeKey, keyInfo, keyForSsh };
