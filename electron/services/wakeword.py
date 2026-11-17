# Hannibal wake word - openWakeWord (free, offline, no account or key needed).
# Prints WAKE_WORD_DETECTED exactly like the old Picovoice version did.
#
# The microphone is opened with retries: if it is busy, not yet permitted, or
# drops out mid-run (headset unplugged, another app grabbing the device), this
# script keeps trying instead of dying. Status goes to stdout, problems to stderr.
import os, sys, time
import numpy as np
import pvrecorder
from openwakeword.model import Model

WAKE_MODEL = os.environ.get("HANNIBAL_WAKE_MODEL", "hey_jarvis")
THRESHOLD = float(os.environ.get("HANNIBAL_WAKE_THRESHOLD", "0.5"))
FRAME = 1280  # 80 ms at 16 kHz, what openWakeWord expects
SILENT_FRAMES_WARN = 125  # ~10 s of pure digital silence = mic not really delivering audio


def log(msg):
    print(msg, flush=True)


def err(msg):
    print(msg, file=sys.stderr, flush=True)


def open_mic():
    """Open the default microphone, retrying with a growing pause until it works."""
    delay = 1.0
    while True:
        try:
            rec = pvrecorder.PvRecorder(frame_length=FRAME)
            rec.start()
            return rec
        except Exception as e:  # noqa: BLE001
            err(f"mic open failed ({e}); retrying in {delay:.0f}s")
            time.sleep(delay)
            delay = min(delay * 2, 15.0)


def close_mic(rec):
    for fn in (getattr(rec, "stop", None), getattr(rec, "delete", None)):
        try:
            fn and fn()
        except Exception:  # noqa: BLE001
            pass


log(f"Loading openWakeWord '{WAKE_MODEL}'...")
model = Model(wakeword_models=[WAKE_MODEL], inference_framework="onnx")

recorder = open_mic()
log(f"Listening for '{WAKE_MODEL}'...")

cooldown = 0
silent = 0
warned_silent = False
try:
    while True:
        try:
            pcm = np.array(recorder.read(), dtype=np.int16)
        except Exception as e:  # noqa: BLE001
            err(f"mic read failed ({e}); reopening the microphone")
            close_mic(recorder)
            time.sleep(1.0)
            recorder = open_mic()
            model.reset()
            log(f"Listening for '{WAKE_MODEL}'... (mic reopened)")
            continue

        # All-zero audio means macOS is handing us silence (no microphone
        # permission for the app that started us). Say so once, clearly.
        if not pcm.any():
            silent += 1
            if silent >= SILENT_FRAMES_WARN and not warned_silent:
                err("mic is delivering pure silence - check microphone permission "
                    "(System Settings > Privacy & Security > Microphone)")
                warned_silent = True
        else:
            if warned_silent:
                log("mic audio is flowing again")
            silent = 0
            warned_silent = False

        scores = model.predict(pcm)
        if max(scores.values()) >= THRESHOLD and time.time() > cooldown:
            log("WAKE_WORD_DETECTED")
            model.reset()
            cooldown = time.time() + 1.5
except KeyboardInterrupt:
    log("Stopping...")
finally:
    close_mic(recorder)
