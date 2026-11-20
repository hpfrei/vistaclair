// Audio container helpers for the ai.sfx adapter: a RIFF/WAVE header around raw
// PCM, and duration measured from the bytes of an MP3 (CBR) or an Ogg Opus file.
// Pure functions, no ffmpeg.

// Raw little-endian signed PCM → a complete .wav (RIFF header + data).
function wavFromPcm(pcm, sampleRate, { channels = 1, bits = 16 } = {}) {
  const rate = Number(sampleRate);
  if (!Number.isInteger(rate) || rate < 1) throw new Error(`invalid sample rate ${sampleRate}`);
  const blockAlign = channels * (bits / 8);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);            // fmt chunk size
  h.writeUInt16LE(1, 20);             // PCM
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * blockAlign, 28);
  h.writeUInt16LE(blockAlign, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

// Seconds of 16-bit PCM.
function pcmSeconds(bytes, sampleRate, channels = 1) {
  return bytes / (2 * channels * sampleRate);
}

// Seconds of a constant-bitrate MP3 (ElevenLabs serves CBR): payload bytes
// (an ID3v2 tag skipped) × 8 / bitrate.
function mp3Seconds(buf, bitrate) {
  let start = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') {
    start = 10 + (((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f));
  }
  return Math.max(0, buf.length - start) * 8 / bitrate;
}

const isOgg = (buf) => buf.length > 4 && buf.toString('latin1', 0, 4) === 'OggS';

// Seconds of an Ogg Opus file: the last page's granule position (48 kHz
// samples) minus the pre-skip in the OpusHead packet. null when not readable.
function oggOpusSeconds(buf) {
  if (!isOgg(buf)) return null;
  const head = buf.indexOf('OpusHead');
  if (head === -1 || head + 12 > buf.length) return null;
  const preSkip = buf.readUInt16LE(head + 10);
  const last = buf.lastIndexOf('OggS');
  if (last === -1 || last + 14 > buf.length) return null;
  const granule = Number(buf.readBigUInt64LE(last + 6));
  if (!Number.isFinite(granule) || granule < 0) return null;
  return Math.max(0, granule - preSkip) / 48000;
}

module.exports = { wavFromPcm, pcmSeconds, mp3Seconds, oggOpusSeconds, isOgg };
