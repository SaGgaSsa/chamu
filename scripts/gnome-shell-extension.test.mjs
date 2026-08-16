import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const test = process.env.VITEST
  ? (await import('vitest')).test
  : (await import('node:test')).default;

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = join(
  repositoryRoot,
  'src-tauri',
  'resources',
  'chamu@chamu.app',
);
const metadataPath = join(extensionRoot, 'metadata.json');
const extensionPath = join(extensionRoot, 'extension.js');
const tauriConfigPath = join(repositoryRoot, 'src-tauri', 'tauri.conf.json');

test('declares the GNOME Shell versions and extension UUID', async () => {
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  assert.equal(metadata.uuid, 'chamu@chamu.app');
  assert.deepEqual(metadata['shell-version'], ['46', '47', '48', '49', '50']);
  assert.equal(typeof metadata.name, 'string');
  assert.equal(typeof metadata.description, 'string');
});

test('exposes the D-Bus Paste contract and emits Ctrl+V', async () => {
  const extension = await readFile(extensionPath, 'utf8');

  assert.match(extension, /app\.chamu\.Input/);
  assert.match(extension, /\/app\/chamu\/Input/);
  assert.match(extension, /method name="Paste"/);
  assert.match(extension, /Paste\(\)/);
  assert.match(extension, /create_virtual_device/);
  assert.match(extension, /Clutter\.InputDeviceType\.KEYBOARD_DEVICE/);
  assert.match(extension, /Clutter\.KeyState\.PRESSED/);
  assert.match(extension, /Clutter\.KeyState\.RELEASED/);
  assert.match(extension, /GLib\.get_monotonic_time\(\)/);
  assert.match(extension, /Control_L/);
  assert.match(extension, /\bKEY_v\b/);
  assert.match(extension, /Ctrl\+V/);
  assert.match(extension, /Gio\.DBusExportedObject\.wrapJSObject/);
  assert.match(extension, /Gio\.DBus\.session\.own_name/);
  assert.match(extension, /Gio\.DBus\.session\.unown_name/);
  assert.match(extension, /\.unexport\(\)/);

  for (const forbidden of ['xdotool', 'ydotool', 'wtype', 'portal', 'sudo']) {
    assert.doesNotMatch(extension.toLowerCase(), new RegExp(forbidden));
  }
});

test('includes the extension directory in the Tauri bundle resources', async () => {
  const config = JSON.parse(await readFile(tauriConfigPath, 'utf8'));

  assert.ok(Array.isArray(config.bundle.resources));
  assert.ok(config.bundle.resources.includes('resources/chamu@chamu.app'));
});
