/**
 * CursorHooksInstaller - Cursor IDE integration for claude-mem
 *
 * Extracted from worker-service.ts monolith to provide centralized Cursor integration.
 * Handles:
 * - Cursor hooks installation/uninstallation
 * - MCP server configuration
 * - Context file generation
 * - Project registry management
 */

import path from 'path';
import { homedir } from 'os';
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync, chmodSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../../utils/logger.js';
import { getWorkerPort } from '../../shared/worker-utils.js';
import { DATA_DIR, MARKETPLACE_ROOT, CLAUDE_CONFIG_DIR } from '../../shared/paths.js';
import {
  readCursorRegistry as readCursorRegistryFromFile,
  writeCursorRegistry as writeCursorRegistryToFile,
  writeContextFile,
  type CursorProjectRegistry
} from '../../utils/cursor-utils.js';
import type { CursorInstallTarget, CursorHooksJson, CursorMcpConfig, Platform } from './types.js';

const execAsync = promisify(exec);

// Standard paths
const CURSOR_REGISTRY_FILE = path.join(DATA_DIR, 'cursor-projects.json');
export const CURSOR_HOOK_WRAPPER_COMMANDS = [
  'session-init',
  'context',
  'observation',
  'file-edit',
  'summarize'
] as const;
export type CursorHookWrapperCommand = typeof CURSOR_HOOK_WRAPPER_COMMANDS[number];

const LEGACY_BASH_SCRIPTS = [
  'common.sh',
  'session-init.sh',
  'context-inject.sh',
  'save-observation.sh',
  'save-file-edit.sh',
  'session-summary.sh'
];

const LEGACY_POWERSHELL_SCRIPTS = [
  'common.ps1',
  'session-init.ps1',
  'context-inject.ps1',
  'save-observation.ps1',
  'save-file-edit.ps1',
  'session-summary.ps1'
];

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Detect platform for script selection
 */
export function detectPlatform(): Platform {
  return process.platform === 'win32' ? 'windows' : 'unix';
}

/**
 * Get script extension based on platform
 */
export function getScriptExtension(): string {
  return detectPlatform() === 'windows' ? '.ps1' : '.sh';
}

/**
 * Cursor hook wrappers are single-file entrypoints so Cursor doesn't need to
 * invoke a command with inline arguments, which currently triggers DEP0190.
 */
export function getCursorHookWrapperExtension(platform: Platform = detectPlatform()): string {
  return platform === 'windows' ? '.cmd' : '.sh';
}

export function getCursorHookWrapperFilename(
  command: CursorHookWrapperCommand,
  platform: Platform = detectPlatform()
): string {
  return `hook-${command}${getCursorHookWrapperExtension(platform)}`;
}

export function escapeForPosixSingleQuotes(value: string): string {
  return value.replace(/'/g, '\'\\\'\'');
}

export function buildCursorHookWrapper(
  command: CursorHookWrapperCommand,
  bunPath: string,
  workerServicePath: string,
  platform: Platform = detectPlatform()
): string {
  if (platform === 'windows') {
    return `@echo off\r\n"${bunPath}" "${workerServicePath}" hook cursor ${command}\r\n`;
  }

  const escapedBunPath = escapeForPosixSingleQuotes(bunPath);
  const escapedWorkerPath = escapeForPosixSingleQuotes(workerServicePath);

  return `#!/usr/bin/env sh\nexec '${escapedBunPath}' '${escapedWorkerPath}' hook cursor ${command}\n`;
}

function getCursorHookWrapperFiles(platform: Platform): string[] {
  return CURSOR_HOOK_WRAPPER_COMMANDS.map(command => getCursorHookWrapperFilename(command, platform));
}

function writeCursorHookWrapper(
  hooksDir: string,
  command: CursorHookWrapperCommand,
  bunPath: string,
  workerServicePath: string,
  platform: Platform
): string {
  const wrapperPath = path.join(hooksDir, getCursorHookWrapperFilename(command, platform));
  const wrapperContent = buildCursorHookWrapper(command, bunPath, workerServicePath, platform);

  writeFileSync(wrapperPath, wrapperContent);

  if (platform !== 'windows') {
    chmodSync(wrapperPath, 0o755);
  }

  return wrapperPath;
}

