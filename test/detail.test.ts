import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeDetail } from '../src/core/ssi/detailParse.ts';

test('layanan dihitung hanya bila ada pemeriksaan yang sudah dikirim', () => {
  const out = summarizeDetail('REG1', {
    data: {
      self_check_status: 'Lengkap',
      screening_count_all: 9,
      screening_count_done: 9,
      screening_layanan: [
        { list_pemeriksaan: [{ is_submit_form: true }] },
        { list_pemeriksaan: [{ is_submit_form: false }, { is_submit_form: false }] },
        { list_pemeriksaan: [] },
        { list_pemeriksaan: [{ is_submit_form: false }, { is_submit_form: true }] },
      ],
    },
  });
  assert.equal(out.servicesTotal, 4);
  assert.equal(out.servicesSubmitted, 2);
  assert.equal(out.formsTotal, 9);
  assert.equal(out.formsSubmitted, 9);
  assert.equal(out.selfCheckStatus, 'Lengkap');
});

test('payload tanpa layanan menghasilkan nol, bukan tebakan', () => {
  const out = summarizeDetail('REG2', { data: { screening_layanan: null } });
  assert.equal(out.servicesTotal, 0);
  assert.equal(out.servicesSubmitted, 0);
  assert.equal(out.formsTotal, null);
});
