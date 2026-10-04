import { Pool } from 'pg';
import { CallRecord, CallStore } from './types';

const COLS = [
  'id', 'twenty_contact_id', 'twenty_object_type', 'contact_name', 'phone_number', 'caller_id', 'telnyx_call_id', 'status', 'disposition',
  'notes', 'started_at', 'ended_at', 'duration_seconds', 'twenty_note_id', 'logged_at', 'last_log_error',
  'session_id', 'rep_email', 'blocked_reasons', 'created_at', 'updated_at',
];

/** Kept in sync with the ALTER TABLE lines in db/schema.sql. */
const ADDED_COLUMNS = ['twenty_object_type TEXT', 'caller_id TEXT'];

const toSnake = (k: string) => k.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase());
const toCamel = (k: string) => k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());

function rowToRecord(row: Record<string, unknown>): CallRecord {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[toCamel(k)] = v instanceof Date ? v.toISOString() : v;
  return out as unknown as CallRecord;
}

/** PostgreSQL store. Schema lives in db/schema.sql (run `npm run db:migrate -w server`). */
export class PostgresStore implements CallStore {
  private pool: Pool;
  private ready: Promise<void>;
  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
    // Columns added after the first deploy. Deploys don't run db:migrate, so add them here
    // (idempotent) before any query selects them — otherwise every calls query would fail.
    this.ready = this.pool
      .query(ADDED_COLUMNS.map((c) => `ALTER TABLE calls ADD COLUMN IF NOT EXISTS ${c}`).join('; '))
      .then(() => undefined)
      .catch((e) => console.error(`[store] could not add new calls columns — run npm run db:migrate -w server: ${e.message}`));
  }

  async create(input: Omit<CallRecord, 'createdAt' | 'updatedAt'>) {
    await this.ready;
    const entries = Object.entries(input);
    const cols = entries.map(([k]) => toSnake(k));
    const vals = entries.map(([k, v]) => (k === 'blockedReasons' && v ? JSON.stringify(v) : v));
    const params = vals.map((_, i) => `$${i + 1}`).join(', ');
    const { rows } = await this.pool.query(
      `INSERT INTO calls (${cols.join(', ')}) VALUES (${params}) RETURNING ${COLS.join(', ')}`,
      vals,
    );
    return rowToRecord(rows[0]);
  }

  async get(id: string) {
    await this.ready;
    const { rows } = await this.pool.query(`SELECT ${COLS.join(', ')} FROM calls WHERE id = $1`, [id]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async update(id: string, patch: Partial<CallRecord>) {
    await this.ready;
    const entries = Object.entries(patch).filter(([k]) => k !== 'id' && k !== 'createdAt');
    if (!entries.length) return (await this.get(id))!;
    const sets = entries.map(([k], i) => `${toSnake(k)} = $${i + 2}`);
    const { rows } = await this.pool.query(
      `UPDATE calls SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${COLS.join(', ')}`,
      [id, ...entries.map(([k, v]) => (k === 'blockedReasons' && v ? JSON.stringify(v) : v))],
    );
    if (!rows[0]) throw new Error(`Call ${id} not found`);
    return rowToRecord(rows[0]);
  }

  async list(opts: { limit?: number; unloggedOnly?: boolean } = {}) {
    await this.ready;
    const where = opts.unloggedOnly ? `WHERE logged_at IS NULL AND status NOT IN ('initiated', 'blocked')` : '';
    const { rows } = await this.pool.query(
      `SELECT ${COLS.join(', ')} FROM calls ${where} ORDER BY created_at DESC LIMIT $1`,
      [opts.limit ?? 50],
    );
    return rows.map(rowToRecord);
  }

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    const { rows } = await this.pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    return rows[0] ? (rows[0].value as T) : null;
  }

  async setSetting<T = unknown>(key: string, value: T): Promise<void> {
    await this.pool.query(
      'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()',
      [key, JSON.stringify(value)],
    );
  }
}
