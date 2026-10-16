/** Mount once per host component. Call the returned function on unmount. */
export function mountBrunoOverlay(config, { documents = {} } = {}) {
  if (!Array.isArray(config.animations) || !config.animations.length) {
    throw new TypeError('Bruno requires at least one animation URL.');
  }
  if (!Number.isFinite(config.duration) || config.duration <= 0) {
    throw new TypeError('Bruno duration must be a positive number.');
  }
  const urls = [...new Set(config.animations.map(path => {
    // Standalone previews can supply already-embedded trusted animation documents.
    if (Object.hasOwn(documents, path)) return path;
    const url = new URL(path, document.baseURI);
    if (url.origin !== location.origin || !/^https?:$/.test(url.protocol)) {
      throw new TypeError('Serve Bruno animation files from this website’s origin.');
    }
    return url.href;
  }))];
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('inert', '');
  host.style.cssText = 'all:initial;position:fixed;display:block;pointer-events:none;overflow:hidden;background:transparent;border:0;';
  Object.assign(host.style, {
    width: config.width, height: config.height, zIndex: String(config.zIndex),
    top: config.position?.top ?? 'auto', left: config.position?.left ?? 'auto',
    right: config.position?.right ?? 'auto', bottom: config.position?.bottom ?? 'auto',
    transform: config.position?.transform ?? 'none',
  });
  const shadow = host.attachShadow({ mode: 'closed' });
  document.body.append(host);
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const abort = new AbortController();
  const cache = new Map();
  const failed = new Set();
  const timers = new Set();
  let disposed = false, generation = 0, active = null, pending = null;
  const later = (fn, ms) => {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id); return id;
  };
  function clearTimers() {
    for (const id of timers) clearTimeout(id);
    timers.clear();
  }
  async function source(url) {
    if (Object.hasOwn(documents, url)) return documents[url];
    if (!cache.has(url)) cache.set(url, fetch(url, {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(config.loadTimeout ?? 8000)]),
      credentials: 'same-origin',
    }).then(async response => {
      if (!response.ok) throw new Error(`Animation HTTP ${response.status}`);
      const html = await response.text();
      if (!html.includes('startBruno') || !html.includes('id="bruno"')) {
        throw new Error('Unexpected animation document.');
      }
      return html;
    }));
    return cache.get(url);
  }
  function reset() {
    generation++; clearTimers();
    active?.remove(); pending?.remove(); active = pending = null;
  }
  function prepare(html, token) {
    // Opaque sandbox origin + CSP keep each animation isolated from the host.
    const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'">`;
    const settings = `<script>globalThis.__BRUNO_OVERLAY_STATIC__=${motion.matches};<\/script>`;
    const bridge = `<script>(()=>{
      const ready=()=>{
        const canvas=document.getElementById('bruno');
        if(typeof window.bruno?.render!=='function' || !canvas){requestAnimationFrame(ready);return;}
        window.bruno.frame=globalThis.__BRUNO_OVERLAY_STATIC__?6:0;
        window.bruno.elapsed=0;
        window.bruno.render(canvas.getContext('2d'));
        parent.postMessage({type:'bruno-ready',token:${JSON.stringify(token)}},'*');
      };requestAnimationFrame(ready);
    })();<\/script>`;
    return html.replace(/<head>/i, '<head>' + policy + settings)
      .replace(/<\/body>/i, bridge + '</body>');
  }
  async function select() {
    if (disposed || document.hidden || !host.isConnected) {
      if (!disposed && !host.isConnected) destroy();
      return;
    }
    const stamp = ++generation;
    const available = urls.filter(url => !failed.has(url));
    if (!available.length) { active?.remove(); active = null; return; }
    // Independent draw: selecting the current clip again is intentionally allowed.
    const url = available[Math.floor(Math.random() * available.length)];
    try {
      const html = await source(url);
      if (disposed || stamp !== generation) return;
      const frame = document.createElement('iframe');
      const token = crypto.randomUUID();
      frame.setAttribute('sandbox', 'allow-scripts');
      frame.setAttribute('tabindex', '-1');
      frame.setAttribute('aria-hidden', 'true');
      frame.setAttribute('scrolling', 'no');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;opacity:0;';
      pending = frame;
      frame.dataset.token = token;
      frame.dataset.url = url;
      frame.srcdoc = prepare(html, token);
      shadow.append(frame);
      later(() => {
        if (pending === frame && stamp === generation) {
          frame.remove(); pending = null; failed.add(url); void select();
        }
      }, config.loadTimeout ?? 8000);
    } catch (error) {
      if (disposed || stamp !== generation) return;
      failed.add(url); void select();
    }
  }
  function receive(event) {
    if (!pending || event.source !== pending.contentWindow ||
        event.data?.type !== 'bruno-ready' || event.data.token !== pending.dataset.token) return;
    clearTimers();
    active?.remove(); active = pending; pending = null;
    active.style.opacity = '1';
    if (!motion.matches) later(() => { void select(); }, config.duration);
  }
  function restart() {
    reset();
    if (!document.hidden) void select();
  }
  // Also clean up if an embedding app removes the overlay without calling destroy.
  const observer = new MutationObserver(() => { if (!host.isConnected) destroy(); });
  observer.observe(document.body, { childList: true });
  function destroy() {
    if (disposed) return;
    disposed = true; reset(); abort.abort(); cache.clear();
    window.removeEventListener('message', receive);
    document.removeEventListener('visibilitychange', restart);
    motion.removeEventListener('change', restart);
    observer.disconnect(); host.remove();
  }
  window.addEventListener('message', receive);
  document.addEventListener('visibilitychange', restart);
  motion.addEventListener('change', restart);
  void select();
  return destroy;
}
