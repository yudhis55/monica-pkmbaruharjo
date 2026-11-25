import net from 'node:net';
import tls from 'node:tls';

export type ProxyScheme = 'http' | 'https' | 'socks4' | 'socks5';

export interface ProxySpec {
  scheme: ProxyScheme;
  host: string;
  port: number;
  /** Bentuk asli `skema://host:port` atau `host:port`. */
  raw: string;
}

export interface TunnelResponse {
  status: number;
  headers: Record<string, string>;
  /** Semua baris Set-Cookie; `headers` hanya menyimpan yang terakhir. */
  setCookies: string[];
  body: string;
  ms: number;
}

export interface ProxyRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/** `socks5://1.2.3.4:1080`, `http://1.2.3.4:8080`, atau `1.2.3.4:8080` (dianggap http). */
export function parseProxy(raw: string, fallback: ProxyScheme = 'http'): ProxySpec | null {
  const text = raw.trim();
  if (!text) return null;
  const m = /^(?:(http|https|socks4|socks5):\/\/)?(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(text);
  if (!m) return null;
  const port = Number(m[3]);
  if (!Number.isFinite(port) || port < 1 || port > 65535) return null;
  const scheme = (m[1] as ProxyScheme | undefined) ?? fallback;
  return { scheme, host: m[2], port, raw: text };
}

function handshake(sock: net.Socket, spec: ProxySpec, targetHost: string, targetPort: number, timeoutMs: number): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const timer = setTimeout(() => { cleanup(); reject(new Error(`${spec.scheme} handshake timeout`)); }, timeoutMs);
  let buf = Buffer.alloc(0);

  const onData = (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    if (spec.scheme === 'http' || spec.scheme === 'https') {
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const line = buf.subarray(0, end).toString('latin1').split('\r\n')[0];
      const code = Number((/^HTTP\/1\.[01] (\d{3})/.exec(line) ?? [])[1]);
      // Sisa byte setelah header adalah awal data TLS; harus dikembalikan ke socket.
      const rest = buf.subarray(end + 4);
      cleanup();
      if (rest.length) sock.unshift(rest);
      if (code === 200) resolve(); else reject(new Error(`CONNECT ${code}`));
      return;
    }
    if (spec.scheme === 'socks4') {
      if (buf.length < 8) return;
      const code = buf[1];
      cleanup();
      if (code === 0x5a) resolve(); else reject(new Error(`socks4 ${code}`));
      return;
    }
    // socks5: greeting (2 byte) lalu balasan connect (10 byte untuk IPv4).
    if (buf.length === 2 && buf[0] === 5) {
      if (buf[1] !== 0) { cleanup(); reject(new Error('socks5 auth')); return; }
      const host = Buffer.from(targetHost, 'utf8');
      sock.write(Buffer.concat([
        Buffer.from([5, 1, 0, 3, host.length]), host,
        Buffer.from([(targetPort >> 8) & 255, targetPort & 255]),
      ]));
      buf = Buffer.alloc(0);
      return;
    }
    if (buf.length >= 10 && buf[0] === 5) {
      const code = buf[1];
      cleanup();
      if (code === 0) resolve(); else reject(new Error(`socks5 ${code}`));
    }
  };
  const onError = (e: Error) => { cleanup(); reject(e); };
  const onClose = () => { cleanup(); reject(new Error('proxy menutup koneksi saat handshake')); };
  function cleanup() {
    clearTimeout(timer);
    sock.off('data', onData);
    sock.off('error', onError);
    sock.off('close', onClose);
  }

  sock.on('data', onData);
  sock.on('error', onError);
  sock.on('close', onClose);

  if (spec.scheme === 'http' || spec.scheme === 'https') {
    sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`);
  } else if (spec.scheme === 'socks4') {
    const [a, b, c, d] = targetHost.split('.').map(Number);
    if ([a, b, c, d].every((n) => Number.isInteger(n))) {
      sock.write(Buffer.from([4, 1, (targetPort >> 8) & 255, targetPort & 255, a, b, c, d, 0]));
    } else {
      sock.write(Buffer.concat([
        Buffer.from([4, 1, (targetPort >> 8) & 255, targetPort & 255, 0, 0, 0, 1, 0]),
        Buffer.from(targetHost, 'ascii'), Buffer.from([0]),
      ]));
    }
  } else {
    sock.write(Buffer.from([5, 1, 0]));
  }

  return promise;
}

/** Terowongan TLS ke target lewat proxy; satu koneksi dipakai untuk beberapa request. */
export interface ProxySession {
  request(opts: ProxyRequest): Promise<TunnelResponse>;
  close(): void;
}

export async function openProxySession(
  spec: ProxySpec,
  targetHost: string,
  targetPort = 443,
  timeoutMs = 12_000,
): Promise<ProxySession> {
  const sock = net.connect({ host: spec.host, port: spec.port });
  sock.setNoDelay(true);
  const { promise: connected, resolve: onConnect, reject: onError } = Promise.withResolvers<void>();
  const killer = setTimeout(() => { sock.destroy(); onError(new Error(`connect timeout ${timeoutMs}ms`)); }, timeoutMs);
  sock.once('connect', () => { clearTimeout(killer); onConnect(); });
  sock.once('error', (e) => { clearTimeout(killer); onError(e); });
  try {
    await connected;
  } catch (e) {
    sock.destroy();
    throw e;
  }
  await handshake(sock, spec, targetHost, targetPort, timeoutMs);

  const secure = tls.connect({ socket: sock, servername: targetHost, ALPNProtocols: ['http/1.1'] });
  secure.setNoDelay(true);
  const { promise: secured, resolve: onSecure, reject: onTlsError } = Promise.withResolvers<void>();
  const tlsTimer = setTimeout(() => { secure.destroy(); onTlsError(new Error('tls timeout')); }, timeoutMs);
  secure.once('secureConnect', () => { clearTimeout(tlsTimer); onSecure(); });
  secure.once('error', (e) => { clearTimeout(tlsTimer); onTlsError(e); });
  try {
    await secured;
  } catch (e) {
    secure.destroy();
    throw e;
  }

  let buffer = Buffer.alloc(0);
  let waiting: { resolve: (r: TunnelResponse) => void; reject: (e: Error) => void; started: number } | null = null;
  let closed: Error | null = null;

  /** Ambil satu respons utuh dari buffer; sisanya disimpan untuk request berikutnya. */
  const drain = () => {
    if (!waiting) return;
    const end = buffer.indexOf('\r\n\r\n');
    if (end < 0) return;
    const headText = buffer.subarray(0, end).toString('latin1');
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

    let bodyStart = end + 4;
    let body: Buffer | null = null;
    if (headers['transfer-encoding'] === 'chunked') {
      const parsed = readChunked(buffer.subarray(bodyStart));
      if (!parsed) return;
      body = parsed.body;
      bodyStart += parsed.consumed;
    } else if (headers['content-length']) {
      const len = Number(headers['content-length']);
      if (!Number.isFinite(len) || buffer.length - bodyStart < len) return;
      body = buffer.subarray(bodyStart, bodyStart + len);
      bodyStart += len;
    } else {
      // Tanpa panjang: respons berakhir saat koneksi ditutup.
      if (!closed) return;
      body = buffer.subarray(bodyStart);
      bodyStart = buffer.length;
    }

    const status = Number((/^HTTP\/1\.[01] (\d{3})/.exec(headText) ?? [])[1] ?? 0);
    buffer = buffer.subarray(bodyStart);
    const current = waiting;
    waiting = null;
    current.resolve({ status, headers, setCookies, body: body.toString('utf8'), ms: Date.now() - current.started });
  };

  secure.on('data', (d: Buffer) => { buffer = Buffer.concat([buffer, d]); drain(); });
  secure.on('error', (e) => { closed = e; waiting?.reject(e); waiting = null; });
  secure.on('close', () => { closed = new Error('koneksi proxy ditutup'); waiting?.reject(closed); waiting = null; });

  return {
    request(opts) {
      if (closed) return Promise.reject(closed);
      const started = Date.now();
      const payload = opts.body ?? '';
      const head = [
        `${opts.method} ${opts.path} HTTP/1.1`,
        `Host: ${targetHost}`,
        ...Object.entries(opts.headers).map(([k, v]) => `${k}: ${v}`),
        `content-length: ${Buffer.byteLength(payload)}`,
        'connection: keep-alive',
        '', '',
      ].join('\r\n');
      const { promise, resolve, reject } = Promise.withResolvers<TunnelResponse>();
      waiting = { resolve, reject, started };
      const timer = setTimeout(() => {
        if (!waiting) return;
        waiting = null;
        reject(new Error(`request timeout ${opts.timeoutMs ?? 20_000}ms`));
      }, opts.timeoutMs ?? 20_000);
      const orig = waiting.resolve;
      waiting.resolve = (r) => { clearTimeout(timer); orig(r); };
      secure.write(head + payload);
      return promise;
    },
    close() { try { secure.destroy(); } catch { /* sudah tertutup */ } },
  };
}

/** Satu request lewat proxy baru, lalu tutup. Untuk uji cepat per proxy. */
export async function requestThroughProxy(
  spec: ProxySpec,
  targetHost: string,
  opts: ProxyRequest,
  targetPort = 443,
): Promise<TunnelResponse> {
  const session = await openProxySession(spec, targetHost, targetPort, opts.timeoutMs ?? 12_000);
  try {
    return await session.request(opts);
  } finally {
    session.close();
  }
}

/** Baca body chunked; null bila belum lengkap. `consumed` termasuk baris terminator. */
function readChunked(buf: Buffer): { body: Buffer; consumed: number } | null {
  const parts: Buffer[] = [];
  let i = 0;
  for (;;) {
    const nl = buf.indexOf('\r\n', i);
    if (nl < 0) return null;
    const size = Number.parseInt(buf.subarray(i, nl).toString('latin1'), 16);
    if (!Number.isFinite(size)) return null;
    if (size === 0) {
      const end = buf.indexOf('\r\n\r\n', nl);
      const consumed = end >= 0 ? end + 4 : nl + 4;
      if (buf.length < consumed) return null;
      return { body: Buffer.concat(parts), consumed };
    }
    const start = nl + 2;
    if (buf.length < start + size + 2) return null;
    parts.push(buf.subarray(start, start + size));
    i = start + size + 2;
  }
}

/**
 * Sumber daftar proxy yang dipakai pool. Daftar ini tidak memuat negara, jadi penyaringan
 * "hanya Indonesia" dilakukan terpisah memakai delegasi APNIC; endpoint diagnostik
 * menerima hasil saringan lewat `?proxies=`.
 */
export const PROXY_SOURCES: string[] = [
  // http
  'https://api.openproxylist.xyz/http.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all',
  'https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&protocol=http&proxy_format=ipport&format=text',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt',
  'https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://raw.githubusercontent.com/iplocate/free-proxy-list/main/protocols/http.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt',
  'https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt',
  'https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt',
  // socks4
  'https://api.openproxylist.xyz/socks4.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks4.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt',
  'https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS4_RAW.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt',
  // socks5
  'https://api.openproxylist.xyz/socks5.txt',
  'https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000',
  'https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/socks5.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt',
  'https://raw.githubusercontent.com/hookzof/socks5_list/master/proxy.txt',
  'https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt',
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt',
  'https://raw.githubusercontent.com/officialputuid/KangProxy/KangProxy/socks5.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/socks5/data.txt',
  'https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt',
];

/** Daftar proxy dari proxyscrape (kompatibilitas). */
export async function fetchProxyList(country = 'id', timeoutMs = 20_000): Promise<string[]> {
  const url = `https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&country=${country}&protocol=http&proxy_format=ipport&format=text`;
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`daftar proxy HTTP ${r.status}`);
  const text = await r.text();
  return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(s));
}

/**
 * Kumpulkan proxy dari banyak sumber sekaligus. Baris boleh berbentuk `ip:port` atau
 * `skema://ip:port`; baris lain (komentar, HTML) diabaikan. Hasil dideduplikasi per
 * alamat+skema karena sumber yang berbeda sering memuat proxy yang sama.
 */
export async function fetchProxyPool(
  urls: string[],
  opts: { defaultScheme?: ProxyScheme; timeoutMs?: number } = {},
): Promise<ProxySpec[]> {
  const fallback = opts.defaultScheme ?? 'http';
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const seen = new Set<string>();
  const out: ProxySpec[] = [];

  const results = await Promise.all(urls.map(async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) return [];
      return (await r.text()).split(/\r?\n/);
    } catch {
      return [];
    }
  }));

  for (const lines of results) {
    for (const line of lines) {
      const spec = parseProxy(line, fallback);
      if (!spec) continue;
      const key = `${spec.scheme}|${spec.host}:${spec.port}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(spec);
    }
  }
  return out;
}
