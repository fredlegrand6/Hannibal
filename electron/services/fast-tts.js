// FAST TTS — Hannibal's voice straight from ElevenLabs, no Python in between.
//
// The old path started python3 + nova-tts.py for every sentence and used the
// slower eleven_multilingual_v2 model. This calls the API directly from Node
// (connection kept warm) with eleven_flash_v2_5 by default: same "Daniel"
// voice, all his languages, a fraction of the wait.
// HANNIBAL_TTS_MODEL=eleven_multilingual_v2 brings the old model back.
'use strict';

const VOICE_ID = process.env.HANNIBAL_TTS_VOICE || 'onwK4e9ZLuTAKqWW03F9';   // Daniel

function ttsRequest(text, { apiKey, model, voiceId = VOICE_ID } = {}) {
  return {
    url: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    init: {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: String(text || ''),
        model_id: model || process.env.HANNIBAL_TTS_MODEL || 'eleven_flash_v2_5',
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.3 },
      }),
    },
  };
}

async function speakToMp3(text, { apiKey = process.env.ELEVENLABS_API_KEY, model, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set');
  const { url, init } = ttsRequest(text, { apiKey, model });
  const r = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`ElevenLabs ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

module.exports = { speakToMp3, ttsRequest };
