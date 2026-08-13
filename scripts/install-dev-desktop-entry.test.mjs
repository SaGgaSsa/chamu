import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { installDesktopEntry } from './install-dev-desktop-entry.mjs';

const test = process.env.VITEST
  ? (await import('vitest')).test
  : (await import('node:test')).default;

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureEntryPath = join(
  repositoryRoot,
  'src-tauri',
  'resources',
  'com.chamu.desktop.desktop',
);

test('copies only the Chamu desktop entry to the XDG applications directory', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'chamu-desktop-entry-'));

  try {
    const target = await installDesktopEntry({
      sourcePath: fixtureEntryPath,
      applicationsDir: join(tempDir, 'applications'),
    });

    assert.equal(
      target,
      join(tempDir, 'applications', 'com.chamu.desktop.desktop'),
    );
    assert.match(await readFile(target, 'utf8'), /Name=Chamu/);
    await assert.rejects(
      stat(join(tempDir, 'applications', 'other.desktop')),
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
