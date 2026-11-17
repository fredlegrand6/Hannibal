#!/usr/bin/env python3
"""
Hannibal · streaming Silero VAD sidecar.

The reason this exists: a level meter cannot tell a voice from a song — both are
just "sound above the floor". Silero is a real speech model; it distinguishes
speech from music, fans, typing, etc. This process loads it ONCE and streams the
mic, emitting end-of-utterance decisions the renderer can trust even with music
playing. It runs alongside the renderer's own capture, exactly like wakeword.py
already does (two concurrent mic clients is fine on CoreAudio).

stdout protocol (one token per line, flushed):
    VAD_READY              model loaded + mic open
    SPEECH_START           sustained speech began
    SPEECH_END             speech ended (trailing silence exceeded the hangover)
    PROB <0..1>            per-frame probability (only if VAD_DEBUG=1)
    VAD_ERROR <msg>        fatal — caller should fall back to level detection

stdin commands (one per line):
    PAUSE                  ignore the mic (use while Hannibal is speaking)
    RESUME                 resume detection
    THRESH <0..1>          live-tune the speech threshold
    SILENCE <ms>           live-tune the end-of-utterance hangover

Test mode (no mic):  vad-stream.py --wav <file>   → prints the same events.
"""

import os
import sys
import threading

SR = 16000
FRAME = 512                  # silero's required frame size at 16 kHz (32 ms)
THRESH = float(os.environ.get("VAD_THRESH", "0.5"))
START_FRAMES = int(os.environ.get("VAD_START_FRAMES", "3"))      # ~96 ms of speech to start a turn
SILENCE_MS = int(os.environ.get("VAD_SILENCE_MS", "700"))        # trailing quiet that ends a turn
DEBUG = os.environ.get("VAD_DEBUG", "") not in ("", "0")

def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()

# ── load silero once (cached under ~/.cache/torch/hub after the first run) ──
try:
    import torch
    import numpy as np
    torch.set_num_threads(1)
    model, _ = torch.hub.load(repo_or_dir="snakers4/silero-vad", model="silero_vad", trust_repo=True)
    model.eval()
except Exception as e:  # noqa: BLE001
    emit(f"VAD_ERROR load: {e}")
    sys.exit(3)

def prob_of(frame_f32):
    """frame_f32: numpy float32 length FRAME in [-1,1] → speech probability."""
    with torch.no_grad():
        return float(model(torch.from_numpy(frame_f32), SR).item())


class Turn:
    """State machine turning per-frame probabilities into START/END events."""
    def __init__(self):
        self.silence_frames = max(1, round(SILENCE_MS / (FRAME / SR * 1000)))
        self.active = False
        self.speech_run = 0
        self.quiet_run = 0

    def retune(self):
        self.silence_frames = max(1, round(SILENCE_MS / (FRAME / SR * 1000)))

    def reset(self):
        self.active = False
        self.speech_run = 0
        self.quiet_run = 0

    def feed(self, p):
        if DEBUG:
            emit(f"PROB {p:.3f}")
        if p >= THRESH:
            self.speech_run += 1
            self.quiet_run = 0
        else:
            self.quiet_run += 1
            self.speech_run = 0
        if not self.active and self.speech_run >= START_FRAMES:
            self.active = True
            emit("SPEECH_START")
        elif self.active and self.quiet_run >= self.silence_frames:
            self.active = False
            emit("SPEECH_END")


# ── test mode: run a wav file through the same machine ──
if "--wav" in sys.argv:
    import torchaudio
    path = sys.argv[sys.argv.index("--wav") + 1]
    wav, sr = torchaudio.load(path)
    if wav.shape[0] > 1:
        wav = wav.mean(0, keepdim=True)
    if sr != SR:
        wav = torchaudio.functional.resample(wav, sr, SR)
    data = wav.squeeze(0).numpy().astype("float32")
    emit("VAD_READY")
    t = Turn()
    for i in range(0, len(data) - FRAME, FRAME):
        t.feed(prob_of(data[i:i + FRAME]))
    if t.active:
        emit("SPEECH_END")
    sys.exit(0)


# ── live mode: pyaudio mic stream ──
paused = False

def stdin_loop():
    global paused, THRESH, SILENCE_MS
    for raw in sys.stdin:
        cmd = raw.strip()
        if cmd == "PAUSE":
            paused = True
        elif cmd == "RESUME":
            turn.reset()      # re-arm so speech already in progress re-fires SPEECH_START
            paused = False
        elif cmd.startswith("THRESH "):
            try: THRESH = float(cmd.split()[1])
            except Exception: pass
        elif cmd.startswith("SILENCE "):
            try:
                SILENCE_MS = int(cmd.split()[1]); turn.retune()
            except Exception: pass

try:
    import pyaudio
    pa = pyaudio.PyAudio()
    stream = pa.open(format=pyaudio.paInt16, channels=1, rate=SR,
                     input=True, frames_per_buffer=FRAME)
except Exception as e:  # noqa: BLE001
    emit(f"VAD_ERROR mic: {e}")
    sys.exit(4)

turn = Turn()
threading.Thread(target=stdin_loop, daemon=True).start()
emit("VAD_READY")

import time
consec_err = 0
while True:
    try:
        data = stream.read(FRAME, exception_on_overflow=False)
        if paused:
            if turn.active:
                turn.reset()   # drop the turn; don't emit END for paused (TTS) audio
            consec_err = 0
            continue
        samples = np.frombuffer(data, dtype=np.int16).astype("float32") / 32768.0
        turn.feed(prob_of(samples))
        consec_err = 0
    except KeyboardInterrupt:
        break
    except Exception as e:  # noqa: BLE001
        # Transient frame error (device contention, Spotify grabbing the device,
        # an overflow). Log to STDERR and KEEP RUNNING — do NOT emit VAD_ERROR,
        # which would flip the renderer to the level detector. Silero must stay
        # the authority across these blips. Only a sustained failure is fatal.
        consec_err += 1
        sys.stderr.write(f"vad frame error ({consec_err}): {e}\n"); sys.stderr.flush()
        if consec_err >= 200:
            emit("VAD_ERROR fatal: too many consecutive frame errors")
            sys.exit(5)
        time.sleep(0.05)  # brief backoff so a wedged device can't hot-spin
