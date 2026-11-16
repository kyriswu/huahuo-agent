import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Script } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { adaptStudioHtml } from '../src/studio/public-prefix.js';

describe('installed Mastra Studio prefix contract', () => {
  it('adapts the installed official runtime configuration without rewriting assets', async () => {
    const cli = createRequire(import.meta.url).resolve('mastra');
    const source = await readFile(join(dirname(cli), 'studio/index.html'), 'utf8');
    // Native studioBase performs this substitution in the generated server.
    const nativeHtml = source.replaceAll('%%MASTRA_STUDIO_BASE_PATH%%', '/agent');
    const html = adaptStudioHtml(nativeHtml, '/agent');
    expect(html).toContain('<base href="/agent/"');
    expect(html).toContain("window.MASTRA_API_PREFIX = '/agent/api';");
    expect(html).toContain("window.MASTRA_AUTO_DETECT_URL = 'true';");
    expect(html).toContain("window.MASTRA_STUDIO_BASE_PATH = '/agent';");
    expect(html.match(/<script type="module"[^>]+>/gu)).toEqual(source.match(/<script type="module"[^>]+>/gu));
    const context = { window: { localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false }), addEventListener: () => undefined }, document: { documentElement: { className: '' } }, EventSource: class { close() {} } };
    new Script(/<script>([\s\S]*?)<\/script>/u.exec(html)![1]).runInNewContext(context);
    expect((context.window as unknown as Record<string, string>).MASTRA_API_PREFIX).toBe('/agent/api');
  });
  it('rejects changed/missing config assignments instead of silently sending requests to Server', () => {
    expect(() => adaptStudioHtml('<html>new vendor layout</html>', '/agent')).toThrow('INCOMPATIBLE');
  });
});
