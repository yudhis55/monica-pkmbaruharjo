import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_TTL_MS, adminKey, signAdminToken, verifyAdminToken } from '../src/server/adminAuth.ts';

const key = adminKey('rahasia');

test('token yang ditandatangani diterima sampai kedaluwarsa', () => {
  const now = 1_700_000_000_000;
  const token = signAdminToken(key, now + ADMIN_TTL_MS);
  assert.equal(verifyAdminToken(key, token, now), true);
  assert.equal(verifyAdminToken(key, token, now + ADMIN_TTL_MS + 1), false);
});

test('mengubah masa berlaku membatalkan tanda tangan', () => {
  const now = Date.now();
  const token = signAdminToken(key, now + 60_000);
  const [, exp, mac] = token.split('.');
  assert.equal(verifyAdminToken(key, `v1.${Number(exp) + 3600_000}.${mac}`, now), false);
  assert.equal(verifyAdminToken(key, token, now), true);
  assert.equal(verifyAdminToken(key, `v1.${exp}.${mac.slice(0, -1)}A`, now), false);
});

test('sandi lain menghasilkan kunci lain', () => {
  const token = signAdminToken(adminKey('rahasia'), Date.now() + 60_000);
  assert.equal(verifyAdminToken(adminKey('rahasia-lain'), token), false);
});

test('secret eksplisit menang atas sandi', () => {
  const a = adminKey('x', 'kunci-eksplisit');
  const b = adminKey('y', 'kunci-eksplisit');
  assert.deepEqual(a, b);
  const token = signAdminToken(a, Date.now() + 60_000);
  assert.equal(verifyAdminToken(a, token), true);
  assert.equal(verifyAdminToken(adminKey('x'), token), false);
});

test('token cacat ditolak tanpa melempar', () => {
  for (const bad of ['', 'v1', 'v1.abc.def', 'v2.1.2', 'v1.1.', 'v1.1.!!']) {
    assert.equal(verifyAdminToken(key, bad), false, bad);
  }
});