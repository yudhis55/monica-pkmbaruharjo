import type { SsiVisit } from './ssi/types.ts';

export interface PushResult { ok: boolean; chunks: number; sent: number; status?: number; message?: string }

/**
 * Kirim snapshot ke instance lain (mode lokal → prod).
 * Idempoten: penerima memakai upsert per reg_id, jadi kirim ulang aman.
 */
export async function pushSnapshot(
  target: string,
  token: string,
  visits: SsiVisit[],
  opts: { chunkSize?: number; onProgress?: (p: { sent: number; total: number }) => void } = {},
): Promise<PushResult> {
  const base = target.replace(/\/+$/, '');
  const url = `${base}/api/ingest/visits`;
  const size = opts.chunkSize ?? 2000;
  let sent = 0;
  let chunks = 0;

  for (let i = 0; i < visits.length; i += size) {
    const slice = visits.slice(i, i + size);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ingest-token': token },
      body: JSON.stringify({ visits: slice }),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!res.ok) {
      return { ok: false, chunks, sent, status: res.status, message: text.slice(0, 300) };
    }
    chunks++;
    sent += slice.length;
    opts.onProgress?.({ sent, total: visits.length });
  }
  return { ok: true, chunks, sent };
}
