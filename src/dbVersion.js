// A cache token is meaningful only on the same connection. data_version
// catches commits by other connections; total_changes catches our writes,
// including equal-sized BLOB replacements and vote changes with equal sums.
// It deliberately over-invalidates on unrelated writes and rolled-back work.
// No application-specific write path has to remember to invalidate a cache.
const statements = new WeakMap();

export function databaseVersion(db) {
  let statement = statements.get(db);
  if (!statement) {
    statement = db.prepare(`
      SELECT data_version, CAST(total_changes() AS TEXT) AS changes
      FROM pragma_data_version
    `);
    statements.set(db, statement);
  }
  const row = statement.get();
  return `${row.data_version}:${row.changes}`;
}
