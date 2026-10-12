import io
import os
import numpy as np
from fastapi import FastAPI, Depends, HTTPException, status, File, Form, UploadFile, APIRouter
from fastapi.security import OAuth2PasswordRequestForm
from fastapi.middleware.cors import CORSMiddleware
import face_recognition
from dotenv import load_dotenv

# Database aur core business actions loading
from database import get_db, Student, Teachers, Enrollment
from hash_pwd import hash_pwd, verify_pwd
from gen_token import create_access_token, verify_token
from attendance import router as attendance_router
from auth import get_current_user
from create_teacher import MakeTeacher
from model import TeacherSignupRequest

load_dotenv()

# Initialize optimized Fast API tracking framework instance
app = FastAPI(
    title="Resonance Backend Gateway",
    description="High-performance structural API grid for acoustic and face-verified student attendance.",
    version="1.0.0"
)

# ============================================================
# CORS PRODUCTION MIDDLWARE SECURITY CONFIGURATION
# ============================================================
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Global variables loaded during initialization window into memory bounds
DUPLICATE_THRESHOLD = float(os.getenv("DUPLICATE_THRESHOLD", "0.6"))

# ============================================================
# CORE CORE GRAPH PIPELINE FUNCTIONS (BIOMETRICS)
# ============================================================
def get_embedding(image_bytes: bytes):
    """
    Loads raw buffered frames securely inside memory contexts to extract face signatures.
    """
    try:
        image = face_recognition.load_image_file(io.BytesIO(image_bytes))
        encodings = face_recognition.face_encodings(image)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Biometric structural format error. Could not process uploaded frame data."
        )
        
    if len(encodings) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No distinct face signatures detected inside image layout bounds."
        )
    if len(encodings) > 1:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Multiple human face models found. Ensure only one target is inside view limits."
        )
    return encodings[0]

def avg_embedding(images: list[bytes]):
    """
    Averages a batch stack array footprint of vector coordinates into a unified matrix index.
    """
    embeddings = [get_embedding(image) for image in images]
    return np.mean(embeddings, axis=0).tolist()

def is_duplicate_student(embeddings: list[float], db) -> bool:
    """
    Vector search distance engine tracking via fast L2-Distance criteria parameters.
    """
    match = db.query(Student).filter(
        Student.face_embedding.l2_distance(embeddings) < DUPLICATE_THRESHOLD
    ).first()
    return match is not None

# ============================================================
# ROUTE PATH: STUDENT SYSTEM REGISTRATION
# ============================================================
@app.post("/register", status_code=status.HTTP_201_CREATED)
async def register(
    Student_id: str = Form(...),
    name: str = Form(...),
    email: str = Form(...),
    password: str = Form(...),
    photos: list[UploadFile] = File(...),
    db=Depends(get_db)
):
    # 1. Active Profile Email Duplication Check
    if db.query(Student).filter(Student.email == email).first():
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email identifier has already been registered inside our grid maps."
        )
        
    # 2. Sequential Validation Limits on biometric arrays
    if not 1 <= len(photos) <= 3:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid image payload signature count. Submit between 1 and 3 frames."
        )

    # Fast stream read pipeline allocation
    images = [await photo.read() for photo in photos]
    embedding = avg_embedding(images)

    # 3. Vector Match Signature Anti-Spoof check
    if is_duplicate_student(embedding, db):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Duplicate biometric identity detected inside master records pool map."
        )

    # 4. Atomic Write Commit Transaction to database grid
    new_student = Student(
        id=Student_id,
        name=name,
        email=email,
        password=hash_pwd(password),
        face_embedding=embedding
    )
    db.add(new_student)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Transaction storage mapping execution failure during account write state."
        )

    return {"message": "Data Entered Successfully"}

# ============================================================
# ROUTE PATH: ACCOUNT UNIFIED AUTHENTICATION LOGIN
# ============================================================
@app.post("/login")
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    db=Depends(get_db)
):
    # Search Teachers Domain first
    teacher = db.query(Teachers).filter(Teachers.email == form.username).first()
    if teacher:
        if not verify_pwd(form.password, teacher.password):
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Incorrect credential details matched against master password hashes."
            )
        access_token = create_access_token(
            data={"sub": str(teacher.id), "role": "teacher"}
        )
        # === FIXED: Response mein token ke sath real name bhej rhe hain ===
        return {"access_token": access_token, "token_type": "bearer", "name": teacher.name}

    # Search Students Profile Database Map next
    student = db.query(Student).filter(Student.email == form.username).first()
    if not student:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User target match not identified inside account identity registry index."
        )
        
    if not verify_pwd(form.password, student.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect credential details matched against master password hashes."
        )
        
    access_token = create_access_token(
        data={"sub": str(student.id), "role": "student"}
    )
    # === FIXED: Response mein token ke sath real name bhej rhe hain ===
    return {"access_token": access_token, "token_type": "bearer", "name": student.name}

# ============================================================
# ROUTE PATH: SESSION REFRESHTOKEN ACCESS MANAGER
# ============================================================
@app.post("/refresh")
async def refresh(token: dict = Depends(verify_token), db=Depends(get_db)):
    user = db.query(Student).filter(Student.id == token['sub']).first()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User footprint matching token context not verified inside storage maps."
        )
    access_token = create_access_token(data={"sub": user.id, "role": "student"})
    return {"access_token": access_token, "token_type": "bearer"}

# ============================================================
# ROUTE PATH: STUDENT COURSE ENROLLMENT SEED ACTION
# ============================================================
@app.post("/enroll")
async def enroll(
    current_user=Depends(get_current_user),
    course_id: int = Form(...),
    db=Depends(get_db)
):
    if not isinstance(current_user, Student):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Access denied permissions error. Only students can execute enrollment bindings."
        )
        
    # Check Active state duplication logs
    is_enrolled = db.query(Enrollment).filter(
        Enrollment.student_id == current_user.id,
        Enrollment.course_id == course_id
    ).first()
    
    if is_enrolled:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Student is already enrolled in this course context footprint pool."
        )

    new_enrollment = Enrollment(student_id=current_user.id, course_id=course_id)
    db.add(new_enrollment)
    try:
        db.commit()
    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Transaction engine fail during enrollment relationship serialization layout."
        )

    return {"message": "Enrollment Successful"}

# ============================================================
# INTEGRATING APP SUB-ROUTERS CONTROL CHANNELS
# ============================================================
app.include_router(attendance_router)

# Teacher Endpoint Context isolation router mapping layout structures
Teacher_router = APIRouter(prefix="/Teacher", tags=["Teacher"])

@Teacher_router.post("/signup")
def teacher_signup(data: TeacherSignupRequest):
    return MakeTeacher(teacher=data.teacher, course=data.course, secret_key=data.secret_key)

app.include_router(Teacher_router)