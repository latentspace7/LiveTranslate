from getpass import getpass

from argon2 import PasswordHasher

if __name__ == "__main__":
    password = getpass("Shared password: ")
    if len(password) < 12:
        raise SystemExit("Use at least 12 characters.")
    if password != getpass("Confirm password: "):
        raise SystemExit("Passwords did not match.")
    print(PasswordHasher().hash(password))
