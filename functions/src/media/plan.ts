/**
 * Pure decisions for media processing (unit-tested; no I/O).
 *
 * Screens play H.264/AAC MP4 with hardware decoding on Android boxes. Files that already fit
 * that profile are used as-is ("passthrough"), which is fast and lossless; everything else is
 * converted once, here, so the player never has to cope with exotic formats.
 */

export interface ProbeResult {
  formatName: string;
  durationSec: number | null;
  video: { codec: string; width: number; height: number; pixFmt: string; rotation: number } | null;
  audio: { codec: string } | null;
}

/** Longest side of the converted video. 1080p suits typical LED controllers; raise for 4K walls. */
export const MAX_VIDEO_SIDE = 1920;
/** Longest side of a display image. */
export const MAX_IMAGE_SIDE = 3840;
export const THUMB_SIDE = 480;

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  tags?: { rotate?: string };
  side_data_list?: Array<{ rotation?: number }>;
}

export function parseProbe(json: {
  format?: { format_name?: string; duration?: string };
  streams?: FfprobeStream[];
}): ProbeResult {
  const streams = json.streams ?? [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  const rotation = Math.abs(
    Number(v?.tags?.rotate ?? v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? 0),
  );
  const duration = Number(json.format?.duration);
  return {
    formatName: json.format?.format_name ?? '',
    durationSec: Number.isFinite(duration) && duration > 0 ? duration : null,
    video: v
      ? { codec: v.codec_name ?? '', width: v.width ?? 0, height: v.height ?? 0, pixFmt: v.pix_fmt ?? '', rotation }
      : null,
    audio: a ? { codec: a.codec_name ?? '' } : null,
  };
}

export type VideoPlan = { action: 'passthrough' } | { action: 'transcode'; reasons: string[] };

export function planVideo(probe: ProbeResult): VideoPlan {
  if (!probe.video) return { action: 'transcode', reasons: ['no video stream'] };
  const reasons: string[] = [];
  if (!probe.formatName.split(',').includes('mp4')) reasons.push(`container ${probe.formatName}`);
  if (probe.video.codec !== 'h264') reasons.push(`codec ${probe.video.codec}`);
  if (probe.video.pixFmt !== 'yuv420p') reasons.push(`pixel format ${probe.video.pixFmt}`);
  if (Math.max(probe.video.width, probe.video.height) > MAX_VIDEO_SIDE) {
    reasons.push(`resolution ${probe.video.width}x${probe.video.height}`);
  }
  if (probe.video.rotation % 360 !== 0) reasons.push(`rotation ${probe.video.rotation}`);
  if (probe.audio && probe.audio.codec !== 'aac') reasons.push(`audio ${probe.audio.codec}`);
  return reasons.length ? { action: 'transcode', reasons } : { action: 'passthrough' };
}

/** ffmpeg arguments for the screen-safe profile: H.264 High, yuv420p, AAC, fast start. */
export function transcodeArgs(input: string, output: string, hasAudio: boolean): string[] {
  return [
    '-hide_banner',
    '-y',
    '-i',
    input,
    // Fit inside MAX_VIDEO_SIDE without upscaling; keep dimensions even for yuv420p.
    '-vf',
    `scale='min(${MAX_VIDEO_SIDE},iw)':'min(${MAX_VIDEO_SIDE},ih)':force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '21',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '128k'] : ['-an']),
    '-movflags',
    '+faststart',
    output,
  ];
}

/** ffmpeg arguments for a JPEG poster frame (1 s in, or the first frame for short clips). */
export function posterArgs(input: string, output: string, durationSec: number | null): string[] {
  const at = durationSec && durationSec > 2 ? '1' : '0';
  return [
    '-hide_banner',
    '-y',
    '-ss',
    at,
    '-i',
    input,
    '-frames:v',
    '1',
    '-vf',
    `scale='min(${THUMB_SIDE},iw)':-2`,
    '-q:v',
    '4',
    output,
  ];
}

/** Display images: keep originals that screens handle well; otherwise convert. */
export function planImage(meta: { format?: string; width?: number; height?: number; pages?: number }):
  | { action: 'passthrough' }
  | { action: 'convert'; to: 'jpeg' | 'png' } {
  const format = meta.format ?? '';
  const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
  if (format === 'gif') return { action: 'passthrough' }; // animated GIFs keep their animation
  if (['jpeg', 'png', 'webp'].includes(format) && longest <= MAX_IMAGE_SIDE) return { action: 'passthrough' };
  return { action: 'convert', to: format === 'png' ? 'png' : 'jpeg' };
}

/** Message stored on the media item when processing fails (shown to users). */
export function friendlyProcessingError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/Invalid data found|unsupported image format|Input buffer contains unsupported/i.test(text)) {
    return 'The file could not be read. It may be damaged or not a real image/video.';
  }
  if (/size|too large/i.test(text)) return text;
  return 'Processing failed. Try re-exporting the file as MP4 (H.264) or JPEG/PNG and upload again.';
}
