/**
 * Outbound HTTP for integrations, with SSRF protection: feed URLs come from customers, so the
 * server must never be tricked into calling internal addresses (metadata server, VPC, localhost).
 * Every hop (including redirects) is resolved and checked; bodies are size-capped and timed out.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { Deps } from '../lib/context';

export class FetchError extends Error {}

/** Loopback, private, link-local, CGNAT, multicast, reserved and IPv6 equivalents. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x);
  }
  return true; // not an IP at all: refuse
}

const defaultLookup = async (host: string) => (await dnsLookup(host, { all: true, verbatim: true })).map((r) => r.address);

async function assertPublic(deps: Deps, url: URL): Promise<void> {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new FetchError('Only http and https addresses are allowed.');
  if (url.port && url.port !== '80' && url.port !== '443') throw new FetchError('Only the standard web ports (80, 443) are allowed.');
  if (url.username || url.password) throw new FetchError('Addresses with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  try {
    addresses = isIP(host) ? [host] : await (deps.lookup ?? defaultLookup)(host);
  } catch {
    throw new FetchError('The address could not be found.');
  }
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new FetchError('This address is not reachable from Visione-X.');
}

/**
 * GET with SSRF checks on every hop, at most 3 redirects, a timeout and a body size cap.
 * Returns the body as text.
 */
export async function safeGet(
  deps: Deps,
  rawUrl: string,
  { maxBytes, timeoutMs = 8_000, accept }: { maxBytes: number; timeoutMs?: number; accept?: string },
): Promise<string> {
  const fetchImpl = deps.fetch ?? fetch;
  let url = new URL(rawUrl);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(deps, url);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'Visione-X/1.0 (+https://visione-x.web.app)', ...(accept ? { Accept: accept } : {}) },
      });
    } catch (err) {
      throw new FetchError((err as Error).name === 'TimeoutError' ? 'The server took too long to answer.' : 'The server could not be reached.');
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      url = new URL(res.headers.get('location')!, url);
      continue;
    }
    if (!res.ok) throw new FetchError(`The server answered with HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new FetchError('The response is too large.');
    const reader = res.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new FetchError('The response is too large.');
      }
      chunks.push(value);
    }
    return new TextDecoder('utf-8').decode(Buffer.concat(chunks));
  }
  throw new FetchError('Too many redirects.');
}
