import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/db/store.ts';
import { buildReport, type PetugasSummary } from '../src/core/report.ts';

async function petugasOf(store: Store, batchId: number, name: string): Promise<PetugasSummary> {
  const hit = (await buildReport(store, batchId)).perPetugas.find((p) => p.petugas === name);
  if (!hit) throw new Error('petugas tidak ada: ' + name);
  return hit;
}

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monev-setor-'));
  return Store.open({ sqlitePath: join(dir, 'test.db') });
}

async function seed(store: Store): Promise<number> {
  const batchId = await store.createBatch({ name: 'Uji', filename: 'x.xlsx', rowCount: 3, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
  await store.replaceAssignments(batchId, [
    { rowNo: 1, petugas: 'RINA', nik: '3503130000000001', name: null, birthDate: null, targetDate: null, year: 2026 },
    { rowNo: 2, petugas: 'RINA', nik: '3503130000000002', name: null, birthDate: null, targetDate: null, year: 2026 },
    { rowNo: 3, petugas: 'RINA', nik: '3503130000000003', name: null, birthDate: null, targetDate: null, year: 2026, failReason: 'faskes_lain', flaggedBy: 'excel' },
  ]);
  return batchId;
}

test('setoran menandai sisa pasien sebagai data hilang dan capaian jadi penuh', async () => {
  const store = await freshStore();
  const batchId = await seed(store);
  const before = await buildReport(store, batchId);
  const pending = before.rows.filter((r) => r.verdict.status !== 'LENGKAP' && !r.failReason).map((r) => r.assignmentId);

  await store.markSubmitted(batchId, 'RINA', { flagIds: pending, reason: 'data_hilang', by: 'setor:RINA', hitungGagal: true });

  const rina = await petugasOf(store, batchId, 'RINA');
  assert.equal(rina.dataHilang, 2);
  assert.equal(rina.faskesLain, 1, 'tanda lama tidak tertimpa');
  assert.equal(rina.perluTindakan, 0);
  assert.equal(rina.pctCapaian, 100);
  assert.equal(rina.submitted, true);
  assert.equal(rina.includesGagal, true);
  await store.close();
});

test('setoran tanpa hitung gagal hanya mencatat status setor', async () => {
  const store = await freshStore();
  const batchId = await seed(store);
  await store.markSubmitted(batchId, 'RINA', { flagIds: [], reason: 'data_hilang', by: 'setor:RINA', hitungGagal: false });
  const rina = await petugasOf(store, batchId, 'RINA');
  assert.equal(rina.submitted, true);
  assert.equal(rina.includesGagal, false);
  assert.equal(rina.perluTindakan, 2, 'sisa pasien tetap perlu ditagih');
  await store.close();
});

test('membatalkan setoran mengembalikan sisa pasien tanpa menghapus tanda lain', async () => {
  const store = await freshStore();
  const batchId = await seed(store);
  const report = await buildReport(store, batchId);
  const pending = report.rows.filter((r) => r.verdict.status !== 'LENGKAP' && !r.failReason).map((r) => r.assignmentId);
  await store.markSubmitted(batchId, 'RINA', { flagIds: pending, reason: 'data_hilang', by: 'setor:RINA', hitungGagal: true });

  const mine = (await store.assignmentsOf(batchId)).filter((a) => a.flagged_by === 'setor:RINA');
  await store.setAssignmentFlagBulk(mine.map((a) => Number(a.id)), null, null, '');
  await store.unmarkSubmitted(batchId, 'RINA');

  const rina = await petugasOf(store, batchId, 'RINA');
  assert.equal(rina.submitted, false);
  assert.equal(rina.dataHilang, 0);
  assert.equal(rina.faskesLain, 1, 'tanda dari Excel tetap ada');
  assert.equal(rina.perluTindakan, 2);
  await store.close();
});

test('setoran dicabut bila impor ulang menyisakan pasien belum diinput', async () => {
  const { staleSubmissions } = await import('../src/core/report.ts');
  const base = { assigned: 3, ada: 0, lengkap: 0, sebagian: 0, belum: 0, ambigu: 0, pctLengkap: 0,
    diinput: 3, gagalDitandai: 0, perluTindakan: 0, selesai: 3, pctCapaian: 100, submitted: true,
    submittedAt: 'x', includesGagal: true, tidakValid: 0, faskesLain: 0, dataHilang: 0, petugas: 'RINA' };
  assert.deepEqual(staleSubmissions([base]), [], 'setoran yang masih menutup semua data dipertahankan');
  assert.deepEqual(staleSubmissions([{ ...base, perluTindakan: 2, selesai: 1, pctCapaian: 33.3 }]), ['RINA']);
  assert.deepEqual(staleSubmissions([{ ...base, submitted: false, perluTindakan: 1 }]), []);
});