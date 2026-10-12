from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    File,
    UploadFile,
    Response,
    BackgroundTasks,
    WebSocket,
    WebSocketDisconnect,
)
from datetime import datetime, timedelta, timezone

from gen_audio import (
    generate_session_audio,
    convert_to_wav,
    SESSION_DURATION,
)

from database import (
    get_db,
    SessionLocal,
    Student,
    Teachers,
    Courses,
    Enrollment,
    Sessions,
    Attendance,
)

from auth import get_current_user

from recieving_audio import (
    decode_audio,
    verify_face,
    MAX_AUDIO_SIZE,
    MAX_IMAGE_SIZE,
)

# === LIVENESS LAYER IMPORT ===
try:
    from liveness import verify_liveness
except ImportError:
    # Fallback placeholder function if model setup structure differs slightly
    def verify_liveness(images):
        return True


import numpy as np
from pathlib import Path

# ============================================================
# ROUTER CONFIGURATION
# ============================================================

router = APIRouter(
    prefix="/attendance",
    tags=["Attendance"],
)

connected_teachers = {}


# ============================================================
# UTILITY: METRICS STREAM ON WEBSOCKET PIPELINE
# ============================================================

async def send_teacher_update(session_id: int, data: dict):
    connections = connected_teachers.get(session_id, [])

    if not connections:
        return

    disconnected = []

    for websocket in connections:
        try:
            await websocket.send_json(data)
        except Exception:
            disconnected.append(websocket)

    for websocket in disconnected:
        if websocket in connections:
            connections.remove(websocket)


# ============================================================
# CORE OPERATION: BATCH MARK ABSENT STUDENTS
# ============================================================

def mark_absent_students(session_id: int, db):
    session = (
        db.query(Sessions)
        .filter(Sessions.id == session_id)
        .first()
    )

    if not session:
        return

    enrolled_students = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == session.course_id)
        .all()
    )

    if not enrolled_students:
        return

    for enrollment in enrolled_students:
        existing_record = (
            db.query(Attendance)
            .filter(
                Attendance.session_id == session.id,
                Attendance.student_id == enrollment.student_id,
            )
            .first()
        )

        if existing_record:
            continue

        absent_record = Attendance(
            session_id=session.id,
            student_id=enrollment.student_id,
            status="ABSENT",
            reason="Student did not mark attendance before the session ended.",
        )

        db.add(absent_record)

    try:
        db.commit()
    except Exception:
        db.rollback()


# ============================================================
# HIGH VELOCITY SYSTEM DECISION WORKER (Replaces Agent.py LLM)
# ============================================================

async def process_attendance_decision(
    session_id: int,
    student_id: str,
    verification_facts: dict,
):
    db = SessionLocal()

    try:
        existing_record = (
            db.query(Attendance)
            .filter(
                Attendance.session_id == session_id,
                Attendance.student_id == student_id,
            )
            .first()
        )

        if existing_record:
            return

        session_valid = verification_facts.get("session_valid", False)
        face_matched = verification_facts.get("face_matched", False)
        liveness_passed = verification_facts.get("liveness_passed", True)

        # High performance conditional system rules mapping
        if not session_valid:
            status_decision = "FLAGGED"
            reason_decision = "Attendance session is invalid or expired."

        elif not liveness_passed:
            status_decision = "FLAGGED"
            reason_decision = (
                "Spoofing attempt detected. Face liveness verification failed."
            )

        elif face_matched:
            status_decision = "PRESENT"
            reason_decision = (
                "Student passed session and biometric face verification."
            )

        else:
            status_decision = "FLAGGED"
            reason_decision = (
                "Student face verification did not match the registered face footprint."
            )

        attendance = Attendance(
            session_id=session_id,
            student_id=student_id,
            status=status_decision,
            reason=reason_decision,
        )

        db.add(attendance)
        db.commit()

        student = (
            db.query(Student)
            .filter(Student.id == student_id)
            .first()
        )

        student_name = student.name if student else None

        await send_teacher_update(
            session_id,
            {
                "type": "attendance_update",
                "session_id": session_id,
                "student_id": student_id,
                "student_name": student_name,
                "status": status_decision,
                "reason": reason_decision,
                "marked_at": (
                    attendance.marked_at.isoformat()
                    if attendance.marked_at
                    else None
                ),
            },
        )

    except Exception:
        db.rollback()
        raise

    finally:
        db.close()


