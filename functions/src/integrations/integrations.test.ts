import { describe, expect, it } from 'vitest';
import type { Deps } from '../lib/context';
import { FetchError, isPrivateAddress, safeGet } from './net';
import { FeedError, parseFeed, plainText } from './rss';
import { normalizeWeather } from './weather';

describe('isPrivateAddress', () => {
  it('blocks internal ranges and allows public ones', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '142.250.183.14', '2606:4700::1111']) expect(isPrivateAddress(ip), ip).toBe(false);
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

const response = (body: string, init: ResponseInit = {}) => new Response(body, init);
const deps = (routes: Record<string, () => Response>, dns: Record<string, string[]>): Deps =>
  ({
    fetch: (async (url: URL | string) => {
      const route = routes[String(url)];
      if (!route) throw new Error(`unexpected ${String(url)}`);
      return route();
    }) as typeof fetch,
    lookup: async (host: string) => dns[host] ?? [],
  }) as Deps;

describe('safeGet', () => {
  it('fetches public addresses and follows safe redirects', async () => {
    const d = deps(
      { 'https://news.example/rss': () => response('', { status: 301, headers: { location: 'https://cdn.example/feed.xml' } }), 'https://cdn.example/feed.xml': () => response('<rss/>') },
      { 'news.example': ['93.184.216.34'], 'cdn.example': ['93.184.216.35'] },
    );
    expect(await safeGet(d, 'https://news.example/rss', { maxBytes: 1000 })).toBe('<rss/>');
  });

  it('refuses internal targets, including via redirect, odd ports and oversized bodies', async () => {
    const d = deps(
      {
        'https://evil.example/x': () => response('', { status: 302, headers: { location: 'http://169.254.169.254/computeMetadata/v1/' } }),
        'https://big.example/x': () => response('x'.repeat(2000)),
      },
      { 'evil.example': ['93.184.216.34'], 'internal.example': ['10.0.0.5'], 'big.example': ['93.184.216.36'] },
    );
    await expect(safeGet(d, 'https://internal.example/feed', { maxBytes: 1000 })).rejects.toThrow(FetchError);
    await expect(safeGet(d, 'https://evil.example/x', { maxBytes: 1000 })).rejects.toThrow('not reachable');
    await expect(safeGet(d, 'https://big.example:8443/x', { maxBytes: 1000 })).rejects.toThrow('standard web ports');
    await expect(safeGet(d, 'https://big.example/x', { maxBytes: 1000 })).rejects.toThrow('too large');
    await expect(safeGet(d, 'file:///etc/passwd', { maxBytes: 1000 })).rejects.toThrow('http and https');
  });
});

describe('feeds', () => {
  it('reduces feed text to safe plain text', () => {
    expect(plainText('<![CDATA[Sensex <b>up</b> 2%]]>')).toBe('Sensex up 2%');
    expect(plainText('&lt;script&gt;alert(1)&lt;/script&gt;Headline &amp; more')).toBe('Headline & more');
    expect(plainText('मुंबई&#8217;s rain &#x20B9;5')).toBe('मुंबई’s rain ₹5');
    expect(plainText('a'.repeat(400), 10)).toBe('aaaaaaaaa…');
  });

  it('reads RSS 2.0 and Atom', () => {
    const rss = `<?xml version="1.0"?><rss version="2.0"><channel><title>City News</title>
      <item><title><![CDATA[Metro line opens]]></title><pubDate>Mon, 12 Oct 2026 08:00:00 +0530</pubDate></item>
      <item><title>Rain alert &amp; traffic</title></item><item><title></title></item></channel></rss>`;
    expect(parseFeed(rss)).toEqual({
      feedTitle: 'City News',
      items: [
        { title: 'Metro line opens', publishedAt: Date.UTC(2026, 9, 12, 2, 30) },
        { title: 'Rain alert & traffic', publishedAt: null },
      ],
    });
    const atom = `<feed xmlns="http://www.w3.org/2005/Atom"><title type="text">Blog</title>
      <entry><title>First</title><updated>2026-10-01T10:00:00Z</updated></entry><entry><title>Second</title></entry></feed>`;
    expect(parseFeed(atom, 1)).toEqual({ feedTitle: 'Blog', items: [{ title: 'First', publishedAt: Date.UTC(2026, 9, 1, 10) }] });
  });

  it('rejects pages that are not feeds', () => {
    expect(() => parseFeed('<html><body>Hello</body></html>')).toThrow(FeedError);
  });
});

describe('normalizeWeather', () => {
  it('maps the Open-Meteo response', () => {
    const w = normalizeWeather({
      timezone: 'Asia/Kolkata',
      current: { temperature_2m: 31.4, apparent_temperature: 35.1, relative_humidity_2m: 62, wind_speed_10m: 11.2, weather_code: 2, is_day: 1 },
      daily: { time: ['2026-10-12', '2026-10-13'], weather_code: [2, 61], temperature_2m_max: [33, 30], temperature_2m_min: [24, 23] },
    });
    expect(w).toEqual({
      current: { tempC: 31.4, feelsLikeC: 35.1, humidity: 62, windKmh: 11.2, code: 2, isDay: true },
      daily: [
        { date: '2026-10-12', code: 2, maxC: 33, minC: 24 },
        { date: '2026-10-13', code: 61, maxC: 30, minC: 23 },
      ],
      timezone: 'Asia/Kolkata',
    });
    expect(() => normalizeWeather({ current: {} })).toThrow(FetchError);
  });
});
