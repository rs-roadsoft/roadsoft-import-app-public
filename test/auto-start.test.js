const test = require('node:test');
const assert = require('node:assert/strict');
const { autoStartOnInstall } = require('../lib/auto-start');

test('a fresh profile gets auto-start on, and the version is remembered', () => {
  assert.deepEqual(autoStartOnInstall({ autoStartEnabled: null, storedVersion: null, currentVersion: '2.2.0' }), {
    autoStartEnabled: 'true',
    storedVersion: '2.2.0',
    changed: true,
  });
});

test('installing a new version turns auto-start on even if it had been switched off', () => {
  const result = autoStartOnInstall({ autoStartEnabled: 'false', storedVersion: null, currentVersion: '2.2.0' });
  assert.equal(result.autoStartEnabled, 'true');
  assert.equal(result.changed, true);
});

test('switching it off after the install is respected until the next version', () => {
  assert.deepEqual(autoStartOnInstall({ autoStartEnabled: 'false', storedVersion: '2.2.0', currentVersion: '2.2.0' }), {
    autoStartEnabled: 'false',
    storedVersion: '2.2.0',
    changed: false,
  });
});

test('the next version turns it on again', () => {
  const result = autoStartOnInstall({ autoStartEnabled: 'false', storedVersion: '2.2.0', currentVersion: '2.3.0' });
  assert.equal(result.autoStartEnabled, 'true');
  assert.equal(result.storedVersion, '2.3.0');
  assert.equal(result.changed, true);
});

test('a missing setting is on, even when the version was already recorded', () => {
  const result = autoStartOnInstall({ autoStartEnabled: null, storedVersion: '2.2.0', currentVersion: '2.2.0' });
  assert.equal(result.autoStartEnabled, 'true');
  assert.equal(result.changed, true);
});
