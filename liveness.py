import io
import os
import secrets
import threading
import time

import face_recognition
import numpy as np
from dotenv import load_dotenv
from fastapi import HTTPException
from jose import JWTError, jwt
from PIL import Image

load_dotenv()

SECRET_KEY = os.environ["SECRET_KEY"]
ALGORITHM = os.environ["ALGORITHM"]
FACE_MATCH_THRESHOLD = float(os.environ["DUPLICATE_THRESHOLD"])

# ------------------------------------------------------------
# Settings
# ------------------------------------------------------------
CHALLENGE_TTL_SECONDS = 120
CHALLENGE_TYPE = "liveness"
ACTIONS = ["EYES_CLOSED", "TURN_LEFT", "TURN_RIGHT"]

# Eye openness (eye aspect ratio): open eyes are about 0.25-0.35, closed eyes about 0.10-0.18.
EYES_CLOSED_MAX = 0.20
EYES_OPEN_MIN = 0.22

# Head turn: 0.5 means facing the camera. Anything beyond 0.5 +/- TURN_MIN_DEVIATION counts as turned.
# Upper limit koi nahi hai, is liye zyada ghumana bhi pass hota hai.
TURN_MIN_DEVIATION = 0.08
FRONT_MAX_DEVIATION = 0.15

# Closed eyes / turned head make face matching less accurate, so those photos use looser limits.
CLOSED_EYES_EXTRA_DISTANCE = 0.15
TURNED_EXTRA_DISTANCE = 0.30
# During registration all photos must show the same person (usual dlib same-person limit).
SAME_PERSON_DISTANCE = 0.60

# Bari photo ko detection se pehle is size tak chhota kiya jata hai (tez aur stable detection).
MAX_IMAGE_SIDE = 800

_random = secrets.SystemRandom()
_used_lock = threading.Lock()
_used_challenges: dict[str, int] = {}


class LivenessResult:
    def __init__(self, steps: list[str], frames: list[dict]):
        self.steps = steps
        self.frames = frames


# ------------------------------------------------------------
# Challenge creation and reading
# ------------------------------------------------------------
def create_challenge() -> dict:
    """Creates a new random challenge: a neutral photo first, then two different random actions."""
    steps = ["FRONT"] + _random.sample(ACTIONS, 2)
    expires_at = int(time.time()) + CHALLENGE_TTL_SECONDS
    token = jwt.encode(
        {
            "typ": CHALLENGE_TYPE,
            "steps": steps,
            "jti": secrets.token_hex(8),
            "exp": expires_at,
        },
        SECRET_KEY,
        algorithm=ALGORITHM,
    )
    return {
        "challenge_id": token,
        "steps": steps,
        "expires_in": CHALLENGE_TTL_SECONDS,
    }


def _invalid_challenge() -> HTTPException:
    return HTTPException(
        status_code=400,
        detail="Liveness challenge is invalid or expired. Please try again.",
    )


def _read_challenge(challenge_id: str) -> list[str]:
    try:
        payload = jwt.decode(challenge_id, SECRET_KEY, algorithms=[ALGORITHM])
    except JWTError:
        raise _invalid_challenge()

    steps = payload.get("steps")
    jti = payload.get("jti")
    expires_at = payload.get("exp")

    valid_steps = (
        payload.get("typ") == CHALLENGE_TYPE
        and isinstance(steps, list)
        and len(steps) == 3
        and steps[0] == "FRONT"
        and all(step in ACTIONS for step in steps[1:])
        and steps[1] != steps[2]
    )
    if not valid_steps or not isinstance(jti, str) or not isinstance(expires_at, int):
        raise _invalid_challenge()

    # A challenge can be used only once (this memory is per server process).
    with _used_lock:
        now = int(time.time())
        for key in [key for key, expiry in _used_challenges.items() if expiry < now]:
            del _used_challenges[key]
        if jti in _used_challenges:
            raise HTTPException(
                status_code=400,
                detail="This liveness challenge was already used. Please try again.",
            )
        _used_challenges[jti] = expires_at

    return steps


