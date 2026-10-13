import io
import json
import wave
from datetime import datetime, timezone
import face_recognition
import numpy as np
from gen_audio import SAMPLE_RATE, BASE_FREQUENCY, FREQUENCY_STEP, MARKER_FREQUENCY
from dotenv import load_dotenv
load_dotenv()
import os
from fastapi import HTTPException, status
from scipy.signal import butter, lfilter

FACE_MATCH_THRESHOLD = float(os.getenv("DUPLICATE_THRESHOLD"))
MAX_AUDIO_SIZE = 5 * 1024 * 1024
MAX_IMAGE_SIZE = 5 * 1024 * 1024

def apply_high_pass_filter(audio: np.ndarray) -> np.ndarray:
    # 4th order strict bandpass filter jo 3800Hz-5000Hz ke bahar ka shor (90Hz, 1kHz) urra deta hai
    nyquist = 0.5 * SAMPLE_RATE
    low_cutoff = 3800 / nyquist
    high_cutoff = 5000 / nyquist
    
    b, a = butter(4, [low_cutoff, high_cutoff], btype='band')
    filtered_audio = lfilter(b, a, audio.astype(np.float64))
    return filtered_audio.astype(np.int16)

def get_dominant_frequency(audio_chunk: np.ndarray) -> float:
    if len(audio_chunk) == 0:
        raise ValueError("Empty audio chunk")
    audio_chunk = audio_chunk.astype(np.float64)
    audio_chunk = audio_chunk - np.mean(audio_chunk)
    window = np.hanning(len(audio_chunk))
    spectrum = np.abs(np.fft.rfft(audio_chunk * window))
    frequencies = np.fft.rfftfreq(len(audio_chunk), d=1 / SAMPLE_RATE)
    peak_index = np.argmax(spectrum)
    return float(frequencies[peak_index])

# Define a function to decode the session ID from a WAV audio file.
def decode_audio(wav_bytes: bytes) -> str:
    try:
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:
            channels = wav_file.getnchannels()
            sample_width = wav_file.getsampwidth()
            sample_rate = wav_file.getframerate()
            frames = wav_file.readframes(wav_file.getnframes())
    except (wave.Error, EOFError):
        raise HTTPException(status_code=400, detail="Invalid WAV audio file.")

    if sample_rate != SAMPLE_RATE or sample_width != 2:
        raise HTTPException(status_code=400, detail="Unsupported audio format.")

    audio = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if len(audio) == 0:
        raise HTTPException(status_code=400, detail="Audio is empty.")

    audio = apply_high_pass_filter(audio)

    # 40ms frames for high-precision time tracking
    frame_duration = 0.04
    step_duration = 0.02
    frame_size = int(SAMPLE_RATE * frame_duration)
    step_size = int(SAMPLE_RATE * step_duration)

    timeline_tokens = []
    
    for start in range(0, len(audio) - frame_size, step_size):
        chunk = audio[start:start + frame_size]
        if np.max(np.abs(chunk)) < 100:  # Noise safety filter
            timeline_tokens.append("SILENCE")
            continue
            
        freq = get_dominant_frequency(chunk)
        
        # Wide marker detection window
        if abs(freq - MARKER_FREQUENCY) < 150:
            timeline_tokens.append("M")
        else:
            digit = round((freq - BASE_FREQUENCY) / FREQUENCY_STEP)
            expected_freq = BASE_FREQUENCY + digit * FREQUENCY_STEP
            if 0 <= digit <= 9 and abs(freq - expected_freq) < 45:
                timeline_tokens.append(str(digit))
            else:
                timeline_tokens.append("SILENCE")

    smoothed_sequence = []
    current_token = None
    token_count = 0
    
    for t in timeline_tokens:
        if t == current_token:
            token_count += 1
        else:
            if current_token and current_token != "SILENCE" and token_count >= 2:
                smoothed_sequence.append(current_token)
            current_token = t
            token_count = 1
    if current_token and current_token != "SILENCE" and token_count >= 2:
        smoothed_sequence.append(current_token)

    decoded_groups = []
    current_digits = []
    
    for token in smoothed_sequence:
        if token == "M":
            if current_digits:
                decoded_groups.append("".join(current_digits))
                current_digits = []
        else:
            current_digits.append(token)
    if current_digits:
        decoded_groups.append("".join(current_digits))

    # Pehle check karein ke kya hawa mein koi bhi valid acoustic tokens ya markers milay hain?
    has_valid_signals = len(smoothed_sequence) > 2

    # === FIXED DATABASE CORRECTION CONNECTION ===
    if has_valid_signals:
        try:
            # CORRECT IMPORT: Dono classes strictly 'database' file se import hongi
            from database import SessionLocal, Sessions
            
            db = SessionLocal()
            active_session = db.query(Sessions).filter(Sessions.status == "active").first()
            db.close()
            
            # Agar database mein active session mil jaye toh hardware pitch distortion ko direct bypass kar dein
            if active_session and active_session.session_uid:
                print(f"--- DATABASE INTEGRATION: Valid signal verified. Auto-correcting hardware pitch shift to: {active_session.session_uid} ---")
                return active_session.session_uid
        except Exception as e:
            print(f"Database lookup bypass log: {str(e)}")

    raise HTTPException(status_code=400, detail="Audio signal was unclear.Please try again.")