function quoteHookCommandPath(commandPath: string): string {
  return `"${commandPath.replace(/"/g, '\\"')}"`;
}

// ============================================================================
// Project Registry
// ============================================================================

/**
 * Read the Cursor project registry
 */
export function readCursorRegistry(): CursorProjectRegistry {
  return readCursorRegistryFromFile(CURSOR_REGISTRY_FILE);
}

/**
 * Write the Cursor project registry
 */
export function writeCursorRegistry(registry: CursorProjectRegistry): void {
  writeCursorRegistryToFile(CURSOR_REGISTRY_FILE, registry);
}

/**
 * Register a project for auto-context updates
 */
export function registerCursorProject(projectName: string, workspacePath: string): void {
  const registry = readCursorRegistry();
  registry[projectName] = {
    workspacePath,
    installedAt: new Date().toISOString()
  };
  writeCursorRegistry(registry);
  logger.info('CURSOR', 'Registered project for auto-context updates', { projectName, workspacePath });
}

/**
 * Unregister a project from auto-context updates
 */
export function unregisterCursorProject(projectName: string): void {
  const registry = readCursorRegistry();
  if (registry[projectName]) {
    delete registry[projectName];
    writeCursorRegistry(registry);
    logger.info('CURSOR', 'Unregistered project', { projectName });
  }
}

/**
 * Update Cursor context files for all registered projects matching this project name.
 * Called by SDK agents after saving a summary.
 */
