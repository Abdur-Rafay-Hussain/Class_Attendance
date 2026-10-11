from jose import jwt, JWTError
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from datetime import datetime, timedelta
import os
from dotenv import load_dotenv
load_dotenv()

SECRET_KEY = os.environ['SECRET_KEY']
ALGORITHM = os.environ['ALGORITHM']

auth = OAuth2PasswordBearer(tokenUrl="login")

def create_access_token(data: dict):
    to_encode = data.copy()
    if not to_encode:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't encode JWT",
        )
    expire = datetime.now() + timedelta(minutes=30)
    to_encode['exp'] = expire
    encoded_jwt = jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)
    if not encoded_jwt:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Can't encode JWT",
        )
    return encoded_jwt

def verify_token(token=Depends(auth)):
    try:
        # print("TOKEN:", token)

        payload = jwt.decode(
            token,
            SECRET_KEY,
            algorithms=[ALGORITHM]
        )

        # print("PAYLOAD:", payload)

        return payload

    except JWTError as e:
        # print("JWT ERROR:", e)

        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
        )