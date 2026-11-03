// A D1 stand-in on node:sqlite (Node 24): the subset the Worker uses (prepare/bind/first/all/run, batch), with
// migrations/*.sql applied. node:sqlite is loaded through a dynamic import typed here, so the Worker's tsconfig
// needs no @types/node.

interface Statement {
  all(...params: unknown[]): Record<string, unknown>[]
  get(...params: unknown[]): Record<string, unknown> | undefined
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint }
}
interface Database {
  exec(sql: string): void
  prepare(sql: string): Statement
}

const { DatabaseSync } = (await import('node:sqlite' as string)) as { DatabaseSync: new (path: string) => Database }
const fs = (await import('node:fs' as string)) as { readdirSync(p: string | URL): string[]; readFileSync(p: string | URL, enc: 'utf8'): string }

const MIGRATIONS = new URL('../migrations/', (import.meta as unknown as { url: string }).url)

function plain(row: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return row ? { ...row } : null
}

function returnsRows(sql: string): boolean {
  return /^\s*(SELECT|WITH)\b/i.test(sql) || /\bRETURNING\b/i.test(sql)
}

class FakeStatement {
  db: FakeD1
  sql: string
  params: unknown[]
  constructor(db: FakeD1, sql: string, params: unknown[] = []) {
    this.db = db
    this.sql = sql
    this.params = params
  }
  bind(...params: unknown[]): FakeStatement {
    for (const p of params) if (p === undefined) throw new Error(`D1_TYPE_ERROR: undefined bound in: ${this.sql}`)
    return new FakeStatement(this.db, this.sql, params)
  }
  private stmt(): Statement {
    this.db.queries.push(this.sql)
    return this.db.sqlite.prepare(this.sql)
  }
  async first<T = Record<string, unknown>>(col?: string): Promise<T | null> {
    const row = plain(this.stmt().get(...this.params))
    if (!row) return null
    return (col ? row[col] : row) as T
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const rows = this.stmt().all(...this.params).map((r) => ({ ...r })) as T[]
    return { results: rows, success: true, meta: { changes: 0 } }
  }
  async run(): Promise<{ results: unknown[]; success: true; meta: { changes: number; last_row_id: number } }> {
    return this.exec()
  }
  exec() {
    const s = this.stmt()
    if (returnsRows(this.sql)) {
      const rows = s.all(...this.params).map((r) => ({ ...r }))
      return { results: rows, success: true as const, meta: { changes: rows.length, last_row_id: 0 } }
    }
    const r = s.run(...this.params)
    return { results: [], success: true as const, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }
  }
}

export class FakeD1 {
  sqlite: Database
  /** Every statement run, in order (SQL text only). */
  queries: string[] = []
  constructor() {
    this.sqlite = new DatabaseSync(':memory:')
    for (const f of fs.readdirSync(MIGRATIONS).filter((n) => n.endsWith('.sql')).sort()) this.sqlite.exec(fs.readFileSync(new URL(f, MIGRATIONS), 'utf8'))
  }
  prepare(sql: string): FakeStatement {
    return new FakeStatement(this, sql)
  }
  /** Like D1: all or nothing. */
  async batch(statements: FakeStatement[]) {
    this.sqlite.exec('BEGIN')
    try {
      const out = statements.map((s) => s.exec())
      this.sqlite.exec('COMMIT')
      return out
    } catch (e) {
      this.sqlite.exec('ROLLBACK')
      throw e
    }
  }
  /** Test helper: rows of a table. */
  rows<T = Record<string, unknown>>(table: string, where = '1 = 1', ...params: unknown[]): T[] {
    return this.sqlite.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(...params).map((r) => ({ ...r })) as T[]
  }
  run(sql: string, ...params: unknown[]): void {
    this.sqlite.prepare(sql).run(...params)
  }
}
