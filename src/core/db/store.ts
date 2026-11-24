import { hostname } from 'node:os';
import { openDb, type Db } from './db.ts';

function isAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isFinite(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) {
    return typeof e === 'object' && e !== null && 'code' in e && e.code === 'EPERM';
  }
}
import type { SsiVisit } from '../ssi/types.ts';
import type { VisitDetail } from '../ssi/detailParse.ts';
import { normalizeName } from '../normalize.ts';
import { isComplete } from '../verdict.ts';

/** Kunci untuk menggabungkan tanda manual dan mendeteksi baris ganda: petugas + NIK. */
export function flagKey(petugas: string, nik: string | null): string {
  return normalizeName(petugas).replace(/\s+/g, ' ') + '|' + String(nik ?? '').trim();
}

// Skema diimpor sebagai string (schema.ts), bukan dibaca dari disk: fungsi serverless
// dibundel, jadi path relatif modul tidak menunjuk folder sumber.
import { SCHEMA_PG, SCHEMA_SQLITE } from './schema.ts';

export interface VisitRow {
  reg_id: string;
  nik: string | null;
  name_raw: string | null;
  name_norm: string | null;
  birth_date: string | null;
  gender: string | null;
  faskes_code: string | null;
  ticket_number: string | null;
  register_date: string | null;
  self_check_status: string | null;
  screening_count_all: number | null;
  screening_count_done: number | null;
  done_date: string | null;
  first_seen_at: string;
  last_seen_at: string;
  is_complete: number;
}

/** Baris tabel `visit` apa adanya, termasuk kolom yang tidak dipakai pencocokan. */
export interface VisitExportRow extends VisitRow {
  faskes_name: string | null;
  attend_date: string | null;
  finished_date: string | null;
  visit_register_date: string | null;
  started_date: string | null;
  content_hash: string | null;
}

export interface AssignmentRow {
  id: number;
  batch_id: number;
  row_no: number | null;
  petugas: string;
  patient_nik: string | null;
  patient_name: string | null;
  name_norm: string | null;
  birth_date: string | null;
  target_date: string | null;
  source_extra: string | null;
  fail_reason: string | null;
  note: string | null;
  flagged_by: string | null;
  flagged_at: string | null;
  target_year: number | null;
}

export interface BatchRow {
  id: number;
  name: string | null;
  filename: string;
  imported_at: string;
  row_count: number;
  period_start: string | null;
  period_end: string | null;
  mapping: string | null;
  status: string;
  note: string | null;
  last_import_at: string | null;
  import_count: number;
  match_rule: string;
  petugas_count?: number;
}

export interface SyncRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string;
  pages: number | null;
  fetched: number | null;
  inserted: number | null;
  updated: number | null;
  message: string | null;
}

export interface UpsertResult { inserted: number; updated: number; unchanged: number }

export class Store {
  private readonly db: Db;

  private constructor(db: Db) { this.db = db; }

  /**
   * Buka store pada SQLite (`sqlitePath`) atau Postgres (`databaseUrl`).
   * Skema dijalankan di sini supaya pemanggil tidak perlu tahu dialeknya.
   */
  static async open(opts: { sqlitePath?: string; databaseUrl?: string }): Promise<Store> {
    const db = await openDb(opts);
    const store = new Store(db);
    await db.exec(db.dialect === 'pg' ? SCHEMA_PG : SCHEMA_SQLITE);
    await store.migrate();
    return store;
  }

  /** Migrasi aditif: CREATE TABLE IF NOT EXISTS tidak menambah kolom ke tabel lama. */
  private async migrate() {
    const cols = async (t: string): Promise<string[]> => {
      if (this.db.dialect === 'pg') {
        const rows = await this.db
          .prepare('SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?')
          .all<{ column_name: string }>([t]);
        return rows.map((c) => c.column_name);
      }
      const rows = await this.db.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>();
      return rows.map((c) => c.name);
    };
    const add = async (t: string, col: string, decl: string) => {
      if (!(await cols(t)).includes(col)) await this.db.exec(`ALTER TABLE ${t} ADD COLUMN ${col} ${decl}`);
    };
    await add('sync_lock', 'pid', 'INTEGER');
    await add('sync_lock', 'host', 'TEXT');
    // Lock lama belum punya lease: anggap kedaluwarsa supaya tidak menyandera sync.
    await add('sync_lock', 'expires_at', 'TEXT');
    await this.db.exec(`UPDATE sync_lock SET expires_at = started_at WHERE expires_at IS NULL`);
    // Sebab gagal input: diisi dari tanda Excel pegawai, lalu bisa dikoreksi supervisor.
    await add('assignment', 'fail_reason', 'TEXT');
    await add('assignment', 'note', 'TEXT');
    await add('assignment', 'flagged_by', 'TEXT');
    await add('assignment', 'flagged_at', 'TEXT');
    // Tahun penugasan untuk filter laporan; diisi dari Excel (kolom tahun / tanggal target).
    await add('assignment', 'target_year', 'INTEGER');
    // Batch kini punya identitas yang bisa dikelola: nama, periode, status, ringkasan impor.
    await add('assignment_batch', 'name', 'TEXT');
    // Batch lama (sebelum ada nama) diberi nama dari file/periode supaya tidak muncul "Batch 6".
    await this.db.exec(`UPDATE assignment_batch
                     SET name = CASE
                       WHEN period_start IS NOT NULL THEN 'Penugasan ' || substr(period_start,1,7)
                       ELSE 'Penugasan ' || substr(imported_at,1,10)
                     END
                   WHERE name IS NULL OR name = ''`);
    await add('assignment_batch', 'status', "TEXT NOT NULL DEFAULT 'aktif'");
    await add('assignment_batch', 'note', 'TEXT');
    await add('assignment_batch', 'last_import_at', 'TEXT');
    await add('assignment_batch', 'import_count', 'INTEGER NOT NULL DEFAULT 0');
    // Syarat "dianggap sudah diinput" per batch, diatur admin (lihat MATCH_RULES).
    await add('assignment_batch', 'match_rule', "TEXT NOT NULL DEFAULT 'selesai'");
    // Setoran laporan per petugas per batch: dasar aksi "tandai sudah setor".
    await this.db.exec(`CREATE TABLE IF NOT EXISTS petugas_submission (
      batch_id   INTEGER NOT NULL,
      petugas    TEXT NOT NULL,
      setor_at   TEXT NOT NULL,
      setor_by   TEXT,
      hitung_gagal INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (batch_id, petugas)
    )`);
    // Batch lama belum punya target_year: turunkan dari tanggal target supaya filter tahun langsung berguna.
    await this.db.exec(`UPDATE assignment SET target_year = CAST(substr(target_date,1,4) AS INTEGER)
                  WHERE target_year IS NULL AND target_date IS NOT NULL AND length(target_date) >= 4`);
  }

