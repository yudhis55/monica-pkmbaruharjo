PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Sesi SSI. Satu baris saja (single-writer).
CREATE TABLE IF NOT EXISTS session (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  token_eksternal TEXT NOT NULL,
  refresh_token   TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- Snapshot kunjungan SSI. Sumber kebenaran: SSI. Tidak pernah diedit manual.
CREATE TABLE IF NOT EXISTS visit (
  reg_id              TEXT PRIMARY KEY,
  nik                 TEXT,
  name_raw            TEXT,
  name_norm           TEXT,
  birth_date          TEXT,
  gender              TEXT,
  faskes_code         TEXT,
  faskes_name         TEXT,
  ticket_number       TEXT,
  register_date       TEXT,
  self_check_status   TEXT,
  screening_count_all INTEGER,
  screening_count_done INTEGER,
  attend_date         TEXT,
  done_date           TEXT,
  finished_date       TEXT,
  visit_register_date TEXT,
  started_date        TEXT,
  is_complete         INTEGER NOT NULL DEFAULT 0,
  first_seen_at       TEXT NOT NULL,
  last_seen_at        TEXT NOT NULL,
  content_hash        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visit_nik  ON visit(nik);
CREATE INDEX IF NOT EXISTS idx_visit_name ON visit(name_norm, birth_date);

-- Riwayat perubahan status. Append-only, hanya ditulis bila content_hash berubah.
CREATE TABLE IF NOT EXISTS visit_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_id         TEXT NOT NULL,
  changed_at     TEXT NOT NULL,
  content_hash   TEXT NOT NULL,
  self_check_status TEXT,
  screening_count_done INTEGER,
  screening_count_all  INTEGER,
  done_date      TEXT
);
CREATE INDEX IF NOT EXISTS idx_hist_reg ON visit_history(reg_id);

-- Batch impor Excel penugasan.
-- Batch = satu periode penugasan (mis. "September 2026"). Semua impor menempel ke batch ini.
CREATE TABLE IF NOT EXISTS assignment_batch (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  row_count   INTEGER NOT NULL,
  period_start TEXT,
  period_end   TEXT,
  mapping     TEXT
);

-- Satu baris = satu pasien yang ditugaskan ke satu petugas.
CREATE TABLE IF NOT EXISTS assignment (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id       INTEGER NOT NULL REFERENCES assignment_batch(id) ON DELETE CASCADE,
  row_no         INTEGER,
  petugas        TEXT NOT NULL,
  patient_nik    TEXT,
  patient_name   TEXT,
  name_norm      TEXT,
  birth_date     TEXT,
  target_date    TEXT,
  source_extra   TEXT
);
CREATE INDEX IF NOT EXISTS idx_assign_batch ON assignment(batch_id);
CREATE INDEX IF NOT EXISTS idx_assign_nik ON assignment(patient_nik);
CREATE INDEX IF NOT EXISTS idx_assign_petugas ON assignment(petugas);

-- Rincian layanan per kunjungan. Diambil per reg_id, bukan bagian sweep.
CREATE TABLE IF NOT EXISTS visit_detail (
  reg_id            TEXT PRIMARY KEY,
  services_total    INTEGER NOT NULL,
  services_submitted INTEGER NOT NULL,
  forms_total       INTEGER,
  forms_submitted   INTEGER,
  self_check_status TEXT,
  fetched_at        TEXT NOT NULL
);

-- Log setiap run fetch.
CREATE TABLE IF NOT EXISTS sync_run (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL,
  pages       INTEGER DEFAULT 0,
  fetched     INTEGER DEFAULT 0,
  inserted    INTEGER DEFAULT 0,
  updated     INTEGER DEFAULT 0,
  message     TEXT
);

-- Kunci sweep lintas-proses. Satu sweep SSI pada satu waktu.
CREATE TABLE IF NOT EXISTS sync_lock (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  owner      TEXT NOT NULL,
  pid        INTEGER,
  host       TEXT,
  started_at TEXT NOT NULL,
  -- Lease: lock dianggap bebas setelah waktu ini. Tidak bergantung proses hidup,
  -- sehingga aman untuk serverless (tidak ada pid yang bisa dipercaya).
  expires_at TEXT
);

-- Galat autentikasi terakhir. Diisi hanya saat SSI benar-benar menolak (401/403).
CREATE TABLE IF NOT EXISTS session_error (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  message    TEXT NOT NULL,
  at         TEXT NOT NULL
);

-- State captcha SSI disimpan di DB, bukan di memori proses: gambar captcha dan POST login
-- bisa dilayani instance berbeda (serverless), dan keduanya harus melihat state yang sama.
CREATE TABLE IF NOT EXISTS ssi_captcha (
  id         TEXT PRIMARY KEY,
  jar        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Pengaturan yang bisa diubah admin tanpa deploy ulang (mis. rentang tarik data).
CREATE TABLE IF NOT EXISTS app_setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