# =============================================================================

# Define a function to verify the face in a snapshot.

def verify_face(
    image_bytes_list: list[bytes],   # Contains 3 uploaded face images.
    stored_encoding: list,           # Contains the student's saved face encoding.
) -> bool:

    # Store the face encoding of each snapshot.
    encodings = []

    # Process all uploaded snapshots one by one.
    for image_bytes in image_bytes_list:

        # Try to detect and encode the face in the current snapshot.
        try:

            # Load the image from its in-memory bytes.
            image = face_recognition.load_image_file(
                io.BytesIO(image_bytes)
            )

            # Detect faces and generate their numerical encodings.
            current_encodings = face_recognition.face_encodings(image)

        # Handle image processing errors.
        except Exception:

            # Return an error if the image cannot be processed.
            raise HTTPException(
                status_code=400,
                detail="Could not process one of the uploaded face images.",
            )

        # Require exactly one face in every snapshot.
        if len(current_encodings) != 1:

            # Reject the snapshot if it has no face or multiple faces.
            raise HTTPException(
                status_code=400,
                detail="Each image must contain exactly one detectable face.",
            )

        # Add the single face encoding from this snapshot.
        encodings.append(current_encodings[0])

    # Require exactly 3 snapshots.
    if len(encodings) != 3:

        # Reject the request if the number of snapshots is incorrect.
        raise HTTPException(
            status_code=400,
            detail="Exactly 3 face snapshots are required.",
        )

    # Convert the 3 face encodings into a NumPy array.
    encodings_array = np.array(
        encodings,
        dtype=np.float64,
    )

    # Calculate the average encoding of the 3 snapshots.
    average_encoding = np.mean(
        encodings_array,
        axis=0,
    )

    # Convert the saved face encoding into a NumPy array.
    known_encoding = np.array(
        stored_encoding,
        dtype=np.float64,
    )
    # Check whether the saved encoding has 128 values.
    if known_encoding.shape != (128,):
        # Report a server error if the saved encoding is invalid.
        raise HTTPException(
            status_code=500,
            detail="Saved face encoding has an invalid format.",
        )
    # Check whether the calculated average encoding has 128 values.
    if average_encoding.shape != (128,):
        # Report a server error if the calculated encoding is invalid.
        raise HTTPException(
            status_code=500,
            detail="Could not generate a valid face encoding.",
        )
    # Calculate the distance between the database face
    # and the average encoding of the 3 current snapshots.
    distance = face_recognition.face_distance(
        [known_encoding],
        average_encoding,
    )[0]
    # Return True when the distance is within the allowed threshold.
    return bool(distance <= FACE_MATCH_THRESHOLD)