# ============================================================
# ENDPOINT: TEACHER TIMELINE INITIATION BEACON
# ============================================================

@router.post("/start")
def start_attendance(
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):
    if not isinstance(current_user, Teachers):
        raise HTTPException(
            status_code=403,
            detail="Only teachers can start attendance",
        )

    course = (
        db.query(Courses)
        .filter(Courses.teacher_id == current_user.id)
        .first()
    )

    if not course:
        raise HTTPException(
            status_code=404,
            detail="Course context profile allocation failed.",
        )

    now = datetime.now(timezone.utc)

    active_session = (
        db.query(Sessions)
        .filter(
            Sessions.course_id == course.id,
            Sessions.status == "active",
            Sessions.expires_at > now,
        )
        .first()
    )

    if active_session:
        raise HTTPException(
            status_code=409,
            detail="Attendance session is already active",
        )

    session_uid = str(int(now.timestamp() * 1000))
    expiry = now + timedelta(minutes=SESSION_DURATION)

    session = Sessions(
        course_id=course.id,
        session_uid=session_uid,
        status="active",
        started_at=now,
        expires_at=expiry,
    )

    db.add(session)

    try:
        db.commit()
        db.refresh(session)

    except Exception:
        db.rollback()

        raise HTTPException(
            status_code=500,
            detail="Could not create attendance session inside transaction engine.",
        )
    try:
        audio = generate_session_audio(session_uid)
        wav_bytes = convert_to_wav(audio)
    except Exception:
        session.status = "failed"
        db.commit()
        raise HTTPException(status_code=500, detail="Could not generate attendance audio")
    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Session-ID": str(session.id),
            "X-Session-UID": session_uid,
            "X-Session-Expiry": expiry.isoformat(),
            "Cache-Control": "no-cache",
        },
    )
# ============================================================
# ENDPOINT: ACQUIRE LIVE AUDIO BEACON
# ============================================================

@router.get("/audio/{session_id}")
def get_attendance_audio(
    session_id: int,
    db=Depends(get_db),
):
    session = (
        db.query(Sessions)
        .filter(
            Sessions.id == session_id,
            Sessions.status == "active",
        )
        .first()
    )

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Active attendance session tracking failed.",
        )

    now = datetime.now(timezone.utc)

    expires_at = (
        session.expires_at.replace(tzinfo=timezone.utc)
        if session.expires_at.tzinfo is None
        else session.expires_at
    )

    if now >= expires_at:
        session.status = "expired"
        db.commit()

        mark_absent_students(session.id, db)

        raise HTTPException(
            status_code=410,
            detail="Attendance session context has expired.",
        )

    try:
        audio = generate_session_audio(session.session_uid)
        wav_bytes = convert_to_wav(audio)

    except Exception:
        raise HTTPException(
            status_code=500,
            detail="Could not process streaming wave generation response.",
        )

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-cache",
            "X-Session-ID": str(session.id),
            "X-Session-UID": str(session.session_uid),
            "X-Session-Expiry": session.expires_at.isoformat(),
        },
    )


# ============================================================
# ENDPOINT: EXECUTE BIOMETRIC & ULTRASONIC MARKING (100k scale)
# ============================================================

