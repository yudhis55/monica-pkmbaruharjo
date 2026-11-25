import net from 'node:net';
import tls from 'node:tls';

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  /** Semua baris Set-Cookie; `headers` hanya menyimpan yang terakhir. */
  setCookies: string[];
  body: string;
  ms: number;
}

/**
 * Satu request HTTP/1.1 lewat proxy `CONNECT` (proxy HTTP biasa, bukan SOCKS).
 * Dipakai hanya oleh diagnostik: menguji apakah instance ini bisa keluar lewat proxy
 * tertentu. Tidak ada dependensi baru dan tidak memakai keep-alive.
 */
export function requestThroughProxy(
  proxyAddr: string,
  host: string,
  opts: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string; timeoutMs?: number },
): Promise<TunnelResponse> {
  const [proxyHost, proxyPort] = proxyAddr.split(':');
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const started = Date.now();

  const { promise, resolve, reject } = Promise.withResolvers<TunnelResponse>();
  try {
    if (!proxyHost || !proxyPort) {
      reject(new Error(`proxy tidak valid: ${proxyAddr}`));
      return promise;
    }
    let settled = false;
    const finish = (fn: () => void) => { if (settled) return; settled = true; clearTimeout(timer); fn(); };

    const sock = net.connect({ host: proxyHost, port: Number(proxyPort) });
    const timer = setTimeout(() => finish(() => { sock.destroy(); reject(new Error(`timeout ${timeoutMs}ms`)); }), timeoutMs);
    sock.on('error', (e) => finish(() => reject(e)));

    sock.on('connect', () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\nProxy-Connection: keep-alive\r\n\r\n`);
    });

    let handshake = '';
    sock.on('data', function onHandshake(chunk) {
      handshake += chunk.toString('latin1');
      const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;
      sock.off('data', onHandshake);
      const code = Number(handshake.slice(0, end).split(' ')[1]);
      if (code !== 200) return finish(() => { sock.destroy(); reject(new Error(`tunnel HTTP ${code}`)); });

      const secure = tls.connect({ socket: sock, servername: host }, () => {
        const bodyText = opts.body ?? '';
        const head = [
          `${opts.method} ${opts.path} HTTP/1.1`,
          `Host: ${host}`,
          ...Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`),
          `content-length: ${Buffer.byteLength(bodyText)}`,
          'connection: close',
          '', '',
        ].join('\r\n');
        secure.write(head + bodyText);
      });
      let raw = '';
      secure.on('data', (d) => { raw += d.toString('utf8'); });
      secure.on('error', (e) => finish(() => reject(e)));
      secure.on('end', () => {
        const split = raw.indexOf('\r\n\r\n');
        const headText = split < 0 ? raw : raw.slice(0, split);
        const bodyRaw = split < 0 ? '' : raw.slice(split + 4);
        const status = Number(headText.split(' ')[1] ?? 0);
        const headers: Record<string, string> = {};
        const setCookies: string[] = [];
        for (const line of headText.split('\r\n').slice(1)) {
          const i = line.indexOf(':');
          if (i <= 0) continue;
          const key = line.slice(0, i).trim().toLowerCase();
          const value = line.slice(i + 1).trim();
          if (key === 'set-cookie') setCookies.push(value);
          headers[key] = value;
        }
        finish(() => resolve({
          status,
          headers,
          setCookies,
          body: headers['transfer-encoding'] === 'chunked' ? dechunk(bodyRaw) : bodyRaw,
          ms: Date.now() - started,
        }));
      });
    });
  } catch (e) {
    reject(e);
  }
  return promise;
}

function dechunk(text: string): string {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const nl = text.indexOf('\r\n', i);
    if (nl < 0) break;
    const size = Number.parseInt(text.slice(i, nl), 16);
    if (!Number.isFinite(size) || size <= 0) break;
    parts.push(text.slice(nl + 2, nl + 2 + size));
    i = nl + 2 + size + 2;
  }
  return parts.join('');
}

/** Ambil daftar proxy dari proxyscrape; daftar gratis berganti tiap jam. */
export async function fetchProxyList(country = 'id', timeoutMs = 20_000): Promise<string[]> {
  const url = `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country}&protocol=http&proxy_format=ipport&format=text`;
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`daftar proxy HTTP ${r.status}`);
  const text = await r.text();
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
}

/** Satu tunnel dipakai untuk beberapa request berurutan (keep-alive). */
export interface ProxySession {
  request(opts: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body?: string; timeoutMs?: number }): Promise<TunnelResponse>;
  close(): void;
}