  close(): Promise<void> { return this.db.close(); }

  // ---- session ----
  async getSession(): Promise<{ tokenEksternal: string; refreshToken: string; updatedAt: string } | null> {
    const row = await this.db.prepare('SELECT token_eksternal, refresh_token, updated_at FROM session WHERE id = 1')
      .get<{ token_eksternal: string; refresh_token: string; updated_at: string }>([]);
    if (!row) return null;
    return { tokenEksternal: row.token_eksternal, refreshToken: row.refresh_token, updatedAt: row.updated_at };
  }

  /**
   * Kunci tulis lintas-proses (CLI + web memakai DB yang sama).
   * SQLite memakai `BEGIN IMMEDIATE`; Postgres memakai satu klien transaksi.
   * Dipakai membungkus baca→refresh→tulis sesi supaya refresh_token single-use tidak dipakai dua kali.
   */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    return this.db.tx(fn);
  }

  /** Catat penolakan SSI supaya UI menampilkan login — satu-satunya sinyal yang jujur. */
  async setSessionError(message: string) {
    await this.db
      .prepare('INSERT INTO session_error (id, message, at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET message = excluded.message, at = excluded.at')
      .run([message, new Date().toISOString()]);
  }

  async clearSessionError() {
    await this.db.prepare('DELETE FROM session_error WHERE id = 1').run();
  }

  async sessionError(): Promise<{ message: string; at: string } | null> {
    return this.db.prepare('SELECT message, at FROM session_error WHERE id = 1').get<{ message: string; at: string }>();
  }

  async saveSession(s: { tokenEksternal: string; refreshToken: string; updatedAt: string }) {
    await this.db.prepare(`
      INSERT INTO session (id, token_eksternal, refresh_token, updated_at) VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET token_eksternal = excluded.token_eksternal,
        refresh_token = excluded.refresh_token, updated_at = excluded.updated_at
    `).run([s.tokenEksternal, s.refreshToken, s.updatedAt]);
  }

  // ---- visits ----
  /**
   * Simpan satu halaman kunjungan. Batch, bukan per baris: lewat pooler Supabase satu
   * round-trip ~50 ms, jadi 2.000 SELECT+UPDATE per baris = 200 detik (terukur 215 dtk
   * untuk halaman 2.000 baris yang isinya tak berubah). Dengan batching: 1 query cek
   * hash + 1 UPDATE massal → hitungan detik.
   */
  async upsertVisits(visits: SsiVisit[]): Promise<UpsertResult> {
    const now = new Date().toISOString();
    const recs = new Map<string, ReturnType<typeof flatten>>();
    for (const v of visits) if (v?.reg_id) recs.set(v.reg_id, flatten(v));
    if (!recs.size) return { inserted: 0, updated: 0, unchanged: 0 };

    const COLS = ['reg_id', 'nik', 'name_raw', 'name_norm', 'birth_date', 'gender', 'faskes_code', 'faskes_name',
      'ticket_number', 'register_date', 'self_check_status', 'screening_count_all', 'screening_count_done',
      'attend_date', 'done_date', 'finished_date', 'visit_register_date', 'started_date', 'is_complete',
      'first_seen_at', 'last_seen_at', 'content_hash'];
    const ph = (n: number) => Array.from({ length: n }, () => '?').join(',');
    const chunks = <T,>(arr: T[], size: number): T[][] => {
      const out: T[][] = [];
      for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
      return out;
    };
    // Batas parameter SQLite (999) jauh lebih kecil daripada Postgres (65535).
    const idChunk = this.db.dialect === 'pg' ? 500 : 300;
    const insertChunk = this.db.dialect === 'pg' ? 200 : 30;

    const ids = [...recs.keys()];
    const existing = new Map<string, string>();
    for (const part of chunks(ids, idChunk)) {
      const rows = await this.db
        .prepare(`SELECT reg_id, content_hash FROM visit WHERE reg_id IN (${ph(part.length)})`)
        .all<{ reg_id: string; content_hash: string }>(part);
      for (const r of rows) existing.set(r.reg_id, r.content_hash);
    }

    const toInsert = ids.filter((id) => !existing.has(id));
    const changed = ids.filter((id) => existing.has(id) && existing.get(id) !== recs.get(id)!.content_hash);
    const untouched = ids.filter((id) => existing.get(id) === recs.get(id)!.content_hash);

    await this.db.tx(async () => {
      for (const part of chunks(toInsert, insertChunk)) {
        const values = part.map(() => `(${ph(COLS.length)})`).join(',');
        const params = part.flatMap((id) => {
          const r = recs.get(id)!;
          return [r.reg_id, r.nik, r.name_raw, r.name_norm, r.birth_date, r.gender, r.faskes_code, r.faskes_name,
            r.ticket_number, r.register_date, r.self_check_status, r.screening_count_all, r.screening_count_done,
            r.attend_date, r.done_date, r.finished_date, r.visit_register_date, r.started_date, r.is_complete,
            now, now, r.content_hash];
        });
        await this.db.prepare(`INSERT INTO visit (${COLS.join(',')}) VALUES ${values}`).run(params);
      }

      // Hanya baris yang benar-benar berubah; biasanya puluhan, bukan ribuan.
      const update = this.db.prepare(`
        UPDATE visit SET nik=?, name_raw=?, name_norm=?, birth_date=?, gender=?, faskes_code=?, faskes_name=?,
          ticket_number=?, register_date=?, self_check_status=?, screening_count_all=?, screening_count_done=?,
          attend_date=?, done_date=?, finished_date=?, visit_register_date=?, started_date=?, is_complete=?,
          last_seen_at=?, content_hash=?
        WHERE reg_id=?`);
      const hist = this.db.prepare(`
        INSERT INTO visit_history (reg_id, changed_at, content_hash, self_check_status, screening_count_done, screening_count_all, done_date)
        VALUES (?,?,?,?,?,?,?)`);
      for (const id of changed) {
        const r = recs.get(id)!;
        await update.run([r.nik, r.name_raw, r.name_norm, r.birth_date, r.gender, r.faskes_code, r.faskes_name,
          r.ticket_number, r.register_date, r.self_check_status, r.screening_count_all, r.screening_count_done,
          r.attend_date, r.done_date, r.finished_date, r.visit_register_date, r.started_date, r.is_complete,
          now, r.content_hash, id]);
        await hist.run([id, now, r.content_hash, r.self_check_status, r.screening_count_done, r.screening_count_all, r.done_date]);
      }

      for (const part of chunks(untouched, idChunk)) {
        await this.db.prepare(`UPDATE visit SET last_seen_at=? WHERE reg_id IN (${ph(part.length)})`).run([now, ...part]);
      }
    });

    return { inserted: toInsert.length, updated: changed.length, unchanged: untouched.length };
  }

  async allVisits(): Promise<VisitRow[]> {
    return this.db.prepare(`SELECT reg_id, nik, name_raw, name_norm, birth_date, gender, faskes_code, ticket_number,
      register_date, self_check_status, screening_count_all, screening_count_done, done_date,
      first_seen_at, last_seen_at, is_complete FROM visit`).all<VisitRow>();
  }

  /**
   * Seluruh kunjungan SSI, bukan hanya yang tercocok ke penugasan. Tahun mengikuti
   * `register_date` — kolom yang sama yang dipakai `yearOf` saat mencocokkan.
   */
  async visitsForExport(year: number | null): Promise<VisitExportRow[]> {
    const cols = `reg_id, nik, name_raw, name_norm, birth_date, gender, faskes_code, faskes_name,
      ticket_number, register_date, self_check_status, screening_count_all, screening_count_done,
      attend_date, done_date, finished_date, visit_register_date, started_date, is_complete,
      first_seen_at, last_seen_at, content_hash`;
    if (year) {
      return this.db.prepare(
        `SELECT ${cols} FROM visit WHERE substr(register_date, 1, 4) = ? ORDER BY register_date, name_raw`,
      ).all<VisitExportRow>([String(year)]);
    }
    return this.db.prepare(`SELECT ${cols} FROM visit ORDER BY register_date, name_raw`).all<VisitExportRow>();
  }

  async visitCount(): Promise<number> {
    const row = await this.db.prepare('SELECT COUNT(*) AS c FROM visit').get<{ c: number | string }>();
    return Number(row?.c ?? 0);
  }

  /**
   * Agregat untuk grafik. Dihitung di database, bukan dikirim 13 ribu baris ke browser.
   * `register_date`/`done_date` adalah string ISO dari SSI (`YYYY-MM-DD`, `YYYY-MM-DDTHH:MM:SS`),
   * jadi substr langsung bisa dipakai dan tidak tergantung zona waktu mesin.
   */
  async visitChartData() {
    const months = await this.db.prepare(`
      SELECT substr(register_date,1,7) AS k, COUNT(*) AS c
      FROM visit
      WHERE register_date IS NOT NULL AND length(register_date) >= 7
      GROUP BY k ORDER BY k
    `).all<{ k: string; c: number | string }>();

    const hours = await this.db.prepare(`
      SELECT substr(done_date,12,2) AS k, COUNT(*) AS c
      FROM visit
      WHERE done_date IS NOT NULL AND length(done_date) >= 13
      GROUP BY k ORDER BY k
    `).all<{ k: string; c: number | string }>();

    // Dekade lahir: 0 untuk yang tanpa tanggal lahir agar tidak hilang diam-diam.
    const decades = await this.db.prepare(`
      SELECT CASE
               WHEN birth_date IS NULL OR birth_date = '' THEN 0
               ELSE (CAST(substr(birth_date,1,4) AS INTEGER) / 10) * 10
             END AS k, COUNT(*) AS c
      FROM visit
      GROUP BY k ORDER BY k
    `).all<{ k: number | string; c: number | string }>();

    // Variasi penulisan jenis kelamin (L / LAKI-LAKI / P / PEREMPUAN) disatukan.
    const gender = await this.db.prepare(`
      SELECT CASE
               WHEN upper(gender) LIKE 'L%' THEN 'L'
               WHEN upper(gender) LIKE 'P%' THEN 'P'
               ELSE 'lain'
             END AS k, COUNT(*) AS c
      FROM visit
      GROUP BY k ORDER BY k
    `).all<{ k: string; c: number | string }>();

    return {
      months: months.map((r) => ({ key: String(r.k), count: Number(r.c) })),
      hours: hours.map((r) => ({ key: String(r.k), count: Number(r.c) })),
      decades: decades.map((r) => ({ key: Number(r.k), count: Number(r.c) })),
      gender: gender.map((r) => ({ key: String(r.k), count: Number(r.c) })),
    };
  }

  // ---- visit detail ----
  async upsertVisitDetails(rows: VisitDetail[]): Promise<number> {
    const stmt = this.db.prepare(`
      INSERT INTO visit_detail (reg_id, services_total, services_submitted, forms_total, forms_submitted, self_check_status, fetched_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(reg_id) DO UPDATE SET services_total = excluded.services_total,
        services_submitted = excluded.services_submitted, forms_total = excluded.forms_total,
        forms_submitted = excluded.forms_submitted, self_check_status = excluded.self_check_status,
        fetched_at = excluded.fetched_at
    `);
    await this.db.tx(async () => {
      for (const r of rows) {
        await stmt.run([r.regId, r.servicesTotal, r.servicesSubmitted, r.formsTotal, r.formsSubmitted, r.selfCheckStatus, r.fetchedAt]);
      }
    });
    return rows.length;
  }

  /** Peta reg_id → rincian. Dipakai laporan agar tidak query per baris. */
  async visitDetails(): Promise<Map<string, VisitDetail>> {
    const rows = await this.db.prepare(`
      SELECT reg_id, services_total, services_submitted, forms_total, forms_submitted, self_check_status, fetched_at
      FROM visit_detail
    `).all<{ reg_id: string; services_total: number; services_submitted: number; forms_total: number | null; forms_submitted: number | null; self_check_status: string | null; fetched_at: string }>();
    const map = new Map<string, VisitDetail>();
    for (const r of rows) {
      map.set(r.reg_id, {
        regId: r.reg_id,
        servicesTotal: r.services_total,
        servicesSubmitted: r.services_submitted,
        formsTotal: r.forms_total,
        formsSubmitted: r.forms_submitted,
        selfCheckStatus: r.self_check_status,
        fetchedAt: r.fetched_at,
      });
    }
    return map;
  }

  // ---- assignments ----
  async createBatch(b: { name: string; filename: string; rowCount: number; periodStart?: string | null; periodEnd?: string | null; mapping?: unknown; note?: string | null }): Promise<number> {
    const now = new Date().toISOString();
    const sql = `
      INSERT INTO assignment_batch (name, filename, imported_at, row_count, period_start, period_end, mapping, status, note, last_import_at, import_count)
      VALUES (?,?,?,?,?,?,?,'aktif',?,?,1)`;
    const params = [
      b.name,
      b.filename,
      now,
      b.rowCount,
      b.periodStart ?? null,
      b.periodEnd ?? null,
      b.mapping ? JSON.stringify(b.mapping) : null,
      b.note ?? null,
      now,
    ];
    if (this.db.dialect === 'pg') {
      const row = await this.db.prepare(`${sql} RETURNING id`).get<{ id: number }>(params);
      return Number(row?.id);
    }
    const r = await this.db.prepare(sql).run(params);
    return Number(r.lastId);
  }

  /** Set jumlah baris akhir setelah impor pertama (baris yang benar-benar masuk, bukan jumlah baris sheet). */
  async setBatchRowCount(id: number, rowCount: number) {
    await this.db.prepare('UPDATE assignment_batch SET row_count = ?, import_count = 1, last_import_at = ? WHERE id = ?')
      .run([rowCount, new Date().toISOString(), id]);
  }

  async markBatchEmpty(id: number) {
    await this.db.prepare('UPDATE assignment_batch SET import_count = 0, last_import_at = NULL WHERE id = ?').run([id]);
  }

  /** Catat bahwa batch baru saja diisi ulang (tanpa mengubah jumlah baris). */
  async touchBatch(batchId: number, filename: string) {
    await this.db.prepare(`
      UPDATE assignment_batch SET last_import_at = ?, import_count = import_count + 1, filename = ? WHERE id = ?
    `).run([new Date().toISOString(), filename, batchId]);
  }

  /** Impor tambahan ke batch yang sudah ada: menambah baris, bukan membuat batch baru. */
  async appendToBatch(batchId: number, rowCount: number, filename: string) {
    await this.db.prepare(`
      UPDATE assignment_batch
         SET row_count = row_count + ?, last_import_at = ?, import_count = import_count + 1, filename = ?
       WHERE id = ?
    `).run([rowCount, new Date().toISOString(), filename, batchId]);
  }

  async listBatches(): Promise<BatchRow[]> {
    const rows = await this.db.prepare(`
      SELECT b.*, (SELECT COUNT(DISTINCT petugas) FROM assignment a WHERE a.batch_id = b.id) AS petugas_count
        FROM assignment_batch b
       ORDER BY b.id DESC
    `).all<BatchRow>();
    // COUNT di Postgres kembali sebagai string (bigint).
    return rows.map((r) => ({ ...r, petugas_count: Number(r.petugas_count ?? 0) }));
  }

  async getBatch(id: number): Promise<BatchRow | null> {
    return this.db.prepare('SELECT * FROM assignment_batch WHERE id = ?').get<BatchRow>([id]);
  }

  async updateBatch(id: number, patch: { name?: string; periodStart?: string | null; periodEnd?: string | null; status?: string; note?: string | null; matchRule?: string }): Promise<boolean> {
    const cur = await this.getBatch(id);
    if (!cur) return false;
    await this.db.prepare(`
      UPDATE assignment_batch SET name = ?, period_start = ?, period_end = ?, status = ?, note = ?, match_rule = ? WHERE id = ?
    `).run([
      patch.name ?? cur.name,
      patch.periodStart !== undefined ? patch.periodStart : cur.period_start,
      patch.periodEnd !== undefined ? patch.periodEnd : cur.period_end,
      patch.status ?? cur.status,
      patch.note !== undefined ? patch.note : cur.note,
      patch.matchRule ?? cur.match_rule ?? 'selesai',
      id,
    ]);
    return true;
  }

  /** Hanya batch yang masih aktif yang bisa jadi acuan laporan. */
  async activeBatches(): Promise<Array<Pick<BatchRow, 'id' | 'name'>>> {
    return this.db.prepare("SELECT id, name FROM assignment_batch WHERE status = 'aktif' ORDER BY id DESC").all<Pick<BatchRow, 'id' | 'name'>>();
  }

  /** Batch acuan: yang diminta, atau batch aktif terbaru. */
  async resolveBatch(id?: number | null): Promise<BatchRow | null> {
    if (id) {
      const b = await this.getBatch(id);
      return b && b.status === 'aktif' ? b : null;
    }
    return this.db.prepare("SELECT * FROM assignment_batch WHERE status = 'aktif' ORDER BY id DESC LIMIT 1").get<BatchRow>();
  }

  /**
   * Tanda yang sudah dibuat manusia (bukan dari Excel) dipakai ulang saat batch diganti isi,
   * supaya hasil verifikasi tidak hilang hanya karena file diunggah ulang.
   * Kunci = NIK + Petugas ternormalisasi (NIK sama milik dua petugas tetap sah).
   */
  async manualFlags(batchId: number): Promise<Map<string, { failReason: string | null; note: string | null; by: string | null }>> {
    const rows = await this.db.prepare(`
      SELECT petugas, patient_nik, fail_reason, note, flagged_by
        FROM assignment
       WHERE batch_id = ? AND (flagged_by IS NOT NULL AND flagged_by <> 'excel')
    `).all<{ petugas: string; patient_nik: string | null; fail_reason: string | null; note: string | null; flagged_by: string | null }>([batchId]);
    const map = new Map<string, { failReason: string | null; note: string | null; by: string | null }>();
    for (const r of rows) {
      map.set(flagKey(r.petugas, r.patient_nik), { failReason: r.fail_reason ?? null, note: r.note ?? null, by: r.flagged_by ?? null });
    }
    return map;
  }

  /** Tanda yang berasal dari kolom Excel (`flagged_by='excel'`), untuk deteksi tanda yang akan hilang. */
  async excelFlags(batchId: number): Promise<Map<string, string>> {
    const rows = await this.db.prepare(`
      SELECT petugas, patient_nik, fail_reason FROM assignment
       WHERE batch_id = ? AND flagged_by = 'excel' AND fail_reason IS NOT NULL
    `).all<{ petugas: string; patient_nik: string | null; fail_reason: string }>([batchId]);
    return new Map(rows.map((r) => [flagKey(r.petugas, r.patient_nik), String(r.fail_reason)]));
  }

  /** Ganti seluruh isi batch dalam satu transaksi: hapus baris lama, tulis baris baru. */
  async replaceAssignments(batchId: number, rows: Array<{ rowNo: number; petugas: string; nik: string | null; name: string | null; birthDate: string | null; targetDate: string | null; year?: number | null; extra?: unknown; failReason?: string | null; note?: string | null; flaggedBy?: string | null }>) {
    await this.db.tx(async () => {
      await this.db.prepare('DELETE FROM assignment WHERE batch_id = ?').run([batchId]);
      await this.insertAssignments(batchId, rows);
    });
  }

  async addAssignments(batchId: number, rows: Array<{ rowNo: number; petugas: string; nik: string | null; name: string | null; birthDate: string | null; targetDate: string | null; year?: number | null; extra?: unknown; failReason?: string | null; note?: string | null; flaggedBy?: string | null }>) {
    await this.db.tx(async () => {
      await this.insertAssignments(batchId, rows);
    });
  }

  private async insertAssignments(batchId: number, rows: Array<{ rowNo: number; petugas: string; nik: string | null; name: string | null; birthDate: string | null; targetDate: string | null; year?: number | null; extra?: unknown; failReason?: string | null; note?: string | null; flaggedBy?: string | null }>) {
    const stmt = this.db.prepare('INSERT INTO assignment (batch_id, row_no, petugas, patient_nik, patient_name, name_norm, birth_date, target_date, source_extra, fail_reason, note, flagged_by, flagged_at, target_year) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const now = new Date().toISOString();
    for (const r of rows) {
      const flagged = r.failReason || r.note ? now : null;
      await stmt.run([batchId, r.rowNo, r.petugas, r.nik, r.name, normalizeName(r.name), r.birthDate, r.targetDate, r.extra ? JSON.stringify(r.extra) : null, r.failReason ?? null, r.note ?? null, r.flaggedBy ?? (r.failReason ? 'excel' : null), flagged, r.year ?? null]);
    }
  }

  /**
   * Koreksi sebab gagal oleh supervisor. Hanya berlaku untuk baris batch aktif;
   * alasan yang dikirim Excel tetap tersimpan sebagai usulan di `source_extra`.
   */
  async setAssignmentFlag(id: number, failReason: string | null, note: string | null, by: string) {
    // Menghapus tanda = benar-benar bersih: tidak boleh menyisakan flagged_by kosong yang
    // nanti terbaca sebagai "tanda manual" saat impor ulang.
    if (!failReason) {
      await this.db.prepare('UPDATE assignment SET fail_reason = NULL, note = NULL, flagged_by = NULL, flagged_at = NULL WHERE id = ?').run([id]);
      return;
    }
    await this.db.prepare('UPDATE assignment SET fail_reason = ?, note = ?, flagged_by = ?, flagged_at = ? WHERE id = ?')
      .run([failReason, note, by, new Date().toISOString(), id]);
  }

  /** Aksi massal: tandai semua baris petugas pada batch yang belum ditemukan di SSI. */
  async setAssignmentFlagBulk(ids: number[], failReason: string | null, note: string | null, by: string): Promise<number> {
    if (!ids.length) return 0;
    const stmt = failReason
      ? this.db.prepare('UPDATE assignment SET fail_reason = ?, note = ?, flagged_by = ?, flagged_at = ? WHERE id = ?')
      : this.db.prepare('UPDATE assignment SET fail_reason = NULL, note = NULL, flagged_by = NULL, flagged_at = NULL WHERE id = ?');
    const now = new Date().toISOString();
    await this.db.tx(async () => {
      for (const id of ids) {
        if (failReason) await stmt.run([failReason, note, by, now, id]);
        else await stmt.run([id]);
      }
    });
    return ids.length;
  }

  /* ---------- setoran laporan petugas ---------- */

  async submissionsOf(batchId: number): Promise<Map<string, { at: string; by: string | null; hitungGagal: boolean }>> {
    const rows = await this.db.prepare('SELECT petugas, setor_at, setor_by, hitung_gagal FROM petugas_submission WHERE batch_id = ?')
      .all<{ petugas: string; setor_at: string; setor_by: string | null; hitung_gagal: number | string }>([batchId]);
    const map = new Map<string, { at: string; by: string | null; hitungGagal: boolean }>();
    for (const r of rows) {
      map.set(String(r.petugas), { at: String(r.setor_at), by: r.setor_by ?? null, hitungGagal: Number(r.hitung_gagal) === 1 });
    }
    return map;
  }

  /** Catat setoran + tandai baris yang masih berstatus belum diinput sebagai gagal. */
  async markSubmitted(batchId: number, petugas: string, opts: { flagIds: number[]; reason: string; by: string; hitungGagal: boolean }) {
    const now = new Date().toISOString();
    await this.db.tx(async () => {
      await this.db.prepare(`INSERT INTO petugas_submission (batch_id, petugas, setor_at, setor_by, hitung_gagal)
                       VALUES (?,?,?,?,?)
                       ON CONFLICT(batch_id, petugas) DO UPDATE SET
                         setor_at = excluded.setor_at, setor_by = excluded.setor_by, hitung_gagal = excluded.hitung_gagal`)
        .run([batchId, petugas, now, opts.by, opts.hitungGagal ? 1 : 0]);
      const stmt = this.db.prepare('UPDATE assignment SET fail_reason = ?, note = ?, flagged_by = ?, flagged_at = ? WHERE id = ?');
      for (const id of opts.flagIds) await stmt.run([opts.reason, null, opts.by, now, id]);
    });
  }

  async unmarkSubmitted(batchId: number, petugas: string) {
    await this.db.prepare('DELETE FROM petugas_submission WHERE batch_id = ? AND petugas = ?').run([batchId, petugas]);
  }

  /**
   * Batalkan setoran seolah tidak pernah terjadi: hapus tanda yang dibuat setoran itu
   * (`flagged_by = setor:<petugas>`) lalu hapus catatan setorannya. Tanda dari Excel atau
   * supervisor tidak disentuh. Dipakai tombol "Batalkan setoran" dan saat impor ulang
   * membuat setoran tidak lagi menutup data.
   */
  async revokeSubmission(batchId: number, petugas: string): Promise<number> {
    const by = `setor:${petugas}`;
    const rows = await this.db.prepare('SELECT id FROM assignment WHERE batch_id = ? AND petugas = ? AND flagged_by = ?')
      .all<{ id: number | string }>([batchId, petugas, by]);
    await this.setAssignmentFlagBulk(rows.map((r) => Number(r.id)), null, null, '');
    await this.unmarkSubmitted(batchId, petugas);
    return rows.length;
  }

  /** Nama petugas yang tercatat di batch aktif, untuk daftar pilihan "oleh". */
  async petugasList(): Promise<string[]> {
    const rows = await this.db.prepare('SELECT DISTINCT petugas FROM assignment WHERE batch_id = (SELECT MAX(id) FROM assignment_batch) ORDER BY petugas').all<{ petugas: string }>();
    return rows.map((r) => String(r.petugas));
  }

  async latestBatch(): Promise<BatchRow | null> {
    return this.db.prepare('SELECT * FROM assignment_batch ORDER BY id DESC LIMIT 1').get<BatchRow>();
  }

  /** Nama petugas pada batch tertentu (untuk aksi massal), bukan selalu batch terakhir. */
  async petugasOfBatch(batchId: number): Promise<string[]> {
    const rows = await this.db.prepare('SELECT DISTINCT petugas FROM assignment WHERE batch_id = ? ORDER BY petugas').all<{ petugas: string }>([batchId]);
    return rows.map((r) => String(r.petugas));
  }

  async assignmentsOf(batchId: number): Promise<AssignmentRow[]> {
    return this.db.prepare('SELECT * FROM assignment WHERE batch_id = ? ORDER BY petugas, row_no').all<AssignmentRow>([batchId]);
  }

  async purgeBatch(batchId: number) {
    // ON DELETE CASCADE menghapus baris; eksplisit di sini supaya tetap benar bila pragma FK dimatikan.
    await this.db.tx(async () => {
      await this.db.prepare('DELETE FROM assignment WHERE batch_id = ?').run([batchId]);
      await this.db.prepare('DELETE FROM assignment_batch WHERE id = ?').run([batchId]);
    });
  }

  // ---- runs ----
  async startRun(): Promise<number> {
    const sql = 'INSERT INTO sync_run (started_at, status) VALUES (?, ?)';
    const params = [new Date().toISOString(), 'running'];
    if (this.db.dialect === 'pg') {
      const row = await this.db.prepare(`${sql} RETURNING id`).get<{ id: number }>(params);
      return Number(row?.id);
    }
    const r = await this.db.prepare(sql).run(params);
    return Number(r.lastId);
  }

  async finishRun(id: number, patch: { status: string; pages?: number; fetched?: number; inserted?: number; updated?: number; message?: string }) {
    await this.db.prepare('UPDATE sync_run SET finished_at=?, status=?, pages=?, fetched=?, inserted=?, updated=?, message=? WHERE id=?')
      .run([new Date().toISOString(), patch.status, patch.pages ?? 0, patch.fetched ?? 0, patch.inserted ?? 0, patch.updated ?? 0, patch.message ?? null, id]);
  }

  /**
   * Ambil kunci sweep dengan lease. Satu UPDATE atomik — tanpa `BEGIN IMMEDIATE`
   * dan tanpa `pid`, jadi perilakunya sama di SQLite maupun Postgres (serverless).
   * `owner` harus unik per proses/instance (mis. `web:<uuid>`), bukan sekadar nama peran.
   */
  async claimSync(owner: string, leaseMs = 10 * 60_000): Promise<boolean> {
    const now = new Date();
    const expires = new Date(now.getTime() + leaseMs).toISOString();
    const pid = Number(owner.split(':')[1]);
    const res = await this.db.prepare(`
      INSERT INTO sync_lock (id, owner, pid, host, started_at, expires_at)
      VALUES (1, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        owner = excluded.owner, pid = excluded.pid, host = excluded.host,
        started_at = excluded.started_at, expires_at = excluded.expires_at
      WHERE sync_lock.expires_at IS NULL
         OR sync_lock.expires_at <= ?
         OR sync_lock.owner = excluded.owner
    `).run([owner, Number.isFinite(pid) ? pid : null, hostname(), now.toISOString(), expires, now.toISOString()]);
    if (Number(res.changes ?? 0) > 0) return true;
    return this.takeOverDeadSync(owner, now.toISOString(), expires);
  }

  /**
   * Ambil alih kunci yang pemiliknya sudah mati di host yang sama. Tidak jalan di serverless
   * (host/pid berbeda), tetapi mempertahankan perilaku lokal: proses yang crash tidak
   * menyandera sync selama 10 menit penuh. Penulisan dikunci pada nilai owner yang dibaca
   * (compare-and-swap), jadi dua pengambil tidak bisa menang bersamaan.
   */
  private async takeOverDeadSync(owner: string, startedAt: string, expiresAt: string): Promise<boolean> {
    const row = await this.db.prepare('SELECT owner, pid, host FROM sync_lock WHERE id = 1')
      .get<{ owner: string; pid: number | null; host: string | null }>();
    if (!row) return false;
    if (row.host && row.host !== hostname()) return false;
    const pid = Number(row.pid);
    if (Number.isFinite(pid) && isAlive(pid)) return false;
    const mine = Number(owner.split(':')[1]);
    const res = await this.db.prepare(`UPDATE sync_lock SET owner = ?, pid = ?, host = ?, started_at = ?, expires_at = ?
                                  WHERE id = 1 AND owner = ?`)
      .run([owner, Number.isFinite(mine) ? mine : null, hostname(), startedAt, expiresAt, String(row.owner)]);
    return Number(res.changes ?? 0) > 0;
  }

  /** Perpanjang lease selama sweep berjalan (dipanggil per halaman). */
  async renewSync(owner: string, leaseMs = 10 * 60_000): Promise<boolean> {
    const expires = new Date(Date.now() + leaseMs).toISOString();
    const res = await this.db.prepare('UPDATE sync_lock SET expires_at = ? WHERE id = 1 AND owner = ?').run([expires, owner]);
    return Number(res.changes ?? 0) > 0;
  }

  async releaseSync(owner: string) {
    await this.db.prepare('DELETE FROM sync_lock WHERE id = 1 AND owner = ?').run([owner]);
  }

  /* ---------- captcha SSI ---------- */

  async saveCaptcha(id: string, jar: string, ttlMs = 10 * 60_000) {
    const now = new Date();
    await this.db.prepare('DELETE FROM ssi_captcha WHERE expires_at < ?').run([now.toISOString()]);
    await this.db.prepare(`INSERT INTO ssi_captcha (id, jar, created_at, expires_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET jar = excluded.jar, created_at = excluded.created_at, expires_at = excluded.expires_at`)
      .run([id, jar, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString()]);
  }

  /** Ambil sekali pakai: baris dihapus apa pun hasilnya, supaya captcha tidak bisa diulang. */
  async takeCaptcha(id: string): Promise<{ jar: string; expiresAt: string } | null> {
    const row = await this.db.prepare('SELECT jar, expires_at FROM ssi_captcha WHERE id = ?').get<{ jar: string; expires_at: string }>([id]);
    if (!row) return null;
    await this.db.prepare('DELETE FROM ssi_captcha WHERE id = ?').run([id]);
    await this.db.prepare('DELETE FROM ssi_captcha WHERE expires_at < ?').run([new Date().toISOString()]);
    return { jar: String(row.jar), expiresAt: String(row.expires_at) };
  }

  /* ---------- pengaturan ---------- */

  async getSetting(key: string): Promise<string | null> {
    const row = await this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get<{ value: string }>([key]);
    return row ? String(row.value) : null;
  }

  async setSetting(key: string, value: string) {
    await this.db.prepare(`INSERT INTO app_setting (key, value, updated_at) VALUES (?,?,?)
                     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .run([key, value, new Date().toISOString()]);
  }

  /** Tutup run yang tertinggal 'running' oleh proses yang sudah mati. */
  async recoverInterrupted(): Promise<number> {
    const r = await this.db
      .prepare("UPDATE sync_run SET status = 'interrupted', finished_at = ? WHERE status = 'running'")
      .run([new Date().toISOString()]);
    return Number(r.changes ?? 0);
  }

  async lastRun(): Promise<SyncRunRow | null> {
    return this.db.prepare('SELECT * FROM sync_run ORDER BY id DESC LIMIT 1').get<SyncRunRow>();
  }
}

function flatten(v: SsiVisit) {
  const nik = String(v.patient?.nik ?? '').trim() || null;
  const name = String(v.patient?.fullname ?? '').trim() || null;
  const birth = String(v.patient?.birth_date ?? '').trim() || null;
  const t = v.treatment ?? {};
  const hashSource = JSON.stringify([
    v.self_check_status, v.screening_count_all, v.screening_count_done,
    t.done_date, t.finished_date, t.attend_date, t.register_date, t.started_date,
    v.register_date, v.ticket_number, v.is_report_available, name, nik, birth,
    v.wali?.fullname ?? null, v.wali?.mobile_number ?? null,
  ]);
  // FNV-1a 32-bit cukup untuk deteksi perubahan, bukan keamanan.
  let h = 0x811c9dc5;
  for (let i = 0; i < hashSource.length; i++) { h ^= hashSource.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return {
    reg_id: v.reg_id,
    nik,
    name_raw: name,
    name_norm: name ? normalizeName(name) : null,
    birth_date: birth,
    gender: v.patient?.gender ?? null,
    faskes_code: v.faskes_code ?? null,
    faskes_name: v.faskes_name ?? null,
    ticket_number: v.ticket_number ?? null,
    register_date: v.register_date ?? null,
    self_check_status: v.self_check_status ?? null,
    screening_count_all: Number(v.screening_count_all ?? 0),
    screening_count_done: Number(v.screening_count_done ?? 0),
    attend_date: t.attend_date ?? null,
    done_date: t.done_date ?? null,
    finished_date: t.finished_date ?? null,
    visit_register_date: t.register_date ?? null,
    started_date: t.started_date ?? null,
    is_complete: isComplete(v) ? 1 : 0,
    content_hash: h.toString(16),
  };
}
