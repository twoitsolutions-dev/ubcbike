// Pure ES2020 RIFF AVI encoder (MJPEG & Uncompressed RGB24) for 224x212 outdoor LED signs.
// Produces standard audio-free RIFF AVI with hdrl (avih + strl/strh/strf), movi (00dc), and idx1.

function writeAscii(view, offset, str) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i) & 0xff);
  }
}

function padEven(n) {
  return n % 2 === 1 ? n + 1 : n;
}

function buildAviContainer({ frames, width, height, fps, compressionFourCc, biCompression, biBitCount, biSizeImage }) {
  const frameCount = frames.length;
  const microSecPerFrame = Math.round(1000000 / Math.max(1, fps));
  const paddedSizes = frames.map((f) => padEven(f.byteLength));
  const moviPayloadSize = paddedSizes.reduce((acc, s) => acc + 8 + s, 0);
  const maxChunkSize = frames.reduce((m, f) => Math.max(m, f.byteLength), 0);

  // Header sizes:
  // avih: 56 bytes payload + 8 = 64
  // strh: 56 bytes payload + 8 = 64
  // strf (BITMAPINFOHEADER): 40 bytes payload + 8 = 48
  // strl LIST: 4 ('strl') + 64 + 48 = 116 (+ 8 = 124)
  // hdrl LIST: 4 ('hdrl') + 64 + 124 = 192 (+ 8 = 200)
  // movi LIST: 4 ('movi') + moviPayloadSize (+ 8)
  // idx1: 8 + frameCount * 16
  const hdrlListSize = 4 + 64 + 124;
  const moviListSize = 4 + moviPayloadSize;
  const idx1Size = frameCount * 16;
  const riffSize = 4 + (8 + hdrlListSize) + (8 + moviListSize) + (8 + idx1Size);
  const totalBytes = 8 + riffSize;

  const out = new Uint8Array(totalBytes);
  const view = new DataView(out.buffer);
  let p = 0;

  // RIFF header
  writeAscii(view, p, 'RIFF'); p += 4;
  view.setUint32(p, riffSize, true); p += 4;
  writeAscii(view, p, 'AVI '); p += 4;

  // LIST hdrl
  writeAscii(view, p, 'LIST'); p += 4;
  view.setUint32(p, hdrlListSize, true); p += 4;
  writeAscii(view, p, 'hdrl'); p += 4;

  // avih (56 bytes)
  writeAscii(view, p, 'avih'); p += 4;
  view.setUint32(p, 56, true); p += 4;
  view.setUint32(p, microSecPerFrame, true); p += 4; // dwMicroSecPerFrame
  view.setUint32(p, maxChunkSize * fps, true); p += 4; // dwMaxBytesPerSec
  view.setUint32(p, 0, true); p += 4; // dwPaddingGranularity
  view.setUint32(p, 0x10, true); p += 4; // dwFlags (AVIF_HASINDEX)
  view.setUint32(p, frameCount, true); p += 4; // dwTotalFrames
  view.setUint32(p, 0, true); p += 4; // dwInitialFrames
  view.setUint32(p, 1, true); p += 4; // dwStreams
  view.setUint32(p, maxChunkSize, true); p += 4; // dwSuggestedBufferSize
  view.setUint32(p, width, true); p += 4; // dwWidth
  view.setUint32(p, height, true); p += 4; // dwHeight
  p += 16; // dwReserved[4]

  // LIST strl
  writeAscii(view, p, 'LIST'); p += 4;
  view.setUint32(p, 4 + 64 + 48, true); p += 4;
  writeAscii(view, p, 'strl'); p += 4;

  // strh (56 bytes)
  writeAscii(view, p, 'strh'); p += 4;
  view.setUint32(p, 56, true); p += 4;
  writeAscii(view, p, 'vids'); p += 4; // fccType
  writeAscii(view, p, compressionFourCc); p += 4; // fccHandler
  view.setUint32(p, 0, true); p += 4; // dwFlags
  view.setUint16(p, 0, true); p += 2; // wPriority
  view.setUint16(p, 0, true); p += 2; // wLanguage
  view.setUint32(p, 0, true); p += 4; // dwInitialFrames
  view.setUint32(p, 1, true); p += 4; // dwScale
  view.setUint32(p, fps, true); p += 4; // dwRate
  view.setUint32(p, 0, true); p += 4; // dwStart
  view.setUint32(p, frameCount, true); p += 4; // dwLength
  view.setUint32(p, maxChunkSize, true); p += 4; // dwSuggestedBufferSize
  view.setUint32(p, 0xffffffff, true); p += 4; // dwQuality
  view.setUint32(p, 0, true); p += 4; // dwSampleSize
  view.setInt16(p, 0, true); p += 2; // rcFrame.left
  view.setInt16(p, 0, true); p += 2; // rcFrame.top
  view.setInt16(p, width, true); p += 2; // rcFrame.right
  view.setInt16(p, height, true); p += 2; // rcFrame.bottom

  // strf (BITMAPINFOHEADER, 40 bytes)
  writeAscii(view, p, 'strf'); p += 4;
  view.setUint32(p, 40, true); p += 4;
  view.setUint32(p, 40, true); p += 4; // biSize
  view.setInt32(p, width, true); p += 4; // biWidth
  view.setInt32(p, height, true); p += 4; // biHeight
  view.setUint16(p, 1, true); p += 2; // biPlanes
  view.setUint16(p, biBitCount, true); p += 2; // biBitCount
  view.setUint32(p, biCompression, true); p += 4; // biCompression
  view.setUint32(p, biSizeImage, true); p += 4; // biSizeImage
  view.setInt32(p, 0, true); p += 4; // biXPelsPerMeter
  view.setInt32(p, 0, true); p += 4; // biYPelsPerMeter
  view.setUint32(p, 0, true); p += 4; // biClrUsed
  view.setUint32(p, 0, true); p += 4; // biClrImportant

  // LIST movi
  writeAscii(view, p, 'LIST'); p += 4;
  view.setUint32(p, moviListSize, true); p += 4;
  writeAscii(view, p, 'movi'); p += 4;

  const idxOffsets = [];
  let moviRel = 4;
  for (let i = 0; i < frameCount; i++) {
    const f = frames[i];
    idxOffsets.push({ offset: moviRel, size: f.byteLength });
    writeAscii(view, p, '00dc'); p += 4;
    view.setUint32(p, f.byteLength, true); p += 4;
    out.set(f, p);
    p += paddedSizes[i];
    moviRel += 8 + paddedSizes[i];
  }

  // idx1
  writeAscii(view, p, 'idx1'); p += 4;
  view.setUint32(p, idx1Size, true); p += 4;
  for (let i = 0; i < frameCount; i++) {
    writeAscii(view, p, '00dc'); p += 4;
    view.setUint32(p, 0x10, true); p += 4; // AVIIF_KEYFRAME
    view.setUint32(p, idxOffsets[i].offset, true); p += 4;
    view.setUint32(p, idxOffsets[i].size, true); p += 4;
  }

  return new Blob([out], { type: 'video/x-msvideo' });
}

