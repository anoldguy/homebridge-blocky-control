/**
 * Minimal client for blocky's REST API.
 * https://0xerr0r.github.io/blocky/latest/rest-api/
 */

export interface BlockingStatus {
  /** true when blocking is active */
  enabled: boolean;
  /** groups that are currently disabled (empty when all groups are affected) */
  disabledGroups?: string[];
  /** seconds until blocking is automatically re-enabled (0 = no timer) */
  autoEnableInSec?: number;
}

export class BlockyApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'BlockyApiError';
  }
}

export interface BlockyClientOptions {
  /** Base URL of blocky's HTTP listener, e.g. http://192.168.1.2:4000 */
  url: string;
  /** Only disable these blocking groups (default: all groups) */
  groups?: string[];
  /** Per-request timeout in milliseconds */
  timeoutMs: number;
}

export class BlockyClient {
  private readonly baseUrl: string;

  constructor(private readonly options: BlockyClientOptions) {
    // tolerate a trailing slash or an explicit /api suffix in the config
    this.baseUrl = options.url.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  }

  async status(): Promise<BlockingStatus> {
    const body = await this.request('/api/blocking/status');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new BlockyApiError(`Unexpected status response from blocky: ${body.slice(0, 200)}`);
    }
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as BlockingStatus).enabled !== 'boolean') {
      throw new BlockyApiError(`Unexpected status response from blocky: ${body.slice(0, 200)}`);
    }
    return parsed as BlockingStatus;
  }

  async enable(): Promise<void> {
    await this.request('/api/blocking/enable');
  }

  /**
   * Disable blocking.
   * @param minutes how long to disable for; omit (or 0) to disable until re-enabled
   */
  async disable(minutes?: number): Promise<void> {
    const params = new URLSearchParams();
    if (minutes && minutes > 0) {
      params.set('duration', `${minutes}m`);
    }
    if (this.options.groups && this.options.groups.length > 0) {
      params.set('groups', this.options.groups.join(','));
    }
    const query = params.toString();
    await this.request(`/api/blocking/disable${query ? `?${query}` : ''}`);
  }

  private async request(path: string): Promise<string> {
    const url = `${this.baseUrl}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new BlockyApiError(`Could not reach blocky at ${url}: ${reason}`);
    }
    const body = await response.text();
    if (!response.ok) {
      throw new BlockyApiError(`blocky returned HTTP ${response.status} for ${path}: ${body.trim().slice(0, 200)}`, response.status);
    }
    return body;
  }
}
