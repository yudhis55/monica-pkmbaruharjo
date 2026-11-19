/**
 * Lapisan database portabel: satu antarmuka untuk SQLite (lokal) dan Postgres (serverless).
 *
 * SQLite memakai `node:sqlite` yang sinkron, Postgres memakai `pg` yang asinkron. Semua
 * metode Store jadi async supaya keduanya bisa bertukar tanpa mengubah pemanggil.
 *
 * Placeholder di lapisan ini selalu `?` (gaya SQLite); adapter Postgres mengubahnya
 * menjadi `$1..$n`. SQL yang ditulis Store karenanya tetap satu versi.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { Pool, type PgPoolClient } from 'pg';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';

export interface DbStmt {
  run(params?: unknown[]): Promise<{ changes: number; lastId?: number }>;
  get<T = any>(params?: unknown[]): Promise<T | null>;
  all<T = any>(params?: unknown[]): Promise<T[]>;
}

export interface Db {
  readonly dialect: 'sqlite' | 'pg';
  /** SQLite: placeholder `?`. Postgres: `?` dikonversi ke `$1..$n` oleh adapter. */
  prepare(sql: string): DbStmt;
  /** DDL / beberapa statement sekaligus. */
  exec(sql: string): Promise<void>;
  /** SQLite: BEGIN IMMEDIATE/COMMIT/ROLLBACK. Postgres: satu klien khusus. */
  tx<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ SQLite */

class SqliteDb implements Db {
  readonly dialect = 'sqlite' as const;
  private db!: DatabaseSync;
  private ready: Promise<void>;

  constructor(path: string) {
    // Impor dinamis: modul bawaan ini tidak ada di sebagian runtime serverless, jadi
    // hanya dimuat ketika jalur SQLite yang benar-benar dipakai.
    this.ready = (async () => {
      const { DatabaseSync: Database } = await import('node:sqlite');
      this.db = new Database(path);
      this.db.exec('PRAGMA busy_timeout = 15000');
    })();
  }

  private async conn(): Promise<DatabaseSync> {
    await this.ready;
    return this.db;
  }

  prepare(sql: string): DbStmt {
    return {
      run: async (params: unknown[] = []) => {
        const db = await this.conn();
        // Nilai parameter berasal dari Store dan selalu tipe yang didukung driver.
        const r = db.prepare(sql).run(...(params as SQLInputValue[]));
        return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
      },
      get: async <T = any>(params: unknown[] = []) => {
        const db = await this.conn();
        return (db.prepare(sql).get(...(params as SQLInputValue[])) as T) ?? null;
      },
      all: async <T = any>(params: unknown[] = []) => {
        const db = await this.conn();
        return db.prepare(sql).all(...(params as SQLInputValue[])) as T[];
      },
    };
  }

  async exec(sql: string): Promise<void> {
    (await this.conn()).exec(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    const db = await this.conn();
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = await fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* sudah rollback */ }
      throw e;
    }
  }

  async close(): Promise<void> {
    await this.ready;
    this.db.close();
  }
}

/* ---------------------------------------------------------------- Postgres */

/** Ubah placeholder `?` menjadi `$n`, tanpa menyentuh tanda tanya di dalam string literal. */
export function toPgPlaceholders(sql: string): string {
  let out = '';
  let n = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) {
        // Kutip ganda di dalam string SQL ditulis dua kali.
        if (sql[i + 1] === quote) { out += sql[i + 1]; i++; continue; }
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; out += ch; continue; }
    if (ch === '?') { out += '$' + (++n); continue; }
    out += ch;
  }
  return out;
}

class PgDb implements Db {
  readonly dialect = 'pg' as const;
  /** Menyimpan klien transaksi aktif supaya statement di dalam `tx()` memakai koneksi yang sama. */
  private txClient = new AsyncLocalStorage<PgPoolClient>();

  private readonly pool: Pool;

  private constructor(pool: Pool) { this.pool = pool; }

  static async create(databaseUrl: string): Promise<PgDb> {
    const host = (() => {
      try { return new URL(databaseUrl).hostname; } catch { return ''; }
    })();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
    const pool = new Pool({
      connectionString: databaseUrl,
      max: 3,
      // Supabase butuh TLS dari luar; Postgres lokal tidak menyediakannya.
      ssl: local ? false : { rejectUnauthorized: false },
    });
    return new PgDb(pool);
  }

  private query<R = Record<string, unknown>>(text: string, params: unknown[] = []) {
    const client = this.txClient.getStore();
    return client ? client.query<R>(text, params) : this.pool.query<R>(text, params);
  }

  prepare(sql: string): DbStmt {
    const text = toPgPlaceholders(sql);
    return {
      run: async (params: unknown[] = []) => {
        const r = await this.query(text, params);
        return { changes: Number(r.rowCount ?? 0) };
      },
      get: async <T = any>(params: unknown[] = []) => {
        const r = await this.query<T>(text, params);
        return r.rows[0] ?? null;
      },
      all: async <T = any>(params: unknown[] = []) => {
        const r = await this.query<T>(text, params);
        return r.rows;
      },
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async tx<T>(fn: () => Promise<T>): Promise<T> {
    // Klien khusus, bukan pool round-robin: BEGIN/COMMIT harus di koneksi yang sama.
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const out = await this.txClient.run(client, fn);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch { /* koneksi mungkin sudah putus */ }
      throw e;
    } finally {
      try { client.release(); } catch { /* sudah dilepas */ }
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/* ------------------------------------------------------------------ factory */

/**
 * `databaseUrl` (Postgres/Supabase) menang bila diisi; selain itu SQLite di `sqlitePath`.
 */
export async function openDb(opts: { sqlitePath?: string; databaseUrl?: string }): Promise<Db> {
  const url = String(opts.databaseUrl ?? '').trim();
  if (url) return PgDb.create(url);
  return new SqliteDb(opts.sqlitePath ?? ':memory:');
}
