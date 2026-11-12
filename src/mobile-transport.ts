type Reply = { status?: number; data?: unknown; text?: string; mime?: string; base64?: string };
declare global {
  interface Window {
    ReactNativeWebView?: { postMessage(value: string): void };
    __gympassManagementReply?: (id: string, reply: Reply) => void;
  }
}

export function installMobileTransport() {
  const original = window.fetch.bind(window);
  const requests = new Map<string, { resolve(reply: Reply): void; reject(error: Error): void }>();
  let sequence = 0;
  window.__gympassManagementReply = (id, reply) => {
    const request = requests.get(id);
    if (!request) return;
    requests.delete(id);
    request.resolve(reply);
  };
  window.fetch = async (input, options = {}) => {
    const request = new Request(new URL(input instanceof Request ? input.url : String(input), location.href), options);
    const url = new URL(request.url);
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return original(request);
    if (request.signal.aborted) throw new DOMException('Solicitud cancelada.', 'AbortError');
    let body: unknown;
    if (!['GET', 'HEAD'].includes(request.method)) {
      if ((request.headers.get('Content-Type') || '').startsWith('application/json')) body = await request.json();
      else {
        const bytes = new Uint8Array(await request.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        body = { mime: request.headers.get('Content-Type') || 'application/octet-stream', base64: btoa(binary) };
      }
    }
    const id = 'api-' + Date.now().toString(36) + '-' + (++sequence);
    const reply = await new Promise<Reply>((resolve, reject) => {
      const cancel = () => { cleanup(); requests.delete(id); reject(new DOMException('Solicitud cancelada.', 'AbortError')); };
      const timer = setTimeout(() => { cleanup(); requests.delete(id); reject(new Error('El teléfono no confirmó la operación. Comprueba los pendientes antes de repetirla.')); }, 120000);
      const cleanup = () => { clearTimeout(timer); request.signal.removeEventListener('abort', cancel); };
      requests.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      request.signal.addEventListener('abort', cancel, { once: true });
      try { window.ReactNativeWebView!.postMessage(JSON.stringify({ type: 'management', id, path: url.pathname.slice(5) + url.search, method: request.method, body })); }
      catch (error) { requests.delete(id); cleanup(); reject(error); }
    });
    const encoded = reply.base64 || (reply.data as { base64?: string } | undefined)?.base64;
    const data = encoded && reply.mime ? Uint8Array.from(atob(encoded), c => c.charCodeAt(0)) : reply.text !== undefined ? reply.text : JSON.stringify(reply.data ?? null);
    return new Response(data, { status: reply.status || 200, headers: { 'Content-Type': reply.mime || 'application/json' } });
  };
}