/**
 * Buka satu koneksi CONNECT lalu pakai ulang untuk GET+POST. Proxy gratis sering menolak
 * koneksi kedua dari IP yang sama (terukur 25 Nov 2026 dari Vercel: crypto-key 200 lalu
 * ETIMEDOUT pada request berikutnya di koneksi baru), jadi jalur yang layak adalah satu
 * tunnel per halaman.
 */
export function openProxySession(proxyAddr: string, host: string, connectTimeoutMs = 12_000): Promise<ProxySession> {
  const [proxyHost, proxyPort] = proxyAddr.split(':');
  const { promise, resolve, reject } = Promise.withResolvers<ProxySession>();
  if (!proxyHost || !proxyPort) {
    reject(new Error(`proxy tidak valid: ${proxyAddr}`));
    return promise;
  }

  const sock = net.connect({ host: proxyHost, port: Number(proxyPort) });
  sock.setNoDelay(true);
  const killer = setTimeout(() => { sock.destroy(); reject(new Error(`tunnel timeout ${connectTimeoutMs}ms`)); }, connectTimeoutMs);
  sock.on('error', (e) => { clearTimeout(killer); reject(e); });

  sock.on('connect', () => {
    sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
  });

  let handshake = '';
  const onHandshake = (chunk: Buffer) => {
    handshake += chunk.toString('latin1');
    const end = handshake.indexOf('\r\n\r\n');
    if (end < 0) return;
    sock.off('data', onHandshake);
    const code = Number(handshake.slice(0, end).split(' ')[1]);
    if (code !== 200) {
      clearTimeout(killer);
      sock.destroy();
      return reject(new Error(`tunnel HTTP ${code}`));
    }
    clearTimeout(killer);
    const secure = tls.connect({ socket: sock, servername: host });
    secure.setNoDelay(true);

    let buffer = '';
    let waiting: { res: (r: TunnelResponse) => void; rej: (e: Error) => void; started: number } | null = null;

    const tryComplete = () => {
      if (!waiting) return;
      const split = buffer.indexOf('\r\n\r\n');
      if (split < 0) return;
      const headText = buffer.slice(0, split);
      const headers: Record<string, string> = {};
      const setCookies: string[] = [];
      for (const line of headText.split('\r\n').slice(1)) {
        const i = line.indexOf(':');
        if (i <= 0) continue;
        const key = line.slice(0, i).trim().toLowerCase();
        const value = line.slice(i + 1).trim();
        if (key === 'set-cookie') setCookies.push(value);
        headers[key] = value;
      }
      const rest = buffer.slice(split + 4);
      let body: string | null = null;
      if (headers['transfer-encoding'] === 'chunked') {
        const endIdx = rest.indexOf('\r\n0\r\n');
        if (endIdx >= 0) body = dechunk(rest.slice(0, endIdx + 5));
      } else if (headers['content-length']) {
        const len = Number(headers['content-length']);
        if (Buffer.byteLength(rest, 'utf8') >= len) body = Buffer.from(rest, 'utf8').subarray(0, len).toString('utf8');
      } else {
        body = rest;
      }
      if (body === null) return;
      const status = Number(headText.split(' ')[1] ?? 0);
      const current = waiting;
      waiting = null;
      buffer = '';
      current.res({ status, headers, setCookies, body, ms: Date.now() - current.started });
    };

    secure.on('data', (d) => { buffer += d.toString('utf8'); tryComplete(); });
    secure.on('error', (e) => { waiting?.rej(e); waiting = null; });
    secure.on('close', () => { waiting?.rej(new Error('koneksi proxy ditutup')); waiting = null; });

    resolve({
      request(opts) {
        const started = Date.now();
        const payload = opts.body ?? '';
        const head = [
          `${opts.method} ${opts.path} HTTP/1.1`,
          `Host: ${host}`,
          ...Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`),
          `content-length: ${Buffer.byteLength(payload)}`,
          'connection: keep-alive',
          '', '',
        ].join('\r\n');
        const { promise: p, resolve: ok, reject: bad } = Promise.withResolvers<TunnelResponse>();
        waiting = { res: ok, rej: bad, started };
        const timer = setTimeout(() => {
          if (!waiting) return;
          waiting = null;
          bad(new Error(`request timeout ${opts.timeoutMs ?? 20_000}ms`));
        }, opts.timeoutMs ?? 20_000);
        const origRes = ok;
        waiting.res = (r) => { clearTimeout(timer); origRes(r); };
        secure.write(head + payload);
        return p;
      },
      close() { try { secure.destroy(); } catch { /* sudah tertutup */ } },
    });
  };
  sock.on('data', onHandshake);
  return promise;
}
