import type { Database } from "bun:sqlite";

type ColumnContract = {
  name: string;
  type: string;
  notNull: number;
  defaultValue: string | null;
  primaryKey: number;
};

type IndexContract = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
  columns: Array<string | null>;
};

type TableContract = {
  columns: ColumnContract[];
  indexes: IndexContract[];
};

export type SchemaContract = Map<string, TableContract>;

type TableRow = { name: string };
type SchemaObjectRow = { type: string };
type ColumnRow = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};
type IndexRow = {
  name: string;
  unique: number;
  origin: string;
  partial: number;
};
type IndexColumnRow = { name: string | null };

function columnsOf(db: Database, table: string): ColumnContract[] {
  return db.query<ColumnRow, [string]>(`
    SELECT name, type, "notnull", dflt_value, pk
    FROM pragma_table_info(?)
    ORDER BY cid
  `).all(table).map((column) => ({
    name: column.name,
    type: column.type.trim().toUpperCase(),
    notNull: column.notnull,
    defaultValue: column.dflt_value,
    primaryKey: column.pk,
  }));
}

function indexesOf(db: Database, table: string): IndexContract[] {
  const indexes = db.query<IndexRow, [string]>(`
    SELECT name, "unique", origin, partial
    FROM pragma_index_list(?)
    ORDER BY seq
  `).all(table);
  return indexes.map((index) => ({
    name: index.name,
    unique: index.unique,
    origin: index.origin,
    partial: index.partial,
    columns: db.query<IndexColumnRow, [string]>(`
      SELECT name FROM pragma_index_info(?) ORDER BY seqno
    `).all(index.name).map((column) => column.name),
  }));
}

export function readSchemaContract(db: Database): SchemaContract {
  const tables = db.query<TableRow, []>(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all();
  return new Map(tables.map(({ name }) => [name, {
    columns: columnsOf(db, name),
    indexes: indexesOf(db, name),
  }]));
}

function formatColumn(column: ColumnContract): string {
  return [
    `type=${column.type || "(empty)"}`,
    `notnull=${column.notNull}`,
    `default=${column.defaultValue ?? "null"}`,
    `pk=${column.primaryKey}`,
  ].join(", ");
}

function formatIndex(index: IndexContract): string {
  return [
    `unique=${index.unique}`,
    `origin=${index.origin}`,
    `partial=${index.partial}`,
    `columns=[${index.columns.map((name) => name ?? "(expression)").join(", ")}]`,
  ].join(", ");
}

function findMismatches(db: Database, expected: SchemaContract): string[] {
  const mismatches: string[] = [];
  for (const [tableName, table] of expected) {
    const object = db.query<SchemaObjectRow, [string]>(
      "SELECT type FROM sqlite_schema WHERE name = ? LIMIT 1",
    ).get(tableName);
    if (!object) continue;
    if (object.type !== "table") {
      mismatches.push(`${tableName} — 期待: table; 実際: ${object.type}`);
      continue;
    }

    const actualColumns = new Map(columnsOf(db, tableName).map((column) => [column.name, column]));
    for (const expectedColumn of table.columns) {
      const actualColumn = actualColumns.get(expectedColumn.name);
      const target = `${tableName}.${expectedColumn.name}`;
      if (!actualColumn) {
        mismatches.push(`${target} — 期待: ${formatColumn(expectedColumn)}; 実際: missing`);
      } else if (formatColumn(actualColumn) !== formatColumn(expectedColumn)) {
        mismatches.push(
          `${target} — 期待: ${formatColumn(expectedColumn)}; 実際: ${formatColumn(actualColumn)}`,
        );
      }
    }

    const actualIndexes = new Map(indexesOf(db, tableName).map((index) => [index.name, index]));
    for (const expectedIndex of table.indexes) {
      const actualIndex = actualIndexes.get(expectedIndex.name);
      const target = `${tableName}.${expectedIndex.name}`;
      if (!actualIndex) {
        mismatches.push(`${target} — 期待: ${formatIndex(expectedIndex)}; 実際: missing`);
      } else if (formatIndex(actualIndex) !== formatIndex(expectedIndex)) {
        mismatches.push(
          `${target} — 期待: ${formatIndex(expectedIndex)}; 実際: ${formatIndex(actualIndex)}`,
        );
      }
    }
  }
  return mismatches;
}

export class SchemaCompatibilityError extends Error {
  constructor(
    public readonly dbPath: string,
    public readonly mismatches: string[],
  ) {
    super([
      `データベースのスキーマに互換性がありません: ${dbPath}`,
      ...mismatches.map((mismatch) => `- ${mismatch}`),
      "",
      "安全のため、このDBには書き込みを行っていません。",
      "非破壊の復旧手順:",
      "1. アプリを終了してください。",
      `2. ${dbPath} と、存在する場合は同名の -wal / -shm ファイルをバックアップしてください。`,
      "3. 互換性のあるアプリ版で開くか、バックアップの複製を使って修復してください。元のDBは変更・削除しないでください。",
    ].join("\n"));
    this.name = "SchemaCompatibilityError";
  }
}

export function assertSchemaCompatible(
  db: Database,
  dbPath: string,
  expected: SchemaContract,
): void {
  const mismatches = findMismatches(db, expected);
  if (mismatches.length > 0) throw new SchemaCompatibilityError(dbPath, mismatches);
}
