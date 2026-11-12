import { apiUrl, getPlatformContext, getPlatformSignal } from './platform-context.ts';

const validTopics = new Set(['access', 'people', 'pos', 'settings', 'alerts', 'time']);
/** Un canal por gimnasio y pestaña; HTTP conserva los cobros y sus reintentos idempotentes. */
export function startLiveUpdates(refresh: (topics?: string[]) => Promise<void>) {
  const context = getPlatformContext(),
    signal = getPlatformSignal();
  let socket: WebSocket | undefined, reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined, handshake: ReturnType<typeof setTimeout> | undefined;
  let stopped = false,
    connected = false,
    attempts = 0;
  let topics = new Set<string>();
  const visible = () => document.visibilityState === 'visible';
  const run = (changed?: string[]) => {
    if (!stopped && visible()) void refresh(changed).catch(() => {});
  };
  const queue = (changed: string[]) => {
    changed.forEach((topic) => topics.add(topic));
    updateTimer ||= setTimeout(() => {
      updateTimer = undefined;
      const changed = [...topics];
      topics.clear();
      run(changed);
    }, 150);
  };
  const retry = () => {
    if (stopped || !visible() || reconnectTimer || !context) return;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(attempts++, 5)) + Math.random() * 300;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, delay);
  };
  const connect = () => {
    if ('ReactNativeWebView' in window && location.hostname === '127.0.0.1') return;
    if (stopped || signal.aborted || !visible() || !context || typeof WebSocket === 'undefined') return;
    const url = new URL(apiUrl('realtime'), location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const protocols = ['gympass.v1', ...(context.supportToken ? ['support.' + context.supportToken] : [])];
    try {
      socket = new WebSocket(url, protocols);
    } catch {
      retry();
      return;
    }
    const current = socket;
    handshake = setTimeout(() => {
      if (!connected && current === socket) current.close();
    }, 8000);
    current.onmessage = (event) => {
      if (stopped || current !== socket || signal.aborted) return;
      try {
        const message = JSON.parse(event.data);
        if (message.type === 'ready' && message.protocol === 1) {
          connected = true;
          attempts = 0;
          clearTimeout(handshake);
          queue(['access', 'people', 'pos', 'alerts']);
        } else if (message.type === 'change' && Array.isArray(message.topics)) {
          queue(message.topics.filter((topic: unknown) => typeof topic === 'string' && validTopics.has(topic)));
        }
      } catch {
        /* Un mensaje inválido no puede ejecutar ni modificar operaciones. */
      }
    };
    current.onerror = () => {}; // onclose decide la reconexión y el respaldo HTTP.
    current.onclose = (event) => {
      if (current !== socket) return;
      connected = false;
      clearTimeout(handshake);
      if (event.code === 4003) {
        stopped = true;
        window.dispatchEvent(new Event('session-expired'));
      } else retry();
    };
  };
  const resume = () => {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    if (visible()) {
      if (!socket || socket.readyState >= WebSocket.CLOSING) connect();
    } else {
      connected = false;
      clearTimeout(handshake);
      socket?.close(1000);
    }
  };
  // Respaldo para redes/proxies sin Upgrade; no consulta si el canal está conectado.
  const fallback = setInterval(() => {
    if (!connected) run();
  }, 30000);
  // Las fechas pueden vencer sin una escritura: una revisión ligera cada cinco minutos.
  const calendar = setInterval(() => {
    if (connected) run(['time', 'alerts']);
  }, 300000);
  const stop = () => {
    stopped = true;
    clearInterval(fallback);
    clearInterval(calendar);
    clearTimeout(reconnectTimer);
    clearTimeout(updateTimer);
    clearTimeout(handshake);
    socket?.close(1000);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('online', resume);
    signal.removeEventListener('abort', stop);
  };
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('online', resume);
  signal.addEventListener('abort', stop, { once: true });
  connect();
  return stop;
}
