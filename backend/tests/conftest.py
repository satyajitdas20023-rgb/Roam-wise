from __future__ import annotations

import sys
from pathlib import Path

import pytest

# Allow both `cd backend; python -m pytest` and `python -m pytest backend`.
BACKEND_DIR = Path(__file__).resolve().parents[1]
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from app import create_app
from extensions import db


@pytest.fixture()
def app(tmp_path):
    database_path = tmp_path / "roamwise-test.db"
    app = create_app(
        {
            "TESTING": True,
            "SQLALCHEMY_DATABASE_URI": f"sqlite:///{database_path.as_posix()}",
            "CORS_ORIGINS": ("http://localhost:3000",),
            "SEED_DATA": True,
        }
    )
    yield app
    with app.app_context():
        db.session.remove()
        db.drop_all()


@pytest.fixture()
def client(app):
    return app.test_client()
