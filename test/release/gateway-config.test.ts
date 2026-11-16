import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveHuahuoServerBaseUrl } from '../../src/server/base-url.js';

const verifier = fileURLToPath(new URL('../../scripts/release/changes/20261116-agent-native-ingress/verify-config.mjs', import.meta.url));
const candidate = {
  APP_ENV: 'test',
  HUAHUO_AGENT_PUBLIC_PATH: '/agent',
  HUAHUO_SERVER_BASE_URL: 'http://server-internal:13001',
  HUAHUO_STUDIO_AUTH_ENABLED: 'true',
  HUAHUO_STUDIO_ORIGIN: 'https://test-api.chuda.cc',
};

function verify(patch: Record<string, string | undefined> = {}) {
  const result = spawnSync(process.execPath, [verifier], {
    env: { ...candidate, ...patch }, encoding: 'utf8', timeout: 5_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  return result.status;
}

describe('gateway release configuration', () => {
  it.each(['http://api-server:3000', 'http://10.0.0.8:13001', 'http://[fd00::8]:13001', 'https://server.internal:8443///'])(
    'keeps IP and service-name origins consistent with the application (%s)', baseUrl => {
      expect(() => resolveHuahuoServerBaseUrl(baseUrl, { APP_ENV: 'production' })).not.toThrow();
      expect(verify({ HUAHUO_SERVER_BASE_URL: baseUrl })).toBe(0);
    },
  );

  it.each([
    { HUAHUO_AGENT_PUBLIC_PATH: '/other' },
    { HUAHUO_STUDIO_ORIGIN: 'https://test-agent.chuda.cc' },
    { HUAHUO_STUDIO_ORIGIN: 'http://test-api.chuda.cc' },
    { HUAHUO_STUDIO_ORIGIN: 'https://test-api.chuda.cc:8443' },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'enabled' },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'false' },
    { HUAHUO_STUDIO_AUTH_ENABLED: undefined },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'false', HUAHUO_STUDIO_ORIGIN: undefined },
    { HUAHUO_STUDIO_AUTH_ENABLED: 'false', HUAHUO_STUDIO_ORIGIN: 'https://test-api.chuda.cc/agent' },
    { APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'true' },
    { APP_ENV: ' test ' },
    { APP_ENV: 'invalid' },
  ])('rejects incompatible public routing or Studio configuration (%#)', patch => {
    expect(verify(patch)).toBe(1);
  });

  it.each(['http://server:65536', 'http://user:fixture@server', 'http://server/api/v1', 'http://server?token=fixture', 'http://server#fragment', 'ftp://server', ''])(
    'rejects invalid or secret-bearing Server origins without output (%#)', baseUrl => {
      expect(verify({ HUAHUO_SERVER_BASE_URL: baseUrl })).toBe(1);
    },
  );

  it.each(['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000'])(
    'enforces the application production loopback rule (%s)', baseUrl => {
      expect(verify({ APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'false', HUAHUO_SERVER_BASE_URL: baseUrl })).toBe(1);
    },
  );

  it('accepts a private production target with Studio explicitly disabled', () => {
    expect(verify({ APP_ENV: 'production', HUAHUO_STUDIO_AUTH_ENABLED: 'false', HUAHUO_STUDIO_ORIGIN: 'https://api.example.com' })).toBe(0);
  });
});
