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

import numpy as np


# ============================================================
# ROUTER
# ============================================================

router = APIRouter(
    prefix="/attendance",
    tags=["Attendance"],
)


# ============================================================
# TEACHER LIVE CONNECTIONS
# ============================================================

connected_teachers = {}


# ============================================================
# SEND UPDATE TO TEACHER DASHBOARD
# ============================================================

async def send_teacher_update(
    session_id,
    data,
):

    connections = connected_teachers.get(
        session_id,
        [],
    )

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
# SAVE ABSENT STUDENTS
# ============================================================

def mark_absent_students(
    session_id,
    db,
):
    """
    Find all students enrolled in the session course.

    Students who do not already have an attendance
    record for this session are marked ABSENT.
    """

    session = (
        db.query(Sessions)
        .filter(
            Sessions.id == session_id
        )
        .first()
    )

    if not session:
        return

    enrolled_students = (
        db.query(Enrollment)
        .filter(
            Enrollment.course_id == session.course_id
        )
        .all()
    )

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

    db.commit()


# ============================================================
# BACKGROUND AGENT TASK
# ============================================================
async def run_attendance_agent(
    session_id,
    student_id,
    verification_facts,
):
    """
    Send hard facts to the attendance agent,
    save the result in PostgreSQL,
    and notify connected teacher dashboards.
    """

    from agent import attendance_agent

    db = SessionLocal()

    try:

        # ----------------------------------------------------
        # Check duplicate attendance
        # ----------------------------------------------------

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

        # ----------------------------------------------------
        # Run attendance agent
        # ----------------------------------------------------

        try:

            result = attendance_agent(
                session_id=session_id,
                student_id=student_id,
                verification_facts=verification_facts,
            )

        except Exception:

            result = {
                "session_id": session_id,
                "student_id": student_id,
                "status": "FLAGGED",
                "reason": (
                    "Attendance agent could not "
                    "process the verification."
                ),
            }

        # ----------------------------------------------------
        # Validate agent result
        # ----------------------------------------------------

        status = result.get("status")

        reason = result.get("reason")

        if status not in {
            "PRESENT",
            "FLAGGED",
        }:

            status = "FLAGGED"

            reason = (
                "Attendance agent returned "
                "an invalid decision."
            )

        if not reason:

            reason = (
                "Attendance agent did not "
                "provide a reason."
            )

        # ----------------------------------------------------
        # Save attendance
        # ----------------------------------------------------

        attendance = Attendance(
            session_id=session_id,
            student_id=student_id,
            status=status,
            reason=reason,
        )

        db.add(attendance)

        db.commit()

        # ----------------------------------------------------
        # Get student name
        # ----------------------------------------------------

        student = (
            db.query(Student)
            .filter(
                Student.id == student_id
            )
            .first()
        )

        # ----------------------------------------------------
        # Send live dashboard update
        # ----------------------------------------------------

        await send_teacher_update(
            session_id,
            {
                "type": "attendance_update",

                "session_id": session_id,

                "student_id": student_id,

                "student_name": (
                    student.name
                    if student
                    else None
                ),

                "status": status,

                "reason": reason,

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
# START ATTENDANCE
# TEACHER
# ============================================================

@router.post("/start")
def start_attendance(
    current_user=Depends(get_current_user),
    db=Depends(get_db),
):

    # --------------------------------------------------------
    # 1. Teacher check
    # --------------------------------------------------------

    if not isinstance(
        current_user,
        Teachers,
    ):

        raise HTTPException(
            status_code=403,
            detail="Only teachers can start attendance",
        )

    # --------------------------------------------------------
    # 2. Find teacher course
    # --------------------------------------------------------

    course = (
        db.query(Courses)
        .filter(
            Courses.teacher_id == current_user.id
        )
        .first()
    )

    if not course:

        raise HTTPException(
            status_code=404,
            detail="Course not found",
        )

    # --------------------------------------------------------
    # 3. Current time
    # --------------------------------------------------------

    now = datetime.now(timezone.utc)

    # --------------------------------------------------------
    # 4. Check existing active session
    # --------------------------------------------------------

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

    # --------------------------------------------------------
    # 5. Generate unique numeric session UID
    # --------------------------------------------------------

    session_uid = str(
        int(
            now.timestamp() * 1000
        )
    )

    # --------------------------------------------------------
    # 6. Calculate expiry
    # --------------------------------------------------------

    expiry = (
        now
        + timedelta(
            minutes=SESSION_DURATION
        )
    )

    # --------------------------------------------------------
    # 7. Create session
    # --------------------------------------------------------

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
            detail="Could not create attendance session",
        )

    # --------------------------------------------------------
    # 8. Generate audio
    # --------------------------------------------------------

    try:

        audio = generate_session_audio(
            session_uid
        )

        wav_bytes = convert_to_wav(
            audio
        )

    except Exception:

        session.status = "failed"

        db.commit()

        raise HTTPException(
            status_code=500,
            detail="Could not generate attendance audio",
        )

    # --------------------------------------------------------
    # 9. Return audio
    # --------------------------------------------------------

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "X-Session-ID": str(
                session.id
            ),
            "X-Session-UID": session_uid,
            "X-Session-Expiry": expiry.isoformat(),
            "Cache-Control": "no-cache",
        },
    )


