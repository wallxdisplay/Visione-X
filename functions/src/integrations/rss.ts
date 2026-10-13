/**
 * Minimal RSS 2.0 / RSS 1.0 (RDF) / Atom reader: extracts the feed title and item titles with
 * dates. Everything is reduced to plain text (tags stripped, entities decoded, whitespace
 * collapsed, length-capped), so nothing from a feed is ever rendered as HTML on a screen.
 */
import { RSS_MAX_ITEMS, type RssData, type RssItem } from '@visione-x/shared';

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', rupee: '₹' };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

/** Feed text → safe plain text. */
export function plainText(raw: string, max = 300): string {
  let s = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Entity-encoded markup (common in titles) is decoded first, then all tags are removed.
  s = decodeEntities(s);
  s = s.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ');
  s = decodeEntities(s); // double-encoded entities
  // Drop control characters, keep normal whitespace.
  // eslint-disable-next-line no-control-regex -- stripping control characters is the point
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const tag = (xml: string, name: string): string | null => {
  const m = new RegExp(`<(?:[a-z0-9]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[a-z0-9]+:)?${name}>`, 'i').exec(xml);
  return m ? m[1]! : null;
};

function parseDate(s: string | null): number | null {
  if (!s) return null;
  const t = Date.parse(plainText(s, 100));
  return Number.isFinite(t) ? t : null;
}

export class FeedError extends Error {}

export function parseFeed(xml: string, maxItems = RSS_MAX_ITEMS): RssData {
  const head = xml.slice(0, 20000);
  if (!/<(rss|feed|rdf:rdf)[\s>]/i.test(head)) throw new FeedError('This address does not return an RSS or Atom feed.');
  const isAtom = /<feed[\s>]/i.test(head);
  const blocks = xml.match(isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  // Channel/feed title: the first <title> outside any item.
  const firstItem = xml.search(isAtom ? /<entry[\s>]/i : /<item[\s>]/i);
  const beforeItems = firstItem === -1 ? xml : xml.slice(0, firstItem);
  const feedTitle = plainText(tag(beforeItems, 'title') ?? '', 120);

  const items: RssItem[] = [];
  for (const block of blocks) {
    const title = plainText(tag(block, 'title') ?? '', 300);
    if (!title) continue;
    const date = isAtom ? (tag(block, 'published') ?? tag(block, 'updated')) : (tag(block, 'pubDate') ?? tag(block, 'date'));
    items.push({ title, publishedAt: parseDate(date) });
    if (items.length >= maxItems) break;
  }
  if (items.length === 0 && blocks.length === 0) throw new FeedError('The feed has no items.');
  return { feedTitle, items };
}
