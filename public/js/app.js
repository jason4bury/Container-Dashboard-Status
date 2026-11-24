// Container Dashboard Status: draws /api/status as a card per machine and refreshes it.
(() => {
  const $ = (id) => document.getElementById(id);
  const OLD_DAYS = 90;
  let data = null;
  let timer = null;
  let sort = load('cds-sort', { key: 'name', dir: 1 });
  const closed = new Set(load('cds-closed', []));

  function load(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* no storage */ } }

  // Build elements without innerHTML, so names from Docker can never become markup.
  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k instanceof Node ? k : String(k));
    return e;
  }

  function bytes(n) {
    if (n == null) return '';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
  }
  function ago(iso) {
    if (!iso) return '';
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return 'just now';
    const m = s / 60, h = m / 60, d = h / 24;
    if (m < 90) return `${Math.round(m)} minutes ago`;
    if (h < 36) return `${Math.round(h)} hours ago`;
    if (d < 60) return `${Math.round(d)} days ago`;
    if (d < 730) return `${Math.round(d / 30.4)} months ago`;
    return `${Math.round(d / 365)} years ago`;
  }
  function day(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; }
  function isOld(iso) { return iso && Date.now() - new Date(iso).getTime() > OLD_DAYS * 86400000; }

  function stateOf(c) {
    if (c.health === 'unhealthy') return 'unhealthy';
    return c.state;
  }
  function isProblem(c) {
    // Exit codes 0, 137 and 143 are normal stops (finished, or stopped by docker stop).
    return ['unhealthy', 'restarting', 'dead'].includes(stateOf(c)) || (c.state === 'exited' && !/Exited \((0|137|143)\)/.test(c.status));
  }

  function shown(c) {
    const q = $('search').value.trim().toLowerCase();
    if (q && ![c.name, c.image, c.project].some((v) => (v || '').toLowerCase().includes(q))) return false;
    const show = $('show').value;
    if (show === 'running') return c.state === 'running';
    if (show === 'stopped') return c.state !== 'running';
    if (show === 'problems') return isProblem(c);
    return true;
  }

  const columns = [
    { key: 'name', label: 'Container', value: (c) => c.name.toLowerCase() },
    { key: 'state', label: 'State', value: (c) => (c.state === 'running' ? 0 : 1) + stateOf(c) },
    { key: 'memory', label: 'Memory', value: (c) => (c.memory ? c.memory.used : -1) },
    { key: 'image', label: 'Image', value: (c) => c.image.toLowerCase() },
    { key: 'imageCreated', label: 'Image built', value: (c) => c.imageCreated || '' },
    { key: 'created', label: 'Last updated', value: (c) => c.created || '' },
  ];
  function sorted(list) {
    const col = columns.find((x) => x.key === sort.key) || columns[0];
    return [...list].sort((a, b) => {
      const x = col.value(a), y = col.value(b);
      return (x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name)) * sort.dir;
    });
  }

  function row(c, machineMemory) {
    const st = stateOf(c);
    const used = c.memory && c.memory.used;
    const share = used && machineMemory ? used / machineMemory : 0;
    return el('tr', {},
      el('td', { class: 'name' }, c.name, c.project && c.project !== c.name ? el('span', { class: 'project', text: c.project }) : null),
      el('td', {}, el('span', { class: `dot ${st}`, title: st }), el('span', { class: 'state-text', text: c.status })),
      el('td', {}, used != null
        ? el('div', { class: 'mem', title: machineMemory ? `${(share * 100).toFixed(1)}% of this machine's memory` : '' },
          el('div', { class: 'bar' }, el('span', { class: share > 0.25 ? 'high' : '', style: `width:${Math.max(1, Math.min(100, share * 400))}%` })),
          el('span', { class: 'v', text: bytes(used) }))
        : el('span', { class: 'muted', text: c.state === 'running' ? '' : '-' })),
      el('td', { class: 'image', title: c.image, text: c.image }),
      el('td', { class: 'date' }, el('span', { class: isOld(c.imageCreated) ? 'old' : '', title: day(c.imageCreated), text: ago(c.imageCreated) || '-' }),
        c.imagePulled ? el('small', { text: `pulled ${ago(c.imagePulled)}`, title: day(c.imagePulled) }) : null),
      el('td', { class: 'date' }, el('span', { class: isOld(c.created) ? 'old' : '', title: day(c.created), text: ago(c.created) || '-' })),
    );
  }

  function machineCard(m) {
    const running = m.containers.filter((c) => c.state === 'running');
    const problems = m.containers.filter(isProblem);
    const memUsed = running.reduce((t, c) => t + ((c.memory && c.memory.used) || 0), 0);
    const facts = m.ok ? [m.machine.os, m.machine.docker && `Docker ${m.machine.docker}`, m.machine.cpus && `${m.machine.cpus} CPUs`, m.machine.memory && `${bytes(m.machine.memory)} memory`].filter(Boolean).join(' · ') : '';
    const card = el('section', { class: `machine${closed.has(m.name) ? ' closed' : ''}` });
    const header = el('header', {
      role: 'button', tabindex: '0', 'aria-expanded': String(!closed.has(m.name)),
      onclick: () => toggle(m.name, card, header),
      onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(m.name, card, header); } },
    },
    el('span', { class: 'chev', text: '▾' }),
    el('h2', { text: m.name }),
    el('span', { class: 'facts', text: facts }),
    el('span', { class: 'counts' }, m.ok
      ? [el('span', { class: 'pill good', text: `${running.length} running` }),
        el('span', { class: 'pill', text: `${m.containers.length - running.length} stopped` }),
        problems.length ? el('span', { class: 'pill bad', text: `${problems.length} need a look` }) : null,
        el('span', { class: 'pill', text: `${bytes(memUsed)} in use` })]
      : el('span', { class: 'pill bad', text: 'Not reached' })));
    card.append(header);
    const body = el('div', { class: 'body' });
    if (!m.ok) {
      body.append(el('div', { class: 'error' }, m.error, el('span', { class: 'muted', text: 'It will be tried again at the next refresh.' })));
    } else {
      const list = sorted(m.containers.filter(shown));
      if (!list.length) body.append(el('div', { class: 'none', text: m.containers.length ? 'No containers here match.' : 'No containers on this machine.' }));
      else {
        const head = el('tr', {}, columns.map((col) => el('th', {
          scope: 'col', tabindex: '0',
          'aria-sort': sort.key === col.key ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
          onclick: () => sortBy(col.key),
          onkeydown: (e) => { if (e.key === 'Enter') sortBy(col.key); },
          text: col.label,
        })));
        body.append(el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, head), el('tbody', {}, list.map((c) => row(c, m.machine.memory))))));
      }
    }
    card.append(body);
    return card;
  }

  function toggle(name, card, header) {
    if (closed.has(name)) closed.delete(name); else closed.add(name);
    card.classList.toggle('closed', closed.has(name));
    header.setAttribute('aria-expanded', String(!closed.has(name)));
    save('cds-closed', [...closed]);
  }
  function sortBy(key) {
    sort = { key, dir: sort.key === key ? -sort.dir : 1 };
    save('cds-sort', sort);
    draw();
  }

  function draw() {
    if (!data) return;
    const all = data.machines.flatMap((m) => m.containers);
    const reached = data.machines.filter((m) => m.ok).length;
    const running = all.filter((c) => c.state === 'running');
    const problems = all.filter(isProblem).length;
    const memUsed = running.reduce((t, c) => t + ((c.memory && c.memory.used) || 0), 0);
    const tile = (n, l, cls) => el('div', { class: `tile ${cls || ''}` }, el('div', { class: 'n', text: n }), el('div', { class: 'l', text: l }));
    $('summary').replaceChildren(
      tile(`${reached} of ${data.machines.length}`, 'machines reached', reached < data.machines.length ? 'bad' : ''),
      tile(running.length, 'containers running'),
      tile(all.length - running.length, 'stopped'),
      tile(problems, 'need a look', problems ? 'bad' : ''),
      tile(bytes(memUsed) || '0 B', 'memory in use'),
    );
    $('machines').replaceChildren(...(data.machines.length ? data.machines.map(machineCard)
      : [el('p', { class: 'muted' }, 'No machines yet. Open ', el('button', { class: 'btn', text: 'Settings', onclick: () => $('settingsBtn').click() }), ' to add one.')]));
    $('checked').textContent = `Checked ${new Date(data.checkedAt).toLocaleTimeString()}`;
  }

  async function refresh(fresh) {
    clearTimeout(timer);
    $('refresh').disabled = true;
    try {
      const res = await fetch(`/api/status${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      if (res.status === 401) { window.location.href = '/login'; return; }
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `The server answered ${res.status}`);
      data = body;
      $('signOut').hidden = !data.signIn;
      $('helpRefresh').textContent = data.refreshSeconds;
      $('aboutVersion').textContent = `Version ${data.version}`;
      draw();
    } catch (e) {
      $('checked').textContent = `Couldn't check: ${e.message}`;
    } finally {
      $('refresh').disabled = false;
      timer = setTimeout(() => refresh(false), ((data && data.refreshSeconds) || 30) * 1000);
    }
  }

  // Look: as the browser, light or dark, remembered in this browser.
  const theme = $('theme');
  try { theme.value = localStorage.getItem('cds-theme') || 'auto'; } catch { theme.value = 'auto'; }
  if (!theme.value) theme.value = 'auto';
  theme.addEventListener('change', () => {
    if (theme.value === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme.value;
    try { localStorage.setItem('cds-theme', theme.value); } catch { /* no storage */ }
  });

  $('show').value = load('cds-show', 'all');
  $('show').addEventListener('change', () => { save('cds-show', $('show').value); draw(); });
  $('search').addEventListener('input', draw);
  $('refresh').addEventListener('click', () => refresh(true));
  $('helpBtn').addEventListener('click', () => $('help').showModal());
  $('aboutBtn').addEventListener('click', () => $('about').showModal());
  document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));
  $('signOut').addEventListener('click', async () => { await fetch('/api/logout', { method: 'POST' }); window.location.href = '/login'; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && data && Date.now() - new Date(data.checkedAt).getTime() > data.refreshSeconds * 1000) refresh(false); });

  window.cds = { el, refresh: () => refresh(true) }; // for settings.js
  refresh(false);
})();
