import hashlib
import hmac
import os
import secrets
import sqlite3
from contextlib import closing
from getpass import getpass
from pathlib import Path


PASSWORD_PREFIX = "pbkdf2_sha256$"
PASSWORD_ITERATIONS = 600_000


def database_path():
    configured = os.environ.get("CAFE_ONE_DATABASE_PATH")
    return Path(configured).resolve() if configured else Path(__file__).resolve().parent / "prisma" / "database.sqlite"


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return f"{PASSWORD_PREFIX}{salt.hex()}${digest.hex()}"


def verify_password(password: str, encoded: str) -> bool:
    if not encoded.startswith(PASSWORD_PREFIX):
        return False
    try:
        salt_hex, digest_hex = encoded.removeprefix(PASSWORD_PREFIX).split("$")
        salt, expected = bytes.fromhex(salt_hex), bytes.fromhex(digest_hex)
    except ValueError:
        return False
    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PASSWORD_ITERATIONS)
    return hmac.compare_digest(actual, expected)


def reset_admin_password():
    path = database_path()
    if not path.is_file():
        raise SystemExit(f"Database not found: {path}")
    print(f"Database: {path}")
    password = getpass("New administrator password: ")
    if len(password) < 8 or password != getpass("Repeat new password: "):
        raise SystemExit("Use at least 8 characters and enter the same password twice.")

    with closing(sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)) as db, db:
        db.execute("BEGIN IMMEDIATE")
        admins = db.execute("SELECT id FROM Employee WHERE role = 'ADMIN' AND isActive = 1").fetchall()
        if len(admins) != 1:
            raise SystemExit("Password reset requires exactly one active administrator.")
        credentials = db.execute("SELECT password FROM Employee WHERE id != ?", (admins[0][0],))
        for (stored,) in credentials:
            if stored == password or verify_password(password, stored):
                raise SystemExit("This password is already in use.")
        db.execute("UPDATE Employee SET password = ? WHERE id = ?", (hash_password(password), admins[0][0]))
    print("Administrator password updated.")


if __name__ == "__main__":
    reset_admin_password()
