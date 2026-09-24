import hashlib
import hmac

from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError
from itsdangerous import BadSignature, URLSafeTimedSerializer

from settings import COOKIE_SECONDS, Settings

hasher = PasswordHasher()


def verify_password(password: str, settings: Settings) -> bool:
    try:
        return hasher.verify(settings.auth_password_hash.get_secret_value(), password)
    except (VerificationError, InvalidHashError):
        return False


def serializer(settings: Settings) -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(settings.auth_secret.get_secret_value(), salt="qwen-login-v1")


def password_version(settings: Settings) -> str:
    return hashlib.sha256(settings.auth_password_hash.get_secret_value().encode()).hexdigest()


def create_session(settings: Settings) -> str:
    return serializer(settings).dumps({"version": password_version(settings)})


def valid_session(cookie: str | None, settings: Settings) -> bool:
    if not cookie or not settings.auth_configured:
        return False
    try:
        data = serializer(settings).loads(cookie, max_age=COOKIE_SECONDS)
        return isinstance(data, dict) and hmac.compare_digest(
            str(data.get("version", "")), password_version(settings)
        )
    except BadSignature:
        return False
