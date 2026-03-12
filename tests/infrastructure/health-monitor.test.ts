import { describe, it, expect, afterEach, mock } from 'bun:test';
import { createServer } from 'node:net';
import {
  isPortInUse,
  waitForHealth,
  waitForPortFree,
  getInstalledPluginVersion,
  checkVersionMatch
} from '../../src/services/infrastructure/index.js';

async function listenOnEphemeralPort() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve ephemeral port');
  }

  return { server, port: address.port };
}

async function closeServer(server: ReturnType<typeof createServer>) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

describe('HealthMonitor', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('isPortInUse', () => {
    it('should return true for a raw TCP listener even without HTTP health responses', async () => {
      const { server, port } = await listenOnEphemeralPort();

      try {
        await expect(isPortInUse(port)).resolves.toBe(true);
      } finally {
        await closeServer(server);
      }
    });

    it('should return false for a free port', async () => {
      const { server, port } = await listenOnEphemeralPort();
      await closeServer(server);

      await expect(isPortInUse(port)).resolves.toBe(false);
    });
  });

  describe('waitForHealth', () => {
    it('should succeed immediately when server responds', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));

      const start = Date.now();
      const result = await waitForHealth(37777, 5000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });

    it('should timeout when no server responds', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const start = Date.now();
      const result = await waitForHealth(39999, 1500);
      const elapsed = Date.now() - start;

      expect(result).toBe(false);
      expect(elapsed).toBeGreaterThanOrEqual(1400);
      expect(elapsed).toBeLessThan(2500);
    });

    it('should succeed after server becomes available', async () => {
      let callCount = 0;
      global.fetch = mock(() => {
        callCount++;
        if (callCount < 3) {
          return Promise.reject(new Error('ECONNREFUSED'));
        }
        return Promise.resolve({ ok: true } as Response);
      });

      const result = await waitForHealth(37777, 5000);

      expect(result).toBe(true);
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should check health endpoint for liveness', async () => {
      const fetchMock = mock(() => Promise.resolve({ ok: true } as Response));
      global.fetch = fetchMock;

      await waitForHealth(37777, 1000);

      const calls = fetchMock.mock.calls;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0][0]).toBe('http://127.0.0.1:37777/api/health');
    });

    it('should use default timeout when not specified', async () => {
      global.fetch = mock(() => Promise.resolve({ ok: true } as Response));

      const result = await waitForHealth(37777);

      expect(result).toBe(true);
    });
  });

  describe('getInstalledPluginVersion', () => {
    it('should return a valid semver string', () => {
      const version = getInstalledPluginVersion();

      if (version !== 'unknown') {
        expect(version).toMatch(/^\d+\.\d+\.\d+/);
      }
    });

    it('should not throw on ENOENT (graceful degradation)', () => {
      expect(() => getInstalledPluginVersion()).not.toThrow();
    });
  });

  describe('checkVersionMatch', () => {
    it('should assume match when worker version is unavailable', async () => {
      global.fetch = mock(() => Promise.reject(new Error('ECONNREFUSED')));

      const result = await checkVersionMatch(39999);

      expect(result.matches).toBe(true);
      expect(result.workerVersion).toBeNull();
    });

    it('should detect version mismatch', async () => {
      global.fetch = mock(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: '0.0.0-definitely-wrong' })
      } as Response));

      const result = await checkVersionMatch(37777);
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion !== 'unknown' && pluginVersion !== '0.0.0-definitely-wrong') {
        expect(result.matches).toBe(false);
      }
    });

    it('should detect version match', async () => {
      const pluginVersion = getInstalledPluginVersion();
      if (pluginVersion === 'unknown') return;

      global.fetch = mock(() => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: pluginVersion })
      } as Response));

      const result = await checkVersionMatch(37777);

      expect(result.matches).toBe(true);
      expect(result.pluginVersion).toBe(pluginVersion);
      expect(result.workerVersion).toBe(pluginVersion);
    });
  });

  describe('waitForPortFree', () => {
    it('should stay false while a non-HTTP listener still occupies the port', async () => {
      const { server, port } = await listenOnEphemeralPort();

      try {
        await expect(waitForPortFree(port, 250)).resolves.toBe(false);
      } finally {
        await closeServer(server);
      }
    });

    it('should return true after the listener is closed', async () => {
      const { server, port } = await listenOnEphemeralPort();
      await closeServer(server);

      await expect(waitForPortFree(port, 1000)).resolves.toBe(true);
    });

    it('should return true immediately when port is already free', async () => {
      const { server, port } = await listenOnEphemeralPort();
      await closeServer(server);

      const start = Date.now();
      const result = await waitForPortFree(port, 1000);
      const elapsed = Date.now() - start;

      expect(result).toBe(true);
      expect(elapsed).toBeLessThan(1000);
    });
  });
});