# ============================================================
# GET LIVE ATTENDANCE AUDIO
# ============================================================

@router.get("/audio/{session_id}")
def get_attendance_audio(
    session_id: int,
    db=Depends(get_db),
):

    # --------------------------------------------------------
    # 1. Find session
    # --------------------------------------------------------

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
            detail="Active attendance session not found",
        )

    # --------------------------------------------------------
    # 2. Check expiry
    # --------------------------------------------------------

    now = datetime.now(timezone.utc)

    if now >= session.expires_at:

        session.status = "expired"

        db.commit()

        # Mark students who never attended as absent.

        mark_absent_students(
            session.id,
            db,
        )

        raise HTTPException(
            status_code=410,
            detail="Attendance session has expired",
        )

    # --------------------------------------------------------
    # 3. Generate audio
    # --------------------------------------------------------

    try:

        audio = generate_session_audio(
            session.session_uid
        )

        wav_bytes = convert_to_wav(
            audio
        )

    except Exception:

        raise HTTPException(
            status_code=500,
            detail="Could not generate attendance audio",
        )

    # --------------------------------------------------------
    # 4. Return audio
    # --------------------------------------------------------

    return Response(
        content=wav_bytes,
        media_type="audio/wav",
        headers={
            "Cache-Control": "no-cache",
            "X-Session-ID": str(
                session.id
            ),
            "X-Session-UID": str(
                session.session_uid
            ),
            "X-Session-Expiry": (
                session.expires_at.isoformat()
            ),
        },
    )


# ============================================================
# MARK ATTENDANCE
# STUDENT
# ============================================================

