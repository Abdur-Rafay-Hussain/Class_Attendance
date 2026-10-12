from fastapi import FastAPI, Depends, HTTPException, status, File, Form, UploadFile, BackgroundTasks, APIRouter, Response
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.exc import IntegrityError
from hash_pwd import hash_pwd, verify_pwd
from gen_token import create_access_token, verify_token
from database import get_db, Student, Teachers, Courses, Enrollment, Sessions, Attendance
import io
import numpy as np
import json
from typing import Annotated
import face_recognition
import os
from datetime import datetime, timedelta, timezone
from attendance import router as attendance_router
from auth import get_current_user
from create_teacher import MakeTeacher
from model import TeacherSignupRequest
from liveness import create_challenge, check_liveness, registration_embedding

app = FastAPI()

from fastapi.middleware.cors import CORSMiddleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ------------------------------------------------------------------------------
DUPLICATE_THRESHOLD = float(os.getenv("DUPLICATE_THRESHOLD"))
MAX_PHOTO_SIZE = 5 * 1024 * 1024


def get_embedding(image_bytes: bytes):
    image = face_recognition.load_image_file(io.BytesIO(image_bytes))
    encodings = face_recognition.face_encodings(image)
    if len(encodings) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No faces found",
        )
    if len(encodings) > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Multiple faces found",
        )
    return encodings[0]


# ------------------------------------------------------------------------------
def avg_embedding(images: list[bytes]):
    embeddings = [get_embedding(image) for image in images]
    return np.mean(embeddings, axis=0).tolist()


# ------------------------------------------------------------------------------
def isduplicate(embeddings: list[float], db=Depends(get_db)):
    return (
        db.query(Student)
        .filter(Student.face_embedding.l2_distance(embeddings) < DUPLICATE_THRESHOLD)
        .first()
        is not None
    )


# ------------------------------------------------------------------------------
# LIVENESS CHALLENGE (used by registration and attendance)
# ------------------------------------------------------------------------------
@app.post("/liveness/challenge")
async def liveness_challenge():
    return create_challenge()


# ------------------------------------------------------------------------------
@app.post("/register")
async def register(
    Student_id: str = Form(...),
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    challenge_id: str = Form(...),
    photos: list[UploadFile] = File(...),
    db=Depends(get_db),
):
    Student_id = Student_id.strip()
    if not Student_id:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Student ID is required",
        )

    # 1. Email and Student ID check
    if db.query(Student).filter(Student.email == email).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
        )
    if db.query(Student).filter(Student.id == Student_id).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Student ID already registered",
        )

    # 2. Photos validation (exactly 3 live photos, in the order of the liveness challenge)
    if len(photos) != 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Exactly 3 face photos are required",
        )
    for photo in photos:
        if photo.content_type not in {"image/jpeg", "image/png"}:
            raise HTTPException(
                status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
                detail="All face photos must be JPEG or PNG",
            )

    # 3. Read images
    images = []
    for photo in photos:
        data = await photo.read(MAX_PHOTO_SIZE + 1)
        if not data:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="One of the face photos is empty",
            )
        if len(data) > MAX_PHOTO_SIZE:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail="One of the face photos is too large",
            )
        images.append(data)

    # 4. Liveness check and face embedding
    liveness_result = check_liveness(challenge_id, images)
    embedding = registration_embedding(liveness_result)

    # 5. Duplicate check
    if isduplicate(db=db, embeddings=embedding):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Duplicate student",
        )

    # 6. Save to Database
    new_student = Student(
        id=Student_id,
        name=name,
        email=email,
        password=hash_pwd(password),
        face_embedding=embedding,
    )
    db.add(new_student)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Student ID or email is already registered",
        )
    db.refresh(new_student)
    return {
        "message": "Data Entered Successfully"
    }


# ------------------------------------------------------------------------------
@app.post("/login")
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db=Depends(get_db),
):
    teacher = (
        db.query(Teachers)
        .filter(Teachers.email == form.username)
        .first()
    )
    if teacher:
        if not verify_pwd(form.password, teacher.password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect password",
            )
        access_token = create_access_token(
            data={
                "sub": str(teacher.id),
                "role": "teacher",
            }
        )
        return {
            "access_token": access_token,
            "token_type": "bearer",
            "name": teacher.name,
        }

    student = (
        db.query(Student)
        .filter(Student.email == form.username)
        .first()
    )
    if not student:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    if not verify_pwd(form.password, student.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect password",
        )
    access_token = create_access_token(
        data={
            "sub": str(student.id),
            "role": "student",
        }
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "name": student.name,
    }


# ------------------------------------------------------------------------------
@app.post("/refresh")
async def refresh(token: str = Depends(verify_token), db=Depends(get_db)):
    user = db.query(Student).filter(Student.id == token['sub']).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found",
        )
    access_token = create_access_token(
        data={"sub": user.id})
    return {"access_token": access_token, "token_type": "bearer"}


# ------------------------------------------------------------------------------
@app.post("/enroll")
async def enroll(current_user=Depends(get_current_user), course_id: int = Form(...), db=Depends(get_db)):
    if not isinstance(current_user, Student):
        raise HTTPException(
            status_code=403,
            detail="Only students can enroll in courses",
        )
    if db.query(Enrollment).filter(Enrollment.student_id == current_user.id, Enrollment.course_id == course_id).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Student already enrolled",
        )
    new_enrollment = Enrollment(
        student_id=current_user.id,
        course_id=course_id
    )
    db.add(new_enrollment)
    db.commit()
    db.refresh(new_enrollment)
    return {
        "message": "Enrollment Successful"
    }


# ------------------------------------------------------------------------------
app.include_router(attendance_router)

Teacher_router = APIRouter(
    prefix="/Teacher",
    tags=["Teacher"],
)


@Teacher_router.post("/signup")
def teacher_signup(data: TeacherSignupRequest):
    return MakeTeacher(teacher=data.teacher, course=data.course, secret_key=data.secret_key)


app.include_router(Teacher_router)