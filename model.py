from pydantic import BaseModel,EmailStr,Field
from typing import List

class Student(BaseModel):
    name: str
    email: EmailStr
    password: str
class Teacher(BaseModel):
    name: str
    email: EmailStr
    password: str
class Course(BaseModel):
    name: str
class Enrollment(BaseModel):
    student_id: int
    course_id: int
class Session(BaseModel):
    course_id: int
    session_uid: str
    status: str
class TeacherSignupRequest(BaseModel):
    teacher: Teacher
    course: Course
    secret_key: str
