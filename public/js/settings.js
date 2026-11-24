// Settings: the machines on the page and the SSH key used for ssh:// machines.
(() => {
  const $ = (id) => document.getElementById(id);
  const { el } = window.cds;
  let current = { machines: [], key: null };

  async function call(method, url, body) {
    const res = await fetch(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401) { window.location.href = '/login'; throw new Error('Not signed in'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `The server answered ${res.status}`);
    return data;
  }
  function say(target, text, good) {
    target.textContent = text;
    target.className = `small ${good === true ? 'good' : good === false ? 'bad' : 'muted'}`;
  }
  function copyButton(text) {
    const b = el('button', { class: 'btn', type: 'button', text: 'Copy' });
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select it and copy'; }
      setTimeout(() => { b.textContent = 'Copy'; }, 2000);
    });
    return b;
  }

  async function load() {
    current = await call('GET', '/api/settings');
    drawMachines();
    drawKey();
  }

  // --- Machines ---
  function drawMachines() {
    $('fromHosts').hidden = !(current.fromHosts && current.machines.length);
    const list = $('machineList');
    if (!current.machines.length) { list.replaceChildren(el('p', { class: 'muted', text: 'No machines yet: add one below.' })); return; }
    list.replaceChildren(el('table', { class: 'settings-table' }, el('tbody', {}, current.machines.map((m, i) => {
      const result = el('span', { class: 'small', role: 'status' });
      return el('tr', {},
        el('td', { class: 'name', text: m.name }),
        el('td', {}, el('code', { text: m.url }), el('br'), result),
        el('td', { class: 'actions' },
          el('button', { class: 'btn', type: 'button', text: 'Test', onclick: () => test(m, result) }),
          el('button', { class: 'btn', type: 'button', text: 'Remove', onclick: () => remove(i) })));
    }))));
  }

  async function test(m, target) {
    say(target, 'Testing...');
    try {
      const r = await call('POST', '/api/settings/test', { name: m.name, url: m.url });
      if (r.ok) say(target, `Works: ${r.hostname}, Docker ${r.docker}, ${r.running} of ${r.containers} containers running.`, true);
      else say(target, r.error, false);
    } catch (e) { say(target, e.message, false); }
  }

  async function saveList(machines) {
    await call('PUT', '/api/settings/machines', { machines });
    await load();
    window.cds.refresh();
  }
  async function remove(i) {
    const m = current.machines[i];
    if (!window.confirm(`Take ${m.name} off the page?`)) return;
    try { await saveList(current.machines.filter((_, j) => j !== i)); } catch (e) { window.alert(e.message); }
  }

  // Build the address from the form, so nobody has to know the ssh:// format.
  function formUrl() {
    const kind = $('mKind').value;
    const address = $('mAddress').value.trim();
    const port = $('mPort').value.trim();
    if (kind === 'socket') return $('mSocket').value.trim();
    if (!address) return '';
    if (kind === 'proxy') return `http://${address}:${port || 2375}`;
    const user = $('mUser').value.trim();
    let docker = $('mDocker').value.trim();
    if (docker && !docker.startsWith('/')) docker = `/${docker}`;
    return `ssh://${user ? encodeURIComponent(user) + '@' : ''}${address}:${port || 22}${docker}`;
  }
  function formChanged() {
    const kind = $('mKind').value;
    document.querySelectorAll('#addMachine [data-kind]').forEach((l) => { l.hidden = !l.dataset.kind.split(' ').includes(kind); });
    $('mPort').placeholder = kind === 'proxy' ? '2375' : '22';
    $('mUrl').textContent = formUrl() || '(fill in the address)';
  }
  ['mKind', 'mName', 'mAddress', 'mPort', 'mUser', 'mDocker', 'mSocket'].forEach((id) => $(id).addEventListener('input', formChanged));
  $('mKind').addEventListener('change', formChanged);
  $('mTest').addEventListener('click', () => test({ name: $('mName').value.trim() || 'Test', url: formUrl() }, $('mResult')));
  $('mAdd').addEventListener('click', async () => {
    const name = $('mName').value.trim();
    if (!name) { say($('mResult'), 'Give it a name first.', false); return; }
    try {
      await saveList([...current.machines, { name, url: formUrl() }]);
      ['mName', 'mAddress', 'mPort', 'mUser', 'mDocker'].forEach((id) => { $(id).value = ''; });
      say($('mResult'), `${name} added.`, true);
      formChanged();
    } catch (e) { say($('mResult'), e.message, false); }
  });

  // --- SSH key ---
  function dockerPaths() {
    const paths = new Set();
    for (const m of current.machines) {
      if (!/^ssh:/i.test(m.url)) continue;
      try { paths.add(decodeURIComponent(new URL(m.url).pathname).replace(/^\/$/, '') || 'docker'); } catch { /* skip */ }
    }
    return paths.size ? [...paths] : ['docker'];
  }

  function drawKey() {
    const k = current.key;
    const box = $('keyBox');
    if (!k) {
      box.replaceChildren(
        el('p', {}, 'Machines added over SSH need a key. Make one here (the private half never leaves the app), or use a key you already have.'),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', text: 'Make a key', onclick: makeKey })));
      return;
    }
    if (k.error) {
      box.replaceChildren(el('p', { class: 'bad', text: `The key file ${k.file} can't be used: ${k.error}` }),
        el('div', { class: 'row' }, el('button', { class: 'btn primary', type: 'button', text: 'Make a key', onclick: makeKey })));
      return;
    }
    const where = k.source === 'made' ? `Made by this app ${new Date(k.created).toLocaleDateString()}` : k.source === 'file' ? `From the file ${k.file} (SSH_KEY)` : `Your own key, saved ${new Date(k.created).toLocaleDateString()}`;
    const lines = dockerPaths().map((d) => `command="${d} system dial-stdio",no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding ${k.publicKey}`);
    box.replaceChildren(
      el('p', { class: 'muted small', text: `${where} · ${k.type} · ${k.fingerprint}` }),
      el('p', {}, 'Add this line to ', el('code', { text: '~/.ssh/authorized_keys' }), ' for the SSH user on each other machine. It lets the key read Docker and nothing else.'),
      ...lines.map((line, i) => el('div', { class: 'keyline' },
        lines.length > 1 ? el('div', { class: 'small muted', text: dockerPaths()[i] === 'docker' ? 'For machines where docker is on the path:' : `For machines with docker at ${dockerPaths()[i]}:` }) : null,
        el('textarea', { readonly: 'readonly', rows: '4', spellcheck: 'false', text: line }), copyButton(line))),
      el('details', {}, el('summary', { class: 'small', text: 'Just the public key' }),
        el('div', { class: 'keyline' }, el('textarea', { readonly: 'readonly', rows: '2', spellcheck: 'false', text: k.publicKey }), copyButton(k.publicKey))),
      el('div', { class: 'row' },
        el('button', { class: 'btn', type: 'button', text: 'Make a new key', onclick: makeKey }),
        k.source !== 'file' ? el('button', { class: 'btn', type: 'button', text: 'Remove key', onclick: removeKey }) : null));
  }

  async function makeKey() {
    if (current.key && !current.key.error && !window.confirm('Make a new key? The old one stops working here, so each machine will need the new line in authorized_keys.')) return;
    try { const r = await call('POST', '/api/settings/key/make', {}); current.key = r.key; drawKey(); window.cds.refresh(); } catch (e) { window.alert(e.message); }
  }
  async function removeKey() {
    if (!window.confirm('Remove the SSH key from the app? Machines over SSH will stop showing until a key is added again.')) return;
    try { const r = await call('DELETE', '/api/settings/key'); current.key = r.key; drawKey(); window.cds.refresh(); } catch (e) { window.alert(e.message); }
  }
  $('kSave').addEventListener('click', async () => {
    if (current.key && !current.key.error && current.key.source !== 'file' && !window.confirm('Replace the key the app has now with this one?')) return;
    say($('kResult'), 'Checking the key...');
    try {
      const r = await call('POST', '/api/settings/key', { privateKey: $('kPrivate').value, passphrase: $('kPass').value });
      $('kPrivate').value = ''; $('kPass').value = '';
      $('pasteKey').open = false;
      say($('kResult'), '');
      current.key = r.key; drawKey(); window.cds.refresh();
    } catch (e) { say($('kResult'), e.message, false); }
  });

  $('settingsBtn').addEventListener('click', async () => {
    $('settings').showModal();
    formChanged();
    try { await load(); } catch (e) { $('machineList').replaceChildren(el('p', { class: 'bad', text: e.message })); }
  });
  // Clear a pasted key if the dialog is closed without saving it.
  $('settings').addEventListener('close', () => { $('kPrivate').value = ''; $('kPass').value = ''; });
})();
// http://<server>:3040/#settings opens Settings straight away.
if (window.location.hash === '#settings') document.getElementById('settingsBtn').click();