# ------------------------------------------------------------
# Measuring a photo
# ------------------------------------------------------------
def _distance(a, b) -> float:
    return float(np.hypot(a[0] - b[0], a[1] - b[1]))


def _eye_aspect_ratio(eye) -> float:
    if len(eye) != 6:
        raise IndexError("eye landmarks")
    width = _distance(eye[0], eye[3])
    if width == 0:
        raise ZeroDivisionError("eye width")
    return (_distance(eye[1], eye[5]) + _distance(eye[2], eye[4])) / (2.0 * width)


def _head_turn(marks) -> float:
    chin = marks["chin"]
    nose = marks["nose_tip"]
    left = chin[0][0]
    right = chin[16][0]
    width = right - left
    if width <= 0:
        raise ZeroDivisionError("face width")
    nose_x = sum(point[0] for point in nose) / len(nose)
    return (nose_x - left) / width


def _load_image(image_bytes: bytes):
    """Loads the photo and shrinks it if it is very large."""
    image = face_recognition.load_image_file(io.BytesIO(image_bytes))
    height, width = image.shape[:2]
    biggest = max(height, width)
    if biggest > MAX_IMAGE_SIDE:
        scale = MAX_IMAGE_SIDE / biggest
        resized = Image.fromarray(image).resize((int(width * scale), int(height * scale)))
        image = np.array(resized)
    return image


def _find_faces(image):
    """Seedha chehra -> halka/zyada turn (upsample) -> CNN (side-face bhi pehchanta hai)."""
    for upsample in (1, 2):
        locations = face_recognition.face_locations(image, number_of_times_to_upsample=upsample)
        if locations:
            return locations
    try:
        return face_recognition.face_locations(image, number_of_times_to_upsample=1, model="cnn")
    except Exception:
        return []


def _analyze_photo(image_bytes: bytes, number: int) -> dict:
    try:
        image = _load_image(image_bytes)
        locations = _find_faces(image)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Could not read photo {number}.")

    if len(locations) != 1:
        raise HTTPException(
            status_code=400,
            detail=f"Photo {number} must contain exactly one face.",
        )

    try:
        landmarks = face_recognition.face_landmarks(image, face_locations=locations)
        encodings = face_recognition.face_encodings(image, known_face_locations=locations)
    except Exception:
        raise HTTPException(status_code=400, detail=f"Could not analyse photo {number}.")

    if len(landmarks) != 1 or len(encodings) != 1:
        raise HTTPException(status_code=400, detail=f"Could not analyse photo {number}.")

    marks = landmarks[0]
    try:
        eye_openness = (
            _eye_aspect_ratio(marks["left_eye"]) + _eye_aspect_ratio(marks["right_eye"])
        ) / 2.0
        turn = _head_turn(marks)
    except (KeyError, IndexError, ZeroDivisionError):
        raise HTTPException(status_code=400, detail=f"Could not measure the face in photo {number}.")

    return {
        "eye_openness": float(eye_openness),
        "turn": float(turn),
        "encoding": np.asarray(encodings[0], dtype=np.float64),
    }


# ------------------------------------------------------------
# Checking the poses
# ------------------------------------------------------------
def _fail(index: int, instruction: str, measured: str) -> HTTPException:
    return HTTPException(
        status_code=400,
        detail=f"Liveness check failed at step {index} of 3: please {instruction}. ({measured})",
    )


