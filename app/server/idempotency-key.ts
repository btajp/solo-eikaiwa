/** UUID等のclient生成request IDを受ける、ログやSQLへ安全に載せられる固定形式。 */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(value);
}
