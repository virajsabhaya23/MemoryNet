// Evaluator-only behavioral oracle for a synthetic task; freeze before dispatching agents.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const target = process.argv[2];
if (!target) throw new Error('Pass an agent-produced retry-policy.mjs');
const { shouldRetry } = await import(pathToFileURL(resolve(target)).href);
assert.equal(typeof shouldRetry, 'function');
let cases = 0;
// Exhaust the valid HTTP status domain and several retry counts, including the decision boundary.
for (let status = 100; status <= 599; status++) {
  for (const retries of [0, 1, 2, 3, 10, Number.MAX_SAFE_INTEGER]) {
    assert.strictEqual(shouldRetry(status, retries), status === 503 && retries < 2, `status=${status}, retries=${retries}`);
    cases++;
  }
}
for (const invalid of [undefined, null, '503', {}, [], NaN, Infinity, -1, 99, 600, 503.5]) {
  assert.strictEqual(shouldRetry(invalid, 0), false); cases++;
}
for (const invalid of [undefined, null, '0', {}, [], NaN, Infinity, -1, 0.5]) {
  assert.strictEqual(shouldRetry(503, invalid), false); cases++;
}
console.log(JSON.stringify({ oracle: 'retry-policy-v1', passed: true, cases }));
