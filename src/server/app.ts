import Fastify from 'fastify';
import { CONFIG } from '../config.ts';
import { Store, flagKey } from '../core/db/store.ts';
import { BUCKET_LABEL, bucketOf, buildReport, exportPatientsToExcel, exportReportToExcel, staleSubmissions, type Bucket, type Report } from '../core/report.ts';
import { exportVisitsToExcel } from '../core/visitsExport.ts';
import { MATCH_RULES, resolveMatchRule } from '../core/verdict.ts';
import { BULK_FLAG_REASONS, BULK_REASON_LABEL, applyBulkFlags, parseBulkFlagFile, writeBulkFlagTemplate } from '../core/bulkFlags.ts';
import { buildCapaianPdf, PDF_MAX_ROWS } from '../core/pdfCapaian.ts';
import { guessMapping, importAssignments, writeAssignmentTemplate, MANUAL_REASONS } from '../core/excel.ts';
import { ensureFreshSession, probeSession, runSync } from '../core/sync.ts';
import { runDetailFetch } from '../core/detailRun.ts';
import { refreshSession } from '../core/ssi/session.ts';
import { BASE_URL, REFERER, USER_AGENT } from '../core/ssi/http.ts';
import { fetchCaptcha, submitLogin } from '../core/ssi/login.ts';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_COOKIE, ADMIN_TTL_MS, adminKey, signAdminToken, verifyAdminToken } from './adminAuth.ts';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Bangun instance Fastify tanpa `listen`. Dipakai dua jalur:
 *  - `startServer()` (proses panjang: lokal, container)
 *  - `api/index.ts` (serverless: Vercel menyerahkan req/res Node mentah)
 */
