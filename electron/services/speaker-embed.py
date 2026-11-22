#!/usr/bin/env python3
"""SPEAKER EMBED - Hannibal's sense of WHO is talking.

A small helper that stays running next to the speech server (stt-server.js
starts it). It turns a clip of speech into a "voiceprint" number list (a
192-number ECAPA speaker embedding, SpeechBrain spkrec-ecapa-voxceleb), so
the server can compare it with Fred's enrolled voice. Everything stays on the
Mac: the model is downloaded once from Hugging Face into
~/Library/Application Support/Hannibal/models/ecapa and the clips never leave
the machine.

Protocol: one JSON object per line on stdin, one answer per line on stdout.
  {"id": 1, "wav": "/tmp/clip.wav"}   ->  {"id": 1, "ok": true, "emb": [...], "seconds": 2.4}
  {"id": 2, "ping": true}              ->  {"id": 2, "ok": true, "ready": true}
On any error: {"id": n, "ok": false, "error": "..."} (the server then tags the
line "unknown", so Hannibal behaves as before).

Why not speechbrain's EncoderClassifier.from_hparams: SpeechBrain 1.0.3 breaks
on the Mac's newer torchaudio (no list_audio_backends) and huggingface_hub 1.x
(no use_auth_token). So the model is built directly and the clip is read with
the standard wave module (no torchaudio / torchcodec audio loading).

Env: HANNIBAL_SPEAKER_MODEL_DIR (model folder), HANNIBAL_SPEAKER_MODEL_REPO.
"""
import json
import os
import sys
import wave

MODEL_DIR = os.environ.get('HANNIBAL_SPEAKER_MODEL_DIR') or os.path.expanduser(
    '~/Library/Application Support/Hannibal/models/ecapa')
REPO = os.environ.get('HANNIBAL_SPEAKER_MODEL_REPO', 'speechbrain/spkrec-ecapa-voxceleb')
CKPT = 'embedding_model.ckpt'


def say(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def log(msg):
    sys.stderr.write('[speaker-embed] ' + msg + '\n')
    sys.stderr.flush()


def ensure_model():
    path = os.path.join(MODEL_DIR, CKPT)
    if os.path.exists(path):
        return path
    os.makedirs(MODEL_DIR, exist_ok=True)
    log('downloading the voice model once (about 80 MB)...')
    from huggingface_hub import hf_hub_download
    hf_hub_download(REPO, CKPT, local_dir=MODEL_DIR)
    return path


def load_model():
    import torchaudio  # noqa: F401  (patched before speechbrain looks at it)
    if not hasattr(torchaudio, 'list_audio_backends'):
        torchaudio.list_audio_backends = lambda: ['soundfile']
    import torch
    from speechbrain.lobes.features import Fbank
    from speechbrain.lobes.models.ECAPA_TDNN import ECAPA_TDNN
    fbank = Fbank(n_mels=80)
    model = ECAPA_TDNN(input_size=80, channels=[1024, 1024, 1024, 1024, 3072],
                       kernel_sizes=[5, 3, 3, 3, 1], dilations=[1, 2, 3, 4, 1],
                       attention_channels=128, lin_neurons=192)
    model.load_state_dict(torch.load(ensure_model(), map_location='cpu'))
    model.eval()
    return torch, fbank, model


def read_wav(path):
    import numpy as np
    w = wave.open(path)
    try:
        sr, ch, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
        raw = w.readframes(w.getnframes())
    finally:
        w.close()
    if width != 2:
        raise ValueError('expected 16-bit audio')
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if sr != 16000:
        # Simple linear resample (the server always sends 16 kHz, this is a safety net).
        n = int(len(a) * 16000 / sr)
        a = np.interp(np.linspace(0, len(a) - 1, n), np.arange(len(a)), a).astype(np.float32)
    return a


def main():
    try:
        torch, fbank, model = load_model()
    except Exception as e:  # missing packages, no network for the first download...
        log('not available: %s' % e)
        for line in sys.stdin:
            try:
                rid = json.loads(line).get('id')
            except Exception:
                rid = None
            say({'id': rid, 'ok': False, 'error': 'speaker model not available: %s' % e})
        return
    log('ready')
    for line in sys.stdin:
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            if req.get('ping'):
                say({'id': rid, 'ok': True, 'ready': True})
                continue
            a = read_wav(req['wav'])
            with torch.no_grad():
                x = torch.from_numpy(a).unsqueeze(0)
                feats = fbank(x)
                feats = feats - feats.mean(dim=1, keepdim=True)   # sentence mean norm, as in training
                emb = model(feats).squeeze()
                emb = emb / emb.norm()
            say({'id': rid, 'ok': True, 'emb': [round(float(v), 5) for v in emb.tolist()],
                 'seconds': round(len(a) / 16000.0, 2)})
        except Exception as e:
            say({'id': rid, 'ok': False, 'error': str(e)[:200]})


if __name__ == '__main__':
    main()
