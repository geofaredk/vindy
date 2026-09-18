// Animation export: turns a sequence of canvases (captured map frames) into an MP4 video
// (browser WebCodecs H.264 + mp4-muxer) or an animated GIF (gifenc). Everything runs in
// the visitor's browser; the libraries are loaded only when an animation is made.

const MP4_CODECS = ['avc1.640033', 'avc1.4d0033', 'avc1.42e033', 'avc1.640028', 'avc1.42e01f'];

// The first H.264 profile/level this browser can encode at this size, or null.
export async function mp4Codec(width, height, fps = 20) {
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined') return null;
  for (const codec of MP4_CODECS) {
    try {
      const { supported } = await VideoEncoder.isConfigSupported({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps });
      if (supported) return codec;
    } catch { /* try the next one */ }
  }
  return null;
}

const bitrateFor = (w, h, fps) => Math.round(Math.max(2e6, Math.min(12e6, w * h * fps * 0.12)));

export async function createMp4Encoder({ width, height, fps, codec }) {
  const { Muxer, ArrayBufferTarget } = await import('/vendor/mp4-muxer/mp4-muxer.mjs');
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, video: { codec: 'avc', width, height, frameRate: fps }, fastStart: 'in-memory' });
  let failure = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { failure = e; },
  });
  encoder.configure({ codec, width, height, bitrate: bitrateFor(width, height, fps), framerate: fps, avc: { format: 'avc' } });
  let n = 0;
  const frameUs = 1e6 / fps;
  return {
    async addFrame(canvas) {
      if (failure) throw failure;
      const frame = new VideoFrame(canvas, { timestamp: Math.round(n * frameUs), duration: Math.round(frameUs) });
      encoder.encode(frame, { keyFrame: n % (fps * 2) === 0 });
      frame.close();
      n++;
      // Don't let the encoder queue grow without bound on slow devices.
      while (encoder.encodeQueueSize > 8) await new Promise(r => setTimeout(r, 5));
    },
    async finish() {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      muxer.finalize();
      return new Blob([target.buffer], { type: 'video/mp4' });
    },
    cancel() { try { encoder.close(); } catch { /* already closed */ } },
  };
}

export async function createGifEncoder({ width, height }) {
  const { GIFEncoder, quantize, applyPalette } = await import('/vendor/gifenc/gifenc.esm.js');
  const gif = GIFEncoder();
  return {
    async addFrame(canvas, delayMs) {
      const { data } = canvas.getContext('2d').getImageData(0, 0, width, height);
      const palette = quantize(data, 256);
      const index = applyPalette(data, palette);
      gif.writeFrame(index, width, height, { palette, delay: delayMs });
      await new Promise(r => setTimeout(r, 0)); // keep the page responsive between frames
    },
    async finish() {
      gif.finish();
      return new Blob([gif.bytes()], { type: 'image/gif' });
    },
    cancel() {},
  };
}
