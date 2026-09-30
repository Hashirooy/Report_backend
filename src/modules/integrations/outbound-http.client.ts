import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface OutboundRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface OutboundResponse {
  status: number;
  body: string;
  truncated: boolean;
}

/** A request that was refused or did not complete. The message is safe to store. */
export class OutboundRequestError extends Error {}

/**
 * Addresses a user-supplied URL must not reach: loopback, private networks,
 * link-local (cloud metadata lives at 169.254.169.254), CGNAT, multicast and
 * reserved ranges.
 */
const FORBIDDEN = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv4');
  }
  for (const [net, prefix] of [
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ] as const) {
    list.addSubnet(net, prefix, 'ipv6');
  }
  return list;
})();

export function isForbiddenAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return FORBIDDEN.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (family === 4) return FORBIDDEN.check(address, 'ipv4');
  if (family === 6) return FORBIDDEN.check(address, 'ipv6');
  return true;
}

/**
 * The one way integrations reach the network.
 *
 * The URL comes from a project's settings, so without these checks anyone with
 * the maintainer role could make the server call its own neighbours. The
 * address is checked inside the socket's DNS lookup, not before the request: a
 * name that resolves differently the second time cannot slip past. Redirects
 * are not followed, for the same reason.
 */
@Injectable()
export class OutboundHttpClient {
  private readonly allowedHosts: string[];
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(config: ConfigService) {
    this.allowedHosts = config.get<string[]>('integrations.allowedHosts') ?? [];
    this.timeoutMs = config.get<number>('integrations.timeoutMs') ?? 15_000;
    this.maxResponseBytes = config.get<number>('integrations.maxResponseBytes') ?? 1024 * 1024;
  }

  get timeout(): number {
    return this.timeoutMs;
  }

  /** Throws OutboundRequestError when the target is not acceptable. */
  assertTarget(rawUrl: string): URL {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new OutboundRequestError(`invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new OutboundRequestError(`unsupported scheme ${url.protocol}`);
    }
    if (url.username || url.password) {
      throw new OutboundRequestError('credentials in the URL are not accepted; put them in a header as {{secret}}');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowed = this.isAllowed(host);
    if (url.protocol === 'http:' && !allowed) {
      throw new OutboundRequestError(
        `plain http is only allowed for hosts listed in INTEGRATIONS_ALLOWED_HOSTS (${host} is not)`,
      );
    }
    if (isIP(host) && !allowed && isForbiddenAddress(host)) {
      throw new OutboundRequestError(
        `${host} is a private or reserved address; add it to INTEGRATIONS_ALLOWED_HOSTS to allow it`,
      );
    }
    return url;
  }

  send(request: OutboundRequest): Promise<OutboundResponse> {
    const url = this.assertTarget(request.url);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const allowed = this.isAllowed(host);

    const lookup = ((hostname: string, options: { family?: number; all?: boolean }, callback: (...args: unknown[]) => void) => {
      dnsLookup(hostname, { all: true, family: options.family ?? 0 }, (error, addresses: LookupAddress[]) => {
        if (error) return callback(error);
        const bad = allowed ? undefined : addresses.find((entry) => isForbiddenAddress(entry.address));
        if (bad) {
          return callback(
            new OutboundRequestError(
              `${hostname} resolves to a private or reserved address (${bad.address}); ` +
                'add it to INTEGRATIONS_ALLOWED_HOSTS to allow it',
            ),
          );
        }
        if (!addresses.length) return callback(new OutboundRequestError(`${hostname} did not resolve`));
        if (options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
      });
    }) as unknown as LookupFunction;

    const transport = url.protocol === 'https:' ? https : http;
    const body = Buffer.from(request.body, 'utf8');

    return new Promise<OutboundResponse>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        outcome();
      };

      const req = transport.request(
        url,
        {
          method: request.method,
          headers: { ...request.headers, 'content-length': String(body.length) },
          lookup,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          let truncated = false;
          const done = () =>
            finish(() =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
                truncated,
              }),
            );

          res.on('data', (chunk: Buffer) => {
            if (truncated) return;
            const room = this.maxResponseBytes - size;
            if (chunk.length > room) {
              chunks.push(chunk.subarray(0, room));
              truncated = true;
              done();
              res.destroy();
              return;
            }
            chunks.push(chunk);
            size += chunk.length;
          });
          res.on('end', done);
          res.on('error', (error) => finish(() => reject(wrap(error))));
        },
      );

      const timer = setTimeout(() => {
        req.destroy(new OutboundRequestError(`no complete response within ${this.timeoutMs} ms`));
      }, this.timeoutMs);

      req.on('error', (error) => finish(() => reject(wrap(error))));
      req.end(body);
    });
  }

  private isAllowed(host: string): boolean {
    return this.allowedHosts.some((entry) =>
      entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry,
    );
  }
}

const wrap = (error: Error): OutboundRequestError =>
  error instanceof OutboundRequestError
    ? error
    : new OutboundRequestError(`request failed: ${error.message}`);
