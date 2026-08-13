import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const test = process.env.VITEST
  ? (await import('vitest')).test
  : (await import('node:test')).default;

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repositoryRoot, 'src-tauri', 'tauri.conf.json');
const desktopEntryPath = join(
  repositoryRoot,
  'src-tauri',
  'resources',
  'com.chamu.desktop.desktop',
);
const packageDesktopEntryPath =
  '/usr/share/applications/com.chamu.desktop.desktop';

test('maps the Chamu desktop entry into both Linux package formats', async () => {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const expectedSource = 'resources/com.chamu.desktop.desktop';

  assert.equal(
    config.bundle.linux.deb.files[packageDesktopEntryPath],
    expectedSource,
  );
  assert.equal(
    config.bundle.linux.appimage.files[packageDesktopEntryPath],
    expectedSource,
  );
  assert.match(await readFile(desktopEntryPath, 'utf8'), /^\[Desktop Entry\]/);
});
