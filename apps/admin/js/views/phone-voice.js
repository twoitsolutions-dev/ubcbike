import { h } from '../ui/dom.js';
import { card, pageHead, toast } from '../ui/components.js';

const VOICES = [
  ['en-US-AndrewMultilingualNeural', 'Andrew (English · Warm Male, Natural)'],
  ['en-US-AvaMultilingualNeural', 'Ava (English · Warm Female, Natural)'],
  ['en-US-BrianMultilingualNeural', 'Brian (English · Clear Male)'],
  ['en-US-EmmaMultilingualNeural', 'Emma (English · Clear Female)'],
  ['en-US-GuyNeural', 'Guy (English · Classic Male)'],
  ['en-US-JennyNeural', 'Jenny (English · Classic Female)'],
  ['es-US-AlonsoNeural', 'Alonso (Español · Voz Masculina)'],
  ['es-US-PalomaNeural', 'Paloma (Español · Voz Femenina)'],
];

const RATES = [
  ['0%', 'Natural phone pace (recommended)'],
];

const PRESETS = [
  {
    name: 'Holiday: Tampa Closed, Alafia Open',
    voice: 'en-US-AndrewMultilingualNeural',
    text: 'Thank you for calling University Bicycle Center in Tampa. Our Tampa store is closed today for the holiday and will reopen on December 26th at 10 AM. Our Alafia River State Park location remains open today from 10 AM to 5 PM. You can also shop 24/7 at ubcbike.com. Have a great ride!',
  },
  {
    name: 'Holiday: Both Stores Closed',
    voice: 'en-US-AndrewMultilingualNeural',
    text: 'Thank you for calling University Bicycle Center. Both our Tampa and Alafia locations are closed today for Christmas Day so our team can celebrate with their families. We will reopen tomorrow with normal business hours. Visit us anytime online at ubcbike.com.',
  },
  {
    name: 'Special Hours / Weather Notice',
    voice: 'en-US-AvaMultilingualNeural',
    text: 'Hello, you have reached University Bicycle Center. Due to weather conditions, our hours today have been adjusted. Please check ubcbike.com or leave a brief message after the tone and our team will return your call as soon as possible.',
  },
  {
    name: 'Normal Hours + Service Center',
    voice: 'en-US-AndrewMultilingualNeural',
    text: 'Thank you for calling University Bicycle Center, serving Tampa Bay since 1972. Our Tampa showroom and Service Center on Fletcher Avenue are open Tuesday through Saturday 10 AM to 6 PM, and Sunday 12 to 5 PM. For trail rentals at Alafia River State Park, press or visit ubcbike.com.',
  },
  {
    name: 'Español: Aviso de Festivo',
    voice: 'es-US-AlonsoNeural',
    text: 'Gracias por llamar a University Bicycle Center. Nuestra tienda de Tampa está cerrada hoy por el día festivo y reabriremos mañana en nuestro horario habitual. Nuestra tienda de Alafia River State Park sí está abierta hoy. También puede comprar las 24 horas en ubcbike.com.',
  },
];

function slugify(s) {
  return String(s || 'greeting').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'greeting';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new window.FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read audio'));
    reader.readAsDataURL(blob);
  });
}

function downloadBlob(blob, filename) {
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => window.URL.revokeObjectURL(url), 1000);
}

// Decodes MP3 in the browser and exports standard mono 16-bit PCM .WAV (8kHz or 16kHz) for PBX/VoIP systems.
async function mp3BlobToMonoWavBlob(mp3Blob, targetRate) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();
  try {
    const arr = await mp3Blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(arr.slice(0));
    const len = Math.max(1, Math.ceil(decoded.duration * targetRate));
    const off = new window.OfflineAudioContext(1, len, targetRate);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    const samples = rendered.getChannelData(0);

    const dataSize = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataSize);
    const v = new DataView(buf);
    const writeStr = (offSet, str) => {
      for (let i = 0; i < str.length; i++) v.setUint8(offSet + i, str.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    v.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    v.setUint32(16, 16, true); // PCM chunk size
    v.setUint16(20, 1, true); // PCM format
    v.setUint16(22, 1, true); // mono
    v.setUint32(24, targetRate, true);
    v.setUint32(28, targetRate * 2, true);
    v.setUint16(32, 2, true);
    v.setUint16(34, 16, true);
    writeStr(36, 'data');
    v.setUint32(40, dataSize, true);
    let pos = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(pos, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      pos += 2;
    }
    return new window.Blob([buf], { type: 'audio/wav' });
  } finally {
    try { await ctx.close(); } catch (e) { /* ignore */ }
  }
}

