/** Builds small synthetic APKs (compiled manifest, zip, v2 signing block) for tests. */
import { deflateRawSync } from 'node:zlib';

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const lp = (...parts: Buffer[]) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length), body]); };

function stringPool(strings: string[]): Buffer {
  const data = strings.map((s) => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le'), u16(0)]));
  const offsets: number[] = [];
  let o = 0;
  for (const d of data) { offsets.push(o); o += d.length; }
  const headerSize = 28;
  const body = Buffer.concat(data);
  const size = headerSize + strings.length * 4 + body.length;
  return Buffer.concat([u16(0x0001), u16(headerSize), u32(size), u32(strings.length), u32(0), u32(0), u32(headerSize + strings.length * 4), u32(0), ...offsets.map(u32), body]);
}

type Attr = { name: number; raw: number; type: number; data: number };
function startElement(name: number, attrs: Attr[]): Buffer {
  const ext = Buffer.concat([u32(0xffffffff), u32(name), u16(20), u16(20), u16(attrs.length), u16(0), u16(0), u16(0)]);
  const body = Buffer.concat(attrs.map((a) => Buffer.concat([u32(0xffffffff), u32(a.name), u32(a.raw), u16(8), Buffer.from([0, a.type]), u32(a.data)])));
  const size = 16 + ext.length + body.length;
  return Buffer.concat([u16(0x0102), u16(16), u32(size), u32(1), u32(0xffffffff), ext, body]);
}

export function manifestXml({ versionCodeName = 'versionCode', packageName = 'com.wallx.play', versionCode = 9, versionName = '0.9.0' } = {}): Buffer {
  // 0 manifest, 1 package, 2 versionCode, 3 versionName, 4 <package>, 5 <versionName>, 6 uses-sdk, 7 minSdkVersion
  const pool = stringPool(['manifest', 'package', versionCodeName, 'versionName', packageName, versionName, 'uses-sdk', 'minSdkVersion']);
  const resMap = Buffer.concat([u16(0x0180), u16(8), u32(8 + 8 * 4), ...[0, 0, 0x0101021b, 0x0101021c, 0, 0, 0, 0x0101020c].map(u32)]);
  const manifest = startElement(0, [
    { name: 1, raw: 4, type: 0x03, data: 4 },
    { name: 2, raw: -1, type: 0x10, data: versionCode },
    { name: 3, raw: 5, type: 0x03, data: 5 },
  ]);
  const usesSdk = startElement(6, [{ name: 7, raw: -1, type: 0x10, data: 24 }]);
  const body = Buffer.concat([pool, resMap, manifest, usesSdk]);
  return Buffer.concat([u16(0x0003), u16(8), u32(8 + body.length), body]);
}

export function zip(files: Array<{ name: string; data: Buffer; deflate?: boolean }>, signingBlock?: Buffer): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const stored = f.deflate ? deflateRawSync(f.data) : f.data;
    const name = Buffer.from(f.name);
    const method = f.deflate ? 8 : 0;
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(method), u32(0), u32(0), u32(stored.length), u32(f.data.length), u16(name.length), u16(0), name, stored]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(method), u32(0), u32(0), u32(stored.length), u32(f.data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name]));
    locals.push(local);
    offset += local.length;
  }
  const sig = signingBlock ?? Buffer.alloc(0);
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cd.length), u32(offset + sig.length), u16(0)]);
  return Buffer.concat([...locals, sig, cd, eocd]);
}

export function v2Block(cert: Buffer): Buffer {
  const signedData = Buffer.concat([lp(), lp(lp(cert)), lp()]);
  const signer = Buffer.concat([lp(signedData), lp(), lp()]);
  const value = lp(lp(signer));
  const pair = Buffer.concat([u64(4 + value.length), u32(0x7109871a), value]);
  const size = pair.length + 8 + 16;
  return Buffer.concat([u64(size), pair, u64(size), Buffer.from('APK Sig Block 42', 'latin1')]);
}


/** A player-like APK: package, version code/name and a signing "certificate". */
export function fakeApk({ packageName = 'com.wallx.play', versionCode = 9, versionName = '0.9.0', cert = 'wallx-play-key' } = {}): Buffer {
  return zip([{ name: 'AndroidManifest.xml', data: manifestXml({ packageName, versionCode, versionName }), deflate: true }], v2Block(Buffer.from(cert)));
}
