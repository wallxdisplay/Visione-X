/**
 * Reads what WallX Play needs from a player APK without extra libraries: the package name,
 * version and minimum Android version from the compiled AndroidManifest.xml, and the signing
 * certificate from the APK Signature Scheme v2/v3 block. Signatures are not verified here
 * (Android does that on install, and the player re-checks the signer before installing); the
 * certificate only lets us refuse an APK signed with a different key up front.
 */
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

export interface ApkInfo {
  packageName: string;
  versionCode: number;
  versionName: string;
  minSdk: number | null;
  /** SHA-256 of the first signer's certificate (hex), null when the APK has no v2/v3 block. */
  signerSha256: string | null;
}

export class ApkError extends Error {}

const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

function findEocd(buf: Buffer): number {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  throw new ApkError('Not an APK (zip directory not found).');
}

function centralDirectory(buf: Buffer): { entries: ZipEntry[]; cdOffset: number } {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) throw new ApkError('Damaged zip directory.');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return { entries, cdOffset };
}

function readEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.localOffset;
  if (buf.readUInt32LE(p) !== LOCAL_SIG) throw new ApkError(`Damaged zip entry ${e.name}.`);
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data;
  if (e.method === 8) return inflateRawSync(data);
  throw new ApkError(`Unsupported compression in ${e.name}.`);
}

// ---------------------------------------------------------------- binary XML (AXML)

const RES_STRING_POOL = 0x0001;
const RES_XML = 0x0003;
const RES_XML_START_ELEMENT = 0x0102;
const RES_XML_RESOURCE_MAP = 0x0180;
const UTF8_FLAG = 0x100;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;

/** android:versionCode / versionName / minSdkVersion resource ids (names may be stripped). */
const ATTR_IDS: Record<number, string> = { 0x0101021b: 'versionCode', 0x0101021c: 'versionName', 0x0101020c: 'minSdkVersion' };

function readStringPool(buf: Buffer, start: number): string[] {
  const count = buf.readUInt32LE(start + 8);
  const flags = buf.readUInt32LE(start + 16);
  const stringsStart = start + buf.readUInt32LE(start + 20);
  const utf8 = (flags & UTF8_FLAG) !== 0;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = stringsStart + buf.readUInt32LE(start + 28 + i * 4);
    if (utf8) {
      // UTF-16 length then UTF-8 byte length, each 1 or 2 bytes.
      p += buf[p]! & 0x80 ? 2 : 1;
      let len = buf[p]!;
      if (len & 0x80) {
        len = ((len & 0x7f) << 8) | buf[p + 1]!;
        p += 2;
      } else p += 1;
      out.push(buf.toString('utf8', p, p + len));
    } else {
      let len = buf.readUInt16LE(p);
      if (len & 0x8000) {
        len = ((len & 0x7fff) << 16) | buf.readUInt16LE(p + 2);
        p += 4;
      } else p += 2;
      out.push(buf.toString('utf16le', p, p + len * 2));
    }
  }
  return out;
}

