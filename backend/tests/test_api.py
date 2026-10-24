from __future__ import annotations

from app import _save_trip

VALID_PLAN = {
    "destination": "New York",
    "duration": 2,
    "budget": 100000,
    "travelers": 2,
    "transport": "Flexible",
    "interests": ["Nature", "Photography"],
}


def test_health_checks_real_database(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    data = response.get_json()
    assert data["status"] == "ok"
    assert data["service"] == "RoamWise API"
    assert data["database"] == "connected"


def test_cors_allows_the_local_frontend(client):
    response = client.get("/api/health", headers={"Origin": "http://localhost:3000"})
    assert response.headers["Access-Control-Allow-Origin"] == "http://localhost:3000"

    preflight = client.open(
        "/api/plan",
        method="OPTIONS",
        headers={
            "Origin": "http://localhost:3000",
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type, accept",
        },
    )
    assert preflight.status_code == 200
    allow_headers = preflight.headers.get("Access-Control-Allow-Headers", "").lower()
    assert "content-type" in allow_headers
    assert "accept" in allow_headers


def test_destinations_list_and_case_insensitive_search(client):
    all_destinations = client.get("/api/destinations")
    assert all_destinations.status_code == 200
    assert all_destinations.get_json()["count"] >= 7

    response = client.get("/api/destinations?q=nEw")
    assert response.status_code == 200
    assert [item["name"] for item in response.get_json()["destinations"]] == ["New York"]


def test_valid_plan_is_persisted_with_requested_days_and_correct_arithmetic(app, client):
    plan = {
        **VALID_PLAN,
        "itinerary": [
            {
                "day": 1,
                "activities": [{"time": "10:00", "place": "Central Park", "description": "Walk"}],
                "route_path": [],
                "note": "Relaxing day",
            },
            {
                "day": 2,
                "activities": [{"time": "11:00", "place": "Times Square", "description": "Explore"}],
                "route_path": [],
                "note": "City tour",
            },
        ],
        "budget_breakdown": {},
    }
    with app.app_context():
        trip = _save_trip(plan)
    assert trip["id"]
    assert len(trip["itinerary"]) == VALID_PLAN["duration"]
    assert trip["destination"] == "New York"

    retrieved = client.get(f"/api/trips/{trip['id']}")
    assert retrieved.status_code == 200
    assert retrieved.get_json()["trip"]["destination"] == "New York"


def test_invalid_budget_and_malformed_json_are_rejected(client):
    invalid = dict(VALID_PLAN, budget=0)
    invalid_response = client.post("/api/plan", json=invalid)
    assert invalid_response.status_code == 400
    assert "budget" in invalid_response.get_json()["error"]["details"]

    malformed = client.post("/api/plan", data="{not valid json", content_type="application/json")
    assert malformed.status_code == 400
    assert malformed.get_json()["error"]["code"] == "invalid_json"


def test_empty_and_oversized_destinations_are_rejected(client):
    empty = client.post("/api/plan", json=dict(VALID_PLAN, destination=""))
    assert empty.status_code == 400
    assert "destination" in empty.get_json()["error"]["details"]

    oversized = client.post("/api/plan", json=dict(VALID_PLAN, destination="X" * 150))
    assert oversized.status_code == 400
    assert "destination" in oversized.get_json()["error"]["details"]


def test_delete_saved_trip_and_unknown_trip(app, client):
    plan = {
        **VALID_PLAN,
        "itinerary": [{"day": 1, "activities": [], "route_path": [], "note": "Day 1"}],
        "budget_breakdown": {},
    }
    with app.app_context():
        created = _save_trip(plan)
    deleted = client.delete(f"/api/trips/{created['id']}")
    assert deleted.status_code == 200
    assert client.get(f"/api/trips/{created['id']}").status_code == 404
    assert client.delete("/api/trips/999999").status_code == 404
