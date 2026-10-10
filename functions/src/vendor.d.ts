declare module '@ffmpeg-installer/ffmpeg' {
  const ffmpeg: { path: string; version: string };
  export default ffmpeg;
}

declare module '@ffprobe-installer/ffprobe' {
  const ffprobe: { path: string; version: string };
  export default ffprobe;
}
