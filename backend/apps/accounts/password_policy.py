"""Password policy for Argon2-hashed account passwords (login-only):
minimum 10 characters and not derived from the username.
"""
from rest_framework.exceptions import ValidationError

MIN_LENGTH = 10


def validate_password_policy(username: str, password: str) -> None:
    errors = []
    if len(password) < MIN_LENGTH:
        errors.append(f"كلمة المرور يجب ألا تقل عن {MIN_LENGTH} أحرف.")
    u, p = username.lower(), password.lower()
    if u and (u in p or p in u):
        errors.append("كلمة المرور لا يجب أن تشتق من اسم المستخدم.")
    if errors:
        raise ValidationError({"new_password": errors})


def generate_temp_password(username: str = "", length: int = 16) -> str:
    import secrets
    import string

    alphabet = string.ascii_letters + string.digits
    for _ in range(20):
        candidate = "".join(secrets.choice(alphabet) for _ in range(length))
        u, p = username.lower(), candidate.lower()
        if not u or (u not in p and p not in u):
            return candidate
    return candidate  # pragma: no cover - practically unreachable