export function encodeMjpegAvi(jpegUint8Frames, width, height, fps) {
  return buildAviContainer({
    frames: jpegUint8Frames,
    width,
    height,
    fps,
    compressionFourCc: 'MJPG',
    biCompression: 0x47504a4d, // 'MJPG' little-endian
    biBitCount: 24,
    biSizeImage: width * height * 3,
  });
}

export function rgbaToBgr24BottomUp(rgba, width, height) {
  const rowStride = (width * 3 + 3) & ~3;
  const buf = new Uint8Array(rowStride * height);
  for (let y = 0; y < height; y++) {
    const srcRow = (height - 1 - y) * width * 4;
    const dstRow = y * rowStride;
    for (let x = 0; x < width; x++) {
      const si = srcRow + x * 4;
      const di = dstRow + x * 3;
      buf[di] = rgba[si + 2]; // B
      buf[di + 1] = rgba[si + 1]; // G
      buf[di + 2] = rgba[si]; // R
    }
  }
  return buf;
}

export function encodeRgb24Avi(bgr24Frames, width, height, fps) {
  const rowStride = (width * 3 + 3) & ~3;
  return buildAviContainer({
    frames: bgr24Frames,
    width,
    height,
    fps,
    compressionFourCc: 'DIB ',
    biCompression: 0, // BI_RGB
    biBitCount: 24,
    biSizeImage: rowStride * height,
  });
}