def _check_steps(steps: list[str], frames: list[dict]) -> None:
    for index, (step, frame) in enumerate(zip(steps, frames), start=1):
        openness = frame["eye_openness"]
        deviation = abs(frame["turn"] - 0.5)

        if step == "FRONT":
            if deviation > FRONT_MAX_DEVIATION:
                raise _fail(index, "look straight at the camera", f"head turn {deviation:.2f}, limit {FRONT_MAX_DEVIATION:.2f}")
            if openness < EYES_OPEN_MIN:
                raise _fail(index, "keep your eyes open", f"eye openness {openness:.2f}, needs at least {EYES_OPEN_MIN:.2f}")
        elif step == "EYES_CLOSED":
            if openness > EYES_CLOSED_MAX:
                raise _fail(index, "close your eyes", f"eye openness {openness:.2f}, needs below {EYES_CLOSED_MAX:.2f}")
        elif step in ("TURN_LEFT", "TURN_RIGHT"):
            side = "left" if step == "TURN_LEFT" else "right"
            if deviation < TURN_MIN_DEVIATION:
                raise _fail(index, f"turn your head more to the {side}", f"head turn {deviation:.2f}, needs at least {TURN_MIN_DEVIATION:.2f}")

    # Different cameras may mirror the image, so a single turn is accepted in either direction.
    # When both a left and a right turn are requested they must be on opposite sides.
    if "TURN_LEFT" in steps and "TURN_RIGHT" in steps:
        left_turn = frames[steps.index("TURN_LEFT")]["turn"] - 0.5
        right_turn = frames[steps.index("TURN_RIGHT")]["turn"] - 0.5
        if left_turn * right_turn >= 0:
            raise _fail(
                steps.index("TURN_RIGHT") + 1,
                "turn your head to the left in one photo and to the right in the other",
                "both turns were on the same side",
            )


def check_liveness(challenge_id: str, image_bytes_list: list[bytes]) -> LivenessResult:
    """
    Verifies the challenge and that the three photos match its steps.
    Raises HTTPException(400) with a clear message when it does not.
    """
    steps = _read_challenge(challenge_id)

    if len(image_bytes_list) != 3:
        raise HTTPException(status_code=400, detail="Exactly 3 face images are required.")

    frames = [
        _analyze_photo(image_bytes, number)
        for number, image_bytes in enumerate(image_bytes_list, start=1)
    ]
    _check_steps(steps, frames)
    return LivenessResult(steps, frames)


# ------------------------------------------------------------
# Face identity
# ------------------------------------------------------------
def match_stored_face(result: LivenessResult, stored_encoding) -> tuple[bool, float]:
    """
    Pehchan sirf seedhi (FRONT) photo se hoti hai. Ghumi hui aur band-aankhon wali photos
    sirf itna check karti hain ke chehra wahi insaan ka hai (loose limit).
    Returns (matched, distance of the FRONT photo).
    """
    known = np.asarray(stored_encoding, dtype=np.float64)
    if known.shape != (128,):
        raise HTTPException(status_code=500, detail="Saved face encoding has an invalid format.")

    front_distance = None
    matched = True
    for step, frame in zip(result.steps, result.frames):
        distance = float(face_recognition.face_distance([known], frame["encoding"])[0])
        if step == "FRONT":
            front_distance = distance
            if distance > FACE_MATCH_THRESHOLD:
                matched = False
        elif step == "EYES_CLOSED":
            if distance > FACE_MATCH_THRESHOLD + CLOSED_EYES_EXTRA_DISTANCE:
                matched = False
        else:
            if distance > FACE_MATCH_THRESHOLD + TURNED_EXTRA_DISTANCE:
                matched = False

    return bool(matched), float(front_distance if front_distance is not None else 1.0)


def registration_embedding(result: LivenessResult) -> list[float]:
    """
    Registration ka face embedding sirf seedhi (FRONT) photo se banta hai.
    Baqi photos sirf check karti hain ke sab photos mein wahi insaan hai.
    """
    same_person_error = HTTPException(
        status_code=400,
        detail="The photos do not appear to show the same person. Please try again.",
    )

    front = None
    for step, frame in zip(result.steps, result.frames):
        if step == "FRONT":
            front = frame["encoding"]
    if front is None:
        raise same_person_error

    for step, frame in zip(result.steps, result.frames):
        if step == "FRONT":
            continue
        limit = SAME_PERSON_DISTANCE + (
            CLOSED_EYES_EXTRA_DISTANCE if step == "EYES_CLOSED" else TURNED_EXTRA_DISTANCE
        )
        if float(np.linalg.norm(frame["encoding"] - front)) > limit:
            raise same_person_error

    return np.asarray(front, dtype=np.float64).tolist()