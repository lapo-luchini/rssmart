import { pragma } from './db.js';

// A browser's vote and read operations share one contiguous sequence per
// article. A later read cannot overtake a missing vote (which itself marks
// read). Keep receipts across restarts: repeating a SET must not re-date it.
export function applyFeedback(db, id, operation, value, mutation, apply) {
  if (mutation !== undefined && (!mutation ||
      typeof mutation.clientId !== 'string' ||
      !/^[A-Za-z0-9_-]{8,128}$/.test(mutation.clientId ?? '') ||
      !Number.isSafeInteger(mutation.sequence) || mutation.sequence < 1)) {
    return { status: 400, error: 'invalid feedback mutation' };
  }
  const synchronous = pragma(db, 'synchronous').synchronous;
  pragma(db, 'synchronous = FULL');
  try {
    return db.transaction(() => {
      if (!db.prepare('SELECT id FROM articles WHERE id = ?').get(id)) {
        return { status: 404, error: 'not found' };
      }
      if (mutation) {
        const { clientId, sequence } = mutation;
        const receipt = db.prepare(`SELECT operation, value FROM feedback_receipts
          WHERE client_id = ? AND article_id = ? AND sequence = ?`).get(clientId, id, sequence);
        if (receipt) {
          if (receipt.operation !== operation || receipt.value !== value) {
            return { status: 409, error: 'feedback mutation was reused with different content' };
          }
          return { applied: false };
        }
        const last = db.prepare(`SELECT MAX(sequence) AS sequence FROM feedback_receipts
          WHERE client_id = ? AND article_id = ?`).get(clientId, id).sequence ?? 0;
        if (sequence !== last + 1) {
          return { status: 409, error: 'feedback sequence gap', expectedSequence: last + 1 };
        }
      }
      apply();
      if (mutation) {
        db.prepare(`INSERT INTO feedback_receipts (client_id, article_id, sequence, operation, value)
          VALUES (?, ?, ?, ?, ?)`).run(mutation.clientId, id, mutation.sequence, operation, value);
      }
      return { applied: true };
    })();
  } finally {
    pragma(db, `synchronous = ${synchronous}`);
  }
}
