import io
import wave
import numpy as np

# Audio configuration
SAMPLE_RATE = 44100

BASE_FREQUENCY = 4000
FREQUENCY_STEP = 40
MARKER_FREQUENCY = 4700

DIGIT_DURATION = 0.3
MARKER_DURATION = 0.15
GAP_DURATION = 0.3

REPEAT_COUNT = 80
SESSION_DURATION = 10

AMPLITUDE = 0.9


# Generate a sine wave for the given frequency and duration
def generate_tone(
    frequency: float,
    duration: float
) -> np.ndarray:

    # Calculate the number of audio samples
    sample_count = int(SAMPLE_RATE * duration)

    # Create time values for each sample
    t = np.arange(sample_count) / SAMPLE_RATE

    # Generate the sine wave
    tone = np.sin(2 * np.pi * frequency * t)

    # Set the volume and return the audio as float32
    return (tone * AMPLITUDE).astype(np.float32)


# Convert each digit into its corresponding audio frequency
def digit_to_tone(digit: int) -> np.ndarray:

    # Make sure the digit is between 0 and 9
    if digit < 0 or digit > 9:
        raise ValueError("Digit must be between 0 and 9")

    # Calculate the frequency for the given digit
    frequency = BASE_FREQUENCY + (
        digit * FREQUENCY_STEP
    )

    # Generate the tone for the digit
    return generate_tone(frequency, DIGIT_DURATION)


# Generate silence between audio signals
def generate_silence(
    duration: float = GAP_DURATION
) -> np.ndarray:

    # Calculate the number of silent audio samples
    sample_count = int(SAMPLE_RATE * duration)

    # Create an array of zeros to represent silence
    return np.zeros(sample_count, dtype=np.float32)


# Generate audio for the numeric session code
def generate_session_audio(
    session_code: str
) -> np.ndarray:

    # Make sure the session code contains only digits
    if not session_code.isdigit():
        raise ValueError("Session code must contain digits only")

    # Store all generated audio parts
    parts = []

    # Repeat the session code multiple times
    for _ in range(REPEAT_COUNT):

        # Add the start marker before each session code
        parts.append(
            generate_tone(
                MARKER_FREQUENCY,
                MARKER_DURATION
            )
        )

        # Add a short silence after the start marker
        parts.append(generate_silence())

        # Convert every digit of the session code into a tone
        for digit in session_code:

            # Generate the tone for the current digit
            parts.append(
                digit_to_tone(int(digit))
            )

            # Add a short silence after each digit
            parts.append(generate_silence())

    # Combine all audio parts into one audio array
    return np.concatenate(parts)


# Convert NumPy audio data into WAV file bytes
def convert_to_wav(audio: np.ndarray) -> bytes:

    # Keep all audio values within the valid range
    audio = np.clip(audio, -1.0, 1.0)

    # Convert the audio from float format to 16-bit PCM
    pcm_audio = (audio * 32767).astype(np.int16)

    # Create an in-memory buffer for the WAV file
    buffer = io.BytesIO()

    # Open the buffer as a WAV file
    with wave.open(buffer, "wb") as wav_file:

        # Set the audio to mono channel
        wav_file.setnchannels(1)

        # Set the sample width to 2 bytes
        wav_file.setsampwidth(2)

        # Set the audio sample rate
        wav_file.setframerate(SAMPLE_RATE)

        # Write the audio data into the WAV file
        wav_file.writeframes(pcm_audio.tobytes())

    # Move the buffer position back to the beginning
    buffer.seek(0)

    # Return the complete WAV file as bytes
    return buffer.read()