export function readManifest(xml: Buffer): Omit<ApkInfo, 'signerSha256'> {
  if (xml.length < 8 || xml.readUInt16LE(0) !== RES_XML) throw new ApkError('AndroidManifest.xml is not compiled XML.');
  let strings: string[] = [];
  let resIds: number[] = [];
  const found: Record<string, string | number> = {};
  let p = xml.readUInt16LE(2);
  while (p + 8 <= xml.length) {
    const type = xml.readUInt16LE(p);
    const size = xml.readUInt32LE(p + 4);
    if (size < 8) break;
    if (type === RES_STRING_POOL) strings = readStringPool(xml, p);
    else if (type === RES_XML_RESOURCE_MAP) {
      const n = (size - 8) / 4;
      resIds = Array.from({ length: n }, (_, i) => xml.readUInt32LE(p + 8 + i * 4));
    } else if (type === RES_XML_START_ELEMENT) {
      const ext = p + 16;
      const element = strings[xml.readUInt32LE(ext + 4)];
      if (element === 'manifest' || element === 'uses-sdk') {
        const attrStart = ext + xml.readUInt16LE(ext + 8);
        const attrSize = xml.readUInt16LE(ext + 10);
        const attrCount = xml.readUInt16LE(ext + 12);
        for (let i = 0; i < attrCount; i++) {
          const a = attrStart + i * attrSize;
          const nameIdx = xml.readUInt32LE(a + 4);
          const name = ATTR_IDS[resIds[nameIdx] ?? -1] ?? strings[nameIdx];
          const raw = xml.readInt32LE(a + 8);
          const dataType = xml.readUInt8(a + 15);
          const data = xml.readUInt32LE(a + 16);
          if (!name) continue;
          if (dataType === TYPE_STRING || raw >= 0) found[name] = raw >= 0 ? strings[raw]! : strings[data]!;
          else if (dataType === TYPE_INT_DEC || dataType === TYPE_INT_HEX) found[name] = data;
        }
      }
    }
    p += size;
  }
  const versionCode = Number(found.versionCode);
  if (typeof found.package !== 'string' || !Number.isInteger(versionCode) || versionCode <= 0) {
    throw new ApkError('The APK manifest has no package name or version code.');
  }
  const minSdk = found.minSdkVersion === undefined ? null : Number(found.minSdkVersion);
  return {
    packageName: found.package,
    versionCode,
    versionName: typeof found.versionName === 'string' ? found.versionName : String(versionCode),
    minSdk: Number.isInteger(minSdk) ? minSdk : null,
  };
}

// ---------------------------------------------------------------- signing block

const SIG_BLOCK_MAGIC = 'APK Sig Block 42';
const V2_ID = 0x7109871a;
const V3_ID = 0xf05368c0;

/** Splits a sequence of uint32-length-prefixed values. */
function lengthPrefixed(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const len = buf.readUInt32LE(p);
    if (p + 4 + len > buf.length) throw new ApkError('Damaged signing block.');
    out.push(buf.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return out;
}

const prefixed = (buf: Buffer) => {
  const [first] = lengthPrefixed(buf.subarray(0, 4 + buf.readUInt32LE(0)));
  return first!;
};

export function readSignerSha256(apk: Buffer, cdOffset: number): string | null {
  if (cdOffset < 32 || apk.toString('latin1', cdOffset - 16, cdOffset) !== SIG_BLOCK_MAGIC) return null;
  const size = Number(apk.readBigUInt64LE(cdOffset - 24));
  const start = cdOffset - size - 8;
  if (start < 0) throw new ApkError('Damaged signing block.');
  let p = start + 8;
  const end = cdOffset - 24;
  const values = new Map<number, Buffer>();
  while (p + 12 <= end) {
    const len = Number(apk.readBigUInt64LE(p));
    values.set(apk.readUInt32LE(p + 8), apk.subarray(p + 12, p + 8 + len));
    p += 8 + len;
  }
  const scheme = values.get(V3_ID) ?? values.get(V2_ID);
  if (!scheme) return null;
  // signers → signer → signed data → certificates → first certificate (DER).
  const signer = lengthPrefixed(prefixed(scheme))[0];
  if (!signer) return null;
  const signedData = prefixed(signer);
  const digestsLen = signedData.readUInt32LE(0);
  const certificates = prefixed(signedData.subarray(4 + digestsLen));
  const cert = lengthPrefixed(certificates)[0];
  return cert ? createHash('sha256').update(cert).digest('hex') : null;
}

export function inspectApk(apk: Buffer): ApkInfo {
  const { entries, cdOffset } = centralDirectory(apk);
  const manifest = entries.find((e) => e.name === 'AndroidManifest.xml');
  if (!manifest) throw new ApkError('Not an APK (no AndroidManifest.xml).');
  return { ...readManifest(readEntry(apk, manifest)), signerSha256: readSignerSha256(apk, cdOffset) };
}