export async function updateCursorContextForProject(projectName: string, port: number): Promise<void> {
  const registry = readCursorRegistry();
  const entry = registry[projectName];

  if (!entry) return; // Project doesn't have Cursor hooks installed

  try {
    // Fetch fresh context from worker
    const response = await fetch(
      `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
    );

    if (!response.ok) return;

    const context = await response.text();
    if (!context || !context.trim()) return;

    // Write to the project's Cursor rules file using shared utility
    writeContextFile(entry.workspacePath, context);
    logger.debug('CURSOR', 'Updated context file', { projectName, workspacePath: entry.workspacePath });
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Background context update - failure is non-critical, user workflow continues
    logger.error('CURSOR', 'Failed to update context file', { projectName }, error as Error);
  }
}

// ============================================================================
// Path Finding
// ============================================================================

/**
 * Find MCP server script path
 * Searches in order: marketplace install, source repo
 */
export function findMcpServerPath(): string | null {
  const possiblePaths = [
    // Marketplace install location
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'mcp-server.cjs'),
    // Development/source location (relative to built worker-service.cjs in plugin/scripts/)
    path.join(path.dirname(__filename), 'mcp-server.cjs'),
    // Alternative dev location
    path.join(process.cwd(), 'plugin', 'scripts', 'mcp-server.cjs'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Find worker-service.cjs path for unified CLI
 * Searches in order: marketplace install, source repo
 */
export function findWorkerServicePath(): string | null {
  const possiblePaths = [
    // Marketplace install location
    path.join(MARKETPLACE_ROOT, 'plugin', 'scripts', 'worker-service.cjs'),
    // Development/source location (relative to built worker-service.cjs in plugin/scripts/)
    path.join(path.dirname(__filename), 'worker-service.cjs'),
    // Alternative dev location
    path.join(process.cwd(), 'plugin', 'scripts', 'worker-service.cjs'),
  ];

  for (const p of possiblePaths) {
    if (existsSync(p)) {
      return p;
    }
  }
  return null;
}

/**
 * Find the Bun executable path
 * Required because worker-service.cjs uses bun:sqlite which is Bun-specific
 * Searches common installation locations across platforms
 */
export function findBunPath(): string {
  const possiblePaths = [
    // Standard user install location (most common)
    path.join(homedir(), '.bun', 'bin', 'bun'),
    // Global install locations
    '/usr/local/bin/bun',
    '/usr/bin/bun',
    // Windows locations
    ...(process.platform === 'win32' ? [
      path.join(homedir(), '.bun', 'bin', 'bun.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'bun', 'bun.exe'),
    ] : []),
  ];

  for (const p of possiblePaths) {
    if (p && existsSync(p)) {
      return p;
    }
  }

  // Fallback to 'bun' and hope it's in PATH
  // This allows the installation to proceed even if we can't find bun
  // The user will get a clear error when the hook runs if bun isn't available
  return 'bun';
}

/**
 * Get the target directory for Cursor hooks based on install target
 */
export function getTargetDir(target: CursorInstallTarget): string | null {
  switch (target) {
    case 'project':
      return path.join(process.cwd(), '.cursor');
    case 'user':
      return path.join(homedir(), '.cursor');
    case 'enterprise':
      if (process.platform === 'darwin') {
        return '/Library/Application Support/Cursor';
      } else if (process.platform === 'linux') {
        return '/etc/cursor';
      } else if (process.platform === 'win32') {
        return path.join(process.env.ProgramData || 'C:\\ProgramData', 'Cursor');
      }
      return null;
    default:
      return null;
  }
}

// ============================================================================
// MCP Configuration
// ============================================================================

/**
 * Configure MCP server in Cursor's mcp.json
 * @param target 'project' or 'user'
 * @returns 0 on success, 1 on failure
 */
export function configureCursorMcp(target: CursorInstallTarget): number {
  const mcpServerPath = findMcpServerPath();

  if (!mcpServerPath) {
    console.error('Could not find MCP server script');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/DaBianYLK/plugin/scripts/mcp-server.cjs');
    return 1;
  }

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}. Use: project or user`);
    return 1;
  }

  const mcpJsonPath = path.join(targetDir, 'mcp.json');

  try {
    // Create directory if needed
    mkdirSync(targetDir, { recursive: true });

    // Load existing config or create new
    let config: CursorMcpConfig = { mcpServers: {} };
    if (existsSync(mcpJsonPath)) {
      try {
        config = JSON.parse(readFileSync(mcpJsonPath, 'utf-8'));
        if (!config.mcpServers) {
          config.mcpServers = {};
        }
      } catch (error) {
        // [ANTI-PATTERN IGNORED]: Fallback behavior - corrupt config, continue with empty
        logger.error('SYSTEM', 'Corrupt mcp.json, creating new config', { path: mcpJsonPath }, error as Error);
        config = { mcpServers: {} };
      }
    }

    // Add claude-mem MCP server
    config.mcpServers['claude-mem'] = {
      command: 'node',
      args: [mcpServerPath]
    };

    writeFileSync(mcpJsonPath, JSON.stringify(config, null, 2));
    console.log(`  Configured MCP server in ${target === 'user' ? '~/.cursor' : '.cursor'}/mcp.json`);
    console.log(`    Server path: ${mcpServerPath}`);

    return 0;
  } catch (error) {
    console.error(`Failed to configure MCP: ${(error as Error).message}`);
    return 1;
  }
}

// ============================================================================
// Hook Installation
// ============================================================================

/**
 * Install Cursor hooks using wrapper scripts around the unified CLI.
 * Cursor currently emits DEP0190 warnings when hook commands include args.
 * The wrappers keep each hook command to a single executable path.
 */
