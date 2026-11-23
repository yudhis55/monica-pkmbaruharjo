import { CONFIG, readCookieJar, readScraperEnv } from './config.ts';
import { Store } from './core/db/store.ts';
import { importAssignments, guessMapping } from './core/excel.ts';
import { buildReport, exportReportToExcel } from './core/report.ts';
import { ensureFreshSession, runSync } from './core/sync.ts';
import { runDetailFetch } from './core/detailRun.ts';
import { refreshSession } from './core/ssi/session.ts';

const [cmd, ...args] = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (n: string) => args.includes(`--${n}`);

function openStore() { return Store.open({ sqlitePath: CONFIG.dbPath, databaseUrl: CONFIG.databaseUrl }); }

async function main() {
  switch (cmd) {
    case 'session:import': {
      const src = flag('from');
      const s = src ? (readCookieJar(src) ?? readScraperEnv(src)) : readScraperEnv();
      if (!s) { console.error('Tidak menemukan token_eksternal/refresh_token di .env scraper.'); process.exit(1); }
      const store = await openStore();
      await store.saveSession({ ...s, updatedAt: new Date().toISOString() });
      await store.close();
      console.log('Sesi tersimpan.');
      return;
    }
    case 'session:check': {
      const store = await openStore();
      const s = await store.getSession();
      await store.close();
      console.log(s ? `Sesi ada, diperbarui ${s.updatedAt}` : 'Belum ada sesi.');
      return;
    }
    case 'session:refresh': {
      const store = await openStore();
      const s = await store.getSession();
      if (!s) { console.error('Belum ada sesi.'); process.exit(1); }
      const r = await store.withWriteLock(async () => {
        const fresh = await store.getSession();
        if (!fresh) return { ok: false as const, reason: 'expired' as const, message: 'Belum ada sesi.' };
        const out = await refreshSession(fresh);
        if (out.ok) await store.saveSession(out.session);
        return out;
      });
      if (r.ok) console.log('Sesi diperpanjang.');
      else console.error(`Gagal: ${r.reason} — ${r.message}`);
      await store.close();
      if (!r.ok) process.exit(2);
      return;
    }
    case 'sync': {
      const store = await openStore();
      // Owner unik + lease: lock tidak bergantung proses hidup, jadi bisa dipakai juga saat
      // sweep dijalankan dari mesin lain (collector) terhadap DB yang sama.
      const owner = `cli:${process.pid}:${Math.random().toString(16).slice(2, 10)}`;
      if (!(await store.claimSync(owner))) { await store.close(); throw new Error('Sweep SSI sedang berjalan di proses lain.'); }
      // Rentang: flag CLI > pengaturan admin (DB) > env. Flag dipakai untuk menyapu per bulan
      // ketika rentang setahun membuat SSI membalas 500 (terukur 23 Nov 2026).
      const startDate = flag('start') ?? (await store.getSetting('sweep.start')) ?? CONFIG.sweepStart;
      const endDate = flag('end') ?? (await store.getSetting('sweep.end')) ?? CONFIG.sweepEnd;
      console.log(`rentang ${startDate} s/d ${endDate}`);
      const runId = await store.startRun();
      try {
        await ensureFreshSession(store);
        const res = await runSync(store, {
          faskesCode: CONFIG.faskesCode,
          startDate,
          endDate,
          pageSize: CONFIG.pageSize,
          userId: CONFIG.userId,
          fullname: CONFIG.fullname,
          partnerCode: CONFIG.partnerCode,
          userType: CONFIG.userType,
          onProgress: (p) => { void store.renewSync(owner).catch(() => { /* lease dicoba lagi di halaman berikutnya */ }); console.log(`halaman ${p.page}/${p.totalPage} — ${p.rows} baris`); },
          push: flag('push') || CONFIG.pushTarget
            ? {
                target: flag('push') ?? CONFIG.pushTarget,
                token: flag('push-token') ?? CONFIG.pushToken,
                onProgress: (p) => console.log(`push ${p.sent}/${p.total}`),
              }
            : undefined,
        });
        await store.finishRun(runId, { status: res.ok ? 'ok' : 'failed', pages: res.pages, fetched: res.fetched, inserted: res.inserted, updated: res.updated, message: res.message });
        console.log(JSON.stringify(res));
        await store.releaseSync(owner);
        await store.close();
        if (!res.ok) process.exit(2);
      } catch (e: any) {
        await store.finishRun(runId, { status: 'error', message: String(e?.message ?? e) });
        await store.releaseSync(owner);
        await store.close();
        throw e;
      }
      return;
    }
    case 'assign:inspect': {
      const file = flag('file');
      if (!file) throw new Error('--file wajib');
      const g = await guessMapping(file);
      console.log(JSON.stringify(g, null, 1));
      return;
    }
    case 'assign:import': {
      const file = flag('file');
      if (!file) throw new Error('--file wajib');
      const g = await guessMapping(file);
      const mapping = {
        ...g.mapping,
        nik: flag('nik') ?? g.mapping.nik,
        nama: flag('nama') ?? g.mapping.nama,
        petugas: flag('petugas') ?? g.mapping.petugas,
        birthDate: flag('birth') ?? g.mapping.birthDate,
        targetDate: flag('target') ?? g.mapping.targetDate,
      };
      const res = await importAssignments(file, mapping);
      const store = await openStore();
      const name = flag('batch-name') ?? ('Impor ' + new Date().toISOString().slice(0, 10));
      const batchId = await store.createBatch({ name, filename: file, rowCount: res.rows.length, mapping });
      await store.addAssignments(batchId, res.rows.map((r) => ({
        rowNo: r.rowNo, petugas: r.petugas, nik: r.nik, name: r.name, birthDate: r.birthDate, targetDate: r.targetDate,
      })));
      await store.close();
      console.log(JSON.stringify({ batchId, imported: res.rows.length, skipped: res.skipped.length, skippedDetail: res.skipped.slice(0, 20) }, null, 1));
      return;
    }
    case 'detail:fetch': {
      const store = await openStore();
      const res = await runDetailFetch(store, {
        batchId: flag('batch') ? Number(flag('batch')) : undefined,
        faskesCode: CONFIG.faskesCode,
        userId: CONFIG.userId,
        fullname: CONFIG.fullname,
        partnerCode: CONFIG.partnerCode,
        userType: CONFIG.userType,
        force: has('force'),
      });
      await store.close();
      console.log(JSON.stringify(res, null, 1));
      if (!res.ok) process.exit(2);
      return;
    }
    case 'report': {
      const store = await openStore();
      const report = await buildReport(store, flag('batch') ? Number(flag('batch')) : undefined);
      await store.close();
      if (flag('out')) {
        await exportReportToExcel(report, flag('out')!);
        console.log(`Ditulis: ${flag('out')}`);
      } else {
        console.log(JSON.stringify({ totals: report.totals, perPetugas: report.perPetugas, lastSyncAt: report.lastSyncAt }, null, 1));
      }
      return;
    }
    case 'serve': {
      const { startServer } = await import('./server/app.ts');
      await startServer();
      return;
    }
    default:
      console.log(`Perintah:
  session:import [--from <env>]   impor token dari .env scraper
  session:check                   cek sesi tersimpan
  session:refresh                 perpanjang sesi (serial, single-use)
  sync [--push <url> --push-token <t>]  sapuan penuh kunjungan SSI (opsional kirim ke prod)
  assign:inspect --file <xlsx>    deteksi kolom otomatis
  assign:import  --file <xlsx>    impor penugasan
  report [--out hasil.xlsx]       rekap monev
  detail:fetch [--batch N --force]  rincian layanan per pasien yang ditugaskan
  serve                           jalankan web app`);
  }
}

main().catch((e) => { console.error(e?.stack ?? e); process.exit(1); });
