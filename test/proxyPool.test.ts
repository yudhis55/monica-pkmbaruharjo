import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isIndonesianIp } from '../src/core/ssi/idRanges.ts';
import { parseProxy } from '../src/core/ssi/proxyFetch.ts';

test('IP Indonesia dikenali dari delegasi APNIC', () => {
  // Sampel nyata dari pool: ISP kecil Indonesia.
  assert.equal(isIndonesianIp('103.163.80.181'), true);
  assert.equal(isIndonesianIp('165.101.42.140'), true);
  assert.equal(isIndonesianIp('36.89.90.97'), true);
});

test('IP di luar Indonesia ditolak', () => {
  assert.equal(isIndonesianIp('8.8.8.8'), false);
  assert.equal(isIndonesianIp('1.1.1.1'), false);
  assert.equal(isIndonesianIp('172.64.149.246'), false);
});

test('bentuk IP cacat tidak melempar', () => {
  for (const bad of ['', '1.2.3', '1.2.3.4.5', '999.1.1.1', 'a.b.c.d', '1.2.3.-1']) {
    assert.equal(isIndonesianIp(bad), false, bad);
  }
});

test('proxy tanpa skema dianggap http', () => {
  assert.deepEqual(parseProxy('103.1.2.3:8080'), { scheme: 'http', host: '103.1.2.3', port: 8080, raw: '103.1.2.3:8080' });
});

test('skema proxy dipertahankan', () => {
  for (const scheme of ['http', 'https', 'socks4', 'socks5'] as const) {
    const p = parseProxy(`${scheme}://103.1.2.3:1080`);
    assert.equal(p?.scheme, scheme);
    assert.equal(p?.port, 1080);
  }
});

test('baris sampah dari daftar publik diabaikan', () => {
  for (const junk of ['', '   ', '<!DOCTYPE html>', 'error code: 502', 'socks5://208.102.51.6', '103.1.2.3:99999', '103.1.2.3:0']) {
    assert.equal(parseProxy(junk), null, junk);
  }
});

test('skema cadangan dipakai bila baris tidak menyebut skema', () => {
  assert.equal(parseProxy('103.1.2.3:1080', 'socks5')?.scheme, 'socks5');
});
