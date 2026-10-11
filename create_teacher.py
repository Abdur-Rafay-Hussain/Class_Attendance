
import os

from database import Teachers, Courses, SessionLocal
from model import Student as TeacherModel, Course
from hash_pwd import hash_pwd
from fastapi import HTTPException, status
from dotenv import load_dotenv

load_dotenv()

def MakeTeacher(
    teacher: TeacherModel,
    course: Course,
    secret_key: str
):
    expected_secret = os.getenv("TEACHER_SIGNUP_SECRET")

    if not expected_secret or secret_key != expected_secret:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Invalid teacher signup secret"
        )

    db = SessionLocal()

    try:
        existing_teacher = (
            db.query(Teachers)
            .filter(Teachers.email == teacher.email)
            .first()
        )

        if existing_teacher:
            raise HTTPException(
                status_code=400,
                detail="Email already registered"
            )

        new_teacher = Teachers(
            name=teacher.name,
            email=teacher.email,
            password=hash_pwd(teacher.password)
        )

        db.add(new_teacher)
        db.flush()

        new_course = Courses(
            name=course.name,
            teacher_id=new_teacher.id
        )

        db.add(new_course)
        db.commit()
        db.refresh(new_course)

        return {
            "message": "Teacher registered successfully",
            "course_id": new_course.id
        }

    except HTTPException:
        db.rollback()
        raise

    except Exception:
        db.rollback()
        raise HTTPException(
            status_code=500,
            detail="An internal server error occurred"
        )

    finally:
        db.close()