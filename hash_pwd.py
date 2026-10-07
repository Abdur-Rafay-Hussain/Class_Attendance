from passlib.context import CryptContext

pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

def hash_pwd(password):
    return pwd_context.hash(password)

def verify_pwd(password, hashed_password):
    return pwd_context.verify(password, hashed_password)