import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/db/store.ts';

/**
 * Batch acuan laporan disimpan di database (`app_setting.current_batch`).
 *
 * Sebelumnya tombol "Pakai" hanya mengubah variabel di halaman, sehingga refresh
 * mengembalikan laporan ke batch aktif terbaru — pilihan admin hilang tanpa pesan.
 */
function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), 'monev-current-'));
  return Store.open({ sqlitePath: join(dir, 'test.db') });
}

async function makeBatch(store: Store, name: string): Promise<number> {
  return store.createBatch({ name, filename: name + '.xlsx', rowCount: 0, periodStart: '2026-01-01', periodEnd: '2026-12-31' });
}

test('tanpa pilihan admin, acuan = batch aktif terbaru', async () => {
  const store = await freshStore();
  await makeBatch(store, 'September');
  const latest = await makeBatch(store, 'November');

  assert.equal((await store.resolveBatch(null))?.id, latest);
  assert.equal(await store.hasCurrentBatch(), false);
  await store.close();
});

test('pilihan admin bertahan setelah store dibuka ulang (setara refresh halaman)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'monev-current-'));
  const path = join(dir, 'test.db');

  const first = await Store.open({ sqlitePath: path });
  const september = await makeBatch(first, 'September');
  await makeBatch(first, 'November'); // lebih baru, tapi bukan pilihan admin
  await first.setCurrentBatch(september);
  assert.equal((await first.resolveBatch(null))?.id, september);
  await first.close();

  // Proses baru membaca ulang dari disk: inilah yang dulu gagal.
  const second = await Store.open({ sqlitePath: path });
  assert.equal((await second.resolveBatch(null))?.id, september, 'pilihan harus bertahan setelah dibuka ulang');
  assert.equal(await second.hasCurrentBatch(), true);
  await second.close();
});

test('reset ke bawaan mengembalikan acuan ke batch aktif terbaru', async () => {
  const store = await freshStore();
  const september = await makeBatch(store, 'September');
  const november = await makeBatch(store, 'November');
  await store.setCurrentBatch(september);
  await store.setCurrentBatch(null);

  assert.equal((await store.resolveBatch(null))?.id, november);
  assert.equal(await store.hasCurrentBatch(), false);
  await store.close();
});

test('batch acuan yang dihapus tidak menyisakan rujukan mati', async () => {
  const store = await freshStore();
  const september = await makeBatch(store, 'September');
  const november = await makeBatch(store, 'November');
  await store.setCurrentBatch(september);
  await store.purgeBatch(september);

  const resolved = await store.resolveBatch(null);
  assert.equal(resolved?.id, november, 'harus jatuh ke batch aktif lain, bukan null');
  assert.equal(await store.hasCurrentBatch(), false, 'kunci pengaturan ikut dibersihkan');
  await store.close();
});

test('batch acuan yang diarsipkan tidak lagi dipakai', async () => {
  const store = await freshStore();
  const september = await makeBatch(store, 'September');
  const november = await makeBatch(store, 'November');
  await store.setCurrentBatch(september);
  await store.updateBatch(september, { status: 'arsip' });

  assert.equal((await store.resolveBatch(null))?.id, november);
  assert.equal(await store.hasCurrentBatch(), false);
  await store.close();
});

test('batch nonaktif tidak bisa dijadikan acuan lewat resolveBatch(id)', async () => {
  const store = await freshStore();
  const september = await makeBatch(store, 'September');
  await makeBatch(store, 'November');
  await store.updateBatch(september, { status: 'selesai' });

  assert.equal(await store.resolveBatch(september), null, 'batch selesai bukan acuan yang sah');
  await store.close();
});
