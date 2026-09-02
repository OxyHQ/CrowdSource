import postgres, { type Row } from 'postgres';

/**
 * Privileged test-only controls for proving that an RLS-filtered absence is not
 * a physically absent row. The URL belongs to the disposable global fixture;
 * this module refuses every other target and opens a bounded one-shot client so
 * global teardown can always drop the database.
 */

const TABLES = {
  audit_events: 'audit_events',
  cases: 'cases',
  outbox_events: 'outbox_events',
  reports: 'reports',
  reviewer_relations: 'reviewer_relations',
} as const;

type TableName = keyof typeof TABLES;
type Filter = Readonly<Record<string, unknown>>;

const FIELD_OVERRIDES: Readonly<Partial<Record<TableName, Readonly<Record<string, string>>>>> = {
  cases: { externalSubjectId: 'subject_external_id' },
};

function snakeToCamel(key: string): string {
  return key.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());
}

function normalizeRow(row: Row): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [snakeToCamel(key), value]));
}

function assertField(table: TableName, field: string): readonly [string, string?] {
  const [column, nested, ...rest] = field.split('.');
  if (!column || rest.length > 0 || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(column)) {
    throw new Error(`Unsafe PostgreSQL control field '${field}'.`);
  }
  if (nested !== undefined && !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(nested)) {
    throw new Error(`Unsafe PostgreSQL JSON field '${field}'.`);
  }
  return [
    FIELD_OVERRIDES[table]?.[column]
      ?? column.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    nested,
  ];
}

function migratorUrl(): string {
  const value = process.env.CROWDSOURCE_BACKEND_TEST_MIGRATOR_URL;
  if (!value) {
    throw new Error('The disposable PostgreSQL control URL is unset; refusing an unscoped query.');
  }
  return value;
}

async function withControl<T>(operation: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(migratorUrl(), { max: 1, connection: { statement_timeout: 2_000 } });
  try {
    return await operation(sql);
  } finally {
    await sql.end();
  }
}

interface Predicate {
  readonly text: string;
  readonly values: readonly unknown[];
}

function predicate(table: TableName, filter: Filter): Predicate {
  const values: unknown[] = [];
  const clauses = Object.entries(filter).map(([field, expected]) => {
    const [column, nested] = assertField(table, field);
    const quoted = `"${column}"`;
    let left = quoted;
    if (nested !== undefined) {
      values.push(nested);
      left = `${quoted} ->> $${values.length}`;
    }
    if (expected && typeof expected === 'object' && !Array.isArray(expected) && '$in' in expected) {
      const options = (expected as { readonly $in: readonly unknown[] }).$in;
      if (options.length === 0) return 'false';
      const placeholders = options.map((option) => {
        values.push(option);
        return `$${values.length}`;
      });
      return `${left} in (${placeholders.join(', ')})`;
    }
    if (expected === null) return `${left} is null`;
    values.push(expected);
    return `${left} = $${values.length}`;
  });
  return { text: clauses.length === 0 ? 'true' : clauses.join(' and '), values };
}

class ControlCursor {
  #sort: Readonly<Record<string, 1 | -1>> | undefined;

  constructor(
    private readonly table: TableName,
    private readonly filter: Filter,
  ) {}

  sort(order: Readonly<Record<string, 1 | -1>>): this {
    this.#sort = order;
    return this;
  }

  async toArray(): Promise<Record<string, unknown>[]> {
    return withControl(async (sql) => {
      const where = predicate(this.table, this.filter);
      const ordering = Object.entries(this.#sort ?? {}).map(([field, direction]) => {
        const [column, nested] = assertField(this.table, field);
        if (nested !== undefined) throw new Error('Nested JSON sorting is not supported by the control.');
        return `"${column}" ${direction === -1 ? 'desc' : 'asc'}`;
      });
      const orderBy = ordering.length === 0 ? '' : ` order by ${ordering.join(', ')}`;
      const rows = await sql.unsafe(
        `select * from "${TABLES[this.table]}" where ${where.text}${orderBy}`,
        where.values as never[],
      );
      return rows.map(normalizeRow);
    });
  }
}

class ControlCollection {
  constructor(private readonly table: TableName) {}

  find(filter: Filter): ControlCursor {
    return new ControlCursor(this.table, filter);
  }

  async findOne(filter: Filter): Promise<Record<string, unknown> | null> {
    const [row] = await this.find(filter).toArray();
    return row ?? null;
  }

  async countDocuments(filter: Filter): Promise<number> {
    return withControl(async (sql) => {
      const where = predicate(this.table, filter);
      const [row] = await sql.unsafe<{ count: number }[]>(
        `select count(*)::integer as count from "${TABLES[this.table]}" where ${where.text}`,
        where.values as never[],
      );
      return row?.count ?? 0;
    });
  }
}

export const postgresControl = {
  collection(name: TableName): ControlCollection {
    return new ControlCollection(name);
  },
};
