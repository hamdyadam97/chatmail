"""Development settings: DEBUG on, sqlite database."""
import os

from .base import *  # noqa: F401,F403

DEBUG = True
ALLOWED_HOSTS = ["*"]
# Explicit origins (never '*': the frontend sends cookies with credentials:
# 'include', and browsers reject the wildcard in credentialed responses).
CORS_ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    # Opt-in extra origins for isolated test runs (e.g. the UI smoke test on :5174).
    *[o for o in os.environ.get("DEV_EXTRA_CORS_ORIGINS", "").split(",") if o],
]
