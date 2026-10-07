from database import Teachers, Courses,SessionLocal
from model import Student as TeacherModel,Course
from hash_pwd import hash_pwd
from fastapi import Depends, HTTPException, status

def MakeTeacher(teacher : TeacherModel,course : Courses):
    try:
        db = SessionLocal()
        if db.query(Teachers).filter(Teachers.email == teacher.email).first():
            raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Email already registered",
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
        db.refresh(new_teacher)
        db.refresh(new_course)
        return {
        "message": "Data Entered Successfully",
        "course_id": new_course.id
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e),
        )
    finally:
        db.close()

print(MakeTeacher(TeacherModel(name="John Doe", email="Johndoe@123.com", password="123456"),Course(name="Python")))
      
      