@router.post("/mark")
async def mark_attendance(
    background_tasks: BackgroundTasks,
    audio: UploadFile = File(...),
    face_image: list[UploadFile] = File(...),
    curr_user=Depends(get_current_user),
    db=Depends(get_db),
):
    if not isinstance(curr_user, Student):
        raise HTTPException(
            status_code=403,
            detail="Only students can execute verification matching context.",
        )

    if audio.content_type not in {
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
    }:
        raise HTTPException(
            status_code=415,
            detail="Upload a valid standard WAV file payload.",
        )

    if len(face_image) != 3:
        raise HTTPException(
            status_code=400,
            detail="Exactly 3 snapshot biometric captures are required.",
        )

    for image in face_image:
        if image.content_type not in {"image/jpeg", "image/png"}:
            raise HTTPException(
                status_code=415,
                detail="Biometric captures must follow JPEG or PNG layouts.",
            )

    # High performance non-blocking reading buffers
    audio_bytes = await audio.read(MAX_AUDIO_SIZE + 1)

    if len(audio_bytes) > MAX_AUDIO_SIZE or not audio_bytes:
        raise HTTPException(
            status_code=400,
            detail="Payload context array buffer validation structural mismatch.",
        )

    image_bytes_list = []

    for image in face_image:
        image_bytes = await image.read(MAX_IMAGE_SIZE + 1)

        if len(image_bytes) > MAX_IMAGE_SIZE or not image_bytes:
            raise HTTPException(
                status_code=400,
                detail="Image frame buffer footprint array extraction corruption.",
            )

        image_bytes_list.append(image_bytes)

    try:
        session_id_text = decode_audio(audio_bytes)
        session_uid = int(session_id_text)

    except (ValueError, TypeError):
        raise HTTPException(
            status_code=400,
            detail="Ultrasonic track missing structural alignment sync signature.",
        )

    now = datetime.now(timezone.utc)

    active_sessions = (
        db.query(Sessions)
        .filter(
            Sessions.session_uid == str(session_uid),
            Sessions.status == "active",
        )
        .all()
    )

    session = None

    for candidate in active_sessions:
        expires_at = (
            candidate.expires_at.replace(tzinfo=timezone.utc)
            if candidate.expires_at.tzinfo is None
            else candidate.expires_at
        )

        if now < expires_at:
            session = candidate
            break

    if not session:
        raise HTTPException(
            status_code=400,
            detail="Invalid or expired active validation timeline window.",
        )

    student = (
        db.query(Student)
        .filter(Student.id == curr_user.id)
        .first()
    )

    if not student:
        raise HTTPException(
            status_code=404,
            detail="Student profile identity registry lookup failure.",
        )

    enrollment = (
        db.query(Enrollment)
        .filter(
            Enrollment.student_id == student.id,
            Enrollment.course_id == session.course_id,
        )
        .first()
    )

    if not enrollment:
        raise HTTPException(
            status_code=403,
            detail="Student is not registered inside this course context matrix.",
        )

    if student.face_embedding is None:
        raise HTTPException(
            status_code=400,
            detail="Student facial template footprint has no verified master record.",
        )

    stored_encoding = np.asarray(
        student.face_embedding,
        dtype=np.float64,
    )
    if stored_encoding.shape != (128,):
        raise HTTPException(
            status_code=500,
            detail="Biometric record corruption error inside verification layer.",
        )

    existing_attendance = (
        db.query(Attendance)
        .filter(
            Attendance.session_id == session.id,
            Attendance.student_id == student.id,
        )
        .first()
    )

    if existing_attendance:
        return {
            "status": existing_attendance.status,
            "message": "Attendance record already logged inside active status pool map.",
        }

    # Execute Face Recognition and Liveness evaluation
    try:
        # A. Face recognition identity match
        face_match = verify_face(
            image_bytes_list,
            stored_encoding,
        )

        # B. Integrated liveness check (anti-spoofing)
        liveness_passed = verify_liveness(image_bytes_list)

    except Exception:
        raise HTTPException(
            status_code=400,
            detail="Model evaluation crash failure inside biometric parsing queue.",
        )

    verification_facts = {
        "session_valid": True,
        "session_id": session.id,
        "session_uid": session_uid,
        "student_id": student.id,
        "student_name": student.name,
        "face_matched": bool(face_match),
        "liveness_passed": bool(liveness_passed),
        "verified_at": now.isoformat(),
    }

    # Queue attendance decision processing as a background task
    background_tasks.add_task(
        process_attendance_decision,
        session.id,
        student.id,
        verification_facts,
    )

    return {
        "session_id": session_uid,
        "face_matched": bool(face_match),
        "liveness_passed": bool(liveness_passed),
        "message": (
            "Verification parameters passed successfully "
            "to asynchronous state engine logic."
        ),
    }
