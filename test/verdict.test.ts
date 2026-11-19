import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexVisits, matchVerdict, isComplete } from '../src/core/verdict.ts';
import { normalizeNik, normalizeName, normalizeDate } from '../src/core/normalize.ts';

const visits = [
  { reg_id: 'r1', self_check_status: 'Lengkap', screening_count_all: 7, screening_count_done: 7, patient: { nik: '3503137006080001', fullname: 'ARIATNE NAYLASARI', birth_date: '2008-06-30' }, register_date: '2026-09-15' },
  { reg_id: 'r2', self_check_status: 'Belum Dilakukan', screening_count_all: 5, screening_count_done: 0, patient: { nik: '3503132012110002', fullname: 'BELUM MULAI', birth_date: '2011-12-20' }, register_date: '2026-09-18' },
  { reg_id: 'r3', self_check_status: 'Belum lengkap', screening_count_all: 5, screening_count_done: 2, patient: { nik: '3503135411730002', fullname: 'SEBAGIAN', birth_date: '1973-11-14' }, register_date: '2026-09-10' },
  // dua kunjungan untuk NIK sama, salah satunya lengkap
  { reg_id: 'r4a', self_check_status: 'Belum Dilakukan', screening_count_all: 4, screening_count_done: 0, patient: { nik: '3503134904680002', fullname: 'MUTI', birth_date: '1968-04-09' }, register_date: '2026-08-01' },
  { reg_id: 'r4b', self_check_status: 'Lengkap', screening_count_all: 4, screening_count_done: 4, patient: { nik: '3503134904680002', fullname: 'MUTI', birth_date: '1968-04-09' }, register_date: '2026-09-01' },
  // tanpa NIK, nama+dob unik
  { reg_id: 'r5', self_check_status: 'Lengkap', screening_count_all: 3, screening_count_done: 3, patient: { nik: '', fullname: 'TANPA NIK', birth_date: '2021-06-30' }, register_date: '2026-09-21' },
  // tanpa NIK, nama+dob menunjuk dua NIK berbeda
  { reg_id: 'r6a', self_check_status: 'Lengkap', screening_count_all: 3, screening_count_done: 3, patient: { nik: '3503130000000001', fullname: 'KEMBAR', birth_date: '2020-01-01' }, register_date: '2026-09-01' },
  { reg_id: 'r6b', self_check_status: 'Lengkap', screening_count_all: 3, screening_count_done: 3, patient: { nik: '3503130000000002', fullname: 'KEMBAR', birth_date: '2020-01-01' }, register_date: '2026-09-02' },
];

const idx = indexVisits(visits);

test('normalizeNik hanya menerima 16 digit', () => {
  assert.equal(normalizeNik('3503132012110002'), '3503132012110002');
  assert.equal(normalizeNik(' 3503 1320 1211 0002 '), '3503132012110002');
  assert.equal(normalizeNik('350313201211000'), null);
  assert.equal(normalizeNik(''), null);
  assert.equal(normalizeNik(null), null);
});

test('normalizeName membuang spasi ganda dan tanda baca', () => {
  assert.equal(normalizeName('  ULFI  VARODHILLAH '), 'ULFI VARODHILLAH');
  assert.equal(normalizeName('MUHAMMAD HIZQIEL DANIAL '), 'MUHAMMAD HIZQIEL DANIAL');
  assert.equal(normalizeName('NUR\'AINI, S.KM'), 'NUR AINI S KM');
});

test('normalizeDate menerima ISO, d/m/Y, dan serial Excel', () => {
  assert.equal(normalizeDate('2026-09-15'), '2026-09-15');
  assert.equal(normalizeDate('15/09/2026'), '2026-09-15');
  assert.equal(normalizeDate('2026-09-15T00:00:00Z'), '2026-09-15');
  assert.equal(normalizeDate(46280), '2026-09-15');
  assert.equal(normalizeDate(''), null);
});

test('isComplete memakai angka, bukan status saja', () => {
  assert.equal(isComplete(visits[0]), true);
  assert.equal(isComplete(visits[1]), false);
  assert.equal(isComplete(visits[2]), false);
  // status Lengkap tanpa angka harus tetap dianggap tidak lengkap
  assert.equal(isComplete({ reg_id: 'x', self_check_status: 'Lengkap', screening_count_all: 0, screening_count_done: 0 }), false);
});

test('NIK cocok -> LENGKAP', () => {
  const v = matchVerdict({ nik: '3503137006080001', name: 'X', birthDate: null }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'LENGKAP');
  assert.equal(v.ada, true);
  assert.equal(v.lengkap, true);
  assert.equal(v.method, 'nik');
  assert.deepEqual(v.matchedRegIds, ['r1']);
});

