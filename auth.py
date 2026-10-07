from fastapi import Depends, HTTPException, status ,Depends
from database import Student,SessionLocal,Teachers
from gen_token import verify_token

def get_current_user(token: str = Depends(verify_token)):

    db = SessionLocal()

    try:
        user_id = int(token["sub"])
        role = token["role"]

        if role == "teacher":

            teacher = db.query(Teachers).filter(
                Teachers.id == user_id
            ).first()

            if not teacher:
                raise HTTPException(
                    status_code=404,
                    detail="Teacher not found"
                )

            return teacher

        elif role == "student":

            student = db.query(Student).filter(
                Student.id == user_id
            ).first()

            if not student:
                raise HTTPException(
                    status_code=404,
                    detail="Student not found"
                )

            return student

        else:
            raise HTTPException(
                status_code=401,
                detail="Invalid role"
            )

    finally:
        db.close()