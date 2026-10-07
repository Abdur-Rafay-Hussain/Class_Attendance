from langchain_core.prompts import ChatPromptTemplate
from langchain_groq import ChatGroq
from langchain_core.output_parsers import JsonOutputParser
from dotenv import load_dotenv


load_dotenv()


# ============================================================
# LLM
# ============================================================

llm = ChatGroq(
    model="openai/gpt-oss-120b",
    temperature=0,
)


# ============================================================
# PROMPT
# ============================================================

prompt = ChatPromptTemplate.from_messages([
    (
        "system",
        """
You are an attendance decision agent.

You receive hard facts from the attendance verification system.

You MUST NOT:

- perform face recognition
- decode audio
- query the database
- invent verification facts

Use ONLY the provided verification facts.

Decision rules:

1. If session_valid is False:

status = "FLAGGED"

reason = "Attendance session is invalid or expired."


2. If session_valid is True AND face_matched is True:

status = "PRESENT"

reason = "Student passed session and face verification."


3. If session_valid is True AND face_matched is False:

status = "FLAGGED"

reason = "Student face verification did not match the registered face."


Return ONLY valid JSON.

The JSON format must be:

{{
    "status": "PRESENT" or "FLAGGED",
    "reason": "short explanation"
}}
"""
    ),
    (
        "human",
        """
Verification facts:

{facts}
"""
    ),
])


# ============================================================
# JSON PARSER
# ============================================================

parser = JsonOutputParser()


# ============================================================
# AGENT CHAIN
# ============================================================

attendance_agent_chain = prompt | llm | parser


# ============================================================
# ATTENDANCE AGENT
# ============================================================

def attendance_agent(
    session_id,
    student_id,
    verification_facts,
):

    result = attendance_agent_chain.invoke(
        {
            "facts": verification_facts
        }
    )

    status = result.get("status")

    reason = result.get("reason")

    if status not in {"PRESENT", "FLAGGED"}:
        raise ValueError(
            "Attendance agent returned an invalid status."
        )

    if not reason:
        raise ValueError(
            "Attendance agent returned no reason."
        )

    return {
        "session_id": session_id,
        "student_id": student_id,
        "status": status,
        "reason": reason,
    }