export async function buildApp() {
  // Tanpa sandi, halaman admin terbuka untuk siapa pun yang bisa menjangkau server.
  // Di localhost itu wajar; di jaringan puskesmas tidak.
  // VERCEL: HOST tetap default 127.0.0.1 padahal aplikasi terbuka di internet —
  // jangan sampai penjaga "local tanpa sandi" ikut aktif di sana.
  const localOnly = LOOPBACK.has(CONFIG.host) && !process.env.VERCEL;
  if (!CONFIG.adminPassword && !localOnly) {
    throw new Error(
      'MONEV_ADMIN_PASSWORD wajib diisi bila HOST bukan localhost. ' +
      'Set mis. MONEV_ADMIN_PASSWORD=rahasia atau jalankan dengan HOST=127.0.0.1.',
    );
  }
  // trustProxy: batas percobaan login memakai IP asli, bukan IP proxy.
  const app = Fastify({ logger: false, bodyLimit: 20 * 1024 * 1024, trustProxy: CONFIG.trustProxy });
  const store = await Store.open({ sqlitePath: CONFIG.dbPath, databaseUrl: CONFIG.databaseUrl });
  // Hanya pada SQLite (satu proses, satu disk): proses baru berarti sweep lama pasti mati.
  // Di Postgres/serverless, run "running" bisa milik instance lain yang masih bekerja —
  // lease `sync_lock` yang menentukan, bukan pembersihan saat start.
  if (!CONFIG.databaseUrl) await store.recoverInterrupted();
  let syncing = false;
  let detailBusy = false;

  /* ---------- admin: sandi + cookie sesi ---------- */
  // Sandi dibandingkan sebagai sha256 agar panjangnya tidak bocor lewat timing.
  const sha256 = (v: string) => createHash('sha256').update(v).digest();
  const passwordHash = CONFIG.adminPassword ? sha256(CONFIG.adminPassword) : null;
  /**
   * Cookie admin stateless (`v1.<exp>.<hmac>`): restart server atau instance berbeda
   * tetap menerima cookie yang sama — syarat untuk serverless/multi-instance.
   */
  const adminSigningKey = adminKey(CONFIG.adminPassword, CONFIG.adminSecret);
  const loginAttempts = new Map<string, { count: number; until: number }>();

  function readCookie(header: string | undefined, name: string): string | null {
    if (!header) return null;
    for (const part of header.split(';')) {
      const i = part.indexOf('=');
      if (i < 0) continue;
      if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return null;
  }

  function isAdmin(req: any): boolean {
    if (!passwordHash) return true; // mode lokal tanpa sandi
    const token = readCookie(req.headers.cookie, ADMIN_COOKIE);
    return Boolean(token && verifyAdminToken(adminSigningKey, token));
  }

  /** Semua endpoint tulis & data mentah wajib admin; pembacaan laporan tetap bebas. */
  // `/api/flags/import` menerima file (menulis data) jadi wajib admin; `/api/flags/template` hanya membaca.
  // Penandaan hasil dan unduhan daftar pasien (NIK penuh) kini hanya untuk admin:
  // menyembunyikan tombolnya saja tidak cukup, endpoint-nya harus menolak juga.
  const ADMIN_PATHS = ['/api/sync', '/api/detail', '/api/session', '/api/ingest', '/api/assign', '/api/batches',
    '/api/flags/set', '/api/flags/bulk', '/api/flags/import', '/api/petugas', '/api/patients', '/api/patients.xlsx', '/api/visits.xlsx', '/api/settings', '/api/diag'];
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0];
    if (url === '/api/admin') return;
    // Daftar batch dibaca halaman laporan publik (pemilih batch di header); isinya hanya
    // nama/periode. Perubahan batch tetap lewat metode tulis yang wajib admin.
    if (req.method === 'GET' && url === '/api/batches') return;
    // Ingest punya autentikasinya sendiri (x-ingest-token), bukan cookie admin:
    // pengirimnya mesin lokal tanpa login.
    if (req.method === 'POST' && url === '/api/ingest/visits') return;
    if (!ADMIN_PATHS.some((p) => url === p || url.startsWith(p + '/'))) return;
    if (isAdmin(req)) return;
    reply.code(401).send({ error: 'Halaman admin terkunci.', locked: true });
  });

  // Dua halaman: laporan publik dan admin (ber-sandi).
  app.get('/', (_req, reply) => {
    reply.type('text/html; charset=utf-8').send(readFileSync(join('web', 'index.html'), 'utf8'));
  });
  app.get('/admin', (_req, reply) => {
    // Halaman admin tidak untuk mesin pencari.
    reply.header('x-robots-tag', 'noindex, nofollow');
    reply.type('text/html; charset=utf-8').send(readFileSync(join('web', 'admin.html'), 'utf8'));
  });

  // Ikon tab. Disajikan sebagai file agar bisa di-cache dan dipakai juga saat deploy.
  app.get('/favicon.svg', async (_req, reply) => {
    try {
      return reply.type('image/svg+xml')
        .header('cache-control', 'public, max-age=604800')
        .send(readFileSync(join('web', 'favicon.svg')));
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  /**
   * SEO minimal untuk satu halaman publik: halaman laporan boleh diindeks,
   * admin dan API tidak. Sitemap memakai host permintaan supaya tetap benar
   * di localhost maupun setelah deploy.
   */
  app.get('/robots.txt', async (_req, reply) => reply
    .type('text/plain; charset=utf-8')
    .send([
      'User-agent: *',
      'Allow: /$',
      'Allow: /fonts/',
      'Disallow: /admin',
      'Disallow: /kelola',
      'Disallow: /api/',
      '',
    ].join('\n')));

  app.get('/sitemap.xml', async (req, reply) => {
    const host = String(req.headers.host ?? 'localhost');
    const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      '  <url>',
      `    <loc>${proto}://${host}/</loc>`,
      '    <changefreq>daily</changefreq>',
      '    <priority>1.0</priority>',
      '  </url>',
      '</urlset>',
      '',
    ].join('\n');
    return reply.type('application/xml; charset=utf-8').send(xml);
  });
  // Route lama dipertahankan sebagai redirect supaya bookmark tidak 404.
  app.get('/kelola', (_req, reply) => reply.redirect('/admin', 302));

  // Font disajikan lokal: puskesmas sering tanpa internet, dan aplikasi harus tetap berfungsi.
  app.get('/fonts/:file', async (req, reply) => {
    const file = (req.params as any).file as string;
    if (!/^[a-z0-9.-]+\.woff2$/i.test(file)) return reply.code(404).send({ error: 'not found' });
    try {
      const buf = readFileSync(join('web', 'fonts', file));
      return reply.type('font/woff2').header('cache-control', 'public, max-age=604800').send(buf);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  });

  const needPassword = Boolean(passwordHash);
  /**
   * Diagnostik jalur SSI dari instance ini: status + sebagian header + potongan body.
   * Dipakai saat sync gagal karena 403/502 — supaya jelas apakah penolakan datang dari
   * WAF/geo (mis. IP datacenter Vercel) atau dari aplikasi SSI.
   */
  app.get('/api/diag/ssi', async () => {
    const probe = async (path: string, headers: Record<string, string>) => {
      const startedAt = Date.now();
      try {
        const r = await fetch(`${BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(20_000) });
        const body = await r.text();
        const pick = ['server', 'content-type', 'cf-ray', 'cf-mitigated', 'x-vercel-id', 'location', 'set-cookie'];
        const h: Record<string, string> = {};
        for (const k of pick) { const v = r.headers.get(k); if (v) h[k] = k === 'set-cookie' ? '<ada>' : v; }
        return { path, status: r.status, ms: Date.now() - startedAt, headers: h, body: body.slice(0, 300) };
      } catch (e: any) {
        return { path, error: `${e?.name ?? 'Error'}: ${e?.message ?? e}`, ms: Date.now() - startedAt };
      }
    };
    const out = {
      egress: { via: process.env.VERCEL ? 'vercel' : 'lokal', region: process.env.VERCEL_REGION ?? null },
      now: new Date().toISOString(),
      probes: [
        await probe('/api/crypto-key', { accept: 'application/json', 'user-agent': USER_AGENT }),
        await probe('/auth/login', { accept: 'text/html', 'user-agent': USER_AGENT, referer: REFERER }),
      ],
    };
    return out;
  });

  // Untuk healthcheck container/uptime monitor: tanpa auth, tanpa data pasien.
  app.get('/api/health', async (_req, reply) => {
    try {
      await store.visitCount();
      return { ok: true, at: new Date().toISOString() };
    } catch (e) {
      return reply.code(503).send({ ok: false, error: String((e as Error).message) });
    }
  });

  app.get('/api/admin', async (req) => ({
    needPassword,
    unlocked: isAdmin(req),
  }));

  app.post('/api/admin/login', async (req, reply) => {
    if (!passwordHash) return { ok: true };
    const ip = String((req as any).ip ?? 'unknown');
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.until > now) {
      return reply.code(429).send({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil((attempt.until - now) / 1000)} detik.` });
    }
    const given = String((req.body as any)?.password ?? '');
    const same = given.length > 0 && timingSafeEqual(sha256(given), passwordHash);
    if (!same) {
      const count = (attempt?.count ?? 0) + 1;
      // 5 salah berturut-turut = tunggu 60 detik.
      loginAttempts.set(ip, { count, until: count >= 5 ? now + 60_000 : 0 });
      return reply.code(401).send({ error: 'Sandi salah.' });
    }
    loginAttempts.delete(ip);
    const token = signAdminToken(adminSigningKey, now + ADMIN_TTL_MS);
    const secure = CONFIG.cookieSecure || req.protocol === 'https';
    reply.header('set-cookie',
      `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ADMIN_TTL_MS / 1000}` +
      (secure ? '; Secure' : ''));
    return { ok: true };
  });

  app.post('/api/admin/logout', async (_req, reply) => {
    // Cookie stateless tidak bisa dicabut di server; menghapusnya di browser sudah cukup
    // untuk perangkat itu. Untuk membatalkan semua perangkat, ganti MONEV_ADMIN_PASSWORD.
    reply.header('set-cookie', `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
    return { ok: true };
  });

  app.get('/api/status', async () => {
    const s = await store.getSession();
    const run = await store.lastRun();
    // Tidak ada cara jujur menebak "sesi hidup": endpoint baca menerima token palsu,
    // sedangkan /menu memberi 401 walau data tetap terbaca. Yang dilaporkan hanya
    // penolakan nyata dari SSI (401/403 saat sync atau refresh).
    const err = await store.sessionError();
    return {
      hasSession: Boolean(s),
      sessionError: err?.message ?? null,
      sessionErrorAt: err?.at ?? null,
      sessionUpdatedAt: s?.updatedAt ?? null,
      visits: await store.visitCount(),
      lastSyncAt: run?.finished_at ?? null,
      lastSyncStatus: run?.status ?? null,
      lastSyncFetched: run?.fetched ?? 0,
      faskesCode: CONFIG.faskesCode,
      syncing,
      ssiFetchAvailable: CONFIG.ssiFetch,
      ...(await sweepRange()),
    };
  });

  /**
   * Cek sesi saat halaman dibuka. Tanpa cron: hanya dijalankan bila diminta UI,
   * dan hasilnya di-cache singkat supaya beberapa tab dalam satu menit tidak
   * menembak SSI berkali-kali.
   *
   * Ditulis HANYA bila ?record=1 karena /menu bisa 401 walau sweep masih jalan
   * (lihat catatan di /api/status). Pemeriksaan murni tampilan tidak boleh
   * mengubah status sesi yang dipakai proses sinkronisasi.
   */
  let probeCache: { at: number; result: Awaited<ReturnType<typeof probeSession>> } | null = null;
  const PROBE_TTL_MS = 60_000;
  app.post('/api/session/probe', async (req) => {
    const now = Date.now();
    const force = String((req.query as any)?.force ?? '') === '1';
    if (!force && probeCache && now - probeCache.at < PROBE_TTL_MS) {
      return { ...probeCache.result, cached: true };
    }
    const record = String((req.query as any)?.record ?? '') === '1';
    const result = await probeSession(store, record);
    // Jangan cache kegagalan jaringan: pengunjung berikutnya berhak atas percobaan baru.
    if (result.state !== 'unknown') probeCache = { at: now, result };
    return { ...result, cached: false };
  });

  app.post('/api/session/refresh', async (_req, reply) => {
    const s = await store.getSession();
    if (!s) return reply.code(400).send({ error: 'Belum ada sesi.' });
    // Lock tulis DB lintas-proses: refresh_token single-use, dua pemakaian = sesi dicabut total.
    const r = await store.withWriteLock(async () => {
      const fresh = await store.getSession();
      if (!fresh) return { ok: false as const, reason: 'expired' as const, message: 'Belum ada sesi.' };
      const out = await refreshSession(fresh);
      if (out.ok) { await store.saveSession(out.session); await store.clearSessionError(); }
      return out;
    });
    if (!r.ok) {
      if (r.reason === 'expired' || r.reason === 'reused') await store.setSessionError(r.message);
      return reply.code(409).send({ error: r.message, reason: r.reason });
    }
    await store.clearSessionError();
    return { ok: true, updatedAt: (r as any).session.updatedAt };
  });

  /**
   * Ingest snapshot dari instance lokal (collector). Dipakai mode lokal → prod:
   * collector memegang sesi SSI (cookie terikat IP/UA), prod hanya menyimpan & melaporkan.
   */
  app.post('/api/ingest/visits', async (req, reply) => {
    const expected = process.env.MONEV_INGEST_TOKEN ?? '';
    if (!expected) return reply.code(403).send({ error: 'Ingest nonaktif: set MONEV_INGEST_TOKEN.' });
    if (req.headers['x-ingest-token'] !== expected) return reply.code(401).send({ error: 'Token ingest salah.' });
    const visits = (req.body as any)?.visits;
    if (!Array.isArray(visits)) return reply.code(400).send({ error: 'Body harus { visits: [...] }.' });
    const res = await store.upsertVisits(visits);
    return { ok: true, received: visits.length, ...res };
  });

  /** Ambil rincian layanan untuk pasien yang ditugaskan (bukan seluruh 13 ribu kunjungan). */
  app.post('/api/detail/fetch', async (req, reply) => {
    const body = req.body as any;
    if (detailBusy) return reply.code(409).send({ error: 'Pengambilan rincian sedang berjalan.' });
    detailBusy = true;
    try {
      return await runDetailFetch(store, {
        batchId: body?.batchId ? Number(body.batchId) : undefined,
        faskesCode: CONFIG.faskesCode,
        userId: CONFIG.userId,
        fullname: CONFIG.fullname,
        partnerCode: CONFIG.partnerCode,
        userType: CONFIG.userType,
        force: Boolean(body?.force),
      });
    } catch (e: any) {
      return reply.code(502).send({ error: String(e?.message ?? e) });
    } finally {
      detailBusy = false;
    }
  });

  app.get('/api/report', async (req) => {
    const q = req.query as any;
    const year = q.year ? Number(q.year) : null;
    const batchId = q.batch ? Number(q.batch) : null;
    const active = await store.resolveBatch(batchId);
    const report = await buildReport(store, active?.id, year && Number.isFinite(year) ? year : null);
    const { rows, ...meta } = report;
    return { ...meta, rows: q.rows === '0' ? undefined : rows };
  });

  app.get('/api/report.xlsx', async (req, reply) => {
    const q = req.query as any;
    const year = q.year ? Number(q.year) : null;
    const batchId = q.batch ? Number(q.batch) : null;
    const report = await buildReport(store, (await store.resolveBatch(batchId))?.id, year && Number.isFinite(year) ? year : null);
    const dir = mkdtempSync(join(tmpdir(), 'monev-'));
    const out = join(dir, 'monev.xlsx');
    await exportReportToExcel(report, out);
    reply.header('content-disposition', 'attachment; filename="monev-ckg.xlsx"');
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(readFileSync(out));
  });

  /**
   * Daftar pasien sebagai Excel, mengikuti filter yang sedang dilihat di halaman laporan.
   * NIK ditulis penuh: gunanya untuk menagih/mencocokkan di luar aplikasi.
   */
  app.get('/api/patients.xlsx', async (req, reply) => {
    const q = req.query as any;
    const year = q.year ? Number(q.year) : null;
    const batchId = q.batch ? Number(q.batch) : null;
    const report = await buildReport(store, (await store.resolveBatch(batchId))?.id, year && Number.isFinite(year) ? year : null);
    const petugas = q.petugas ? String(q.petugas) : null;
    const status = q.status ? String(q.status) : null;
    const needle = q.q ? String(q.q).trim().toLowerCase() : '';
    const rows = report.rows.filter((r) => {
      if (petugas && r.petugas !== petugas) return false;
      if (status && r.bucket !== status) return false;
      if (!needle) return true;
      return [r.name, r.nik, r.petugas].some((v) => String(v ?? '').toLowerCase().includes(needle));
    });
    const dir = mkdtempSync(join(tmpdir(), 'monev-'));
    const out = join(dir, 'pasien.xlsx');
    await exportPatientsToExcel(rows, {
      batchName: report.batchName, year: report.year, petugas, status, query: q.q ? String(q.q) : null,
    }, out);
    const safe = (v: string) => v.replace(/[^\w\-]+/g, '_');
    const parts = ['pasien', report.batchName ?? 'batch'];
    if (petugas) parts.push(safe(petugas));
    if (status) parts.push(safe(status.toLowerCase()));
    reply.header('content-disposition', `attachment; filename="${parts.join('-')}.xlsx"`);
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(readFileSync(out));
  });

  /**
   * Data mentah SSI: seluruh kunjungan yang tersimpan, bukan hanya pasien yang dibagi ke
   * petugas. NIK ditulis penuh; berkas ini admin-only karena memuat identitas pasien.
   */
  app.get('/api/visits.xlsx', async (req, reply) => {
    const q = req.query as any;
    const raw = String(q.year ?? '').trim();
    if (raw && !/^\d{4}$/.test(raw)) return reply.code(400).send({ error: 'Parameter year harus 4 angka, mis. 2026.' });
    const year = raw ? Number(raw) : null;
    const [rows, run] = await Promise.all([store.visitsForExport(year), store.lastRun()]);
    const dir = mkdtempSync(join(tmpdir(), 'monev-'));
    const out = join(dir, 'ssi.xlsx');
    await exportVisitsToExcel(rows, { year, syncedAt: run?.finished_at ?? null }, out);
    reply.header('content-disposition', `attachment; filename="data-ssi-${year ?? 'semua'}.xlsx"`);
    return reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(readFileSync(out));
  });

  /** Daftar petugas + hasil per status, untuk isi filter di halaman laporan. */
  app.get('/api/patients/filters', async () => {
    const report = await buildReport(store, (await store.resolveBatch(null))?.id, null);
    return {
      batchId: report.batchId,
      petugas: [...new Set(report.rows.map((r) => r.petugas))].sort((a, b) => a.localeCompare(b)),
      buckets: (['DIINPUT', 'TIDAK_VALID', 'FASKES_LAIN', 'DATA_HILANG', 'LAINNYA', 'BELUM'] as Bucket[])
        .map((code) => ({ code, label: BUCKET_LABEL[code] })),
    };
  });

  /** Langkah 1 login: ambil captcha. Gambar ditampilkan ke operator, bukan di-OCR. */
  app.get('/api/session/captcha', async (_req, reply) => {
    try { return await fetchCaptcha(store); }
    catch (e: any) { return reply.code(502).send({ error: String(e?.message ?? e) }); }
  });

  /** Langkah 2 login: captcha + kredensial. Sesi disimpan di server, tidak pernah ke browser. */
  app.post('/api/session/login', async (req, reply) => {
    const body = req.body as any;
    if (!body?.email || !body?.password || !body?.captchaId || !body?.code) {
      return reply.code(400).send({ error: 'email, password, captchaId, dan code wajib.' });
    }
    const out = await submitLogin(store, {
      email: String(body.email),
      password: String(body.password),
      captchaId: String(body.captchaId),
      code: String(body.code),
    });
    if (!out.ok) return reply.code(401).send({ error: out.message, reason: out.reason });


    await store.withWriteLock(async () => {
      await store.saveSession(out.session);
      await store.clearSessionError();
    });
    return { ok: true, updatedAt: out.session.updatedAt };
  });

  app.post('/api/session', async (req, reply) => {
    const body = req.body as any;
    const cookie: string = body?.cookie ?? '';
    const jar = Object.fromEntries(
      cookie.split(';').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()]; }),
    );
    const tokens = body?.tokens ?? jar;
    const tokenEksternal = body?.token_eksternal ?? tokens.token_eksternal;
    const refreshToken = body?.refresh_token ?? tokens.refresh_token;
    if (!tokenEksternal || !refreshToken) {
      return reply.code(400).send({ error: 'Butuh token_eksternal dan refresh_token (tempel cookie header atau isi dua kolom).' });
    }
    await store.withWriteLock(async () => {
      await store.saveSession({ tokenEksternal, refreshToken, updatedAt: new Date().toISOString() });
      await store.clearSessionError();
    });
    return { ok: true };
  });

  /** Menerima file via base64 (browser) atau path lokal (CLI/skrip). */
  async function resolveUpload(body: any): Promise<string> {
    if (body?.path) return body.path;
    if (!body?.base64) throw new Error('Kirim file (base64) atau path.');
    const name = String(body.filename ?? 'penugasan.xlsx').replace(/[^\w.\-]+/g, '_');
    const dir = mkdtempSync(join(tmpdir(), 'monev-up-'));
    const out = join(dir, name);
    writeFileSync(out, Buffer.from(String(body.base64).replace(/^data:[^;]+;base64,/, ''), 'base64'));
    return out;
  }

  /** Template impor penugasan: nama kolom, format NIK, dan pilihan Keterangan sudah paten. */
  app.get('/api/assign/template', async (req, reply) => {
    const q = req.query as any;
    const batch = q.batch ? await store.getBatch(Number(q.batch)) : await store.resolveBatch(null);
    const petugas = batch ? await store.petugasOfBatch(batch.id) : [];
    const year = batch?.period_start ? Number(String(batch.period_start).slice(0, 4)) : new Date().getFullYear();
    const dir = mkdtempSync(join(tmpdir(), 'monev-tpl-'));
    const name = 'template-penugasan.xlsx';
    const out = join(dir, name);
    try {
      await writeAssignmentTemplate(out, petugas, Number.isFinite(year) ? year : null);
    } catch (e: any) {
      return reply.code(500).send({ error: 'Gagal membuat template: ' + String(e?.message ?? e) });
    }
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(readFileSync(out));
  });

  app.post('/api/assign/inspect', async (req, reply) => {
    try { return await guessMapping(await resolveUpload(req.body)); }
    catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }
  });

  app.post('/api/assign/import', async (req, reply) => {
    const body = req.body as any;
    let file: string;
    try { file = await resolveUpload(body); } catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }
    const mapping = body.mapping ?? (await guessMapping(file)).mapping;
    let res;
    try { res = await importAssignments(file, mapping); }
    catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }

    // Tujuan impor: batch yang sudah ada (impor susulan) atau batch baru.
    let batchId: number;
    let created = false;
    if (body.batchId) {
      batchId = Number(body.batchId);
      const target = await store.getBatch(batchId);
      if (!target) return reply.code(404).send({ error: `Batch ${batchId} tidak ditemukan.` });
      if (target.status !== 'aktif') {
        return reply.code(409).send({ error: `Batch "${target.name}" sudah ${target.status}; tambahkan baris ke batch aktif.` });
      }
    } else {
      const name = String(body.batchName ?? '').trim();
      if (!name) return reply.code(400).send({ error: 'Nama batch wajib diisi (mis. "September 2026").' });
      batchId = await store.createBatch({
        name,
        filename: body.filename ?? file,
        rowCount: 0,
        mapping,
        periodStart: body.periodStart || null,
        periodEnd: body.periodEnd || null,
      });
      created = true;
    }

    // Satu file = satu kebenaran untuk batch ini: unggah ulang MENGGANTI isi, bukan menambah.
    // Tanda manual yang sudah ada dipakai ulang untuk NIK + Petugas yang sama.
    const carried = await store.manualFlags(batchId);
    const fromFile = await store.excelFlags(batchId);
    const incoming = res.rows.map((r) => {
      const prev = carried.get(flagKey(r.petugas, r.nik));
      // Tanda Excel menang atas usulan lama; tanda manual lama menang bila Excel tidak menandai.
      const failReason = r.failReason ?? prev?.failReason ?? null;
      const note = r.failReason ? r.note : (prev?.note ?? null);
      const by = r.failReason ? 'excel' : (prev?.by ?? null);
      return {
        rowNo: r.rowNo, petugas: r.petugas, nik: r.nik, name: r.name, birthDate: r.birthDate, targetDate: r.targetDate,
        failReason, note, flaggedBy: by, year: r.year,
      };
    });

    // Baris ganda di dalam satu file: kunci NIK + Petugas. Dilaporkan, bukan disimpan.
    const seen = new Set<string>();
    const duplicates: Array<{ rowNo: number; nik: string | null; petugas: string; name: string | null }> = [];
    const toInsert = incoming.filter((r) => {
      const key = flagKey(r.petugas, r.nik);
      if (seen.has(key)) {
        duplicates.push({ rowNo: r.rowNo, nik: r.nik, petugas: r.petugas, name: r.name });
        return false;
      }
      seen.add(key);
      return true;
    });
    // Tanda yang dulu datang dari kolom Keterangan file lama, tetapi tidak ada di file baru:
    // hilang bersama file. Dihitung dulu supaya bisa dilaporkan, bukan hilang diam-diam.
    const droppedExcelFlags = [...fromFile]
      .filter(([key]) => toInsert.some((r) => flagKey(r.petugas, r.nik) === key && !r.failReason))
      .map(([key, reason]) => ({ key, reason }));

    await store.replaceAssignments(batchId, toInsert);
    await store.setBatchRowCount(batchId, toInsert.length);

    // Setoran yang tercatat bisa jadi tidak lagi menutup data karena file baru menambah
    // pasien. Setoran seperti itu dicabut: lebih jujur daripada menandai pasien baru
    // sebagai "Data Hilang" tanpa ada yang memutuskan.
    const afterImport = await buildReport(store, batchId, null);
    const stale = staleSubmissions(afterImport.perPetugas);
    for (const name of stale) await store.revokeSubmission(batchId, name);
    // appendToBatch mencatat kapan impor terakhir terjadi (jumlah baris tidak ditambah lagi).
    await store.touchBatch(batchId, body.filename ?? file);

    const flagged = incoming.filter((r) => r.failReason).length;
    const unrecognized = incoming.filter((r) => r.failReason === 'lainnya' && r.note).length;
    return {
      batchId, created, replaced: !created,
      imported: toInsert.length,
      skipped: res.skipped.length + duplicates.length,
      skippedDetail: res.skipped.slice(0, 20),
      duplicates: duplicates.slice(0, 20),
      statusColumn: mapping.status ?? null, flagged, unrecognized,
      carriedFlags: incoming.filter((r) => r.flaggedBy !== 'excel' && r.failReason).length,
      setoranDireset: stale,
      droppedExcelFlags: droppedExcelFlags.length,
    };
  });

  /* ---------- batch penugasan ---------- */
  app.get('/api/batches', async () => ({ batches: await store.listBatches() }));

  /** Pilihan syarat "dianggap sudah diinput" + aturan yang kini dipakai tiap batch. */
  app.get('/api/match-rules', async () => ({
    rules: MATCH_RULES,
    batches: (await store.listBatches()).map((b) => ({ id: b.id, name: b.name, matchRule: resolveMatchRule(b.match_rule) })),
  }));

  app.post('/api/batches', async (req, reply) => {
    const body = req.body as any;
    const name = String(body?.name ?? '').trim();
    if (!name) return reply.code(400).send({ error: 'Nama batch wajib diisi.' });
    // Batch cukup nama + tahun: tahun disimpan di period_start agar kolom DB tidak bertambah.
    const year = String(body.year ?? '').trim();
    if (!/^\d{4}$/.test(year)) return reply.code(400).send({ error: 'Tahun batch wajib 4 digit (mis. 2026).' });
    const id = await store.createBatch({
      name,
      filename: '(kosong)',
      rowCount: 0,
      periodStart: year + '-01-01',
      periodEnd: year + '-12-31',
      note: body.note || null,
    });
    await store.markBatchEmpty(id);
    return { id };
  });

  app.patch('/api/batches/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const body = req.body as any;
    if (!(await store.getBatch(id))) return reply.code(404).send({ error: 'Batch tidak ditemukan.' });
    if (body.status && !['aktif', 'selesai', 'arsip'].includes(body.status)) {
      return reply.code(400).send({ error: 'Status harus aktif, selesai, atau arsip.' });
    }
    if (body.matchRule && !MATCH_RULES.some((r) => r.code === body.matchRule)) {
      return reply.code(400).send({ error: `Aturan tidak dikenal: ${body.matchRule}` });
    }
    await store.updateBatch(id, {
      name: body.name !== undefined ? String(body.name).trim() : undefined,
      periodStart: body.periodStart !== undefined ? (body.periodStart || null) : undefined,
      periodEnd: body.periodEnd !== undefined ? (body.periodEnd || null) : undefined,
      status: body.status,
      note: body.note !== undefined ? (body.note || null) : undefined,
      matchRule: body.matchRule,
    });
    return { ok: true, batch: await store.getBatch(id) };
  });

  app.delete('/api/batches/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    if (!(await store.getBatch(id))) return reply.code(404).send({ error: 'Batch tidak ditemukan.' });
    await store.purgeBatch(id);
    return { ok: true };
  });

  /**
   * Capaian per petugas sebagai PDF satu halaman. Batch dan tahun yang difilter ikut
   * tercetak di header supaya rekap yang dipegang orang tidak ambigu.
   */
  app.get('/api/report.pdf', async (req, reply) => {
    const q = req.query as any;
    const year = q.year ? Number(q.year) : null;
    const batchId = q.batch ? Number(q.batch) : null;
    const report: Report = await buildReport(store, (await store.resolveBatch(batchId))?.id, year && Number.isFinite(year) ? year : null);
    const period = report.batch?.periodStart ? String(report.batch.periodStart).slice(0, 4) : null;
    const yearLabel = report.matchYears ? report.matchYears.join(', ') : 'semua tahun';
    const when = new Date(report.generatedAt).toLocaleString('id-ID', { dateStyle: 'long', timeStyle: 'short' });
    try {
      const pdf = buildCapaianPdf({
        title: 'Capaian Entry CKG Pegawai',
        meta: [
          ['Batch', `${report.batchName ?? '-'}${period ? ' (' + period + ')' : ''} - Tahun ${yearLabel}`],
          ['Faskes', `Puskesmas Baruharjo - dicetak ${when}`],
        ],
        rows: report.perPetugas.map((p) => ({
          petugas: p.petugas, assigned: p.assigned, diinput: p.diinput, gagal: p.gagalDitandai,
          belum: p.perluTindakan, pct: p.pctCapaian,
        })),
        total: {
          petugas: 'TOTAL', assigned: report.totals.assigned, diinput: report.totals.diinput,
          gagal: report.totals.gagalDitandai, belum: report.totals.perluTindakan, pct: report.totals.pctCapaian,
        },
      });
      const safeName = String(report.batchName ?? 'rekap').replace(/[^\w\-]+/g, '_');
      reply.header('content-disposition', `attachment; filename="capaian-petugas-${safeName}.pdf"`);
      return reply.type('application/pdf').send(pdf);
    } catch (e: any) {
      return reply.code(409).send({ error: String(e?.message ?? e) });
    }
  });

  /** Template file tanda massal: NIK + pilihan "Tidak Valid" / "Faskes Lain". */
  app.get('/api/flags/template', async (req, reply) => {
    const q = req.query as any;
    const batchId = q.batch ? Number(q.batch) : (await store.resolveBatch(null))?.id;
    const petugas = batchId ? await store.petugasOfBatch(batchId) : [];
    const dir = mkdtempSync(join(tmpdir(), 'monev-tpl-'));
    // Nama file harus sama dengan isi Content-Disposition: nama berbeda membuat browser
    // menyimpan dengan nama salah (dulu: "admin.htm.xlsx").
    const name = 'template-tanda-tidak-valid.xlsx';
    const out = join(dir, name);
    try {
      await writeBulkFlagTemplate(out, petugas);
    } catch (e: any) {
      return reply.code(500).send({ error: 'Gagal membuat template: ' + String(e?.message ?? e) });
    }
    const buf = readFileSync(out);
    // Tipe ditulis eksplisit lewat header: `reply.type()` tidak menimpa tipe yang sudah ada.
    return reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'no-store')
      .send(buf);
  });

  /**
   * Impor tanda massal dari Excel. Hanya dua sebab yang boleh lewat file ini; sebab lain
   * (mis. "pasien menolak") tetap satu per satu karena detailnya berbeda tiap pasien.
   */
  app.post('/api/flags/import', async (req, reply) => {
    const body = req.body as any;
    let file: string;
    try { file = await resolveUpload(body); } catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }

    const batch = await store.resolveBatch(body?.batchId ? Number(body.batchId) : null);
    if (!batch) return reply.code(409).send({ error: 'Belum ada batch aktif. Impor penugasan dulu.' });
    if (batch.status !== 'aktif') return reply.code(409).send({ error: `Batch "${batch.name}" sudah ${batch.status}.` });

    let parsed;
    try { parsed = await parseBulkFlagFile(file); }
    catch (e: any) { return reply.code(400).send({ error: String(e?.message ?? e) }); }

    const report = await buildReport(store, batch.id, null);
    const assignments = (await store.assignmentsOf(batch.id)).map((a) => ({
      id: Number(a.id), petugas: String(a.petugas), nik: a.patient_nik, name: a.patient_name,
      failReason: a.fail_reason ?? null,
    }));
    const doneIds = new Set(report.rows.filter((r) => r.verdict.status === 'LENGKAP').map((r) => r.assignmentId));
    const result = applyBulkFlags(assignments, doneIds, parsed.rows);

    // Satu transaksi: tanda lama pada baris yang sama diganti oleh sebab dari file.
    const byReason = new Map<string, number[]>();
    for (const c of result.chosen) {
      const list = byReason.get(c.reason);
      if (list) list.push(c.id); else byReason.set(c.reason, [c.id]);
    }
    let flagged = 0;
    for (const [reason, ids] of byReason) {
      flagged += await store.setAssignmentFlagBulk(ids, reason, body?.note ? String(body.note) : null, String(body.by ?? 'admin:excel'));
    }

    return {
      batchId: batch.id,
      batchName: batch.name,
      read: parsed.rows.length,
      flagged,
      duplicates: parsed.duplicates,
      skipped: parsed.skipped.slice(0, 30),
      skippedCount: parsed.skipped.length,
      notInBatch: result.notInBatch.slice(0, 30),
      notInBatchCount: result.notInBatch.length,
      alreadyDone: result.alreadyDone.slice(0, 30),
      alreadyDoneCount: result.alreadyDone.length,
      byReason: BULK_FLAG_REASONS.map((code) => ({
        code, label: BULK_REASON_LABEL[code],
        count: result.applied.filter((a) => a.reason === code).length,
      })),
    };
  });

  /** Daftar sebab gagal + petugas, untuk isi panel penandaan. */
  app.get('/api/flags/options', async () => {
    const batch = await store.resolveBatch(null);
    return {
      // Hanya tiga kategori yang disepakati; pilihan lain tidak lagi ditawarkan.
      reasons: MANUAL_REASONS,
      petugas: batch ? await store.petugasOfBatch(batch.id) : [],
      batchId: batch?.id ?? null,
    };
  });

  /** Tandai satu pasien gagal (atau koreksi sebabnya). failReason null = hapus tanda. */
  app.post('/api/flags/set', async (req, reply) => {
    const body = req.body as any;
    const id = Number(body?.id);
    if (!id) return reply.code(400).send({ error: 'id wajib' });
    const reason = body.failReason ? String(body.failReason) : null;
    if (reason && !MANUAL_REASONS.some((r) => r.code === reason)) {
      return reply.code(400).send({ error: `sebab tidak dikenal: ${reason}` });
    }
    await store.setAssignmentFlag(id, reason, body.note ? String(body.note) : null, String(body.by ?? 'supervisor'));
    return { ok: true };
  });

  /** Aksi massal: semua baris petugas yang belum diinput dan belum ditandai. */
  app.post('/api/flags/bulk', async (req, reply) => {
    const body = req.body as any;
    const petugas = String(body?.petugas ?? '').trim();
    const reason = String(body?.failReason ?? '');
    if (!petugas) return reply.code(400).send({ error: 'petugas wajib' });
    if (!MANUAL_REASONS.some((r) => r.code === reason)) {
      return reply.code(400).send({ error: `sebab tidak dikenal: ${reason}` });
    }
    const report = await buildReport(store, (await store.resolveBatch(body?.batchId ? Number(body.batchId) : null))?.id, body?.year ? Number(body.year) : null);
    const ids = report.rows
      .filter((r) => r.petugas === petugas && r.verdict.status !== 'LENGKAP' && !r.failReason)
      .map((r) => r.assignmentId);
    const n = await store.setAssignmentFlagBulk(ids, reason, body.note ? String(body.note) : null, String(body.by ?? 'supervisor'));
    return { ok: true, flagged: n };
  });

  /**
   * Tandai petugas "sudah setor". Sisa pasien petugas itu yang masih berstatus belum diinput
   * ditandai `data_hilang` supaya capaiannya tidak menggantung; baris yang sudah berstatus
   * LENGKAP atau sudah punya tanda lain tidak disentuh.
   *
   * Setoran dicatat per petugas + batch, jadi bisa dibatalkan: membatalkan hanya menghapus
   * tanda yang dibuat oleh setoran, bukan tanda lain (Excel pegawai / koreksi supervisor).
   */
  app.post('/api/petugas/setor', async (req, reply) => {
    const body = req.body as any;
    const petugas = String(body?.petugas ?? '').trim();
    if (!petugas) return reply.code(400).send({ error: 'petugas wajib' });
    const batch = await store.resolveBatch(body?.batchId ? Number(body.batchId) : null);
    if (!batch) return reply.code(409).send({ error: 'Belum ada batch aktif.' });

    const report = await buildReport(store, batch.id, null);
    const rows = report.rows.filter((r) => r.petugas === petugas);
    if (!rows.length) return reply.code(404).send({ error: `Petugas "${petugas}" tidak ada di batch ${batch.name}.` });
    const by = `setor:${petugas}`;

    // Batal: hanya baris yang ditandai oleh setoran petugas ini yang dikembalikan ke belum diinput.
    if (body?.batal) {
      const direset = await store.revokeSubmission(batch.id, petugas);
      return { ok: true, batal: true, direset, sisaBelum: rows.filter((r) => r.verdict.status !== 'LENGKAP' && !r.failReason).length };
    }

    const pending = rows.filter((r) => r.verdict.status !== 'LENGKAP' && !r.failReason).map((r) => r.assignmentId);
    const already = rows.filter((r) => r.verdict.status !== 'LENGKAP' && r.failReason).length;
    const diinput = rows.filter((r) => r.verdict.status === 'LENGKAP').length;
    const hitungGagal = body?.hitungGagal !== false;
    await store.markSubmitted(batch.id, petugas, {
      flagIds: hitungGagal ? pending : [],
      reason: 'data_hilang',
      by,
      hitungGagal,
    });
    return {
      ok: true,
      petugas,
      batchId: batch.id,
      diinput,
      sudahBertanda: already,
      ditandaiHilang: hitungGagal ? pending.length : 0,
      capaian: rows.length ? Math.round(((diinput + already + (hitungGagal ? pending.length : 0)) / rows.length) * 1000) / 10 : 0,
    };
  });

  /** Simpan rentang tarik dari UI admin. Berlaku untuk tombol "Tarik data SSI" dan CLI berikutnya. */
  app.post('/api/settings/sweep', async (req, reply) => {
    const body = req.body as any;
    const start = String(body?.startDate ?? '').trim();
    const end = String(body?.endDate ?? '').trim();
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(start) || !iso.test(end)) {
      return reply.code(400).send({ error: 'Format tanggal harus YYYY-MM-DD.' });
    }
    if (start > end) return reply.code(400).send({ error: 'Tanggal awal harus sebelum tanggal akhir.' });
    await store.setSetting('sweep.start', start);
    await store.setSetting('sweep.end', end);
    return { ok: true, ...(await sweepRange()) };
  });

  /** Rentang tarik efektif: pengaturan admin (DB) menang atas env, supaya bisa diubah tanpa deploy. */
  async function sweepRange(): Promise<{ startDate: string; endDate: string; fromSetting: boolean }> {
    const start = await store.getSetting('sweep.start');
    const end = await store.getSetting('sweep.end');
    return {
      startDate: start ?? CONFIG.sweepStart,
      endDate: end ?? CONFIG.sweepEnd,
      fromSetting: Boolean(start || end),
    };
  }

  app.post('/api/sync', async (req, reply) => {
    // Owner unik per pemanggilan: pid tidak unik di serverless, dan lease-lah yang
    // menentukan lock bebas, bukan pemeriksaan proses.
    const owner = `web:${process.pid}:${randomBytes(4).toString('hex')}`;
    const { startDate, endDate } = await sweepRange();
    if (syncing || !(await store.claimSync(owner))) return reply.code(409).send({ error: 'Sweep SSI sedang berjalan di proses lain.' });
    syncing = true;
    const runId = await store.startRun();
    try {
      await ensureFreshSession(store);
      const q = (req.query ?? {}) as { pages?: string };
      const maxPages = q.pages ? Math.max(1, Number(q.pages)) : (CONFIG.syncMaxPages > 0 ? CONFIG.syncMaxPages : undefined);
      const res = await runSync(store, {
        maxPages,
        maxMs: CONFIG.syncMaxMs > 0 ? CONFIG.syncMaxMs : undefined,
        faskesCode: CONFIG.faskesCode,
        startDate,
        endDate,
        pageSize: CONFIG.pageSize,
        userId: CONFIG.userId,
        fullname: CONFIG.fullname,
        partnerCode: CONFIG.partnerCode,
        userType: CONFIG.userType,
        // Lease diperpanjang tiap halaman: sweep panjang tidak kehilangan lock di tengah jalan.
        onProgress: () => { void store.renewSync(owner).catch(() => { /* lease dicoba lagi di halaman berikutnya */ }); },
      });
      await store.finishRun(runId, {
        status: res.ok ? 'ok' : 'failed', pages: res.pages, fetched: res.fetched,
        inserted: res.inserted, updated: res.updated, message: res.message,
      });
      return res;
    } catch (e: any) {
      await store.finishRun(runId, { status: 'error', message: String(e?.message ?? e) });
      return reply.code(500).send({ error: String(e?.message ?? e) });
    } finally {
      await store.releaseSync(owner);
      syncing = false;
    }
  });

  // Prod berjalan tanpa campur tangan: perpanjang sesi sebelum kedaluwarsa.
  // refresh_token single-use, jadi selalu lewat kunci tulis DB.
  const REFRESH_EVERY_MS = 60 * 60_000;
  const MAX_AGE_MS = 6 * 60 * 60_000;
  const timer = setInterval(async () => {
    const s = await store.getSession();
    if (!s || Date.now() - Date.parse(s.updatedAt) < MAX_AGE_MS) return;
    try {
      const r = await store.withWriteLock(async () => {
        const fresh = await store.getSession();
        if (!fresh) return { ok: false as const, reason: 'expired' as const, message: 'Belum ada sesi.' };
        if (Date.now() - Date.parse(fresh.updatedAt) < MAX_AGE_MS) return { ok: true as const };
        const out = await refreshSession(fresh);
        if (out.ok) await store.saveSession(out.session);
        return out;
      });
      if (!r.ok) console.warn(`[sesi] perpanjangan otomatis gagal: ${(r as any).message}`);
    } catch (e: any) {
      console.warn('[sesi] perpanjangan otomatis error:', String(e?.message ?? e));
    }
  }, REFRESH_EVERY_MS);
  timer.unref();

  return app;
}

export async function startServer() {
  const app = await buildApp();
  await app.listen({ port: CONFIG.port, host: CONFIG.host });
  console.log(`Monev CKG: http://${CONFIG.host}:${CONFIG.port}`);
  return app;
}