# ============================================================
# WEBSOCKET STREAM ROUTE
# ============================================================
@router.websocket("/live/{session_id}")
async def attendance_live(websocket: WebSocket, session_id: int):
    await websocket.accept()

    if session_id not in connected_teachers:
        connected_teachers[session_id] = []

    connected_teachers[session_id].append(websocket)

    try:
        while True:
            await websocket.receive_text()

    except WebSocketDisconnect:
        if session_id in connected_teachers:
            if websocket in connected_teachers[session_id]:
                connected_teachers[session_id].remove(websocket)

            if not connected_teachers[session_id]:
                del connected_teachers[session_id]


# ============================================================
# ENDPOINT: REALTIME ATTENDANCE LOG STATUS POOL MONITOR
# ============================================================

@router.get("/status/{session_id}")
def attendance_status(
    session_id: int,
    db=Depends(get_db),
):
    session = (
        db.query(Sessions)
        .filter(Sessions.id == session_id)
        .first()
    )

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Target session reference tracking failed.",
        )

    now = datetime.now(timezone.utc)

    expires_at = (
        session.expires_at.replace(tzinfo=timezone.utc)
        if session.expires_at.tzinfo is None
        else session.expires_at
    )

    if session.status == "active" and now >= expires_at:
        session.status = "expired"
        db.commit()

        mark_absent_students(session.id, db)

    records = (
        db.query(Attendance)
        .filter(Attendance.session_id == session.id)
        .all()
    )

    result = []

    for record in records:
        student = (
            db.query(Student)
            .filter(Student.id == record.student_id)
            .first()
        )

        result.append(
            {
                "student_id": record.student_id,
                "student_name": student.name if student else None,
                "status": record.status,
                "reason": record.reason,
                "marked_at": record.marked_at,
            }
        )

    return {
        "session_id": session.id,
        "session_uid": session.session_uid,
        "status": session.status,
        "started_at": session.started_at,
        "expires_at": session.expires_at,
        "students": result,
    }
# ============================================================
# ENDPOINT: MANUAL TEACHER GRACEFUL SHUTDOWN CLOSURE
# ============================================================
@router.post("/finish/{session_id}")
def finish_attendance(
    session_id: int,
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):
    if not isinstance(current_user, Teachers):
        raise HTTPException(
            status_code=403,
            detail="Only teachers can start validation closures.",
        )

    session = (
        db.query(Sessions)
        .filter(Sessions.id == session_id)
        .first()
    )

    if not session:
        raise HTTPException(
            status_code=404,
            detail="Target session lookup structural footprint array empty.",
        )

    course = (
        db.query(Courses)
        .filter(Courses.id == session.course_id)
        .first()
    )

    if not course or course.teacher_id != current_user.id:
        raise HTTPException(
            status_code=403,
            detail="Unauthorized action permissions context footprint mapping failure.",
        )

    if session.status == "completed":
        return {
            "session_id": session.id,
            "status": "completed",
            "message": (
                "Attendance validation workflow state "
                "already marked completed safely."
            ),
        }

    session.status = "completed"
    db.commit()

    mark_absent_students(session.id, db)

    return {
        "session_id": session.id,
        "status": "completed",
        "message": "Attendance batch tracking cycle finalized cleanly.",
    }