@router.post("/mark")
async def mark_attendance(
    background_tasks: BackgroundTasks,

    audio: UploadFile = File(...),

    face_image: list[UploadFile] = File(...),

    curr_user=Depends(get_current_user),

    db=Depends(get_db),
):

    # --------------------------------------------------------
    # 1. Student check
    # --------------------------------------------------------

    if not isinstance(
        curr_user,
        Student,
    ):

        raise HTTPException(
            status_code=403,
            detail="Only students can mark attendance",
        )

    # --------------------------------------------------------
    # 2. Validate audio type
    # --------------------------------------------------------

    if audio.content_type not in {
        "audio/wav",
        "audio/x-wav",
        "audio/wave",
    }:

        raise HTTPException(
            status_code=415,
            detail="Upload a WAV audio file.",
        )

    # --------------------------------------------------------
    # 3. Exactly 3 images
    # --------------------------------------------------------

    if len(face_image) != 3:

        raise HTTPException(
            status_code=400,
            detail="Exactly 3 face images are required.",
        )

    # --------------------------------------------------------
    # 4. Validate image types
    # --------------------------------------------------------

    for image in face_image:

        if image.content_type not in {
            "image/jpeg",
            "image/png",
        }:

            raise HTTPException(
                status_code=415,
                detail="All face images must be JPEG or PNG.",
            )

    # --------------------------------------------------------
    # 5. Read audio
    # --------------------------------------------------------

    audio_bytes = await audio.read(
        MAX_AUDIO_SIZE + 1
    )

    if len(audio_bytes) > MAX_AUDIO_SIZE:

        raise HTTPException(
            status_code=413,
            detail="Audio file is too large.",
        )

    if not audio_bytes:

        raise HTTPException(
            status_code=400,
            detail="Audio file is empty.",
        )

    # --------------------------------------------------------
    # 6. Read images
    # --------------------------------------------------------

    image_bytes_list = []

    for image in face_image:

        image_bytes = await image.read(
            MAX_IMAGE_SIZE + 1
        )

        if len(image_bytes) > MAX_IMAGE_SIZE:

            raise HTTPException(
                status_code=413,
                detail="One of the face images is too large.",
            )

        if not image_bytes:

            raise HTTPException(
                status_code=400,
                detail="One of the face images is empty.",
            )

        image_bytes_list.append(
            image_bytes
        )

    # --------------------------------------------------------
    # 7. Decode session UID from audio
    # --------------------------------------------------------

    try:

        session_id_text = decode_audio(
            audio_bytes
        )

        session_uid = int(
            session_id_text
        )

    except (
        ValueError,
        TypeError,
    ):

        raise HTTPException(
            status_code=400,
            detail="Invalid session ID in audio.",
        )

    # --------------------------------------------------------
    # 8. Find valid active session
    # --------------------------------------------------------

    now = datetime.now(timezone.utc)

    session = (
        db.query(Sessions)
        .filter(
            Sessions.session_uid == str(
                session_uid
            ),
            Sessions.status == "active",
            Sessions.expires_at > now,
        )
        .first()
    )

    if not session:

        raise HTTPException(
            status_code=400,
            detail="Invalid or expired attendance session.",
        )

    # --------------------------------------------------------
    # 9. Get student
    # --------------------------------------------------------

    student = (
        db.query(Student)
        .filter(
            Student.id == curr_user.id
        )
        .first()
    )

    if not student:

        raise HTTPException(
            status_code=404,
            detail="Student not found.",
        )

    # --------------------------------------------------------
    # 10. Make sure student is enrolled
    # --------------------------------------------------------

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
            detail="Student is not enrolled in this course.",
        )

    # --------------------------------------------------------
    # 11. Check registered face
    # --------------------------------------------------------

    if student.face_embedding is None:

        raise HTTPException(
            status_code=400,
            detail="Student face is not registered.",
        )

    # --------------------------------------------------------
    # 12. Convert stored face encoding
    # --------------------------------------------------------

    stored_encoding = np.asarray(
        student.face_embedding,
        dtype=np.float64,
    )

    # --------------------------------------------------------
    # 13. Validate face encoding
    # --------------------------------------------------------

    if stored_encoding.shape != (128,):

        raise HTTPException(
            status_code=500,
            detail="Saved face encoding is invalid.",
        )

    # --------------------------------------------------------
    # 14. Prevent duplicate attendance
    # --------------------------------------------------------

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
            "session_id": session_uid,
            "face_matched": (
                existing_attendance.status
                == "PRESENT"
            ),
            "status": existing_attendance.status,
            "reason": existing_attendance.reason,
            "message": "Attendance already processed.",
        }

    # --------------------------------------------------------
    # 15. Face verification
    # --------------------------------------------------------

    try:

        face_match = verify_face(
            image_bytes_list,
            stored_encoding,
        )

    except Exception:

        raise HTTPException(
            status_code=400,
            detail="Could not verify face.",
        )

    # --------------------------------------------------------
    # 16. HARD FACTS
    # --------------------------------------------------------

    verification_facts = {
        "session_valid": True,
        "session_id": session.id,
        "session_uid": session_uid,
        "student_id": student.id,
        "student_name": student.name,
        "face_matched": bool(
            face_match
        ),
        "verified_at": now.isoformat(),
    }

    # --------------------------------------------------------
    # 17. Send hard facts to agent
    # --------------------------------------------------------

    background_tasks.add_task(
        run_attendance_agent,
        session.id,
        student.id,
        verification_facts,
    )

    # --------------------------------------------------------
    # 18. Immediate response
    # --------------------------------------------------------

    return {
        "session_id": session_uid,
        "face_matched": bool(
            face_match
        ),
        "message": (
            "Verification facts sent to attendance agent."
        ),
    }


# ============================================================
# TEACHER LIVE DASHBOARD WEBSOCKET
# ============================================================

