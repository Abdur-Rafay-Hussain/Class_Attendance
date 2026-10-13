from dotenv import load_dotenv
load_dotenv()
import random
import os
from datetime import datetime, timezone

from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    DateTime,
    ForeignKey,
    Index,
)

from sqlalchemy.orm import (
    sessionmaker,
    Session,
    declarative_base,
    relationship,
)

from pgvector.sqlalchemy import Vector


# ============================================================
# DATABASE CONNECTION
# ============================================================

DATABASE_URL = os.environ["DATABASE_URL"]

engine = create_engine(
    DATABASE_URL,
    pool_pre_ping=True,
    pool_size=20,
    max_overflow=40,
    pool_timeout=30,
    pool_recycle=1800,
)

SessionLocal = sessionmaker(
    autocommit=False,
    autoflush=False,
    bind=engine
)
from sqlalchemy import event


@event.listens_for(engine, "connect")
def _set_utc_timezone(dbapi_connection, connection_record):
    cursor = dbapi_connection.cursor()
    cursor.execute("SET TIME ZONE 'UTC'")
    cursor.close()
    dbapi_connection.commit()

Base = declarative_base()


# ============================================================
# STUDENT
# ============================================================

class Student(Base):

    __tablename__ = "student"

    id = Column(
        String(50),
        primary_key=True,
        index=True
    )

    name = Column(
        String(50),
        nullable=False
    )

    email = Column(
        String(50),
        unique=True,
        nullable=False
    )

    password = Column(
        String,
        nullable=False
    )
    face_embedding = Column(
        Vector(128),
        nullable=False
    )

    created_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc)
    )

    # Relationships

    enrollment = relationship(
        "Enrollment",
        back_populates="student"
    )

    attendance = relationship(
        "Attendance",
        back_populates="student"
    )


# ============================================================
# TEACHER
# ============================================================

class Teachers(Base):

    __tablename__ = "teachers"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True
    )

    name = Column(
        String(50),
        nullable=False
    )

    email = Column(
        String(50),
        unique=True,
        nullable=False
    )

    password = Column(
        String,
        nullable=False
    )

    # One teacher can teach many courses

    courses = relationship(
        "Courses",
        back_populates="teacher"
    )


# ============================================================
# COURSES
# ============================================================

class Courses(Base):

    __tablename__ = "courses"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True
    )

    name = Column(
        String(50),
        nullable=False
    )

    teacher_id = Column(
        Integer,
        ForeignKey("teachers.id"),
        nullable=False
    )

    # Relationship with teacher

    teacher = relationship(
        "Teachers",
        back_populates="courses"
    )

    # Relationship with enrollment

    enrollment = relationship(
        "Enrollment",
        back_populates="course"
    )

    # Relationship with sessions

    sessions = relationship(
        "Sessions",
        back_populates="course"
    )


# ============================================================
# ENROLLMENT
# ============================================================

class Enrollment(Base):

    __tablename__ = "enrollment"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True
    )

    student_id = Column(
        String(50),
        ForeignKey("student.id"),
        nullable=False
    )

    course_id = Column(
        Integer,
        ForeignKey("courses.id"),
        nullable=False
    )

    # Student relationship

    student = relationship(
        "Student",
        back_populates="enrollment"
    )

    # Course relationship

    course = relationship(
        "Courses",
        back_populates="enrollment"
    )


# ============================================================
# SESSIONS
# ============================================================

class Sessions(Base):

    __tablename__ = "sessions"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True
    )

    course_id = Column(
        Integer,
        ForeignKey("courses.id"),
        nullable=False
    )

    session_uid = Column(
    String(50),
    unique=True,
    index=True,
    nullable=False
)

    status = Column(
        String(50),
        nullable=False
    )
    started_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc)
    )
    expires_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc)
    )
    # Course relationship

    course = relationship(
        "Courses",
        back_populates="sessions"
    )

    # Attendance relationship

    attendance = relationship(
        "Attendance",
        back_populates="session"
    )


# ============================================================
# ATTENDANCE
# ============================================================
class Attendance(Base):

    __tablename__ = "attendance"

    id = Column(
        Integer,
        primary_key=True,
        index=True,
        autoincrement=True
    )

    session_id = Column(
        Integer,
        ForeignKey("sessions.id"),
        nullable=False
    )

    student_id = Column(
        String(50),
        ForeignKey("student.id"),
        nullable=False
    )

    status = Column(
        String(50),
        nullable=False
    )

    reason = Column(
        String(255),
        nullable=False
    )

    marked_at = Column(
        DateTime,
        default=lambda: datetime.now(timezone.utc)
    )

    # Session relationship

    session = relationship(
        "Sessions",
        back_populates="attendance"
    )

    # Student relationship

    student = relationship(
        "Student",
        back_populates="attendance"
    )


# ============================================================
# DATABASE SESSION
# ============================================================

def get_db():

    db = SessionLocal()

    try:
        yield db

    finally:
        db.close()


# ============================================================
# CREATE TABLES
# ============================================================

Base.metadata.create_all(engine)