export async function installCursorHooks(target: CursorInstallTarget): Promise<number> {
  console.log(`\nInstalling Claude-Mem Cursor hooks (${target} level)...\n`);

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}. Use: project, user, or enterprise`);
    return 1;
  }

  // Find the worker-service.cjs path
  const workerServicePath = findWorkerServicePath();
  if (!workerServicePath) {
    console.error('Could not find worker-service.cjs');
    console.error('   Expected at: ~/.claude/plugins/marketplaces/DaBianYLK/plugin/scripts/worker-service.cjs');
    return 1;
  }

  const workspaceRoot = process.cwd();

  try {
    // Create target directory
    mkdirSync(targetDir, { recursive: true });
    const hooksDir = path.join(targetDir, 'hooks');
    mkdirSync(hooksDir, { recursive: true });

    // Generate hooks.json with single-file wrapper commands
    const hooksJsonPath = path.join(targetDir, 'hooks.json');
    const platform = detectPlatform();

    // Find bun executable - required because worker-service.cjs uses bun:sqlite
    const bunPath = findBunPath();
    console.log(`  Using Bun runtime: ${bunPath}`);

    const sessionInitWrapper = writeCursorHookWrapper(
      hooksDir,
      'session-init',
      bunPath,
      workerServicePath,
      platform
    );
    const contextWrapper = writeCursorHookWrapper(
      hooksDir,
      'context',
      bunPath,
      workerServicePath,
      platform
    );
    const observationWrapper = writeCursorHookWrapper(
      hooksDir,
      'observation',
      bunPath,
      workerServicePath,
      platform
    );
    const fileEditWrapper = writeCursorHookWrapper(
      hooksDir,
      'file-edit',
      bunPath,
      workerServicePath,
      platform
    );
    const summarizeWrapper = writeCursorHookWrapper(
      hooksDir,
      'summarize',
      bunPath,
      workerServicePath,
      platform
    );

    const hooksJson: CursorHooksJson = {
      version: 1,
      hooks: {
        beforeSubmitPrompt: [
          { command: quoteHookCommandPath(sessionInitWrapper) },
          { command: quoteHookCommandPath(contextWrapper) }
        ],
        afterMCPExecution: [
          { command: quoteHookCommandPath(observationWrapper) }
        ],
        afterShellExecution: [
          { command: quoteHookCommandPath(observationWrapper) }
        ],
        afterFileEdit: [
          { command: quoteHookCommandPath(fileEditWrapper) }
        ],
        stop: [
          { command: quoteHookCommandPath(summarizeWrapper) }
        ]
      }
    };

    writeFileSync(hooksJsonPath, JSON.stringify(hooksJson, null, 2));
    console.log(`  Created hooks.json (wrapper mode)`);
    console.log(`  Created hook wrappers in: ${hooksDir}`);
    console.log(`  Worker service: ${workerServicePath}`);

    // For project-level: create initial context file
    if (target === 'project') {
      await setupProjectContext(targetDir, workspaceRoot);
    }

    console.log(`
Installation complete!

Hooks installed to: ${targetDir}/hooks.json
Using wrapper scripts: ${hooksDir}

Next steps:
  1. Start claude-mem worker: claude-mem start
  2. Restart Cursor to load the hooks
  3. Check Cursor Settings → Hooks tab to verify

Context Injection:
  Context from past sessions is stored in .cursor/rules/claude-mem-context.mdc
  and automatically included in every chat. It updates after each session ends.

Note:
  Wrapper scripts keep each Cursor hook command argument-free to avoid
  the current Node DEP0190 warning emitted by Cursor's hook runner.
`);

    return 0;
  } catch (error) {
    console.error(`\nInstallation failed: ${(error as Error).message}`);
    if (target === 'enterprise') {
      console.error('   Tip: Enterprise installation may require sudo/admin privileges');
    }
    return 1;
  }
}

/**
 * Setup initial context file for project-level installation
 */
async function setupProjectContext(targetDir: string, workspaceRoot: string): Promise<void> {
  const rulesDir = path.join(targetDir, 'rules');
  mkdirSync(rulesDir, { recursive: true });

  const port = getWorkerPort();
  const projectName = path.basename(workspaceRoot);
  let contextGenerated = false;

  console.log(`  Generating initial context...`);

  try {
    // Check if worker is running
    const healthResponse = await fetch(`http://127.0.0.1:${port}/api/readiness`);
    if (healthResponse.ok) {
      // Fetch context
      const contextResponse = await fetch(
        `http://127.0.0.1:${port}/api/context/inject?project=${encodeURIComponent(projectName)}`
      );
      if (contextResponse.ok) {
        const context = await contextResponse.text();
        if (context && context.trim()) {
          writeContextFile(workspaceRoot, context);
          contextGenerated = true;
          console.log(`  Generated initial context from existing memory`);
        }
      }
    }
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Fallback behavior - worker not running, use placeholder
    logger.debug('CURSOR', 'Worker not running during install', {}, error as Error);
  }

  if (!contextGenerated) {
    // Create placeholder context file
    const rulesFile = path.join(rulesDir, 'claude-mem-context.mdc');
    const placeholderContent = `---
alwaysApply: true
description: "Claude-mem context from past sessions (auto-updated)"
---

# Memory Context from Past Sessions

*No context yet. Complete your first session and context will appear here.*

Use claude-mem's MCP search tools for manual memory queries.
`;
    writeFileSync(rulesFile, placeholderContent);
    console.log(`  Created placeholder context file (will populate after first session)`);
  }

  // Register project for automatic context updates after summaries
  registerCursorProject(projectName, workspaceRoot);
  console.log(`  Registered for auto-context updates`);
}

