import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  normalizeRelativePath,
  shouldExcludePath,
  syncDirectoryContents,
} = require('../../scripts/sync-marketplace.cjs');

describe('sync-marketplace script', () => {
  it('normalizes Windows paths to repository-relative POSIX paths', () => {
    expect(normalizeRelativePath('plugin\\scripts\\worker-service.cjs')).toBe('plugin/scripts/worker-service.cjs');
  });

  it('applies gitignore-style exclusions needed for marketplace sync', () => {
    const patterns = ['node_modules/', '**/_tree-sitter/', '*.log', 'src/ui/viewer.html', '.env', 'bak/'];

    expect(shouldExcludePath('node_modules/esbuild/index.js', false, patterns)).toBe(true);
    expect(shouldExcludePath('src/parser/_tree-sitter/cache.bin', false, patterns)).toBe(true);
    expect(shouldExcludePath('logs/worker.log', false, patterns)).toBe(true);
    expect(shouldExcludePath('src/ui/viewer.html', false, patterns)).toBe(true);
    expect(shouldExcludePath('plugin/scripts/worker-service.cjs', false, patterns)).toBe(false);
    expect(shouldExcludePath('bak/snapshot/file.txt', false, patterns)).toBe(true);
  });

  it('syncs files, deletes stale non-excluded files, and preserves excluded destinations', () => {
    const sourceRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-sync-src-'));
    const destinationRoot = mkdtempSync(path.join(tmpdir(), 'claude-mem-sync-dst-'));
    const patterns = ['node_modules/', '.git/', '*.log'];

    mkdirSync(path.join(sourceRoot, 'nested'), { recursive: true });
    mkdirSync(path.join(sourceRoot, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(path.join(sourceRoot, 'keep.txt'), 'keep');
    writeFileSync(path.join(sourceRoot, 'nested', 'keep.js'), 'nested');
    writeFileSync(path.join(sourceRoot, 'node_modules', 'pkg', 'index.js'), 'ignored');

    mkdirSync(path.join(destinationRoot, 'nested'), { recursive: true });
    mkdirSync(path.join(destinationRoot, '.git'), { recursive: true });
    writeFileSync(path.join(destinationRoot, 'stale.txt'), 'remove me');
    writeFileSync(path.join(destinationRoot, 'nested', 'obsolete.js'), 'remove me too');
    writeFileSync(path.join(destinationRoot, '.git', 'config'), 'preserve');

    syncDirectoryContents(sourceRoot, destinationRoot, patterns);

    expect(readFileSync(path.join(destinationRoot, 'keep.txt'), 'utf-8')).toBe('keep');
    expect(readFileSync(path.join(destinationRoot, 'nested', 'keep.js'), 'utf-8')).toBe('nested');
    expect(existsSync(path.join(destinationRoot, 'stale.txt'))).toBe(false);
    expect(existsSync(path.join(destinationRoot, 'nested', 'obsolete.js'))).toBe(false);
    expect(existsSync(path.join(destinationRoot, 'node_modules'))).toBe(false);
    expect(readFileSync(path.join(destinationRoot, '.git', 'config'), 'utf-8')).toBe('preserve');
  });
});
