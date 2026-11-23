import crypto from 'node:crypto';
import { z } from 'zod';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { audit, logError } from './audit.js';
import { HttpError, type AppContext } from './context.js';

const CLIP_TTL_MS = 15 * 60 * 1000;
const MAX_CLIPS = 30;
const clipCache = new Map<string, { companyId: string; buffer: Buffer; expiresAt: number }>();

export function saveVoiceClip(companyId: string, buffer: Buffer): string {
  const now = Date.now();
  for (const [k, v] of clipCache.entries()) {
    if (v.expiresAt <= now) clipCache.delete(k);
  }
  while (clipCache.size >= MAX_CLIPS) {
    const oldest = clipCache.keys().next().value;
    if (!oldest) break;
    clipCache.delete(oldest);
  }
  const id = crypto.randomUUID();
  clipCache.set(id, { companyId, buffer, expiresAt: now + CLIP_TTL_MS });
  return id;
}

export function getVoiceClip(companyId: string, id: string): Buffer | null {
  const item = clipCache.get(id);
  if (!item) return null;
  if (item.expiresAt <= Date.now()) {
    clipCache.delete(id);
    return null;
  }
  if (item.companyId !== companyId) return null;
  return item.buffer;
}

export const ALLOWED_VOICES = [
  'en-US-AndrewMultilingualNeural',
  'en-US-AvaMultilingualNeural',
  'en-US-BrianMultilingualNeural',
  'en-US-EmmaMultilingualNeural',
  'en-US-GuyNeural',
  'en-US-JennyNeural',
  'es-US-AlonsoNeural',
  'es-US-PalomaNeural',
] as const;

export const voiceGenerateSchema = z.object({
  text: z.string().trim().min(2).max(1500),
  voice: z.enum(ALLOWED_VOICES).default('en-US-AndrewMultilingualNeural'),
  rate: z.enum(['-15%', '-10%', '0%', '+10%']).default('-10%'),
});

// Florida pronunciation fixes: keep "Alafia" spelled normally in the UI,
// while speaking it phonetically as "Alafaya" (/ˌæləˈfaɪə/) for TTS engines.
function normalizeSpeechText(text: string): string {
  return text.replace(/\balafia\b/gi, 'Alafaya');
}

async function synthesizeWithEdge(text: string, voice: string): Promise<Buffer> {
  const tts = new MsEdgeTTS();
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks: Buffer[] = [];
    for await (const chunk of audioStream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buf = Buffer.concat(chunks);
    if (!buf.length) throw new Error('Empty audio stream from Edge TTS');
    return buf;
  } finally {
    try { tts.close(); } catch { /* ignore */ }
  }
}

function splitForGoogleTts(text: string, maxLen = 170): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const parts: string[] = [];
  let rest = clean;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf('. ', maxLen);
    if (cut < 40) cut = rest.lastIndexOf(', ', maxLen);
    if (cut < 40) cut = rest.lastIndexOf(' ', maxLen);
    if (cut < 20) cut = maxLen;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

async function synthesizeWithGoogleFallback(text: string, lang: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for (const part of splitForGoogleTts(text)) {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(lang)}&q=${encodeURIComponent(part)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Google TTS HTTP ${res.status}`);
    chunks.push(Buffer.from(await res.arrayBuffer()));
  }
  return Buffer.concat(chunks);
}

export async function generatePhoneGreetingAudio(
  ctx: AppContext,
  companyId: string,
  userId: string,
  input: z.infer<typeof voiceGenerateSchema>,
): Promise<{ buffer: Buffer; engine: 'edge' | 'google' }> {
  const spokenText = normalizeSpeechText(input.text);
  let buffer: Buffer;
  let engine: 'edge' | 'google' = 'edge';
  try {
    buffer = await synthesizeWithEdge(spokenText, input.voice);
  } catch (err) {
    const lang = input.voice.startsWith('es-') ? 'es' : 'en';
    try {
      buffer = await synthesizeWithGoogleFallback(spokenText, lang);
      engine = 'google';
    } catch (fallbackErr) {
      await logError(ctx.pool, {
        companyId,
        source: 'voice:generate',
        message: `Edge: ${(err as Error).message}; Fallback: ${(fallbackErr as Error).message}`,
      }).catch(() => {});
      throw new HttpError(502, 'UPSTREAM_ERROR', 'Could not synthesize voice audio right now. Please try again.');
    }
  }

  await audit(ctx.pool, {
    companyId,
    userId,
    action: 'voice.greeting_generated',
    detail: { voice: input.voice, rate: input.rate, chars: input.text.length, engine, bytes: buffer.length },
  }).catch(() => {});

  return { buffer, engine };
}
