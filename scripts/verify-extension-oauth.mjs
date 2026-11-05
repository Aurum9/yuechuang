import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { hashDirectory, buildFingerprint, sha256 } from './artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFile(path.join(root, name));
const json = async name => JSON.parse((await read(name)).toString());
const manifest = await json('dist/manifest.json'), pkg = await json('package.json');
assert.equal(manifest.version, pkg.version);
assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'webNavigation', 'declarativeNetRequestWithHostAccess', 'contextMenus', 'sidePanel', 'alarms']);
assert.equal(manifest.host_permissions, undefined);
const files = await hashDirectory(path.join(root, 'dist')), fingerprint = buildFingerprint(files);
const archivePath = `release/reading-assistant-${manifest.version}.zip`, archiveBytes = await read(archivePath), archive = unzipSync(archiveBytes);
assert.deepEqual(Object.keys(archive).sort(), Object.keys(files).sort());
for (const [name, bytes] of Object.entries(archive)) {
  assert.ok(!name.startsWith('/') && !name.split('/').includes('..'));
  assert.deepEqual(Buffer.from(bytes), await read(`dist/${name}`));
  const text = Buffer.from(bytes).toString();
  for (const forbidden of ['connectNative', 'com.yuechuang.helper', 'e2e-synthetic-access', 'e2e-synthetic-refresh', 'siwc-synthetic-access-token-DO-NOT-USE']) assert.ok(!text.includes(forbidden), `Forbidden runtime/test marker in ${name}: ${forbidden}`);
  assert.ok(!/credentials\.bin|helper-config\.json|\.exe$/.test(name));
}
const auth = await json('test-results/siwc-auth/report.json'), ui = await json('test-results/siwc-ui/report.json');
const sidebar = await json(`test-results/sidebar-e2e-report-${manifest.version}.json`);
for (const report of [auth, ui, sidebar]) {
  assert.equal(report.version ?? report.extensionVersion, manifest.version);
  assert.equal(report.mockOnly, true); assert.equal(report.realModelVerified, false);
  assert.equal(report.testedBuild.fingerprint, fingerprint); assert.equal(report.testedBuild.unchangedAfterTest, true);
  assert.ok(!report.fatal); assert.equal(report.error, undefined); assert.ok(report.checks.every(c => c.result === 'pass'));
}
assert.ok(auth.passed >= 6); assert.equal(auth.failed, 0); assert.equal(auth.actualWorkerStopVerified, true); assert.equal(auth.testedBuild.testCopyRestored, true); assert.deepEqual(auth.unexpectedNetwork, []);
assert.equal(auth.actualExecutionContextResetVerified, true);
assert.ok(ui.checks.some(c => c.name.includes('no helper installer') && c.result === 'pass'));
assert.equal(sidebar.failed, 0); assert.ok(sidebar.passed >= 16);
const unit = (await read(`test-results/unit-${manifest.version}.log`)).toString();
assert.match(unit, /(?:#|ℹ) fail 0\b/);
const passed = Number(unit.match(/(?:#|ℹ) pass (\d+)/)?.[1]); assert.ok(passed >= 411);
const result = { version: manifest.version, verifiedAt: new Date().toISOString(), buildFingerprint: fingerprint, files,
  archive: { path: archivePath, bytes: archiveBytes.length, sha256: sha256(archiveBytes) },
  checks: { unit: passed, browserAuth: auth.passed, ui: ui.checks.length, sidebar: sidebar.passed, nativeMessagingRemoved: true, zipMatchesDist: true },
  realAccountVerified: false, realModelVerified: false, pending: ['Live OpenAI account authorization and inference', 'Windows and macOS real-account acceptance', 'Native permission dialog'] };
const directory = path.join(root, 'docs', '验收证据', manifest.version); await fs.mkdir(directory, { recursive: true });
await fs.writeFile(path.join(directory, 'extension-oauth-verification.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`Verified ${manifest.version}: ${passed} unit checks, ${auth.passed} real MV3 OAuth fixture checks, ${ui.checks.length} UI checks, ${sidebar.passed} sidebar checks. ZIP matches current tested dist; no helper. Live account acceptance remains pending.\n`);
