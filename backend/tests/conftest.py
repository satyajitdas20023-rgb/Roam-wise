from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Allow both `cd backend; python -m pytest` and `python -m pytest backend`.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import create_app


@pytest.fixture()
def app(tmp_path):
    database_path = tmp_path / "roamwise-test.db"
    app = create_app(
        {
            "TESTING": True,
            "DATABASE_PATH": str(database_path),
            "CORS_ORIGINS": ("http://localhost:3000",),
        }
    )
    yield app


@pytest.fixture()
def client(app):
    return app.test_client()
