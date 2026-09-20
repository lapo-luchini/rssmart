import { readFileSync } from 'node:fs';
import vm from 'node:vm';

export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const page = id => ({ articles: [{ id }], total: 10, nextCursor: `cursor-${id}` });
export function app(box = { count: 0, issue: null, project: article => ({ ...article }), flush: async () => [] }) {
  let definition; const timers = [];
  const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
  vm.runInNewContext(source, {
    navigator: {}, window: { matchMedia: () => ({ matches: false }) }, URLSearchParams, AbortController,
    setTimeout: fn => { timers.push(fn); return timers.length; }, clearTimeout() {},
    createOutbox: () => box, createApp: value => { definition = value; return { mount() {} }; },
  });
  const ctx = definition.data();
  for (const [name, fn] of Object.entries(definition.methods)) ctx[name] = fn.bind(ctx);
  for (const [name, fn] of Object.entries(definition.computed)) Object.defineProperty(ctx, name, { get: () => fn.call(ctx) });
  ctx.loadSidebarData = () => {}; ctx.syncHash = () => {};
  return { ctx, definition, timers };
}
