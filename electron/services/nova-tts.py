#!/usr/bin/env python3
import sys, os, requests

def speak(text, output_file):
    api_key = os.environ.get('ELEVENLABS_API_KEY', '')
    if not api_key:
        env_path = os.path.join(os.path.dirname(__file__), '.env')
        if os.path.exists(env_path):
            for line in open(env_path):
                if line.startswith('ELEVENLABS_API_KEY='):
                    api_key = line.split('=', 1)[1].strip()

    voice_id = 'onwK4e9ZLuTAKqWW03F9'  # Daniel
    url = f'https://api.elevenlabs.io/v1/text-to-speech/{voice_id}'

    resp = requests.post(url, timeout=30,
        headers={
            'xi-api-key': api_key,
            'Content-Type': 'application/json'
        },
        json={
            'text': text,
            'model_id': 'eleven_multilingual_v2',
            'voice_settings': {
                'stability': 0.5,
                'similarity_boost': 0.75,
                'style': 0.3
            }
        })

    if resp.status_code == 200:
        with open(output_file, 'wb') as f:
            f.write(resp.content)
    else:
        print(f'Error: {resp.status_code} {resp.text}', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    text = sys.stdin.read().strip()
    output = sys.argv[1] if len(sys.argv) > 1 else '/tmp/nova-tts.mp3'
    speak(text, output)
