import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBulkFlags, parseBulkReason } from '../src/core/bulkFlags.ts';

test('alasan hanya menerima label yang dijanjikan template', () => {
  assert.equal(parseBulkReason('Tidak Valid'), 'nik_tidak_valid');
  assert.equal(parseBulkReason('tidak  valid'), 'nik_tidak_valid');
  assert.equal(parseBulkReason('Faskes Lain'), 'faskes_lain');
  assert.equal(parseBulkReason('puskesmas lain'), 'faskes_lain');
  assert.equal(parseBulkReason('Data Hilang'), 'data_hilang');
  assert.equal(parseBulkReason('data hilang di SSI'), 'data_hilang');
  assert.equal(parseBulkReason('hilang'), 'data_hilang');
  assert.equal(parseBulkReason('Pasien menolak'), null, 'sebab di luar tiga opsi harus ditolak');
  assert.equal(parseBulkReason(''), null);
});

const A = (id: number, nik: string, failReason: string | null = null, petugas = 'PETUGAS A') =>
  ({ id, petugas, nik, name: 'NAMA ' + id, failReason });

test('menandai baris yang ada di batch dan belum diinput', () => {
  const res = applyBulkFlags([A(1, '3503134405650002')], new Set(), [{ rowNo: 2, nik: '3503134405650002', reason: 'faskes_lain' }]);
  assert.deepEqual(res.chosen, [{ id: 1, reason: 'faskes_lain' }]);
  assert.equal(res.notInBatch.length, 0);
});

test('baris yang sudah lengkap tidak ditandai: tidak ada yang gagal diinput', () => {
  const res = applyBulkFlags([A(1, '3503134405650002')], new Set([1]), [{ rowNo: 2, nik: '3503134405650002', reason: 'nik_tidak_valid' }]);
  assert.equal(res.chosen.length, 0);
  assert.equal(res.alreadyDone.length, 1);
});

test('NIK di luar batch dilaporkan, bukan diabaikan diam-diam', () => {
  const res = applyBulkFlags([A(1, '3503134405650002')], new Set(), [{ rowNo: 2, nik: '1111111111111111', reason: 'faskes_lain' }]);
  assert.equal(res.chosen.length, 0);
  assert.equal(res.notInBatch[0].nik, '1111111111111111');
});

test('NIK yang dipegang dua petugas: yang belum ditandai dipilih lebih dulu', () => {
  const res = applyBulkFlags(
    [A(1, '3503134405650002', 'faskes_lain'), A(2, '3503134405650002', null)],
    new Set(),
    [{ rowNo: 2, nik: '3503134405650002', reason: 'nik_tidak_valid' }],
  );
  assert.equal(res.chosen[0].id, 2);
});
