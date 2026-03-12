#!/usr/bin/env node
/**
 * Protected sync-marketplace script
 *
 * Prevents accidental overwrite when the installed plugin is on a beta branch.
 * On all platforms, syncs the working tree into the installed marketplace path
 * and the versioned cache folder without depending on rsync.
 */

const { execFileSync, execSync } = require('child_process');
const {
  existsSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  statSync,
  chmodSync
} = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

const INSTALLED_PATH = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'DaBianYLK');
const CACHE_BASE_PATH = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'DaBianYLK', 'claude-mem');

function normalizeRelativePath(relativePath) {
  return relativePath
    .split(path.sep)
    .join('/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function wildcardToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
}

function matchPathSegments(patternSegments, pathSegments, patternIndex = 0, pathIndex = 0) {
  if (patternIndex === patternSegments.length) {
    return pathIndex === pathSegments.length;
  }

  const patternSegment = patternSegments[patternIndex];
  if (patternSegment === '**') {
    if (patternIndex === patternSegments.length - 1) return true;
    for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex++) {
      if (matchPathSegments(patternSegments, pathSegments, patternIndex + 1, nextPathIndex)) {
        return true;
      }
    }
    return false;
  }

  if (pathIndex >= pathSegments.length) {
    return false;
  }

  return wildcardToRegExp(patternSegment).test(pathSegments[pathIndex]) &&
    matchPathSegments(patternSegments, pathSegments, patternIndex + 1, pathIndex + 1);
}

function matchesDirectoryPatternAnywhere(patternSegments, pathSegments) {
  for (let endIndex = 1; endIndex <= pathSegments.length; endIndex++) {
    if (matchPathSegments(patternSegments, pathSegments.slice(0, endIndex))) {
      return true;
    }
  }
  return false;
}

function shouldExcludePath(relativePath, isDirectory, patterns) {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) return false;

  const pathSegments = normalizedPath.split('/').filter(Boolean);
  const basename = pathSegments[pathSegments.length - 1];

  for (const rawPattern of patterns) {
    const normalizedPattern = normalizeRelativePath(String(rawPattern || '').trim().replace(/\\/g, '/'));
    if (!normalizedPattern) continue;

    const directoryPattern = /\/$/.test(String(rawPattern).trim());
    const patternSegments = normalizedPattern.split('/').filter(Boolean);

    if (patternSegments.length === 0) continue;

    if (directoryPattern) {
      if (patternSegments.length === 1) {
        const segmentRegex = wildcardToRegExp(patternSegments[0]);
        if (pathSegments.some(segment => segmentRegex.test(segment))) {
          return true;
        }
        continue;
      }

      if (matchesDirectoryPatternAnywhere(patternSegments, pathSegments)) {
        return true;
      }
      continue;
    }

    if (patternSegments.length === 1) {
      if (wildcardToRegExp(patternSegments[0]).test(basename)) {
        return true;
      }
      continue;
    }

    if (matchPathSegments(patternSegments, pathSegments)) {
      return true;
    }
  }

  return false;
}

function getCurrentBranch() {
  try {
    if (!existsSync(path.join(INSTALLED_PATH, '.git'))) {
      return null;
    }
    return execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: INSTALLED_PATH,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
  } catch {
    return null;
  }
}

function getIgnorePatterns(basePath) {
  const gitignorePath = path.join(basePath, '.gitignore');
  if (!existsSync(gitignorePath)) return [];

  return readFileSync(gitignorePath, 'utf-8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'));
}

function ensureParentDirectory(targetPath) {
  mkdirSync(path.dirname(targetPath), { recursive: true });
}

function ensureDirectoryAtPath(targetPath) {
  if (existsSync(targetPath) && !statSync(targetPath).isDirectory()) {
    rmSync(targetPath, { recursive: true, force: true });
  }
  mkdirSync(targetPath, { recursive: true });
}

function copyFileWithMetadata(sourcePath, destinationPath) {
  ensureParentDirectory(destinationPath);
  if (existsSync(destinationPath) && statSync(destinationPath).isDirectory()) {
    rmSync(destinationPath, { recursive: true, force: true });
  }

  copyFileSync(sourcePath, destinationPath);

  try {
    chmodSync(destinationPath, statSync(sourcePath).mode);
  } catch {
    // Best-effort only. Windows may ignore chmod changes.
  }
}

