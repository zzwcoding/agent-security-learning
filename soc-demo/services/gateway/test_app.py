from app import app
from fastapi.testclient import TestClient


def test_healthz():
    r = TestClient(app).get("/healthz")
    assert r.status_code == 200
    assert r.json() == {"ok": True, "service": "gateway"}
