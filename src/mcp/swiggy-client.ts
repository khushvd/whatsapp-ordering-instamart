import type { SwiggyOAuth } from './swiggy-oauth.js';

const PROTOCOL_VERSION = '2025-03-26';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class SwiggyMcpClient {
  private sessionId: string | undefined;
  private initialized = false;
  private requestId = 0;

  constructor(
    private readonly mcpUrl: string,
    private readonly oauth: SwiggyOAuth,
  ) {}

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    await this.ensureInitialized();

    const payload = await this.rpc('tools/call', { name, arguments: args });
    return payload.result;
  }

  async listTools(): Promise<McpTool[]> {
    await this.ensureInitialized();
    const payload = await this.rpc('tools/list', {});
    const result = payload.result as { tools?: McpTool[] } | undefined;
    return result?.tools ?? [];
  }

  /** Drop cached session state. Next call reinitializes. */
  reset(): void {
    this.sessionId = undefined;
    this.initialized = false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    const initPayload = await this.rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'ordering-mcp', version: '0.1.0' },
    });
    if (initPayload.error) {
      throw new Error(`MCP initialize failed: ${initPayload.error.message}`);
    }

    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });

    this.initialized = true;
  }

  private async rpc(method: string, params: unknown): Promise<JsonRpcResponse> {
    this.requestId += 1;
    const id = this.requestId;
    const body = { jsonrpc: '2.0', id, method, params };

    const { data } = await this.post(body);
    const picked = pickResponse(data, id);
    if (!picked) {
      throw new Error(`No MCP response matched request id ${id} for ${method}`);
    }
    if (picked.error) {
      throw new Error(`MCP ${method} error: ${picked.error.message}`);
    }
    return picked;
  }

  private async post(body: unknown): Promise<{ data: JsonRpcResponse | JsonRpcResponse[] | null }> {
    const accessToken = await this.oauth.getAccessToken();

    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${accessToken}`,
      'mcp-protocol-version': PROTOCOL_VERSION,
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;

    const res = await fetch(this.mcpUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      redirect: 'manual',
    });

    const newSession = res.headers.get('mcp-session-id');
    if (newSession) this.sessionId = newSession;

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || '(none)';
      throw new Error(`MCP POST redirect ${res.status} from ${this.mcpUrl} → ${loc}`);
    }

    const text = await res.text();

    if (!res.ok) {
      const ct = res.headers.get('content-type') || '';
      throw new Error(`MCP POST ${res.status} url=${res.url} ct=${ct}: ${text.slice(0, 200)}`);
    }
    if (res.status === 202 || text.trim() === '') {
      return { data: null };
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const frames = parseSse(text).map((f) => JSON.parse(f) as JsonRpcResponse);
      return { data: frames.length === 1 ? frames[0] : frames };
    }

    return { data: JSON.parse(text) as JsonRpcResponse };
  }
}

function pickResponse(
  data: JsonRpcResponse | JsonRpcResponse[] | null,
  id: number,
): JsonRpcResponse | null {
  if (!data) return null;
  if (Array.isArray(data)) return data.find((d) => d && d.id === id) ?? null;
  return data;
}

function parseSse(raw: string): string[] {
  const frames: string[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const dataLines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart());
    if (dataLines.length) frames.push(dataLines.join('\n'));
  }
  return frames;
}
