import type { Parameter, Sql, TransactionSql } from "postgres";

type TimestampSql = Pick<Sql | TransactionSql, "typed">;

// Postgres.js normally infers Date values automatically. Explicitly binding the
// timestamp type keeps that behavior reliable through hosted connection poolers.
export function timestamp(sql: TimestampSql, value: Date): Parameter<string> {
  return sql.typed(value.toISOString(), 1184);
}