@router.websocket(
    "/live/{session_id}"
)
async def attendance_live(
    websocket: WebSocket,
    session_id: int,
):

    await websocket.accept()

    if session_id not in connected_teachers:

        connected_teachers[
            session_id
        ] = []

    connected_teachers[
        session_id
    ].append(
        websocket
    )

    try:

        while True:

            await websocket.receive_text()

    except WebSocketDisconnect:

        if session_id in connected_teachers:

            if websocket in connected_teachers[
                session_id
            ]:

                connected_teachers[
                    session_id
                ].remove(
                    websocket
                )

            if not connected_teachers[
                session_id
            ]:

                del connected_teachers[
                    session_id
                ]


# ============================================================
# SESSION STATUS
# ============================================================

@router.get(
    "/status/{session_id}"
)
def attendance_status(
    session_id: int,
    db=Depends(get_db),
):

    # --------------------------------------------------------
    # 1. Find session
    # --------------------------------------------------------

    session = (
        db.query(Sessions)
        .filter(
            Sessions.id == session_id
        )
        .first()
    )

    if not session:

        raise HTTPException(
            status_code=404,
            detail="Session not found",
        )

    # --------------------------------------------------------
    # 2. Check expiry
    # --------------------------------------------------------

    now = datetime.now(timezone.utc)

    if (
        session.status == "active"
        and now >= session.expires_at
    ):

        session.status = "expired"

        db.commit()

        # Mark students who never attended.

        mark_absent_students(
            session.id,
            db,
        )

    # --------------------------------------------------------
    # 3. Get attendance records
    # --------------------------------------------------------

    records = (
        db.query(Attendance)
        .filter(
            Attendance.session_id
            == session.id
        )
        .all()
    )

    result = []

    # --------------------------------------------------------
    # 4. Build student result
    # --------------------------------------------------------

    for record in records:

        student = (
            db.query(Student)
            .filter(
                Student.id
                == record.student_id
            )
            .first()
        )

        result.append({
            "student_id": record.student_id,

            "student_name": (
                student.name
                if student
                else None
            ),

            "status": record.status,

            "reason": record.reason,

            "marked_at": record.marked_at,
        })

    # --------------------------------------------------------
    # 5. Return status
    # --------------------------------------------------------

    return {
        "session_id": session.id,
        "session_uid": session.session_uid,
        "status": session.status,
        "started_at": session.started_at,
        "expires_at": session.expires_at,
        "students": result,
    }


# ============================================================
# FINISH SESSION
# ============================================================

@router.post(
    "/finish/{session_id}"
)
def finish_attendance(
    session_id: int,

    current_user=Depends(
        get_current_user
    ),

    db=Depends(get_db),
):

    # --------------------------------------------------------
    # 1. Teacher check
    # --------------------------------------------------------

    if not isinstance(
        current_user,
        Teachers,
    ):

        raise HTTPException(
            status_code=403,
            detail="Only teachers can finish attendance",
        )

    # --------------------------------------------------------
    # 2. Find session
    # --------------------------------------------------------

    session = (
        db.query(Sessions)
        .filter(
            Sessions.id == session_id
        )
        .first()
    )

    if not session:

        raise HTTPException(
            status_code=404,
            detail="Session not found",
        )

    # --------------------------------------------------------
    # 3. Make sure teacher owns the course
    # --------------------------------------------------------

    course = (
        db.query(Courses)
        .filter(
            Courses.id == session.course_id
        )
        .first()
    )

    if not course:

        raise HTTPException(
            status_code=404,
            detail="Course not found",
        )

    if course.teacher_id != current_user.id:

        raise HTTPException(
            status_code=403,
            detail="You cannot finish this attendance session.",
        )

    # --------------------------------------------------------
    # 4. Check if already finished
    # --------------------------------------------------------

    if session.status == "completed":

        return {
            "session_id": session.id,
            "status": "completed",
            "message": "Attendance session is already finished.",
        }

    # --------------------------------------------------------
    # 5. Mark session completed
    # --------------------------------------------------------

    session.status = "completed"

    db.commit()

    # --------------------------------------------------------
    # 6. Mark missing students ABSENT
    # --------------------------------------------------------

    mark_absent_students(
        session.id,
        db,
    )

    # --------------------------------------------------------
    # 7. Return result
    # --------------------------------------------------------

    return {
        "session_id": session.id,
        "status": "completed",
        "message": "Attendance session finished.",
    }