export async function renderPhoneVoice(ctx) {
  const { api } = ctx;
  const st = {
    presetName: PRESETS[0].name,
    voice: PRESETS[0].voice,
    rate: '0%',
    text: PRESETS[0].text,
    lastBlob: null,
    generating: false,
  };

  const voiceSel = h('select', {
    onchange: (e) => { st.voice = e.target.value; },
  }, VOICES.map(([val, label]) => h('option', { value: val, selected: val === st.voice }, label)));

  const rateSel = h('select', {
    onchange: (e) => { st.rate = e.target.value; },
  }, RATES.map(([val, label]) => h('option', { value: val, selected: val === st.rate }, label)));

  const textArea = h('textarea', {
    rows: '5',
    maxLength: '1500',
    value: st.text,
    placeholder: 'Write the message your phone system should speak…',
    oninput: (e) => { st.text = e.target.value; updateCounter(); },
  });

  const counter = h('span.small.muted');
  function updateCounter() {
    counter.textContent = (textArea.value || '').length + ' / 1500 characters';
  }
  updateCounter();

  const audioEl = h('audio', { controls: true, style: { width: '100%' }, hidden: true });
  const previewStatus = h('span.small.muted', 'Click "Generate & Listen" to create the audio.');

  const dlMp3Btn = h('button.btn', {
    type: 'button',
    disabled: true,
    onclick: () => {
      if (!st.lastBlob) return;
      downloadBlob(st.lastBlob, 'ubc-phone-' + slugify(st.presetName) + '.mp3');
    },
  }, 'Download .MP3');

  const dlWav16Btn = h('button.btn', {
    type: 'button',
    disabled: true,
    onclick: async () => {
      if (!st.lastBlob) return;
      dlWav16Btn.disabled = true;
      try {
        const wav = await mp3BlobToMonoWavBlob(st.lastBlob, 16000);
        downloadBlob(wav, 'ubc-phone-' + slugify(st.presetName) + '-16khz.wav');
      } catch (err) {
        toast(err.message || 'WAV conversion failed', 'bad');
      } finally {
        dlWav16Btn.disabled = false;
      }
    },
  }, 'Download .WAV (16kHz PBX)');

  const dlWav8Btn = h('button.btn', {
    type: 'button',
    disabled: true,
    onclick: async () => {
      if (!st.lastBlob) return;
      dlWav8Btn.disabled = true;
      try {
        const wav = await mp3BlobToMonoWavBlob(st.lastBlob, 8000);
        downloadBlob(wav, 'ubc-phone-' + slugify(st.presetName) + '-8khz.wav');
      } catch (err) {
        toast(err.message || 'WAV conversion failed', 'bad');
      } finally {
        dlWav8Btn.disabled = false;
      }
    },
  }, 'Download .WAV (8kHz PBX)');

  const genBtn = h('button.btn.primary', {
    type: 'button',
    onclick: async () => {
      const txt = textArea.value.trim();
      if (txt.length < 2) {
        toast('Write a message first', 'bad');
        return;
      }
      st.generating = true;
      genBtn.disabled = true;
      previewStatus.textContent = 'Generating voice audio…';
      try {
        const rawBlob = await api.generateVoice({ text: txt, voice: voiceSel.value, rate: rateSel.value });
        const mp3Blob = new window.Blob([await rawBlob.arrayBuffer()], { type: 'audio/mpeg' });
        st.lastBlob = mp3Blob;
        // Safari iOS frequently fails on blob: URLs in <audio>; a base64 data URL plays reliably.
        audioEl.src = await blobToDataUrl(mp3Blob);
        audioEl.hidden = false;
        audioEl.load();
        dlMp3Btn.disabled = false;
        dlWav16Btn.disabled = false;
        dlWav8Btn.disabled = false;
        const kb = Math.round(mp3Blob.size / 1024);
        previewStatus.textContent = 'Ready (' + kb + ' KB MP3). Press play to preview or download MP3/WAV below.';
        toast('Phone greeting ready', 'ok');
      } catch (err) {
        previewStatus.textContent = err.message || 'Could not generate audio.';
        toast(err.message || 'Voice generation failed', 'bad');
      } finally {
        st.generating = false;
        genBtn.disabled = false;
      }
    },
  }, 'Generate & Listen');

  const presetBtns = PRESETS.map((p) => h('button.btn.sm', {
    type: 'button',
    onclick: () => {
      st.presetName = p.name;
      st.voice = p.voice;
      st.text = p.text;
      voiceSel.value = p.voice;
      textArea.value = p.text;
      updateCounter();
    },
  }, p.name));

  return h('div.stack',
    pageHead('Phone Greetings', 'Free voice generator ($0/mo) for the store phone system — holiday closures, Alafia hours, and custom notices.'),
    card('1. Quick Templates (click to load & edit)',
      h('div.row', { style: { flexWrap: 'wrap', gap: '8px' } }, presetBtns)),
    h('div.grid.grid-2',
      card('2. Script & Voice',
        h('div.stack-sm',
          h('div.grid.grid-2', { style: { gap: '10px' } },
            h('label.field', h('span.small.muted', 'Voice'), voiceSel),
            h('label.field', h('span.small.muted', 'Speed'), rateSel)),
          h('label.field', h('span.small.muted', 'Phone Message Script'), textArea),
          h('div.row-between', counter, genBtn))),
      card('3. Preview & Download for Phone System',
        h('div.stack-sm',
          previewStatus,
          audioEl,
          h('div.row', { style: { flexWrap: 'wrap', gap: '8px', marginTop: '4px' } },
            dlMp3Btn,
            dlWav16Btn,
            dlWav8Btn),
          h('div.small.muted', 'Tip: Most modern VoIP/PBX systems accept .MP3 or 16kHz/8kHz Mono .WAV. Zero API cost.')))));
}
