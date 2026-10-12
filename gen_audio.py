import io
import wave
import numpy as np

# Audio configuration
SAMPLE_RATE = 44100
BASE_FREQUENCY = 4000
FREQUENCY_STEP = 60        # Safe spacing taake echo overlap na ho
MARKER_FREQUENCY = 4800    # Frontend ki 5000Hz limit ke andar safe marker
DIGIT_DURATION = 0.35      
MARKER_DURATION = 0.15     # Perfect 0.15s duration
GAP_DURATION = 0.5         # Goonj (echo) khatam karne ke liye silence gap
REPEAT_COUNT = 8
SESSION_DURATION = 2
AMPLITUDE = 0.9

def generate_tone(frequency: float, duration: float) -> np.ndarray:
    sample_count = int(SAMPLE_RATE * duration)
    t = np.arange(sample_count) / SAMPLE_RATE
    tone = np.sin(2 * np.pi * frequency * t)
    return (tone * AMPLITUDE).astype(np.float32)

def digit_to_tone(digit: int) -> np.ndarray:
    if digit < 0 or digit > 9:
        raise ValueError("Digit must be between 0 and 9")
    frequency = BASE_FREQUENCY + (digit * FREQUENCY_STEP)
    return generate_tone(frequency, DIGIT_DURATION)

def generate_silence(duration: float = GAP_DURATION) -> np.ndarray:
    sample_count = int(SAMPLE_RATE * duration)
    return np.zeros(sample_count, dtype=np.float32)

def generate_session_audio(session_code: str) -> np.ndarray:
    if not session_code.isdigit():
        raise ValueError("Session code must contain digits only")
    
    parts = []
    for _ in range(REPEAT_COUNT):
        parts.append(generate_tone(MARKER_FREQUENCY, MARKER_DURATION))
        parts.append(generate_silence())
        
        for digit in session_code:
            parts.append(digit_to_tone(int(digit)))
            parts.append(generate_silence())
        
    return np.concatenate(parts)

def convert_to_wav(audio: np.ndarray) -> bytes:
    audio = np.clip(audio, -1.0, 1.0)
    pcm_audio = (audio * 32767).astype(np.int16)
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(SAMPLE_RATE)
        wav_file.writeframes(pcm_audio.tobytes())
    buffer.seek(0)
    return buffer.read()