import { bufToVec, cosine } from './enrich.js';

// Connectivity is a minimum consistency check in the supplied vector space,
// not a claim that all members describe the same event. Missing vectors can
// bridge observed components, so incomplete groups cannot be split safely.
export function analyzeDuplicateGroups(rows, { threshold, dimensions = null, spaceCompatible = true }) {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const grouped = new Map();
  for (const row of rows) {
    if (row.duplicate_of == null) continue;
    let members = grouped.get(row.duplicate_of);
    if (!members) grouped.set(row.duplicate_of, members = new Set([row.duplicate_of]));
    members.add(row.id);
  }
  const result = [];
  for (const [root, memberSet] of grouped) {
    const ids = [...memberSet].sort((a, b) => a - b);
    const vectors = new Map(), unavailable = [];
    let expectedDims = dimensions;
    for (const id of ids) {
      const bytes = byId.get(id)?.embedding;
      if (!bytes?.byteLength || bytes.byteLength % 2) { unavailable.push(id); continue; }
      const vector = bufToVec(bytes);
      expectedDims ??= vector.length;
      let squaredNorm = 0;
      for (const value of vector) squaredNorm += value * value;
      if (vector.length !== expectedDims || !Number.isFinite(squaredNorm) || Math.abs(squaredNorm - 1) > .02) {
        unavailable.push(id); continue;
      }
      vectors.set(id, vector);
    }
    const parent = new Map([...vectors.keys()].map((id) => [id, id]));
    const find = (id) => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root);
      while (id !== root) { const next = parent.get(id); parent.set(id, root); id = next; }
      return root;
    };
    const comparable = [...vectors.keys()];
    let comparisons = 0;
    for (let i = 0; i < comparable.length; i++) {
      for (let j = i + 1; j < comparable.length; j++) {
        comparisons++;
        const a = comparable[i], b = comparable[j];
        if (cosine(vectors.get(a), vectors.get(b)) >= threshold) parent.set(find(b), find(a));
      }
    }
    const componentsByRoot = new Map();
    for (const id of comparable) {
      const representative = find(id);
      let component = componentsByRoot.get(representative);
      if (!component) componentsByRoot.set(representative, component = []);
      component.push(id);
    }
    const components = [...componentsByRoot.values()].sort((a, b) => a[0] - b[0]);
    const invalidStructure = !byId.has(root) || byId.get(root).duplicate_of != null
      || ids.some((id) => id !== root && grouped.has(id));
    const complete = spaceCompatible && !invalidStructure && unavailable.length === 0;
    result.push({
      root, ids, complete, unavailable, invalidStructure, comparisons, components,
      verdict: !complete ? 'unmeasurable' : components.length === 1 ? 'connected' : 'disconnected',
    });
  }
  return result.sort((a, b) => a.root - b.root);
}

export function inspectDuplicateGroups(db, options) {
  const rows = db.prepare(`SELECT id, duplicate_of, embedding FROM articles
    WHERE duplicate_of IS NOT NULL OR id IN
      (SELECT duplicate_of FROM articles WHERE duplicate_of IS NOT NULL)`).all();
  return analyzeDuplicateGroups(rows, options);
}

/** Analyze and split only fully comparable disconnected groups atomically. */
export function repairDisconnectedGroups(db, options) {
  return db.transaction(() => {
    const groups = inspectDuplicateGroups(db, options);
    const update = db.prepare('UPDATE articles SET duplicate_of = ? WHERE id = ? AND duplicate_of IS NOT ?');
    let splitGroups = 0, changedLinks = 0;
    for (const group of groups) {
      if (group.verdict !== 'disconnected') continue;
      splitGroups++;
      for (const component of group.components) {
        const root = component.includes(group.root) ? group.root : component[0];
        for (const id of component) {
          const parent = id === root ? null : root;
          changedLinks += update.run(parent, id, parent).changes;
        }
      }
    }
    return { groups, splitGroups, changedLinks };
  })();
}