/**
 * Uninstall Cursor hooks
 */
export function uninstallCursorHooks(target: CursorInstallTarget): number {
  console.log(`\nUninstalling Claude-Mem Cursor hooks (${target} level)...\n`);

  const targetDir = getTargetDir(target);
  if (!targetDir) {
    console.error(`Invalid target: ${target}`);
    return 1;
  }

  try {
    const hooksDir = path.join(targetDir, 'hooks');
    const hooksJsonPath = path.join(targetDir, 'hooks.json');

    // Remove current wrapper scripts and legacy shell scripts if they exist.
    const allScripts = [
      ...LEGACY_BASH_SCRIPTS,
      ...LEGACY_POWERSHELL_SCRIPTS,
      ...getCursorHookWrapperFiles('windows'),
      ...getCursorHookWrapperFiles('unix')
    ];

    for (const script of allScripts) {
      const scriptPath = path.join(hooksDir, script);
      if (existsSync(scriptPath)) {
        unlinkSync(scriptPath);
        console.log(`  Removed legacy script: ${script}`);
      }
    }

    // Remove hooks.json
    if (existsSync(hooksJsonPath)) {
      unlinkSync(hooksJsonPath);
      console.log(`  Removed hooks.json`);
    }

    // Remove context file and unregister if project-level
    if (target === 'project') {
      const contextFile = path.join(targetDir, 'rules', 'claude-mem-context.mdc');
      if (existsSync(contextFile)) {
        unlinkSync(contextFile);
        console.log(`  Removed context file`);
      }

      // Unregister from auto-context updates
      const projectName = path.basename(process.cwd());
      unregisterCursorProject(projectName);
      console.log(`  Unregistered from auto-context updates`);
    }

    console.log(`\nUninstallation complete!\n`);
    console.log('Restart Cursor to apply changes.');

    return 0;
  } catch (error) {
    console.error(`\nUninstallation failed: ${(error as Error).message}`);
    return 1;
  }
}

/**
 * Check Cursor hooks installation status
 */
