import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { hashDirectory, buildFingerprint, sha256 } from './artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = name => fs.readFile(path.join(root, name));
const json = async name => JSON.parse((await read(name)).toString('utf8'));
const manifest = await json('dist/manifest.json');
assert.equal(manifest.version, (await json('package.json')).version);
assert.equal(manifest.version, (await json('package-lock.json')).version);
assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'webNavigation', 'declarativeNetRequestWithHostAccess', 'contextMenus', 'sidePanel', 'nativeMessaging']);
assert.equal(manifest.host_permissions, undefined);
assert.equal(manifest.web_accessible_resources, undefined);
const files = await hashDirectory(path.join(root, 'dist'));
const fingerprint = buildFingerprint(files);
const archivePath = `release/reading-assistant-${manifest.version}.zip`;
const archiveBytes = await read(archivePath);
const archive = unzipSync(archiveBytes);
assert.deepEqual(Object.keys(archive).sort(), Object.keys(files).sort());
for (const [name, bytes] of Object.entries(archive)) {
  assert.equal(sha256(bytes), files[name].sha256, `Packaged extension differs: ${name}`);
  for (const marker of ['siwc-synthetic-access-token-DO-NOT-USE', '__siwcUiHarness', 'fixture-access-token']) assert.ok(!Buffer.from(bytes).toString().includes(marker), `Test credential or hook in production: ${name}`);
}
const ui = await json('test-results/siwc-ui/report.json');
assert.equal(ui.version, manifest.version); assert.equal(ui.mockOnly, true); assert.equal(ui.realModelVerified, false);
assert.equal(ui.testedBuild.fingerprint, fingerprint); assert.ok(ui.checks.length >= 9); assert.ok(ui.checks.every(item => item.result === 'pass')); assert.deepEqual(ui.unexpectedNetwork, []);
if (['0.11.0', '0.12.0', '0.12.1', '0.13.0'].includes(manifest.version)) {
  assert.ok(ui.checks.length >= 20);
  for (const feature of ['automatic search has no manual switch', 'actual search metadata', 'source metadata rejects', 'search interruption remains explicit']) assert.ok(ui.checks.some(item => item.name.includes(feature) && item.result === 'pass'), `Missing automatic search check: ${feature}`);
}
if (['0.12.0', '0.12.1', '0.13.0'].includes(manifest.version)) {
  assert.ok(ui.checks.length >= 25);
  for (const feature of ['response details are collapsed', 'hostile or invalid detail fields', 'response details preserve their disclosure', 'response details and unsent draft', 'expanded response details retain source placement']) assert.ok(ui.checks.some(item => item.name.includes(feature) && item.result === 'pass'), `Missing response details check: ${feature}`);
}
const sidebarPath = `test-results/sidebar-e2e-report-${manifest.version}.json`;
const sidebar = await json(sidebarPath);
assert.equal(sidebar.extensionVersion, manifest.version); assert.equal(sidebar.mockOnly, true); assert.equal(sidebar.realModelVerified, false);
assert.equal(sidebar.testedBuild.fingerprint, fingerprint); assert.equal(sidebar.testedBuild.unchangedAfterTest, true);
assert.equal(sidebar.failed, 0); assert.equal(sidebar.passed, manifest.version === '0.13.0' ? 17 : 16);
if (manifest.version === '0.13.0') {
  assert.ok(ui.checks.length >= 28);
  assert.equal(sidebar.coverage?.twoProviderConnectionSave, true);
  assert.ok(sidebar.checks.some(check => check.name.includes('actual settings switches an OAuth model') && check.result === 'pass'));
  for (const name of ['webchat-content.js', 'webchat-page-content.js', 'webchat-native-client.js']) assert.equal(files[name], undefined, `Retired website script packaged: ${name}`);
  const background = (await read('dist/background.js')).toString();
  for (const marker of ['/backend-api/', 'reader-chatgpt-web', 'reader-chatgpt-page']) assert.ok(!background.includes(marker), `Retired website runtime packaged: ${marker}`);
  const settingsPage = (await read('dist/options.html')).toString();
  assert.ok(!settingsPage.includes('id="connection-web"'));
  assert.ok(!settingsPage.includes('id="webchat-details"'));
}
const reload = await json('test-results/content-reload/report.json');
assert.equal(reload.mockOnly, true); assert.equal(reload.actualExtensionReloadVerified, false); assert.equal(reload.checks.length, 9); assert.equal(reload.passed, 9);
assert.equal(reload.sourceBundledInMemory, true); assert.equal(reload.distModified, false); assert.ok(reload.checks.every(item => item.result === 'pass')); assert.deepEqual(reload.unexpectedNetwork, []);
const actualReloadPath = `test-results/content-extension-reload/${manifest.version}.json`;
let actualReload;
try { actualReload = await json(actualReloadPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (actualReload) {
  assert.equal(actualReload.version, manifest.version); assert.equal(actualReload.mockOnly, true);
  assert.equal(actualReload.actualExtensionReloadVerified, true); assert.equal(actualReload.actualRetiredContextVerified, true);
  assert.equal(actualReload.expectedBaselineFailure, false); assert.equal(actualReload.realAccountVerified, false); assert.equal(actualReload.realModelVerified, false);
  assert.equal(actualReload.error, undefined); assert.ok(actualReload.checks.length >= 4); assert.equal(actualReload.passed, actualReload.checks.length);
  assert.ok(actualReload.checks.every(item => item.result === 'pass')); assert.equal(actualReload.modelRequests, 0);
  assert.deepEqual(actualReload.exceptions, []); assert.deepEqual(actualReload.pageErrors, []); assert.deepEqual(actualReload.unexpectedNetwork, []);
  assert.equal(actualReload.testedBuild.fingerprint, fingerprint); assert.equal(actualReload.testedBuild.testCopyRestored, true); assert.equal(actualReload.testedBuild.unchangedAfterTest, true);
}
const reconnectPath = `test-results/sidebar-reconnect/${manifest.version}.json`;
let reconnect;
try { reconnect = await json(reconnectPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (reconnect) {
  assert.equal(reconnect.version, manifest.version); assert.equal(reconnect.extensionVersion, manifest.version); assert.equal(reconnect.baseline, false);
  assert.equal(reconnect.mockOnly, true); assert.equal(reconnect.realModelVerified, false); assert.equal(reconnect.fatal, undefined);
  assert.equal(reconnect.actualWorkerStopVerified, true); assert.equal(reconnect.actualPortDisconnectVerified, true); assert.equal(reconnect.autoResendRequests, 0);
  assert.ok(reconnect.checks.length >= 5); assert.equal(reconnect.failed, 0); assert.equal(reconnect.passed, reconnect.checks.length); assert.ok(reconnect.checks.every(item => item.result === 'pass'));
  assert.deepEqual(reconnect.unexpectedNetwork, []);
  assert.ok(reconnect.network.every(item => { const url = new URL(item.url); return url.protocol === 'http:' && url.hostname === '127.0.0.1'; }), 'Reconnect fixture made a request outside literal loopback HTTP');
  assert.equal(reconnect.testedBuild.fingerprint, fingerprint); assert.deepEqual(reconnect.testedBuild.files, files);
  assert.equal(reconnect.testedBuild.unchangedAfterTest, true); assert.equal(reconnect.testedBuild.testCopyRestored, true);
  for (const key of ['isolatedChromiumProfile', 'productionWorkerWithoutTestEntry', 'testCopyRestored', 'trustedShellFormsAndButtonClicks', 'realRuntimePorts', 'noRealHelperOrAccount']) assert.equal(reconnect.testHarness[key], true, `Reconnect harness boundary: ${key}`);
  assert.equal(reconnect.testHarness.productionSourceModified, false); assert.equal(reconnect.testHarness.mockedRuntimePorts, false); assert.equal(reconnect.testHarness.nativeSidePanelSurfaceVerified, false);
  for (const key of ['actualWorkerStop', 'sameDocument', 'automaticReconnect', 'draftPreserved', 'noAutomaticModelRetry', 'interruptedStream', 'productionBytesUnchanged']) assert.equal(reconnect.coverage[key], true, `Reconnect coverage: ${key}`);
}
const unitLog = (await read(`test-results/unit-${manifest.version}.log`)).toString('utf8');
assert.match(unitLog, /ℹ fail 0\b/);
if (manifest.version === '0.12.1') assert.match(unitLog, /a greeting survives metadata-only completion without Content-Type/);
const passed = Number(unitLog.match(/ℹ pass (\d+)/)?.[1]); assert.ok(passed >= 340);
const helperPath = `release/yuechuang-helper-${manifest.version}.zip`;
const helperBytes = await read(helperPath);
const helper = unzipSync(helperBytes);
const checksums = JSON.parse(Buffer.from(helper['checksums.json']).toString('utf8'));
for (const item of checksums) { assert.ok(helper[item.file]); assert.equal(helper[item.file].length, item.bytes); assert.equal(sha256(helper[item.file]), item.sha256); }
assert.equal(sha256(helper['yuechuang-helper.exe']), sha256(await read('helper/bin/yuechuang-helper.exe')));
assert.ok(!Object.keys(helper).some(name => /credentials|helper-config/.test(name)), 'User credentials or bound installation config in package');
const directory = path.join(root, 'docs', '验收证据', manifest.version);
await fs.mkdir(directory, { recursive: true });
for (const name of ['test-results/siwc-ui/report.json', 'test-results/content-reload/report.json', sidebarPath, `test-results/unit-${manifest.version}.log`]) {
  const target = name.includes('siwc-ui') ? 'siwc-ui-report.json' : name.includes('content-reload') ? 'content-reload-report.json' : path.basename(name);
  await fs.copyFile(path.join(root, name), path.join(directory, target));
}
if (actualReload) await fs.copyFile(path.join(root, actualReloadPath), path.join(directory, 'content-extension-reload-report.json'));
if (reconnect) await fs.copyFile(path.join(root, reconnectPath), path.join(directory, 'sidebar-reconnect-report.json'));
const result = { version: manifest.version, verifiedAt: new Date().toISOString(), mode: 'trial-package-and-mock-validation', files, buildFingerprint: fingerprint,
  extensionArchive: { path: archivePath, bytes: archiveBytes.length, sha256: sha256(archiveBytes) },
  helperArchive: { path: helperPath, bytes: helperBytes.length, sha256: sha256(helperBytes), executableBytes: helper['yuechuang-helper.exe'].length, executableSha256: sha256(helper['yuechuang-helper.exe']) },
  checks: { unit: passed, siwcUiMock: ui.checks.length, sidebarMock: sidebar.passed, contentReloadMock: reload.checks.length, contentExtensionReload: actualReload?.checks.length ?? null, sidebarReconnect: reconnect?.checks.length ?? null },
  actualExtensionReloadVerified: Boolean(actualReload),
  ...(actualReload ? { contentExtensionReload: { path: actualReloadPath, fingerprint: actualReload.testedBuild.fingerprint, actualRetiredContextVerified: true, modelRequests: 0, scope: 'isolated Chromium MV3 extension reload against loopback fixtures; user Chrome and real account not exercised' } } : {}),
  actualSidebarReconnectVerified: Boolean(reconnect),
  ...(reconnect ? { sidebarReconnect: { path: reconnectPath, fingerprint: reconnect.testedBuild.fingerprint, actualWorkerStopVerified: true, actualPortDisconnectVerified: true, autoResendRequests: 0, scope: 'isolated Chromium CDP worker stop and real Port disconnect; extension-tab sidepanel with loopback model fixture, no real helper/account or native docked sidepanel' } } : {}),
  realAccountVerified: false, realModelVerified: false,
  pending: ['Live side panel completed response with all ChatGPT tabs closed', 'Real multi-turn continuation and helper idle process acceptance', 'User source-page content lifecycle acceptance', 'User Chrome sidepanel recovery after refreshing helper state', 'Actual account automatic web search and citations', 'Actual account returned model and token usage in response details'] };
await fs.writeFile(path.join(directory, 'siwc-trial-verification.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(`Trial ${manifest.version}: ZIP matches built and browser-tested extension; helper payload checksums verified. ${passed} unit checks, ${ui.checks.length} SIWC UI, ${sidebar.passed} sidebar, ${reload.checks.length} reload mock checks passed. ${actualReload ? `${actualReload.checks.length} isolated real MV3 reload checks passed.` : 'Optional real MV3 reload report is absent.'} ${reconnect ? `${reconnect.checks.length} isolated real-worker sidebar reconnect checks passed.` : 'Optional real-worker sidebar reconnect report is absent.'} Live model acceptance is pending.\n`);