function syncDirectoryContents(sourceRoot, destinationRoot, patterns) {
  if (!existsSync(sourceRoot)) {
    throw new Error(`Source directory does not exist: ${sourceRoot}`);
  }

  mkdirSync(destinationRoot, { recursive: true });
  const includedPaths = new Set();

  function copyRecursive(currentSourceDir, relativeDir = '') {
    for (const entry of readdirSync(currentSourceDir, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(path.posix.join(relativeDir, entry.name));
      const sourcePath = path.join(currentSourceDir, entry.name);
      const destinationPath = path.join(destinationRoot, ...relativePath.split('/'));

      if (shouldExcludePath(relativePath, entry.isDirectory(), patterns)) {
        continue;
      }

      includedPaths.add(relativePath);

      if (entry.isDirectory()) {
        ensureDirectoryAtPath(destinationPath);
        copyRecursive(sourcePath, relativePath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const resolvedStats = statSync(sourcePath);
        if (resolvedStats.isDirectory()) {
          ensureDirectoryAtPath(destinationPath);
          copyRecursive(sourcePath, relativePath);
        } else {
          copyFileWithMetadata(sourcePath, destinationPath);
        }
        continue;
      }

      copyFileWithMetadata(sourcePath, destinationPath);
    }
  }

  function deleteExtraneous(currentDestinationDir, relativeDir = '') {
    for (const entry of readdirSync(currentDestinationDir, { withFileTypes: true })) {
      const relativePath = normalizeRelativePath(path.posix.join(relativeDir, entry.name));
      const destinationPath = path.join(currentDestinationDir, entry.name);

      if (shouldExcludePath(relativePath, entry.isDirectory(), patterns)) {
        continue;
      }

      if (!includedPaths.has(relativePath)) {
        rmSync(destinationPath, { recursive: true, force: true });
        continue;
      }

      if (entry.isDirectory()) {
        deleteExtraneous(destinationPath, relativePath);
      }
    }
  }

  copyRecursive(sourceRoot);
  deleteExtraneous(destinationRoot);
}

function resolveBunExecutable() {
  const candidates = [
    process.env.BUN,
    process.env.BUN_PATH,
    path.join(os.homedir(), '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun'),
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe')
      : null,
    'bun'
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (candidate === 'bun') return candidate;
    if (existsSync(candidate)) return candidate;
  }

  return 'bun';
}

function runBunInstall(cwd) {
  execFileSync(resolveBunExecutable(), ['install'], {
    cwd,
    stdio: 'inherit'
  });
}

function triggerWorkerRestart() {
  console.log('\n🔄 Triggering worker restart...');
  const req = http.request({
    hostname: '127.0.0.1',
    port: 37777,
    path: '/api/admin/restart',
    method: 'POST',
    timeout: 2000
  }, (res) => {
    if (res.statusCode === 200) {
      console.log('\x1b[32m%s\x1b[0m', '✓ Worker restart triggered');
    } else {
      console.log('\x1b[33m%s\x1b[0m', `ℹ Worker restart returned status ${res.statusCode}`);
    }
  });

  req.on('error', () => {
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker not running, will start on next hook');
  });
  req.on('timeout', () => {
    req.destroy();
    console.log('\x1b[33m%s\x1b[0m', 'ℹ Worker restart timed out');
  });
  req.end();
}

function getPluginVersion() {
  try {
    const pluginJsonPath = path.join(__dirname, '..', 'plugin', '.claude-plugin', 'plugin.json');
    const pluginJson = JSON.parse(readFileSync(pluginJsonPath, 'utf-8'));
    return pluginJson.version;
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Failed to read plugin version:', error.message);
    process.exit(1);
  }
}

function createIgnoreSet(...patternLists) {
  return [...new Set(patternLists.flat().filter(Boolean))];
}

function main() {
  const branch = getCurrentBranch();
  const isForce = process.argv.includes('--force');

  if (branch && branch !== 'main' && !isForce) {
    console.log('');
    console.log('\x1b[33m%s\x1b[0m', `WARNING: Installed plugin is on beta branch: ${branch}`);
    console.log('\x1b[33m%s\x1b[0m', 'Running sync would overwrite beta code.');
    console.log('');
    console.log('Options:');
    console.log('  1. Use UI at http://localhost:37777 to update beta');
    console.log('  2. Switch to stable in UI first, then run sync');
    console.log('  3. Force sync: npm run sync-marketplace:force');
    console.log('');
    process.exit(1);
  }

  console.log('Syncing to marketplace...');
  try {
    const rootDir = path.join(__dirname, '..');
    const rootPatterns = createIgnoreSet('.git', 'bun.lock', 'package-lock.json', getIgnorePatterns(rootDir));

    syncDirectoryContents(rootDir, INSTALLED_PATH, rootPatterns);

    console.log('Running bun install in marketplace...');
    runBunInstall(INSTALLED_PATH);

    const version = getPluginVersion();
    const cacheVersionPath = path.join(CACHE_BASE_PATH, version);
    const pluginDir = path.join(rootDir, 'plugin');
    const pluginPatterns = createIgnoreSet('.git', getIgnorePatterns(pluginDir));

    console.log(`Syncing to cache folder (version ${version})...`);
    syncDirectoryContents(pluginDir, cacheVersionPath, pluginPatterns);

    console.log(`Running bun install in cache folder (version ${version})...`);
    runBunInstall(cacheVersionPath);

    console.log('\x1b[32m%s\x1b[0m', 'Sync complete!');
    triggerWorkerRestart();
  } catch (error) {
    console.error('\x1b[31m%s\x1b[0m', 'Sync failed:', error.message);
    process.exit(1);
  }
}

module.exports = {
  normalizeRelativePath,
  shouldExcludePath,
  getIgnorePatterns,
  syncDirectoryContents,
  resolveBunExecutable,
};

if (require.main === module) {
  main();
}
