/**
 * Cek cepat: apakah `DATABASE_URL` (atau SQLite default) bisa dibuka, dan apakah
 * skema aplikasi sudah ada. Dipakai sebelum deploy: `npm run db:check`.
 */
import { CONFIG } from '../src/config.ts';
import { openDb } from '../src/core/db/db.ts';

const target = CONFIG.databaseUrl ? 'Postgres (DATABASE_URL)' : `SQLite (${CONFIG.dbPath})`;
console.log(`target: ${target}`);

let db;
try {
  db = await openDb({ sqlitePath: CONFIG.dbPath, databaseUrl: CONFIG.databaseUrl });
  // Pool Postgres bersifat lazy: satu query nyata wajib dijalankan sebelum bilang "OK".
  await db.prepare('SELECT 1 AS one').get();
  console.log('koneksi: OK');
  if (db.dialect === 'pg') {
    const version = await db.prepare('SELECT version() AS v').get<{ v: string }>();
    if (version?.v) console.log(`server: ${version.v.split(',')[0]}`);
  }
  // Skema dibuat oleh Store.open(); di sini cukup cek tabel inti.
  try {
    const c = db.dialect === 'pg'
      ? Number((await db.prepare("SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public'").get<{ c: number }>())!.c)
      : Number((await db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'").get<{ c: number }>())!.c);
    console.log(`tabel di skema: ${c} ${c === 0 ? '(kosong — jalankan aplikasi sekali untuk membuat skema)' : ''}`);
  } catch (e: any) {
    console.log('cek tabel gagal:', String(e?.message ?? e));
  }
} catch (e: any) {
  const codes: string[] = [];
  if (e?.code) codes.push(e.code);
  for (const a of e?.aggregateErrors ?? []) if (a?.code) codes.push(a.code);
  console.log(`koneksi: GAGAL ${codes.length ? `[${codes.join(', ')}]` : ''} ${e?.message ?? ''}`.trim());
  if (codes.includes('ENOTFOUND') || codes.includes('ETIMEDOUT')) {
    console.log('petunjuk: host `db.<ref>.supabase.co` sering hanya IPv6. Pakai Connection pooling → Transaction pooler (:6543).');
  }
  process.exitCode = 1;
} finally {
  await db?.close();
}
