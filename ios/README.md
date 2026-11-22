# Hannibal on iPhone (native app)

Step 1 of the native app: chat, hold-to-talk, his own voice, Yes/No, camera
and the living orb. It talks to the same server as the web phone app
(`server/phone-app.js`), so **no server deploy is needed** for this step.

## Put it on your iPhone (first time, about 10 minutes)

1. On the Mac: `cd ~/Desktop/Projects/hannibal-v2 && git pull && open ios/Hannibal.xcodeproj`
2. In Xcode, click **Hannibal** at the top of the left column, then the
   **Signing & Capabilities** tab. Tick **Automatically manage signing** and pick
   your name under **Team**. If Xcode says the bundle id is taken, change
   `com.revalisgroup.hannibal` to something like `com.revalisgroup.hannibal.fred`.
3. Plug the iPhone into the Mac with a cable, unlock it, and tap **Trust**.
4. At the top of Xcode, pick your iPhone as the device, then press **▶ Run**.
5. The first time, the iPhone asks for **Developer Mode**: Settings › Privacy &
   Security › Developer Mode › On, restart the phone, then press Run again.
   If it says "Untrusted Developer": Settings › General › VPN & Device
   Management › your name › Trust.
6. Open Hannibal on the phone, paste the phone-app link Hannibal sends on
   Telegram (the one with `?k=`), tap **Connect**.

Tailscale must be on on the iPhone, same as for the web app.

## Using it

- **Live talk** (step 2): tap the orb, or the waveform button at the top. Then just talk:
  he answers in his voice, and you can talk over him to interrupt. It keeps going with
  the screen locked. Tap the orb or the red stop button to end it; it also sleeps after
  3 quiet minutes. Echo cancellation keeps him from hearing himself.
- **Hold the mic** and talk, let go to send. Slide up to cancel.
- **Tap the orb** to stop him talking. Starting to talk also stops him.
- Speaker icon: read every answer aloud, or only when you talked.
- Camera button: take or choose a photo; anything typed goes with it as the question.
- Reminders, the morning brief and Yes/No questions show up live while the app is open,
  and as notifications when it's closed (No right there; Yes needs the phone unlocked and opens the app).

### Siri, Action Button, lock screen (step 4)

Open Hannibal once after installing, so iOS learns the shortcuts.

- **Siri:** "Hey Siri, start Hannibal" (or "Hannibal live") starts live talk. Not "talk to": Siri takes that as calling a contact. "Hey Siri, ask Hannibal" lets Siri ask
  for the question and reads his answer out without opening the app (Siri's voice; same brain).
- **Action Button:** Settings › Action Button › Controls (or Shortcut) › *Talk to Hannibal*.
- **Lock screen / Control Center:** long-press the lock screen › Customize › Lock Screen › tap a
  bottom button › *Talk to Hannibal*. In Control Center: tap + › Add a Control › Hannibal.
- **Dynamic Island:** while live talk runs it shows listening / thinking / speaking, with Stop.

## Notes for builders

- `ios/Hannibal/orb.js` is a copy of `server/phone/orb.js`. The GitHub check
  (`.github/workflows/ios-build.yml`) fails if they differ, so copy it over
  when the orb changes.
- Auth: the link's key is kept in the Keychain and sent as the same
  `hannibal_k` cookie the web app uses.
- Long answers are spoken sentence by sentence (the next one loads while one plays).
- Live talk sends each sentence as a 16 kHz WAV to /api/voice; no server change.
- `ios/Shared/` is compiled into both the app and the `HannibalWidgets` extension (Live Activity
  data + the start/stop intents). The extension (iOS 18+) draws the control button and the Live Activity.
