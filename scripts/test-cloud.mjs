import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// These checks use mock page state or inspect source. They do not start the
// Windows app, connect to a browser, or require the .NET SDK.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = [
  'tests/approval-count.test.mjs',
  'tests/fieldtrip-report-navigation.test.mjs',
  'tests/fieldtrip-report-preparation.test.mjs',
  'tests/fieldtrip-report-reader.test.mjs',
  'tests/mainform-session-isolation.test.mjs',
  'tests/nice-session.test.mjs',
  'tests/portal-session.test.mjs',
  'tests/power-request-definition.test.mjs',
  'tests/session-state-detection.test.mjs',
  'tests/session-timing.test.mjs',
  'tests/student-management-navigation.test.mjs',
];

console.log('Cloud checks: Node-only subset; Windows and .NET runtime checks are not included.');
const result = spawnSync(process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  { cwd: root, stdio: 'inherit' });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
