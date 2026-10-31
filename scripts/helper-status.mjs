import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

// Read only this application's install metadata. No credential export, browser
// profile access, authentication, registration or model request is available.
const extensionId = process.argv[2];
assert.match(extensionId || '', /^[a-p]{32}$/, 'Provide the actual Yuechuang extension ID.');
assert.equal(process.platform, 'win32');
const root = path.join(process.env.LOCALAPPDATA, 'YuechuangHelper');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'com.yuechuang.helper.json'), 'utf8'));
const origin = `chrome-extension://${extensionId}/`;
assert.equal(manifest.name, 'com.yuechuang.helper');
assert.deepEqual(manifest.allowed_origins, [origin]);
const exe = path.join(root, 'bin', 'yuechuang-helper.exe');
assert.equal(path.resolve(manifest.path), path.resolve(exe));
const helperConfig = JSON.parse(await fs.readFile(path.join(root, 'bin', 'helper-config.json'), 'utf8'));
assert.deepEqual(helperConfig.allowedOrigins, [origin]);
const bytes = await fs.readFile(exe);
const request = Buffer.from(JSON.stringify({ id: 'local-install-status', command: 'status' }));
const header = Buffer.alloc(4); header.writeUInt32LE(request.length);
const child = spawn(exe, [origin], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = Buffer.alloc(0), response;
const timer = setTimeout(() => child.kill(), 12_000);
try {
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.stdout.on('data', chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length > 1_048_580 || output.length >= 4 && output.readUInt32LE(0) > 1_048_576) { child.kill(); reject(new Error('Invalid native frame size.')); return; }
      if (!response && output.length >= 4 && output.length >= 4 + output.readUInt32LE(0)) {
        try { response = JSON.parse(output.subarray(4, 4 + output.readUInt32LE(0)).toString('utf8')); child.stdin.end(); }
        catch { child.kill(); reject(new Error('Invalid native response.')); }
      }
    });
    child.stdin.on('error', () => {});
    child.on('close', code => code === 0 && response ? resolve() : reject(new Error('Local helper status check failed.')));
    child.stdin.write(Buffer.concat([header, request]));
  });
  assert.equal(response.id, 'local-install-status');
  assert.equal(response.ok, true, `Helper status failed: ${/^[A-Za-z]{1,60}$/.test(response.error?.code || '') ? response.error.code : 'unknown'}`);
  assert.ok(['signedOut', 'ready', 'planDenied', 'reauthRequired'].includes(response.result.state));
  process.stdout.write(JSON.stringify({ checkedAt: new Date().toISOString(), installed: true, extensionId, helperVersion: response.result.version,
    state: response.result.state, planAuthorized: response.result.account?.planAuthorized === true,
    helperBytes: bytes.length, helperSha256: createHash('sha256').update(bytes).digest('hex'), hostExited: true,
    chromeConnectionVerified: false, realModelVerified: false, check: 'direct native protocol status only' }, null, 2) + '\n');
} finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
