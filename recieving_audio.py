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
from scipy.signal import butter, sosfiltfilt

FACE_MATCH_THRESHOLD = float(os.getenv("DUPLICATE_THRESHOLD"))

MAX_AUDIO_SIZE = 5 * 1024 * 1024

MAX_IMAGE_SIZE = 5 * 1024 * 1024



def apply_high_pass_filter(audio: np.ndarray) -> np.ndarray:
    # Keep the original audio samples in floating-point format.
    audio = audio.astype(np.float64)

    # Design a high-pass filter with a 16 kHz cutoff.
    sos = butter(
        4,
        3000,
        btype="highpass",
        fs=SAMPLE_RATE,
        output="sos",
    )

    # Remove frequencies below the cutoff.
    filtered_audio = sosfiltfilt(sos, audio)

    # Return the filtered audio samples.
    return filtered_audio

# Define a function to find the strongest frequency in an audio segment.
def get_dominant_frequency(audio_chunk: np.ndarray) -> float:

    # Check whether the audio segment contains any samples.
    if len(audio_chunk) == 0:

        # Raise an error if the segment is empty.
        raise ValueError("Empty audio chunk")

    # Convert audio samples to floating-point numbers.
    audio_chunk = audio_chunk.astype(np.float64)

    # Remove the average value to reduce the DC offset.
    audio_chunk = audio_chunk - np.mean(audio_chunk)

    # Create a Hann window to reduce frequency leakage.
    window = np.hanning(len(audio_chunk))

    # Calculate the strength of each frequency using the FFT.
    spectrum = np.abs(np.fft.rfft(audio_chunk * window))

    # Generate the frequency value for each FFT result.
    frequencies = np.fft.rfftfreq(
        len(audio_chunk),       # Use the number of audio samples.
        d=1 / SAMPLE_RATE,      # Calculate the time between samples.
    )

    # Find the index of the strongest frequency.
    peak_index = np.argmax(spectrum)

    # Return the frequency at that index.
    return float(frequencies[peak_index])


# Define a function to decode the session ID from a WAV audio file.
def decode_audio(wav_bytes: bytes) -> str:

    # Try to open the audio file from its in-memory bytes.
    try:
        # Open the uploaded bytes as a WAV file.
        with wave.open(io.BytesIO(wav_bytes), "rb") as wav_file:

            # Get the number of audio channels.
            channels = wav_file.getnchannels()

            # Get the number of bytes used for each audio sample.
            sample_width = wav_file.getsampwidth()

            # Get the audio sample rate.
            sample_rate = wav_file.getframerate()

            # Read all audio samples from the WAV file.
            frames = wav_file.readframes(wav_file.getnframes())

    # Handle errors caused by invalid WAV files.
    except (wave.Error, EOFError):

        # Return an HTTP 400 error for invalid audio.
        raise HTTPException(
            status_code=400,
            detail="Invalid WAV audio file.",
        )

    # Check whether the sample rate matches the expected rate.
    if sample_rate != SAMPLE_RATE:

        # Reject audio with an unsupported sample rate.
        raise HTTPException(
            status_code=400,
            detail="Unsupported audio sample rate.",
        )

    # Check whether the audio uses 16-bit samples.
    if sample_width != 2:

        # Reject audio that does not use 16-bit PCM.
        raise HTTPException(
            status_code=400,
            detail="Audio must use 16-bit PCM.",
        )

    # Convert the raw audio bytes into 16-bit integer samples.
    audio = np.frombuffer(frames, dtype=np.int16)

    # Check whether the audio has multiple channels.
    if channels > 1:

        # Convert multi-channel audio into one mono channel.
        audio = audio.reshape(-1, channels).mean(axis=1)

    # Check whether the audio contains any samples.
    if len(audio) == 0:

        # Reject empty audio.
        raise HTTPException(
            status_code=400,
            detail="Audio is empty.",
        )
    # Reduce low-frequency background noise.
    audio = apply_high_pass_filter(audio)
    # Calculate the number of samples in a 50-millisecond frame.
    frame_size = int(SAMPLE_RATE * 0.05)

    # Create a list to store detected sound segments.
    active_segments = []

    # Create a temporary list for the current sound segment.
    current_segment = []

    # Calculate a threshold to distinguish sound from silence.
    threshold = max(500, np.max(np.abs(audio)) * 0.08)

    # Process the audio in small frames.
    for start in range(0, len(audio), frame_size):

        # Select the current 50-millisecond audio frame.
        chunk = audio[start:start + frame_size]

        # Stop if the remaining frame is incomplete.
        if len(chunk) < frame_size:
            break

        # Calculate the volume of the current frame.
        if np.sqrt(np.mean(chunk.astype(np.float64) ** 2)) > threshold:

            # Add active sound samples to the current segment.
            current_segment.extend(chunk.tolist())

        # Run this block when the current frame is silent.
        elif current_segment:

            # Save the completed sound segment.
            active_segments.append(np.array(current_segment))

            # Reset the temporary segment.
            current_segment = []

    # Save the last segment if the audio ends with sound.
    if current_segment:
        active_segments.append(np.array(current_segment))

    # Store complete groups of decoded digits.
    decoded_groups = []

    # Store digits for the current session signal.
    current_digits = []

    # Process every detected sound segment.
    for segment in active_segments:

        # Ignore segments that are shorter than 80 milliseconds.
        if len(segment) < int(SAMPLE_RATE * 0.08):
            continue

        # Find the strongest frequency in the current segment.
        frequency = get_dominant_frequency(segment)

        # Check whether this segment contains the marker frequency.
        if abs(frequency - MARKER_FREQUENCY) < 100:

            # Save the previous group if it contains digits.
            if current_digits:
                decoded_groups.append("".join(current_digits))

                # Start collecting digits for a new group.
                current_digits = []

            # Skip further processing of the marker segment.
            continue

        # Estimate the digit represented by the detected frequency.
        digit = round(
            (frequency - BASE_FREQUENCY) / FREQUENCY_STEP
        )

        # Calculate the expected frequency for the estimated digit.
        expected_frequency = BASE_FREQUENCY + digit * FREQUENCY_STEP

        # Check whether the digit is valid and its frequency is close enough.
        if (
            0 <= digit <= 9
            and abs(frequency - expected_frequency) < 25
        ):

            # Add the detected digit to the current group.
            current_digits.append(str(digit))

    # Save the last digit group if it was not followed by a marker.
    if current_digits:
        decoded_groups.append("".join(current_digits))

    # Check whether any session ID groups were detected.
    if not decoded_groups:

        # Reject audio when no session ID could be decoded.
        raise HTTPException(
            status_code=400,
            detail="Could not decode the attendance session from audio.",
        )

    # Create a dictionary to count repeated session ID groups.
    counts = {}

    # Count how many times each group was decoded.
    for group in decoded_groups:
        counts[group] = counts.get(group, 0) + 1

    # Select the most frequently detected session ID.
    session_id = max(counts, key=counts.get)

    # Require the selected session ID to appear at least twice.
    if counts[session_id] < 2:

        # Reject the signal if it is not sufficiently consistent.
        raise HTTPException(
            status_code=400,
            detail="Audio signal was unclear. Please try again.",
        )

    # Return the decoded session ID as text.
    return session_id

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
