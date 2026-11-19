declare module 'pg' {
  export interface PgQueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
  }

  export interface PgPoolClient {
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>>;
    release(): void;
  }

  export interface PgPoolConfig {
    connectionString?: string;
    max?: number;
    ssl?: false | { rejectUnauthorized: boolean };
  }

  export class Pool {
    constructor(config?: PgPoolConfig);
    query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<PgQueryResult<R>>;
    connect(): Promise<PgPoolClient>;
    end(): Promise<void>;
  }
}
