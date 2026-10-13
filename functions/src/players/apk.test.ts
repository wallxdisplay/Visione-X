import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { manifestXml, v2Block, zip } from '../../../tests/fixtures/apk';
import { ApkError, inspectApk } from './apk';

describe('inspectApk', () => {
  const cert = Buffer.from('fake DER certificate bytes');

  it('reads package, version, min SDK and the signer certificate', () => {
    const apk = zip([{ name: 'classes.dex', data: Buffer.alloc(64) }, { name: 'AndroidManifest.xml', data: manifestXml(), deflate: true }], v2Block(cert));
    expect(inspectApk(apk)).toEqual({
      packageName: 'com.wallx.play',
      versionCode: 9,
      versionName: '0.9.0',
      minSdk: 24,
      signerSha256: createHash('sha256').update(cert).digest('hex'),
    });
  });

  it('uses resource ids when attribute names are stripped; unsigned APKs have no signer', () => {
    const apk = zip([{ name: 'AndroidManifest.xml', data: manifestXml({ versionCodeName: '' }) }]);
    expect(inspectApk(apk)).toMatchObject({ versionCode: 9, signerSha256: null });
  });

  it('rejects files that are not APKs', () => {
    expect(() => inspectApk(Buffer.from('hello'))).toThrow(ApkError);
    expect(() => inspectApk(zip([{ name: 'readme.txt', data: Buffer.from('x') }]))).toThrow(/AndroidManifest/);
  });
});
