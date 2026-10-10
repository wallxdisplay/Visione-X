import { describe, expect, it } from 'vitest';
import { parseProbe, planImage, planVideo, transcodeArgs } from './plan';

const probe = (over: Partial<{ format: string; codec: string; w: number; h: number; pix: string; audio: string | null; rotate: string }>) =>
  parseProbe({
    format: { format_name: over.format ?? 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.5' },
    streams: [
      {
        codec_type: 'video',
        codec_name: over.codec ?? 'h264',
        width: over.w ?? 1920,
        height: over.h ?? 1080,
        pix_fmt: over.pix ?? 'yuv420p',
        ...(over.rotate ? { tags: { rotate: over.rotate } } : {}),
      },
      ...(over.audio === null ? [] : [{ codec_type: 'audio', codec_name: over.audio ?? 'aac' }]),
    ],
  });

describe('planVideo', () => {
  it('passes through screen-ready H.264 MP4 (landscape and portrait 1080p)', () => {
    expect(planVideo(probe({}))).toEqual({ action: 'passthrough' });
    expect(planVideo(probe({ w: 1080, h: 1920 }))).toEqual({ action: 'passthrough' });
    expect(planVideo(probe({ audio: null }))).toEqual({ action: 'passthrough' });
  });

  it('transcodes everything else and says why', () => {
    const p = planVideo(probe({ format: 'matroska,webm', codec: 'vp9', w: 3840, h: 2160, audio: 'opus' }));
    expect(p.action).toBe('transcode');
    if (p.action === 'transcode') {
      expect(p.reasons).toEqual(['container matroska,webm', 'codec vp9', 'resolution 3840x2160', 'audio opus']);
    }
    expect(planVideo(probe({ codec: 'hevc' })).action).toBe('transcode');
    expect(planVideo(probe({ pix: 'yuv422p10le' })).action).toBe('transcode');
    expect(planVideo(probe({ rotate: '90' })).action).toBe('transcode');
  });

  it('reads duration from the container', () => {
    expect(probe({}).durationSec).toBe(12.5);
  });

  it('builds a fast-start, yuv420p transcode command', () => {
    const args = transcodeArgs('in', 'out.mp4', false);
    expect(args).toContain('+faststart');
    expect(args).toContain('-an');
    expect(args.at(-1)).toBe('out.mp4');
  });
});

describe('planImage', () => {
  it('keeps normal JPEG/PNG/WebP and GIF, converts huge or unusual images', () => {
    expect(planImage({ format: 'jpeg', width: 3840, height: 2160 })).toEqual({ action: 'passthrough' });
    expect(planImage({ format: 'gif', width: 9000, height: 9000 })).toEqual({ action: 'passthrough' });
    expect(planImage({ format: 'png', width: 8000, height: 2000 })).toEqual({ action: 'convert', to: 'png' });
    expect(planImage({ format: 'tiff', width: 100, height: 100 })).toEqual({ action: 'convert', to: 'jpeg' });
  });
});
