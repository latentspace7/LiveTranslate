import pytest
from argon2 import PasswordHasher

from settings import Settings


@pytest.fixture(scope="session")
def settings():
    return Settings(
        _env_file=None,
        auth_password_hash=PasswordHasher().hash("test-password-for-local-tests"),
        auth_secret="local-test-signing-secret-32-characters-minimum",
        dashscope_api_key="test-key-never-sent-to-qwen",
        app_origins="https://testserver",
    )
