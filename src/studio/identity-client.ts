import { z } from 'zod';
import { ServerHttpClient, ServerRequestError } from '../server/http-client.js';

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

export interface StudioLoginInput {
  phone: string;
  smsRequestId: string;
  smsCode: string;
  clientType: 'app' | 'web';
  clientId: string;
  agreementAccepted: boolean;
  agreementVersion: string;
  privacyVersion: string;
  clientVersion: string;
  timeZone?: string;
}

export class StudioIdentityClient {
  private readonly http: ServerHttpClient;

  constructor(baseUrl?: string) {
    this.http = new ServerHttpClient({ baseUrl });
  }

  async sendCode(phone: string, requestId: string, signal?: AbortSignal) {
    return this.request('/api/v1/auth/sms-code', { phone, purpose: 'sign_in' }, smsSchema, requestId, signal);
  }

  async login(input: StudioLoginInput, requestId: string, signal?: AbortSignal) {
    return this.request('/api/v1/auth/login', input, loginSchema, requestId, signal);
  }

  private async request<T>(path: string, body: unknown, schema: z.ZodType<T>, requestId: string, signal?: AbortSignal): Promise<T> {
    try {
      // No automatic retry: sending SMS and issuing login tokens are stateful operations.
      return await this.http.post(path, body, schema, {
        authentication: 'none', idempotencyKey: requestId, signal,
      });
    } catch (error) {
      if (!(error instanceof ServerRequestError)) throw error;
      if (['network', 'timeout', 'cancelled'].includes(error.kind)) throw new StudioLoginError('SERVER_UNAVAILABLE', 503);
      if (error.kind === 'response') throw new StudioLoginError('SERVER_RESPONSE_INVALID', 502);
      const status = error.status !== undefined && [400, 401, 403, 409, 412, 429, 503].includes(error.status) ? error.status : 502;
      throw new StudioLoginError(error.code, status);
    }
  }
}
