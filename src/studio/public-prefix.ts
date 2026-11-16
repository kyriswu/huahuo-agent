import type { Middleware } from '@mastra/core/server';

/**
 * Native studioBase owns assets and SPA navigation. Mastra currently shares
 * apiPrefix between internal routes and the browser: adapt only its runtime
 * HTML configuration, never vendor sources, JS assets, or build output.
 * The installed-template test guards this contract on framework upgrades.
 */
export function adaptStudioHtml(html: string, publicPath: string): string {
  if (!/^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/u.test(publicPath)) throw new Error('HUAHUO_AGENT_PUBLIC_PATH_INVALID');
  const replacements = [
    [/window\.MASTRA_API_PREFIX\s*=\s*(['"])[^'"\r\n]*\1\s*;/gu, `window.MASTRA_API_PREFIX = '${publicPath}/api';`],
    [/window\.MASTRA_AUTO_DETECT_URL\s*=\s*(['"])[^'"\r\n]*\1\s*;/gu, "window.MASTRA_AUTO_DETECT_URL = 'true';"],
  ] as const;
  for (const [pattern, value] of replacements) {
    if ([...html.matchAll(pattern)].length !== 1) throw new Error('STUDIO_PUBLIC_CONFIG_INCOMPATIBLE');
    html = html.replace(pattern, () => value);
  }
  return html;
}

export function createStudioPrefixMiddleware(publicPath: string): Middleware {
  return async (c, next) => {
    await next();
    if (!(c.req.path === publicPath || c.req.path.startsWith(`${publicPath}/`)) || c.req.method !== 'GET'
      || !c.res.ok || !c.res.headers.get('content-type')?.includes('text/html')) return;
    try {
      const html = adaptStudioHtml(await c.res.text(), publicPath);
      const headers = new Headers(c.res.headers);
      headers.delete('content-length');
      headers.delete('etag');
      headers.set('cache-control', 'no-store');
      c.res = new Response(html, { status: c.res.status, headers });
    } catch {
      c.res = Response.json({ error: { code: 'STUDIO_PUBLIC_CONFIG_INCOMPATIBLE' } }, { status: 503 });
    }
  };
}
