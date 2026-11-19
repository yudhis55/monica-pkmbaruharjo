/**
 * Ambil rincian layanan hanya untuk pasien yang ditugaskan, bukan seluruh 13 ribu kunjungan.
 * Biaya: ±1,5 detik per kunjungan, jadi 300 pasien ≈ 8 menit. Cache 12 jam.
 */
import type { Store } from './db/store.ts';
import { buildReport } from './report.ts';
import { buildAuth, fetchCryptoPair, makeUser } from './ssi/client.ts';
import { fetchVisitDetail } from './ssi/detail.ts';
import type { VisitDetail } from './ssi/detailParse.ts';

export interface DetailRunOptions {
  batchId?: number;
  faskesCode: string;
  userId?: string;
  fullname?: string;
  partnerCode?: string | null;
  userType?: string | null;
  /** Ambil ulang walau cache masih segar. */
  force?: boolean;
  maxAgeMs?: number;
  concurrency?: number;
  onProgress?: (p: { done: number; total: number; regId: string }) => void;
}

export interface DetailRunResult {
  ok: boolean;
  total: number;
  fetched: number;
  cached: number;
  failed: number;
  errors: Array<{ regId: string; message: string }>;
  message?: string;
}

export async function assignedRegIds(store: Store, batchId?: number): Promise<string[]> {
  const report = await buildReport(store, batchId);
  const ids = new Set<string>();
  for (const row of report.rows) for (const id of row.verdict.matchedRegIds) ids.add(id);
  return [...ids];
}

export async function runDetailFetch(store: Store, opts: DetailRunOptions): Promise<DetailRunResult> {
  const regIds = await assignedRegIds(store, opts.batchId);
  const maxAgeMs = opts.maxAgeMs ?? 12 * 60 * 60_000;
  const known = await store.visitDetails();
  const cutoff = Date.now() - maxAgeMs;

  const todo = opts.force
    ? regIds
    : regIds.filter((id) => {
        const d = known.get(id);
        return !d || Date.parse(d.fetchedAt) < cutoff;
      });
  const cached = regIds.length - todo.length;

  const result: DetailRunResult = {
    ok: true, total: regIds.length, fetched: 0, cached, failed: 0, errors: [],
  };
  if (todo.length === 0) {
    result.message = 'semua rincian masih segar';
    return result;
  }

  const session = await store.getSession();
  const auth = buildAuth(session?.tokenEksternal ?? '', await fetchCryptoPair());
  auth.user = makeUser({
    userId: opts.userId,
    fullname: opts.fullname,
    faskesCode: opts.faskesCode,
    partnerCode: opts.partnerCode,
    userType: opts.userType,
  });

  const size = Math.max(1, Math.min(opts.concurrency ?? 3, 5));
  let cursor = 0;
  let done = 0;

  async function worker() {
    while (cursor < todo.length) {
      const regId = todo[cursor++];
      try {
        const detail: VisitDetail = await fetchVisitDetail(auth, regId);
        await store.upsertVisitDetails([detail]);
        result.fetched++;
      } catch (e) {
        result.failed++;
        result.errors.push({ regId, message: String((e as Error).message).slice(0, 200) });
      }
      done++;
      opts.onProgress?.({ done, total: todo.length, regId });
    }
  }

  await Promise.all(Array.from({ length: size }, worker));
  result.ok = result.failed === 0;
  if (!result.ok) result.message = `${result.failed} rincian gagal diambil`;
  return result;
}
