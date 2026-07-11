// Prefixes console output with an ISO8601 timestamp, so cron/serve output
// can be ordered and correlated across runs and concurrent processes.
export function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

export function logError(...args) {
  console.error(new Date().toISOString(), ...args);
}