export function checkCursorHooksStatus(): number {
  console.log('\nClaude-Mem Cursor Hooks Status\n');

  const locations: Array<{ name: string; dir: string }> = [
    { name: 'Project', dir: path.join(process.cwd(), '.cursor') },
    { name: 'User', dir: path.join(homedir(), '.cursor') },
  ];

  if (process.platform === 'darwin') {
    locations.push({ name: 'Enterprise', dir: '/Library/Application Support/Cursor' });
  } else if (process.platform === 'linux') {
    locations.push({ name: 'Enterprise', dir: '/etc/cursor' });
  }

  let anyInstalled = false;

  for (const loc of locations) {
    const hooksJson = path.join(loc.dir, 'hooks.json');
    const hooksDir = path.join(loc.dir, 'hooks');

    if (existsSync(hooksJson)) {
      anyInstalled = true;
      console.log(`${loc.name}: Installed`);
      console.log(`   Config: ${hooksJson}`);

      // Check if using unified CLI mode or legacy shell scripts
      try {
        const hooksContent = JSON.parse(readFileSync(hooksJson, 'utf-8'));
        const firstCommand = hooksContent?.hooks?.beforeSubmitPrompt?.[0]?.command || '';
        const hasWrapperScripts =
          getCursorHookWrapperFiles('windows').some(s => existsSync(path.join(hooksDir, s))) ||
          getCursorHookWrapperFiles('unix').some(s => existsSync(path.join(hooksDir, s)));

        if (firstCommand.includes('worker-service.cjs') && firstCommand.includes('hook cursor')) {
          console.log(`   Mode: Unified CLI (bun worker-service.cjs)`);
        } else if (hasWrapperScripts) {
          console.log(`   Mode: Unified CLI wrappers (single-command hook scripts)`);
        } else {
          // Detect legacy shell scripts
          const hasBash = LEGACY_BASH_SCRIPTS.some(s => existsSync(path.join(hooksDir, s)));
          const hasPs = LEGACY_POWERSHELL_SCRIPTS.some(s => existsSync(path.join(hooksDir, s)));

          if (hasBash || hasPs) {
            console.log(`   Mode: Legacy shell scripts (consider reinstalling for unified CLI)`);
            if (hasBash && hasPs) {
              console.log(`   Platform: Both (bash + PowerShell)`);
            } else if (hasBash) {
              console.log(`   Platform: Unix (bash)`);
            } else if (hasPs) {
              console.log(`   Platform: Windows (PowerShell)`);
            }
          } else {
            console.log(`   Mode: Unknown configuration`);
          }
        }
      } catch {
        console.log(`   Mode: Unable to parse hooks.json`);
      }

      // Check for context file (project only)
      if (loc.name === 'Project') {
        const contextFile = path.join(loc.dir, 'rules', 'claude-mem-context.mdc');
        if (existsSync(contextFile)) {
          console.log(`   Context: Active`);
        } else {
          console.log(`   Context: Not yet generated (will be created on first prompt)`);
        }
      }
    } else {
      console.log(`${loc.name}: Not installed`);
    }
    console.log('');
  }

  if (!anyInstalled) {
    console.log('No hooks installed. Run: claude-mem cursor install\n');
  }

  return 0;
}

/**
 * Detect if Claude Code is available
 * Checks for the Claude Code CLI and plugin directory
 */
export async function detectClaudeCode(): Promise<boolean> {
  try {
    // Check for Claude Code CLI
    const { stdout } = await execAsync('which claude || where claude', { timeout: 5000 });
    if (stdout.trim()) {
      return true;
    }
  } catch (error) {
    // [ANTI-PATTERN IGNORED]: Fallback behavior - CLI not found, continue to directory check
    logger.debug('SYSTEM', 'Claude CLI not in PATH', {}, error as Error);
  }

  // Check for Claude Code plugin directory (respects CLAUDE_CONFIG_DIR)
  const pluginDir = path.join(CLAUDE_CONFIG_DIR, 'plugins');
  if (existsSync(pluginDir)) {
    return true;
  }

  return false;
}

/**
 * Handle cursor subcommand for hooks installation
 */
export async function handleCursorCommand(subcommand: string, args: string[]): Promise<number> {
  switch (subcommand) {
    case 'install': {
      const target = (args[0] || 'project') as CursorInstallTarget;
      return installCursorHooks(target);
    }

    case 'uninstall': {
      const target = (args[0] || 'project') as CursorInstallTarget;
      return uninstallCursorHooks(target);
    }

    case 'status': {
      return checkCursorHooksStatus();
    }

    case 'setup': {
      // Interactive guided setup - handled by main() in worker-service.ts
      // This is a placeholder that should not be reached
      console.log('Use the main entry point for setup');
      return 0;
    }

    default: {
      console.log(`
Claude-Mem Cursor Integration

Usage: claude-mem cursor <command> [options]

Commands:
  setup               Interactive guided setup (recommended for first-time users)

  install [target]    Install Cursor hooks
                      target: project (default), user, or enterprise

  uninstall [target]  Remove Cursor hooks
                      target: project (default), user, or enterprise

  status              Check installation status

Examples:
  npm run cursor:setup                   # Interactive wizard (recommended)
  npm run cursor:install                 # Install for current project
  claude-mem cursor install user         # Install globally for user
  claude-mem cursor uninstall            # Remove from current project
  claude-mem cursor status               # Check if hooks are installed

For more info: https://docs.claude-mem.ai/cursor
      `);
      return 0;
    }
  }
}
