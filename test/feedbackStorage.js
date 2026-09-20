// Match Storage's independent named values; a one-value stub conceals
// cross-version clobbering and cannot exercise migrations between keys.
export function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: key => values.get(String(key)) ?? null,
    setItem: (key, value) => { values.set(String(key), String(value)); },
    removeItem: key => { values.delete(String(key)); },
  };
}
