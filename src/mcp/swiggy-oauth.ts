import * as crypto from 'node:crypto';

import type { OrderStore } from '../orders/order-store.js';

const DISCOVERY_URL = 'https://mcp.swiggy.com/.well-known/oauth-authorization-server';
const REDIRECT_URI = 'http://localhost/callback';
const CLIENT_NAME = 'ordering-mcp';
const SCOPES = 'mcp:tools mcp:resources mcp:prompts';

interface DiscoveryMeta {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

function b64url(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export class SwiggyOAuth {
  private discoveryCache: DiscoveryMeta | null = null;

  constructor(private readonly store: OrderStore) {}

  async beginAuth(): Promise<{ authUrl: string; redirectUri: string }> {
    const meta = await this.discover();
    const clientId = await this.register(meta.registration_endpoint);

    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const state = b64url(crypto.randomBytes(16));

    this.store.saveMcpAuthFlow({ state, codeVerifier: verifier, clientId });

    const authUrl = new URL(meta.authorization_endpoint);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('client_id', clientId);
    authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('state', state);
    authUrl.searchParams.set('code_challenge', challenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');

    return { authUrl: authUrl.toString(), redirectUri: REDIRECT_URI };
  }

  async completeAuth(callbackUrl: string): Promise<{ expiresAt: number }> {
    const { code, state } = parseCallback(callbackUrl);

    const flow = this.store.getMcpAuthFlow(state);
    if (!flow) {
      throw new Error('Unknown or expired auth flow. Run `!login` again.');
    }

    const meta = await this.discover();
    const token = await this.exchangeCode(
      meta.token_endpoint,
      flow.clientId,
      code,
      flow.codeVerifier,
    );

    const expiresAt = Date.now() + (token.expires_in - 30) * 1000;
    this.store.saveMcpToken({
      accessToken: token.access_token,
      expiresAt,
      scope: token.scope,
    });
    this.store.setMcpAuth('authenticated');
    this.store.deleteMcpAuthFlow(state);

    return { expiresAt };
  }

  async getAccessToken(): Promise<string> {
    const token = this.store.getMcpToken();
    if (!token) {
      throw new McpAuthError('Not authenticated. Run `!login` in the allowed group.');
    }
    if (Date.now() >= token.expiresAt) {
      this.store.setMcpAuth('disconnected');
      throw new McpAuthError('Swiggy MCP token expired. Run `!login` to re-auth.');
    }
    return token.accessToken;
  }

  disconnect(): void {
    this.store.clearMcpToken();
    this.store.setMcpAuth('disconnected');
  }

  private async discover(): Promise<DiscoveryMeta> {
    if (this.discoveryCache) return this.discoveryCache;

    const res = await fetch(DISCOVERY_URL, { headers: { accept: 'application/json' } });
    if (!res.ok) {
      throw new Error(`OAuth discovery failed (${res.status}): ${await res.text()}`);
    }
    const meta = (await res.json()) as DiscoveryMeta;
    this.discoveryCache = meta;
    return meta;
  }

  private async register(endpoint: string): Promise<string> {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [REDIRECT_URI],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPES,
      }),
    });
    if (!res.ok) {
      throw new Error(`DCR failed (${res.status}): ${await res.text()}`);
    }
    const body = (await res.json()) as { client_id: string };
    return body.client_id;
  }

  private async exchangeCode(
    tokenEndpoint: string,
    clientId: string,
    code: string,
    verifier: string,
  ): Promise<TokenResponse> {
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: clientId,
      code_verifier: verifier,
    });
    const res = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    });
    if (!res.ok) {
      throw new Error(`Token exchange failed (${res.status}): ${await res.text()}`);
    }
    return (await res.json()) as TokenResponse;
  }
}

export class McpAuthError extends Error {}

function parseCallback(pasted: string): { code: string; state: string } {
  let url: URL;
  try {
    url = new URL(pasted.trim());
  } catch {
    throw new Error(`Not a valid URL: "${pasted.slice(0, 80)}"`);
  }
  const err = url.searchParams.get('error');
  if (err) {
    const desc = url.searchParams.get('error_description') ?? '';
    throw new Error(`OAuth error: ${err}${desc ? ` — ${desc}` : ''}`);
  }
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) {
    throw new Error('Callback URL missing `code` or `state` parameter.');
  }
  return { code, state };
}
