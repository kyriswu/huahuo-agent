import { z } from 'zod';
import { resolveHuahuoServerBaseUrl } from '../server/base-url.js';
import { trustedIdentityHeaders, type TrustedHuahuoIdentity } from '../auth/trusted-identity.js';

export class StudioLoginError extends Error {
  constructor(readonly code: string, readonly status = 401) { super(code); }
}

const tokenSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  accessTokenExpiresAt: z.string().datetime(),
});
const userSchema = z.object({ userId: z.string().uuid(), displayName: z.string(), phoneMasked: z.string() });
const loginSchema = tokenSchema.extend({ user: userSchema });
const smsSchema = z.object({ smsRequestId: z.string().uuid(), cooldownSeconds: z.number().int().min(1).max(600) });
export type StudioTokens = z.infer<typeof tokenSchema>;
export type StudioUser = z.infer<typeof userSchema>;

export class StudioIdentityClient {
  constructor(private readonly baseUrl = resolveHuahuoServerBaseUrl()) {}

  async sendCode(phone: string, requestId: string) {
    return this.parse(smsSchema, await this.request('/api/v1/auth/sms-code', { phone, purpose: 'sign_in' }, requestId));
  }

  async login(input: Record<string, unknown>, requestId: string) {
    return this.parse(loginSchema, await this.request('/api/v1/auth/login', input, requestId));
  }

  async logout(identity: TrustedHuahuoIdentity): Promise<void> {
    await this.request('/api/v1/auth/logout', undefined, undefined, identity);
  }

  private parse<T>(schema: z.ZodType<T>, data: unknown): T {
    const result = schema.safeParse(data);
    if (!result.success) throw new StudioLoginError('SERVER_RESPONSE_INVALID', 502);
    return result.data;
  }

  private async request(path: string, body?: unknown, requestId?: string, identity?: TrustedHuahuoIdentity): Promise<unknown> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (requestId) headers['x-idempotency-key'] = requestId;
    if (identity) Object.assign(headers, trustedIdentityHeaders(identity));
    let response: Response;
    try {
      // No automatic retry: sending SMS and rotating refresh tokens are stateful operations.
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(20_000), redirect: 'error',
      });
    } catch { throw new StudioLoginError('SERVER_UNAVAILABLE', 503); }
    let envelope: { success?: unknown; data?: unknown; error?: { code?: unknown } };
    try { envelope = await response.json(); } catch { throw new StudioLoginError('SERVER_RESPONSE_INVALID', 502); }
    if (!response.ok || envelope?.success !== true) {
      const code = envelope?.error?.code;
      const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/u.test(code) ? code : 'SERVER_REQUEST_FAILED';
      throw new StudioLoginError(safeCode, [400, 401, 403, 409, 412, 429, 503].includes(response.status) ? response.status : 502);
    }
    return envelope.data;
  }
}
