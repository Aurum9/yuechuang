import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { unzipSync } from 'fflate';
import { hashDirectory, buildFingerprint, sha256 } from './artifact-hashes.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(root, 'dist', 'manifest.json'), 'utf8'));
if (manifest.permissions.includes('alarms') && !manifest.permissions.includes('nativeMessaging')) {
  await import('./verify-extension-oauth.mjs');
  process.exit(0);
}
if (manifest.permissions.includes('nativeMessaging')) {
  await import('./verify-siwc-trial.mjs');
  process.exit(0);
}
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
const contextualReading = manifest.permissions.includes('contextMenus');
const selectionToolbar = contextualReading && manifest.version !== '0.3.0';
const evidenceDirectory = path.join(root, 'docs', '验收证据', manifest.version);
const evidencePrefix = `docs/验收证据/${manifest.version}`;
const dist = await hashDirectory(path.join(root, 'dist'));
const phraseCollection = !!dist['phrases.html'];
const research = !!dist['research.html'];
const sidebar = !!dist['sidepanel.html'];
const markdownChat = !!dist['MARKED-LICENSE.txt'];
const webChat = !!dist['webchat-content.js'];
const pageChat = !!dist['webchat-page-content.js'];
const nativeWebapp = !!dist['webchat-native-client.js'];
const runtimeDiscovery = nativeWebapp && manifest.version !== '0.9.0';
const connectionDiagnostics = Object.keys(dist).some(name => name.startsWith('assets/webchat-status-ui-'));
const fingerprint = buildFingerprint(dist);
const archivePath = `release/reading-assistant-${manifest.version}.zip`;
const archiveBytes = await readFile(path.join(root, archivePath));
const archive = unzipSync(archiveBytes);
assert.deepEqual(Object.keys(archive).sort(), Object.keys(dist).sort(), 'ZIP and dist contain different files');
for (const [name, bytes] of Object.entries(archive)) {
  assert.ok(!name.startsWith('/') && !name.split('/').includes('..'), 'Unsafe archive path');
  assert.deepEqual(Buffer.from(bytes), await readFile(path.join(root, 'dist', name)), `${name} differs from ZIP`);
  assert.ok(!Buffer.from(bytes).toString().includes('m1-local-mock-key-do-not-use-with-real-service'), `Test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('m2-local-mock-key-do-not-use-with-real-service'), `M2 test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('phrases-local-mock-key-do-not-use-with-real-service'), `Phrase test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('research-local-mock-key-do-not-use-with-real-service'), `Research test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('sidebar-local-mock-key-do-not-use-with-real-service'), `Sidebar test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('mock-openai-session-token-do-not-use'), `Web chat test credential in ${name}`);
  for (const marker of ['fixture-session-secret-NOT-REAL', 'fixture-requirements-secret-NOT-REAL', 'fixture-proof-secret-NOT-REAL']) assert.ok(!Buffer.from(bytes).toString().includes(marker), `Webapp test credential in ${name}`);
  assert.ok(!Buffer.from(bytes).toString().includes('__contextE2EDispatch'), `Test-only menu dispatch in ${name}`);
}
assert.deepEqual(JSON.parse(Buffer.from(archive['manifest.json']).toString()), manifest);
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ['storage', 'scripting', 'webNavigation', 'declarativeNetRequestWithHostAccess', ...(contextualReading ? ['contextMenus'] : []), ...(sidebar ? ['sidePanel'] : [])]);
assert.equal(manifest.host_permissions, undefined, 'Release unexpectedly requires site permissions on install');
assert.ok(archive[manifest.background.service_worker]);
assert.ok(archive[manifest.options_page]);
if (sidebar) { assert.equal(manifest.side_panel?.default_path, 'sidepanel.html'); assert.equal(manifest.action?.default_popup, undefined); assert.equal(manifest.web_accessible_resources, undefined); }
if (markdownChat) { assert.ok(archive['MARKED-LICENSE.txt']); assert.ok(archive['DOMPURIFY-LICENSE.txt']); assert.ok(archive['DOMPURIFY-LICENSE-MPL.txt']); }
for (const html of ['options.html', ...(phraseCollection ? ['phrases.html'] : []), ...(research ? ['research.html'] : []), ...(sidebar ? ['sidepanel.html'] : [])]) {
  for (const target of Buffer.from(archive[html]).toString().matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) {
    assert.ok(archive[target[1].slice(1)], `Missing ${html} asset: ${target[1]}`);
  }
}
const evidence = [];
if (nativeWebapp) {
  const name = `webchat-webapp-e2e-report-${manifest.version}.json`, bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version); assert.equal(report.mockOnly, true);
  assert.equal(report.realAccountVerified, false); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= (runtimeDiscovery ? 14 : 13));
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true);
  assert.equal(report.testHarness.productionSourceModified, false); assert.equal(report.testHarness.testCopyRestored, true);
  for (const coverage of ['independentConfiguration','loginAndActualModels','noApiKeyRequired','backgroundPinnedProxy','ordinaryDraftPreserved','remoteMultiTurn','deltaV1Stream','localClearKeepsRemoteHistory','clearDoesNotOpenChatPage','stopAbortsStream','explicitFailureNoFallback','safeCopiedDiagnostics','expiredLoginRequiresRecheck','tokenIsolation','narrow390And320','productionBytesUnchanged']) assert.equal(report.coverage?.[coverage], true, `Missing Webapp coverage: ${coverage}`);
  if (runtimeDiscovery) assert.equal(report.coverage?.longLivedPageUpgrade, true, 'Missing long-lived page upgrade coverage');
  assert.equal(report.testedBuild?.fingerprint, fingerprint); assert.deepEqual(report.testedBuild.files, dist); assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser, realAccountVerified: false });
  const liveName = 'live-native-client-2026-10-29.json';
  const liveBytes = await readFile(path.join(evidenceDirectory, liveName));
  const live = JSON.parse(liveBytes.toString());
  assert.equal(live.version, manifest.version); assert.equal(live.buildFingerprint, fingerprint);
  assert.equal(live.nativeClientSha256, dist['webchat-native-client.js'].sha256);
  assert.equal(live.installedExtensionSidePanelVerified, false); assert.equal(live.privateValuesStored, false);
  if (runtimeDiscovery) {
    assert.equal(live.bridgeVersion, 'reader-native-v3');
    assert.equal(live.preconditions?.domRuntimeTagsAbsent, true); assert.equal(live.preconditions.initialRuntimeTimingAbsent, true);
    assert.equal(live.preconditions.publicManifestRuntimeAvailable, true); assert.equal(live.preconditions.legacyBridgeVersion, 'reader-native-v2');
    assert.equal(live.result?.type, 'status'); assert.equal(live.result.state, 'ready'); assert.equal(live.result.modelsAvailable, true);
    assert.equal(live.generationSent, false); assert.equal(live.pageReloaded, false); assert.equal(live.newTabCreated, false);
  } else {
    assert.equal(live.status?.ready, true); assert.equal(live.request?.automaticRetries, 0);
    assert.equal(live.result?.type, 'done'); assert.ok(live.result.text?.trim());
    assert.equal(live.result.remoteConversationReloadShowsPromptAndAnswer, true);
    const screenshotBytes = await readFile(path.join(evidenceDirectory, live.screenshot));
    evidence.push({ file: `${evidencePrefix}/${live.screenshot}`, sha256: sha256(screenshotBytes) });
  }
  evidence.push({ file: `${evidencePrefix}/${liveName}`, sha256: sha256(liveBytes), realNativeAccountCheckVerified: true, realGenerationVerifiedForBuild: !runtimeDiscovery, installedExtensionSidePanelVerified: false });
}
if (pageChat && !nativeWebapp) {
  const name = `webchat-page-e2e-report-${manifest.version}.json`, bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version); assert.equal(report.mockOnly, true);
  assert.equal(report.realAccountVerified, false); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= 6);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true);
  assert.equal(report.testHarness.productionSourceModified, false); assert.equal(report.testHarness.testCopyRestored, true);
  for (const coverage of ['domOnlyNoPrivateRequests','backgroundOwnedTab','realShellControls','remoteMultiTurn','clearStartsFreshPage','draftPreserved','stopOwnedTurn','closedPageRecovery','otherTabsUntouched','narrow390And320','productionBytesUnchanged']) assert.equal(report.coverage?.[coverage], true, `Missing official-page coverage: ${coverage}`);
  assert.equal(report.testedBuild?.fingerprint, fingerprint); assert.deepEqual(report.testedBuild.files, dist); assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser, realAccountVerified: false });
}
if (webChat && !nativeWebapp) {
  const name = `webchat-e2e-report-${manifest.version}.json`, bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version); assert.equal(report.mockOnly, true);
  assert.equal(report.realAccountVerified, false); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= 9);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true);
  assert.equal(report.testHarness.productionSourceModified, false); assert.equal(report.testHarness.testCopyRestored, true);
  for (const coverage of ['independentConfiguration', 'loginAndActualModels', 'signedOutState', 'noApiKeyRequired', 'remoteMultiTurn', 'localClearKeepsRemoteHistory', 'explicitFailureNoFallback', 'tokenIsolation', 'narrow390And320', 'productionBytesUnchanged']) assert.equal(report.coverage?.[coverage], true, `Missing Web chat coverage: ${coverage}`);
  if (connectionDiagnostics) {
    assert.ok(report.passed >= 13);
    for (const coverage of ['generationStates', 'safeCopiedDiagnostics', 'refreshDoesNotVerifyChat', 'explicitCausesAndFormat']) assert.equal(report.coverage?.[coverage], true, `Missing connection diagnostic coverage: ${coverage}`);
  }
  assert.equal(report.testedBuild?.fingerprint, fingerprint); assert.deepEqual(report.testedBuild.files, dist); assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser, realAccountVerified: false });
}
if (sidebar) {
  const name = `sidebar-e2e-report-${manifest.version}.json`, bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version); assert.equal(report.mockOnly, true); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= 15);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed); assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true); assert.equal(report.testHarness.productionSourceModified, false); assert.equal(report.testHarness.testCopyRestored, true);
  assert.equal(report.testHarness.nativeActionClickVerified, false); assert.equal(report.testHarness.nativeSidePanelSurfaceVerified, false);
  for (const coverage of ['nativeSidePanelConfiguration','defaultChatAndFourTabs','shellTabRendering','embeddedSettingsSave','embeddedSettingsLinkNavigation','concurrentChatAndResearch','zeroCallsOnNavigationAndSave','trustedChatClicks','multiTurnAssistantRole','safeHtmlAndCopy','retainedDraftsAndFrames','confirmedClear','stopAbortsAndExcludesPartial','overBudgetZeroCalls','actualContentSenderIsolation','embeddedResearchTwoPagesThreeCalls','tabSwitchKeepsResearch','embeddedReportSaveAndDownload','narrow390And320','ownerCloseAborts','keyIsolationAndSessionCleared','localReportPersists','productionBytesUnchanged']) assert.equal(report.coverage?.[coverage], true, `Missing sidebar coverage: ${coverage}`);
  if (markdownChat) { assert.equal(report.coverage?.markdownRenderingAndSafety, true, 'Missing safe Markdown rendering coverage'); assert.ok(report.passed >= 16); }
  assert.equal(report.testedBuild?.fingerprint, fingerprint); assert.deepEqual(report.testedBuild.files, dist); assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser, nativeActionClickVerified: false, nativeSidePanelSurfaceVerified: false });
}
if (research) {
  const name = `research-e2e-report-${manifest.version}.json`;
  const bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version); assert.equal(report.mockOnly, true); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= 17);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true);
  assert.equal(report.testHarness.productionSourceModified, false); assert.equal(report.testHarness.testCopyRestored, true);
  for (const coverage of ['realResearchForm','inputValidationAndFiveUrlLimit','ungrantedZeroRequests','twoPagesThreeCalls','verifiedQuotesAndCitations','sourceComparisonTable','markdownComparisonTable','temporaryTabsClosed','partialFailuresExcluded','sixCallCeiling','overBudgetZeroCalls','invalidEvidenceRejected','safeHtmlRendering','explicitLocalSave','safeMarkdownDownload','senderAndStorageIsolation','settingsEntryAndNarrow390','stopAbortsAndNoLaterRequests','closePageStops','sameProfileRestartPersistence','sessionKeyClearedAfterRestart','offlineReportManagement','deleteConfirmation','productionBytesUnchanged']) assert.equal(report.coverage?.[coverage], true, `Missing research coverage: ${coverage}`);
  assert.equal(report.testedBuild?.fingerprint, fingerprint); assert.deepEqual(report.testedBuild.files, dist); assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser });
}
if (phraseCollection) {
  const name = `phrases-e2e-report-${manifest.version}.json`;
  const bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version);
  assert.equal(report.mockOnly, true); assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0); assert.ok(!report.fatal); assert.ok(report.passed >= 20);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.checks.every(check => check.result === 'pass'));
  assert.equal(report.testHarness?.productionWorkerWithoutTestEntry, true);
  assert.equal(report.testHarness.trustedMouseSelectionAndButtonClicks, true);
  assert.equal(report.testHarness.productionSourceModified, false);
  assert.equal(report.testHarness.testCopyRestored, true);
  for (const coverage of ['trustedSelectionSave','onlyCompletedAnswersSaveable','saveAddsZeroModelRequests','deduplication','examplesUpdateSamePhrase','previewIframeSource','contentScriptIsolation','actualLibraryEntry','updatedPhraseSortsFirst','unchangedRefreshPreservesExpansion','deletedPhraseCanBeSavedAgain','searchAndModeFilters','safeJsonAndMarkdownExport','deleteConfirmationAndEmptyState','narrow390','localOnlyStorage','sameProfileRestartPersistence','sessionKeyClearedAfterRestart','managementWithoutModelOrWebsitePermission','productionBytesUnchanged']) {
    assert.equal(report.coverage?.[coverage], true, `Missing phrase coverage: ${coverage}`);
  }
  assert.equal(report.testedBuild?.fingerprint, fingerprint, 'Phrase report did not test current dist');
  assert.deepEqual(report.testedBuild.files, dist);
  assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser });
}
for (const name of [selectionToolbar ? `context-e2e-report-${manifest.version}.json` : contextualReading ? 'context-e2e-report.json' : 'e2e-report.json']) {
  const bytes = await readFile(path.join(evidenceDirectory, name));
  const report = JSON.parse(bytes.toString());
  assert.equal(report.extensionVersion, manifest.version);
  assert.equal(report.mockOnly, true);
  assert.equal(report.realModelVerified, false);
  assert.equal(report.failed, 0);
  assert.ok(!report.fatal);
  assert.equal(report.checks.filter(check => check.result === 'pass').length, report.passed);
  assert.ok(report.passed >= (contextualReading ? 18 : 37));
  assert.ok(report.checks.every(check => check.result === 'pass'));
  if (contextualReading) {
    assert.equal(report.nativeMenuSelectionVerified, false, 'Keep native menu-selection scope explicit');
    assert.equal(report.testHarness?.nativeMenuCallbackInstrumented, true);
    assert.equal(report.testHarness.productionSourceModified, false);
    assert.equal(report.testHarness.testCopyRestored, true);
    if (selectionToolbar) {
      assert.equal(report.testHarness.toolbarFlowProductionWorker, true);
      for (const coverage of ['automaticToolbarZeroRequests','oneClickTranslation','mainAndPreviewFrames','bilingualPairs','usageExamples','longTranslationNoExamples','selectionLifecycle','m1DragSmoke']) {
        assert.equal(report.coverage?.[coverage], true, `Missing current selection coverage: ${coverage}`);
      }
    } else {
      for (const phrase of ['technical selection inside', 'foreign selection inside', 'consecutive A and B', 'permission revocation']) {
        assert.ok(report.checks.some(check => check.name.includes(phrase) && check.result === 'pass'), `Missing M2 coverage: ${phrase}`);
      }
    }
  } else {
    const repeated = report.checks.find(check => check.name.includes('same URL'));
    assert.equal(repeated?.result, 'pass');
    assert.ok(repeated.newRequests >= 3);
    const longText = report.checks.find(check => check.name.includes('whole text tail'));
    assert.equal(longText?.result, 'pass');
    assert.ok(longText.newRequests > 1);
  }
  assert.equal(report.testedBuild?.fingerprint, fingerprint, `${name} did not test the current dist`);
  assert.deepEqual(report.testedBuild.files, dist, `${name} file hashes differ from current dist`);
  assert.equal(report.testedBuild.unchangedAfterTest, true);
  evidence.push({ file: `${evidencePrefix}/${name}`, sha256: sha256(bytes), passed: report.passed, failed: report.failed, browser: report.browser });
}
const rebuildBytes = await readFile(path.join(evidenceDirectory, 'rebuild-consistency.json'));
const rebuild = JSON.parse(rebuildBytes.toString());
assert.equal(rebuild.byteIdentical, true);
assert.deepEqual(rebuild.files, dist, 'Source rebuild evidence differs from the release');
const unitBytes = await readFile(path.join(evidenceDirectory, 'unit-test.txt'));
const passed = Number(unitBytes.toString().match(/pass\s+(\d+)\b/)?.[1]);
assert.ok(passed >= (runtimeDiscovery ? 322 : nativeWebapp ? 313 : connectionDiagnostics ? 201 : webChat ? 170 : sidebar ? 142 : research ? 123 : phraseCollection ? 94 : contextualReading ? 65 : 33));
assert.match(unitBytes.toString(), /fail\s+0\b/);
evidence.push({ file: `${evidencePrefix}/rebuild-consistency.json`, sha256: sha256(rebuildBytes), byteIdentical: true });
evidence.push({ file: `${evidencePrefix}/unit-test.txt`, sha256: sha256(unitBytes), passed, failed: 0 });
const sourceFiles = {};
for (const directory of ['src', 'public', 'scripts', 'tests']) {
  for (const [name, details] of Object.entries(await hashDirectory(path.join(root, directory)))) sourceFiles[`${directory}/${name}`] = details;
}
for (const file of ['options.html', ...(phraseCollection ? ['phrases.html'] : []), ...(research ? ['research.html'] : []), ...(sidebar ? ['sidepanel.html'] : []), 'package.json', 'package-lock.json', 'tsconfig.json', 'THIRD_PARTY_NOTICES.md']) {
  const bytes = await readFile(path.join(root, file));
  sourceFiles[file] = { bytes: bytes.length, sha256: sha256(bytes) };
}
const record = {
  verifiedAt: new Date().toISOString(), algorithm: 'SHA-256', version: manifest.version,
  checks: { zipByteIdenticalToDist: true, onlyOptionalHostPermissions: true, noMockCredentialInRelease: true, browserEvidenceMatchesDist: true, sourceRebuildByteIdentical: true },
  buildFingerprint: fingerprint, dist,
  archive: { file: archivePath, bytes: archiveBytes.length, sha256: sha256(archiveBytes) },
  evidence, sourceFiles, realModelVerified: false,
  ...(nativeWebapp ? { realNativeAccountCheckVerified: true, realGenerationVerifiedForBuild: !runtimeDiscovery, installedExtensionSidePanelVerified: false } : {}),
  pending: nativeWebapp ? ['M6 user Chrome installed-extension side-panel end-to-end account send and multi-turn acceptance', 'M6 actual OpenAI history persistence', 'Internal website client may change; fail closed on unsupported runtime', 'User Chrome native toolbar and permission dialogs'] : pageChat ? ['M6 real-account official-page DOM send, streamed answer and multi-turn verification in user Chrome', 'M6 actual OpenAI history persistence', 'Legacy direct protocol remains incompatible with the observed live website', 'User Chrome native side-panel toolbar and permission dialogs'] : webChat ? ['M6 user Chrome ChatGPT login and actual model discovery', 'M6 live ChatGPT web protocol and real multi-turn inference compatibility', 'M6 actual OpenAI history persistence', 'User Chrome native side-panel toolbar and permission dialogs'] : sidebar ? ['M5 user Chrome native toolbar click opens the docked side panel', 'M5 real model multi-turn conversation quality', 'User Chrome native permission dialog and context-menu item selection'] : research ? ['M4 user acceptance of cross-page research and real model evidence quality', 'User Chrome native permission dialog and context-menu item selection'] : phraseCollection ? ['M3 user acceptance of local phrase collection', 'User-configured real model explanation and translation quality', 'User Chrome native permission dialog and context-menu item selection'] : contextualReading
    ? ['M2 user Chrome native context-menu item selection and Google Search coexistence', 'M2 user-configured real model explanation and translation quality']
    : ['User Chrome native permission dialog and context-menu / tab-strip interactions', 'User-configured real model quality and real website embedding compatibility']
};
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(path.join(evidenceDirectory, 'build-sha256.json'), `${JSON.stringify(record, null, 2)}\n`);
console.log(`Release verified: ${fingerprint}; ${Object.keys(dist).length} files; ZIP byte-identical; browser reports match.`);