test('NIK ada tapi belum mulai -> BELUM_DIINPUT dengan ada=true', () => {
  const v = matchVerdict({ nik: '3503132012110002', name: 'X', birthDate: null }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'BELUM_DIINPUT');
  assert.equal(v.ada, true);
  assert.equal(v.lengkap, false);
});

test('NIK ada, progress sebagian -> DIINPUT_SEBAGIAN', () => {
  const v = matchVerdict({ nik: '3503135411730002', name: 'X', birthDate: null }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'DIINPUT_SEBAGIAN');
  assert.equal(v.ada, true);
  assert.equal(v.lengkap, false);
  assert.equal(v.screeningDone, 2);
  assert.equal(v.screeningAll, 5);
});

test('NIK dengan beberapa kunjungan: salah satu lengkap -> LENGKAP', () => {
  const v = matchVerdict({ nik: '3503134904680002', name: 'X', birthDate: null }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'LENGKAP');
  assert.deepEqual(v.matchedRegIds.sort(), ['r4a', 'r4b']);
});

test('NIK tidak ditemukan -> BELUM_DIINPUT, ada=false', () => {
  const v = matchVerdict({ nik: '3503139999999999', name: 'X', birthDate: null }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'BELUM_DIINPUT');
  assert.equal(v.ada, false);
  assert.equal(v.method, 'nik');
});

test('NIK kosong, nama+tanggal lahir unik -> match', () => {
  const v = matchVerdict({ nik: null, name: 'TANPA NIK', birthDate: '2021-06-30' }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'LENGKAP');
  assert.equal(v.method, 'nama_tgl_lahir');
});

test('NIK kosong, nama+tanggal lahir menunjuk >1 NIK -> AMBIGU', () => {
  const v = matchVerdict({ nik: null, name: 'KEMBAR', birthDate: '2020-01-01' }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'AMBIGU');
  assert.equal(v.ada, true);
});

test('NIK kosong dan tidak ada kandidat -> AMBIGU (bukan BELUM_DIINPUT palsu)', () => {
  const v = matchVerdict({ nik: null, name: 'TIDAK ADA', birthDate: '1990-01-01' }, idx.byNik, idx.byNameDob);
  assert.equal(v.status, 'AMBIGU');
});

test('NIK tidak valid (15 digit) diperlakukan sebagai tanpa NIK', () => {
  const v = matchVerdict({ nik: normalizeNik('350313201211000'), name: 'TANPA NIK', birthDate: '2021-06-30' }, idx.byNik, idx.byNameDob);
  assert.equal(v.method, 'nama_tgl_lahir');
  assert.equal(v.status, 'LENGKAP');
});

test('aturan terdaftar: kunjungan tanpa screening pun dianggap diinput', async () => {
  const { indexVisits, matchVerdict } = await import('../src/core/verdict.ts');
  const idx = indexVisits([{
    reg_id: 'r1', self_check_status: 'Belum Dilakukan', screening_count_all: 6, screening_count_done: 0,
    patient: { nik: '3503130000000001', fullname: 'PASIEN', birth_date: '1990-01-01' }, register_date: '2026-02-01',
  }], new Set([2026]));
  const input = { nik: '3503130000000001', name: 'PASIEN', birthDate: '1990-01-01' };
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob).status, 'BELUM_DIINPUT');
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob, 'terdaftar').status, 'LENGKAP');
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob, 'ada_atau_sebagian').status, 'BELUM_DIINPUT');
});

test('aturan ada_atau_sebagian: satu item selesai sudah diinput', async () => {
  const { indexVisits, matchVerdict } = await import('../src/core/verdict.ts');
  const idx = indexVisits([{
    reg_id: 'r1', self_check_status: 'Belum lengkap', screening_count_all: 6, screening_count_done: 1,
    patient: { nik: '3503130000000002', fullname: 'PASIEN', birth_date: '1990-01-01' }, register_date: '2026-02-01',
  }], new Set([2026]));
  const input = { nik: '3503130000000002', name: 'PASIEN', birthDate: '1990-01-01' };
  // Di bawah aturan bawaan ini tetap bukan "diinput": 1 dari 6 item belum selesai.
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob).status, 'DIINPUT_SEBAGIAN');
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob, 'ada_atau_sebagian').status, 'LENGKAP');
  // `lengkap` tetap berarti screening benar-benar selesai, walau status monev sudah LENGKAP.
  assert.equal(matchVerdict(input, idx.byNik, idx.byNameDob, 'ada_atau_sebagian').lengkap, false);
});

test('aturan tidak dikenal kembali ke selesai', async () => {
  const { resolveMatchRule } = await import('../src/core/verdict.ts');
  assert.equal(resolveMatchRule('ngawur'), 'selesai');
  assert.equal(resolveMatchRule(null), 'selesai');
  assert.equal(resolveMatchRule('terdaftar'), 'terdaftar');
});
