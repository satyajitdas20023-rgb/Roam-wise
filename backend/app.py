"""RoamWise Flask API in one file.

Geoapify discovers real OpenStreetMap-based points of interest; hosted Gemma selects and
organizes them into a personalized itinerary. SQLite is used only for saved-trip persistence.
"""
from __future__ import annotations

import json
import logging
from contextlib import contextmanager
import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
from google import genai
from google.genai import types
from dotenv import load_dotenv
from flask import Flask, current_app, jsonify, request
from flask_cors import CORS
from werkzeug.exceptions import HTTPException

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")
GEOAPIFY_GEOCODE_URL = "https://api.geoapify.com/v1/geocode/search"
GEOAPIFY_AUTOCOMPLETE_URL = "https://api.geoapify.com/v1/geocode/autocomplete"
GEOAPIFY_PLACES_URL = "https://api.geoapify.com/v2/places"
_PLACE_CACHE: dict[str, tuple[float, tuple[str, str, list[dict[str, Any]]]]] = {}
_PLACE_CACHE_TTL_SECONDS = 15 * 60
MIN_VERIFIED_SIGHT_COUNT = 3
SUPPORTED_TRANSPORT = {"Flexible", "Public transport", "Walking", "Cab", "Rental vehicle"}
MAX_BUDGET_INR = 100_000

# These are Explore-page starter cards only. They are NOT an allowlist and are
# never used to generate itineraries; users can plan any destination.
EXPLORE_DESTINATIONS = [
    {
        "id": 1, "name": "New York", "region": "USA",
        "description": "Iconic parks, neighbourhoods, museums and skyline views.",
        "image_url": "https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?auto=format&fit=crop&w=900&q=85",
        "tag": "City icons",
    },
    {
        "id": 2, "name": "Puri", "region": "Odisha, India",
        "description": "Temple heritage, ocean sunsets and local Odia food.",
        "image_url": "https://images.unsplash.com/photo-1593693397690-362cb9666fc2?auto=format&fit=crop&w=900&q=85",
        "tag": "Culture & coast",
    },
    {
        "id": 3, "name": "Goa", "region": "India",
        "description": "Beach days, Portuguese heritage and laid-back cafés.",
        "image_url": "https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=900&q=85",
        "tag": "Beach escape",
    },
    {
        "id": 4, "name": "Jaipur", "region": "Rajasthan, India",
        "description": "Colourful markets, forts and remarkable architecture.",
        "image_url": "https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=900&q=85",
        "tag": "History & culture",
    },
    {
        "id": 5, "name": "Manali", "region": "Himachal Pradesh, India",
        "description": "Mountain views, fresh air and scenic trails.",
        "image_url": "https://images.unsplash.com/photo-1626621341517-bbf3d9990a23?auto=format&fit=crop&w=900&q=85",
        "tag": "Mountain break",
    },
    {
        "id": 6, "name": "Meghalaya", "region": "Northeast India",
        "description": "Misty hills, waterfalls and lush green landscapes.",
        "image_url": "https://images.unsplash.com/photo-1500530855697-b586d89ba3ee?auto=format&fit=crop&w=900&q=85",
        "tag": "Nature & adventure",
    },
    {
        "id": 7, "name": "Varanasi", "region": "Uttar Pradesh, India",
        "description": "Riverfront walks, old streets and living traditions.",
        "image_url": "https://images.unsplash.com/photo-1561361058-c24cecae35ca?auto=format&fit=crop&w=900&q=85",
        "tag": "Heritage",
    },
]

INTEREST_TERMS: dict[str, tuple[str, ...]] = {
    "nature": ("nature", "park", "garden", "forest", "mountain", "waterfall", "lake", "trail", "scenic"),
    "history": ("history", "historical", "museum", "monument", "fort", "palace", "landmark", "heritage", "memorial"),
    "temples": ("temple", "shrine", "worship", "religious", "church", "mosque", "monastery", "pagoda"),
    "beaches": ("beach", "coast", "seaside", "waterfront", "island", "bay"),
    "local food": ("food", "restaurant", "market", "cafe", "café", "bakery", "street food", "food court"),
    "adventure": ("adventure", "hiking", "climbing", "rafting", "outdoor", "ski", "trail", "amusement"),
    "photography": ("viewpoint", "scenic", "lookout", "landmark", "garden", "skyline", "waterfront"),
    "hidden gems": ("local", "village", "craft", "neighbourhood", "neighborhood", "market", "art district"),
}


class ApiProblem(Exception):
    def __init__(self, message: str, status: int = 400, code: str = "request_error", details: dict[str, str] | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.details = details or {}


def _default_database_path() -> Path:
    custom = os.getenv("ROAMWISE_DB_PATH", "").strip()
    if custom:
        return Path(custom).expanduser().resolve()

    # Retain compatibility with the old SQLAlchemy-style SQLite env setting.
    database_url = os.getenv("DATABASE_URL", "").strip()
    if database_url.startswith("sqlite:///"):
        value = database_url[len("sqlite:///"):]
        if value:
            path = Path(value).expanduser()
            if path.is_absolute():
                return path
            return (BASE_DIR / path).resolve()

    return BASE_DIR / "instance" / "data" / "roamwise.db"


def _connect() -> sqlite3.Connection:
    path = Path(current_app.config["DATABASE_PATH"]).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection


@contextmanager
def _database_connection():
    connection = _connect()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def _init_database(app: Flask) -> None:
    """Create only the saved-trip table, preserving any existing records."""
    path = Path(app.config["DATABASE_PATH"]).expanduser()
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path, timeout=15)
    try:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS trips (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                destination VARCHAR(120) NOT NULL,
                duration INTEGER NOT NULL,
                total_budget INTEGER NOT NULL,
                travelers INTEGER NOT NULL DEFAULT 1,
                transport VARCHAR(80) NOT NULL,
                interests JSON NOT NULL,
                expense_breakdown JSON NOT NULL,
                itinerary JSON NOT NULL,
                created_at DATETIME NOT NULL,
                planner_engine VARCHAR(120) NOT NULL DEFAULT 'legacy saved plan'
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(trips)").fetchall()}
        # Existing SQLAlchemy-generated databases predate this optional column.
        if "planner_engine" not in columns:
            connection.execute(
                "ALTER TABLE trips ADD COLUMN planner_engine VARCHAR(120) NOT NULL DEFAULT 'legacy saved plan'"
            )
        connection.execute("CREATE INDEX IF NOT EXISTS ix_trips_created_at ON trips (created_at)")
        connection.commit()
    finally:
        connection.close()


def _validate_plan(payload: object) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ApiProblem("Request body must be a JSON object.", 400, "invalid_json")

    errors: dict[str, str] = {}
    destination = payload.get("destination")
    if not isinstance(destination, str) or not destination.strip():
        errors["destination"] = "Destination is required."
    elif len(destination.strip()) > 120:
        errors["destination"] = "Destination must be 120 characters or fewer."

    duration = payload.get("duration")
    if not isinstance(duration, int) or isinstance(duration, bool) or not 1 <= duration <= 7:
        errors["duration"] = "Duration must be an integer between 1 and 7 days."

    budget = payload.get("budget")
    if not isinstance(budget, (int, float)) or isinstance(budget, bool) or not 500 <= budget <= MAX_BUDGET_INR:
        errors["budget"] = f"Budget must be between ₹500 and ₹{MAX_BUDGET_INR:,}."

    travelers = payload.get("travelers")
    if not isinstance(travelers, int) or isinstance(travelers, bool) or not 1 <= travelers <= 20:
        errors["travelers"] = "Travelers must be an integer between 1 and 20."

    transport = payload.get("transport")
    if transport not in SUPPORTED_TRANSPORT:
        errors["transport"] = f"Transport must be one of: {', '.join(sorted(SUPPORTED_TRANSPORT))}."

    interests = payload.get("interests", [])
    if not isinstance(interests, list) or len(interests) > 8:
        errors["interests"] = "Interests must be an array containing at most 8 items."
    elif any(not isinstance(item, str) or not item.strip() or len(item.strip()) > 60 for item in interests):
        errors["interests"] = "Each interest must be a non-empty string of at most 60 characters."

    if errors:
        raise ApiProblem("One or more fields are invalid.", 400, "validation_error", errors)

    return {
        "destination": destination.strip(),
        "duration": duration,
        "budget": int(round(budget)),
        "travelers": travelers,
        "transport": transport,
        "interests": list(dict.fromkeys(item.strip() for item in interests)),
    }


def _require_env(name: str, purpose: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise ApiProblem(
            f"{name} is not configured. Add it to backend/.env to {purpose}.",
            503,
            f"missing_{name.lower()}",
        )
    return value


def _service_headers() -> dict[str, str]:
    contact = os.getenv("ROAMWISE_CONTACT_EMAIL", "").strip()
    identity = f"RoamWise/1.0 (contact: {contact})" if contact else "RoamWise/1.0 (local development)"
    return {"User-Agent": identity, "Accept": "application/json"}


def _provider_error(response: requests.Response, provider: str) -> ApiProblem:
    if response.status_code in (401, 403):
        current_app.logger.warning("%s rejected the configured API key (HTTP %s).", provider, response.status_code)
        return ApiProblem(
            f"{provider} rejected its API key. Check the key in backend/.env and confirm the API is enabled.",
            503,
            f"{provider.lower().replace(' ', '_')}_authentication_error",
        )
    if response.status_code == 429:
        return ApiProblem(f"{provider} rate limit reached. Wait a moment and retry.", 503, "places_rate_limited")
    current_app.logger.warning("%s returned HTTP %s.", provider, response.status_code)
    return ApiProblem(f"{provider} is temporarily unavailable. Please retry shortly.", 503, "places_provider_unavailable")


def _geoapify_geocode(destination: str, api_key: str) -> tuple[float, float, str]:
    try:
        response = requests.get(
            GEOAPIFY_GEOCODE_URL,
            params={"text": destination, "format": "json", "limit": 1, "lang": "en", "apiKey": api_key},
            headers=_service_headers(),
            timeout=(5, 15),
        )
    except requests.RequestException as error:
        current_app.logger.warning("Geoapify geocoding failed (%s).", type(error).__name__)
        raise ApiProblem("The place-data service could not be reached. Check your internet connection and try again.", 503, "geocoding_network_error") from error

    if not response.ok:
        raise _provider_error(response, "Geoapify geocoding")
    try:
        payload = response.json()
    except ValueError as error:
        raise ApiProblem("The place-data service returned an unreadable geocoding response.", 502, "geocoding_invalid_response") from error

    results = payload.get("results", []) if isinstance(payload, dict) else []
    if not isinstance(results, list) or not results:
        raise ApiProblem(
            f"We couldn't identify '{destination}'. Try adding its state or country.",
            422,
            "destination_not_found",
        )
    try:
        lat = float(results[0]["lat"])
        lon = float(results[0]["lon"])
    except (KeyError, TypeError, ValueError, IndexError) as error:
        raise ApiProblem("The place-data service could not resolve coordinates for that destination.", 422, "destination_coordinates_missing") from error
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise ApiProblem("The place-data service returned invalid coordinates for that destination.", 502, "destination_coordinates_invalid")
    formatted = str(results[0].get("formatted") or destination).strip()
    return lat, lon, formatted


BASE_PLACE_CATEGORIES = [
    "tourism",
    "tourism.sights",
    "tourism.attraction",
    "entertainment.museum",
    "entertainment.culture",
    "heritage",
    "leisure.park",
    "natural",
    "national_park",
    "beach",
    "religion.place_of_worship",
]

INTEREST_CATEGORIES: dict[str, list[str]] = {
    "nature": ["natural", "leisure.park", "national_park"],
    "history": ["heritage", "tourism.sights", "entertainment.museum"],
    "temples": ["religion.place_of_worship", "tourism.sights.place_of_worship"],
    "beaches": ["beach", "natural.coastal"],
    "local food": ["catering.restaurant", "catering.cafe", "catering.food_court"],
    "adventure": ["activity", "sport", "natural", "tourism.attraction"],
    "photography": ["tourism.attraction.viewpoint", "tourism.sights", "natural", "leisure.park"],
    "hidden gems": ["tourism", "entertainment.culture", "heritage", "leisure.park"],
}

SIGHT_CATEGORY_PREFIXES = (
    "tourism", "entertainment", "heritage", "leisure", "natural", "national_park",
    "beach", "religion", "historic", "museum",
)


def _get_place_categories(interests: list[str]) -> list[str]:
    categories = list(BASE_PLACE_CATEGORIES)
    for interest in interests:
        categories.extend(INTEREST_CATEGORIES.get(interest.casefold(), []))
    # Keep the request compact and don't include unsupported or unrelated category names.
    return list(dict.fromkeys(categories))[:25]


def _human_category(categories: list[str]) -> str:
    if not categories:
        return "Point of interest"
    preferred_prefixes = ("tourism.sights", "tourism.attraction", "heritage", "entertainment.museum", "leisure.park", "natural", "beach", "religion")
    chosen = next((item for prefix in preferred_prefixes for item in categories if item == prefix or item.startswith(prefix + ".")), categories[0])
    return chosen.replace(".", " · ").replace("_", " ").title()


def _discover_geoapify_places(destination: str, lat: float, lon: float, interests: list[str], api_key: str) -> list[dict[str, Any]]:
    categories = _get_place_categories(interests)
    try:
        response = requests.get(
            GEOAPIFY_PLACES_URL,
            params={
                "categories": ",".join(categories),
                "filter": f"circle:{lon:.6f},{lat:.6f},20000",
                "bias": f"proximity:{lon:.6f},{lat:.6f}",
                "limit": 100,
                "lang": "en",
                "apiKey": api_key,
            },
            headers=_service_headers(),
            timeout=(5, 20),
        )
    except requests.RequestException as error:
        current_app.logger.warning("Geoapify place search failed (%s).", type(error).__name__)
        raise ApiProblem("Place search is temporarily unavailable. Please retry in a moment.", 503, "places_network_error") from error

    if not response.ok:
        raise _provider_error(response, "Geoapify Places")
    try:
        payload = response.json()
    except ValueError as error:
        raise ApiProblem("The place-data service returned an unreadable places response.", 502, "places_invalid_response") from error

    features = payload.get("features", []) if isinstance(payload, dict) else []
    if not isinstance(features, list):
        raise ApiProblem("The place-data service returned an unexpected places response.", 502, "places_invalid_response")

    places: list[dict[str, Any]] = []
    seen: set[str] = set()
    for feature in features:
        if not isinstance(feature, dict):
            continue
        props = feature.get("properties") or {}
        if not isinstance(props, dict):
            continue
        name = str(props.get("name") or props.get("address_line1") or "").strip()
        if not name or name.casefold() in {destination.casefold(), "unnamed"}:
            continue
        geometry = feature.get("geometry")
        coordinates = geometry.get("coordinates") if isinstance(geometry, dict) else None
        raw_lat = props.get("lat")
        raw_lon = props.get("lon")
        if (raw_lat is None or raw_lon is None) and isinstance(coordinates, (list, tuple)) and len(coordinates) >= 2:
            raw_lon = coordinates[0] if raw_lon is None else raw_lon
            raw_lat = coordinates[1] if raw_lat is None else raw_lat
        try:
            place_lat = float(raw_lat)
            place_lon = float(raw_lon)
        except (TypeError, ValueError):
            continue
        if not (-90 <= place_lat <= 90 and -180 <= place_lon <= 180):
            continue
        raw_id = str(props.get("place_id") or f"{name.casefold()}:{place_lat:.5f}:{place_lon:.5f}")
        if raw_id in seen:
            continue
        seen.add(raw_id)
        raw_categories = props.get("categories") or []
        if not isinstance(raw_categories, list):
            raw_categories = []
        clean_categories = [str(category) for category in raw_categories[:12]]
        osm_url = f"https://www.openstreetmap.org/?mlat={place_lat:.6f}&mlon={place_lon:.6f}#map=16/{place_lat:.6f}/{place_lon:.6f}"
        places.append({
            "id": raw_id,
            "name": name,
            "description": "",
            "category": _human_category(clean_categories),
            "categories": clean_categories,
            "address": str(props.get("formatted") or "").strip(),
            "latitude": place_lat,
            "longitude": place_lon,
            "rating": None,
            "maps_url": osm_url,
            "map_url": osm_url,
            "provider": "Geoapify / OpenStreetMap",
            "entry_fee_known": False,
            "estimated_entry_fee_per_person": 0,
            "visit_duration_minutes": 90,
            "visit_duration_is_estimate": True,
            "costs_are_estimates": True,
            "planning_notes": "Opening hours, access rules, and ticket prices are not verified by this place search; check before travelling.",
        })

    return places


def discover_places(destination: str, interests: list[str]) -> tuple[list[dict[str, Any]], str]:
    """Resolve a destination and retrieve real OSM-based POIs via Geoapify."""
    api_key = _require_env("GEOAPIFY_API_KEY", "search real places and resolve destinations")
    cache_key = f"{destination.casefold().strip()}|{','.join(sorted(i.casefold() for i in interests))}"
    cached = _PLACE_CACHE.get(cache_key)
    if cached and time.monotonic() - cached[0] < _PLACE_CACHE_TTL_SECONDS:
        cached_resolved_destination, _cached_key, cached_places = cached[1]
        return [dict(place) for place in cached_places], cached_resolved_destination

    latitude, longitude, resolved_destination = _geoapify_geocode(destination, api_key)
    places = _discover_geoapify_places(destination, latitude, longitude, interests, api_key)
    if not places:
        raise ApiProblem(
            f"RoamWise doesn't have enough place data for {destination} right now. Try a better-known nearby city or another destination.",
            422,
            "destination_not_available",
        )
    _PLACE_CACHE[cache_key] = (time.monotonic(), (resolved_destination, api_key, [dict(place) for place in places]))
    return places, resolved_destination


def _rank_places(places: list[dict[str, Any]], interests: list[str]) -> list[dict[str, Any]]:
    if not interests:
        return places

    def score(place: dict[str, Any]) -> int:
        searchable = " ".join(
            [str(place.get(key) or "") for key in ("name", "category", "address")] +
            [str(value) for value in (place.get("categories") or [])]
        ).lower()
        return sum(
            1 for interest in interests
            for term in INTEREST_TERMS.get(interest.lower(), (interest.lower(),))
            if term in searchable
        )

    return sorted(places, key=score, reverse=True)


def _parse_model_json(text: str) -> dict[str, Any]:
    """Parse a JSON object even if the model wraps it in a code fence or prose."""
    if not text or not text.strip():
        raise ValueError("Gemma returned an empty response")

    cleaned = text.strip().lstrip("\ufeff")
    cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s*```$", "", cleaned)

    # Decode the first complete JSON object rather than using rfind('}'), which
    # can accidentally include trailing explanations or a second JSON example.
    decoder = json.JSONDecoder()
    first_object = cleaned.find("{")
    if first_object < 0:
        raise ValueError("Gemma did not return a JSON object")
    candidate = cleaned[first_object:]
    try:
        parsed, _ = decoder.raw_decode(candidate)
    except json.JSONDecodeError:
        # Recover from a common small model formatting mistake: trailing commas.
        repaired = re.sub(r",\s*([}\]])", r"\1", candidate)
        parsed, _ = decoder.raw_decode(repaired)

    if not isinstance(parsed, dict):
        raise ValueError("Gemma response was not an object")
    return parsed


def _gemma_response_text(response: Any) -> str:
    """Get generated text from the SDK response without assuming its shortcut exists."""
    try:
        text_value = getattr(response, "text", None)
        if isinstance(text_value, str) and text_value.strip():
            return text_value.strip()
    except Exception:
        # The SDK shortcut can fail when a response has no ordinary text part.
        pass

    collected: list[str] = []
    for candidate in (getattr(response, "candidates", None) or []):
        content = getattr(candidate, "content", None)
        for part in (getattr(content, "parts", None) or []):
            part_text = getattr(part, "text", None)
            if isinstance(part_text, str) and part_text.strip():
                collected.append(part_text)
    return "\n".join(collected).strip()


def _generate_gemma_itinerary(plan: dict[str, Any], places: list[dict[str, Any]], resolved_destination: str) -> list[dict[str, Any]]:
    api_key = _require_env("GEMMA_API_KEY", "generate personalized itineraries")
    model_name = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it").strip() or "gemma-4-26b-a4b-it"
    # Limit the prompt size while preserving provider-ranked candidates.
    candidates = _rank_places(places, plan["interests"])[:60]
    candidates_by_id = {place["id"]: place for place in candidates}
    compact_places = [
        {
            "place_id": place["id"],
            "name": place["name"],
            "category": place["category"],
            "address": place["address"],
        }
        for place in candidates
    ]
    system_instruction = (
        "You are RoamWise, a careful travel-itinerary planner. You must only select places from the supplied candidate list. "
        "Never invent a place, provider ID, address, opening hour, ticket price, or factual claim not supported by input. "
        "If a place's exact details are not provided, phrase recommendations as suggestions, not verified facts. "
        "Output one JSON object only. Do not include markdown fences, analysis, or text before or after the JSON."
    )
    prompt = f"""Create a practical itinerary using only the place candidates listed below.
Destination resolved by the provider: {resolved_destination}
User destination text: {plan['destination']}
Duration: {plan['duration']} days
Group budget: INR {plan['budget']}
Travelers: {plan['travelers']}
Transportation: {plan['transport']}
Interests: {json.dumps(plan['interests'], ensure_ascii=False)}

CANDIDATE PLACES (each place_id must be copied exactly; never create IDs):
{json.dumps(compact_places, ensure_ascii=False)}

Requirements:
- Return exactly {plan['duration']} day objects with day numbers 1 through {plan['duration']}.
- Use 2-3 different places per day when enough candidates exist; never repeat a place.
- Choose places that best fit the user's interests. Keep the schedule realistic.
- duration_minutes must be an integer from 30 to 180.
- Do not invent ticket prices, opening hours, historic facts, or other unsupported claims.
- If there are not enough appropriate candidates, return fewer activities and explain in the day's note. Never invent a replacement.
- Return only this JSON shape:
{{
  "days": [
    {{
      "day": 1,
      "theme": "short theme",
      "activities": [
        {{"place_id": "copy an exact place_id from the candidates", "duration_minutes": 90, "reason": "brief recommendation reason grounded in candidate information"}}
      ],
      "note": "optional short note"
    }}
  ],
  "general_tips": ["short practical caveat"]
}}
"""

    response_schema = {
        "type": "OBJECT",
        "required": ["days", "general_tips"],
        "properties": {
            "days": {
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "required": ["day", "theme", "activities"],
                    "properties": {
                        "day": {"type": "INTEGER"},
                        "theme": {"type": "STRING"},
                        "note": {"type": "STRING"},
                        "activities": {
                            "type": "ARRAY",
                            "items": {
                                "type": "OBJECT",
                                "required": ["place_id", "duration_minutes", "reason"],
                                "properties": {
                                    "place_id": {"type": "STRING"},
                                    "duration_minutes": {"type": "INTEGER"},
                                    "reason": {"type": "STRING"},
                                },
                            },
                        },
                    },
                },
            },
            "general_tips": {"type": "ARRAY", "items": {"type": "STRING"}},
        },
    }

    client = genai.Client(api_key=api_key)
    structured_output_supported = True

    def generate_response(contents: str):
        nonlocal structured_output_supported
        if structured_output_supported:
            try:
                return client.models.generate_content(
                    model=model_name,
                    contents=contents,
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        temperature=0.1,
                        max_output_tokens=5000,
                        response_mime_type="application/json",
                        response_schema=response_schema,
                    ),
                )
            except Exception as structured_error:
                # Some model/API combinations reject response schema settings. Retry once
                # using ordinary text generation and a strict JSON-only prompt.
                status_code = getattr(structured_error, "code", None) or getattr(structured_error, "status_code", None)
                message = str(structured_error).lower()
                likely_config_error = status_code in (400, 404, 422) or any(
                    token in message for token in ("response_schema", "response_mime_type", "structured output", "not supported")
                )
                if not likely_config_error:
                    raise
                current_app.logger.warning(
                    "Gemma JSON-schema mode was rejected (%s); retrying with strict JSON prompting.",
                    type(structured_error).__name__,
                )
                structured_output_supported = False

        return client.models.generate_content(
            model=model_name,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system_instruction,
                temperature=0.0,
                max_output_tokens=5000,
            ),
        )

    try:
        response = generate_response(prompt)
        output_text = _gemma_response_text(response)
    except Exception as error:
        current_app.logger.warning("Gemma request failed (%s).", type(error).__name__)
        raise ApiProblem(
            "Gemma couldn't generate the itinerary. Check GEMMA_API_KEY, GEMMA_MODEL, your API quota, and then retry.",
            503,
            "gemma_unavailable",
        ) from error

    model_plan: dict[str, Any] | None = None
    parse_error: Exception | None = None
    for attempt in range(2):
        try:
            model_plan = _parse_model_json(output_text)
            if not isinstance(model_plan.get("days"), list):
                raise ValueError("Gemma JSON did not contain a 'days' array")
            break
        except (ValueError, json.JSONDecodeError) as error:
            model_plan = None
            parse_error = error
            if attempt == 0:
                current_app.logger.warning(
                    "Gemma itinerary output was not usable JSON (length=%d, preview=%r); retrying once.",
                    len(output_text),
                    output_text[:220],
                )
                retry_prompt = (
                    prompt
                    + "\n\nIMPORTANT RETRY: Your previous output could not be parsed. Output ONLY one valid JSON object. "
                    + "The top-level keys must be exactly 'days' and 'general_tips'. Do not use markdown, comments, or trailing commas. "
                    + "Use the candidate place_id strings verbatim. Keep the response concise so it is not cut off."
                )
                try:
                    response = generate_response(retry_prompt)
                    output_text = _gemma_response_text(response)
                except Exception as retry_error:
                    current_app.logger.warning("Gemma retry failed (%s).", type(retry_error).__name__)
                    raise ApiProblem(
                        "Gemma couldn't complete itinerary generation. Please retry in a moment.",
                        503,
                        "gemma_unavailable",
                    ) from retry_error

    if model_plan is None:
        current_app.logger.warning(
            "Gemma returned invalid itinerary JSON after retry (length=%d, parse_error=%s, preview=%r).",
            len(output_text),
            type(parse_error).__name__ if parse_error else "unknown",
            output_text[:220],
        )
        raise ApiProblem(
            "Gemma couldn't format the itinerary correctly after two attempts. Please retry generation.",
            502,
            "gemma_invalid_response",
        )

    raw_days = model_plan["days"]
    day_map: dict[int, dict[str, Any]] = {}
    used_ids: set[str] = set()
    for raw_day in raw_days:
        if not isinstance(raw_day, dict):
            continue
        try:
            day_number = int(raw_day.get("day"))
        except (TypeError, ValueError):
            continue
        if not 1 <= day_number <= plan["duration"] or day_number in day_map:
            continue
        raw_activities = raw_day.get("activities", [])
        activities: list[dict[str, Any]] = []
        if isinstance(raw_activities, list):
            for item in raw_activities:
                if not isinstance(item, dict):
                    continue
                place_id = str(item.get("place_id", ""))
                place = candidates_by_id.get(place_id)
                # Validate model-selected IDs and prevent repeats. The model cannot create factual place records.
                if not place or place_id in used_ids:
                    continue
                used_ids.add(place_id)
                try:
                    visit_duration = int(item.get("duration_minutes", 90))
                except (TypeError, ValueError):
                    visit_duration = 90
                visit_duration = max(30, min(180, visit_duration))
                reason = item.get("reason")
                if not isinstance(reason, str) or not reason.strip():
                    reason = f"A potential match for your interests in {', '.join(plan['interests']) or 'local attractions'}. Verify details before visiting."
                activities.append({
                    "attraction_id": place["id"],
                    "place_id": place["id"],
                    "name": place["name"],
                    "description": reason.strip()[:450],
                    "category": place["category"],
                    "estimated_cost": 0,
                    "estimated_entry_fee_per_person": 0,
                    "entry_fee_known": False,
                    "visit_duration_minutes": visit_duration,
                    "visit_duration_is_estimate": True,
                    "planning_notes": "Check the official listing for opening hours, access rules, ticket prices, and temporary closures.",
                    "address": place["address"],
                    "latitude": place["latitude"],
                    "longitude": place["longitude"],
                    "rating": place["rating"],
                    "maps_url": place["maps_url"],
                    "provider": place["provider"],
                    "costs_are_estimates": True,
                })
        day_theme = raw_day.get("theme")
        note = raw_day.get("note")
        day_obj: dict[str, Any] = {"day": day_number, "activities": activities}
        if isinstance(day_theme, str) and day_theme.strip():
            day_obj["theme"] = day_theme.strip()[:100]
        if isinstance(note, str) and note.strip():
            day_obj["note"] = note.strip()[:300]
        elif not activities:
            day_obj["note"] = "There aren't enough verified stops for this day. Keep it flexible rather than relying on invented places."
        day_map[day_number] = day_obj

    itinerary: list[dict[str, Any]] = []
    for day_number in range(1, plan["duration"] + 1):
        itinerary.append(day_map.get(day_number, {
            "day": day_number,
            "activities": [],
            "note": "Gemma didn't return a plan for this day. Keep it flexible or regenerate the itinerary.",
        }))

    if len(used_ids) < 2:
        raise ApiProblem("Gemma couldn't create a usable itinerary from the verified places returned. Try another destination or different interests.", 502, "gemma_no_usable_stops")
    return itinerary


def _estimate_budget(plan: dict[str, Any], itinerary: list[dict[str, Any]]) -> dict[str, Any]:
    """Very rough INR planning assumptions; never represent these as live prices."""
    person_days = plan["duration"] * plan["travelers"]
    transport_per_person_day = {
        "Walking": 120,
        "Public transport": 300,
        "Flexible": 450,
        "Cab": 900,
        "Rental vehicle": 1400,
    }[plan["transport"]]
    accommodation = 1200 * person_days
    food = 700 * person_days
    transportation = transport_per_person_day * person_days
    # Ticket/admission costs are unknown: do not make up a number or add them.
    entry_fees = 0
    miscellaneous = round((accommodation + food + transportation) * 0.08)
    total = accommodation + food + transportation + entry_fees + miscellaneous
    submitted = plan["budget"]
    return {
        "currency": "INR",
        "transportation": transportation,
        "accommodation": accommodation,
        "food": food,
        "entry_fees": entry_fees,
        "miscellaneous": miscellaneous,
        "total": total,
        "submitted_budget": submitted,
        "remaining": max(submitted - total, 0),
        "amount_over_budget": max(total - submitted, 0),
        "is_within_budget": total <= submitted,
        "costs_are_estimates": True,
        "estimate_note": (
            "Illustrative INR placeholders only, not destination-specific quotes. Place discovery does not provide verified ticket, "
            "accommodation, or transport prices; attraction entry fees are excluded. Verify costs before travel."
        ),
    }


def _trip_from_row(row: sqlite3.Row) -> dict[str, Any]:
    breakdown = json.loads(row["expense_breakdown"] or "{}")
    itinerary = json.loads(row["itinerary"] or "[]")
    budget = int(row["total_budget"])
    total = int(breakdown.get("total", 0))
    return {
        "id": int(row["id"]),
        "destination": row["destination"],
        "duration": int(row["duration"]),
        "budget": budget,
        "travelers": int(row["travelers"]),
        "transport": row["transport"],
        "interests": json.loads(row["interests"] or "[]"),
        "itinerary": itinerary,
        "budget_breakdown": breakdown,
        "is_within_budget": bool(breakdown.get("is_within_budget", total <= budget)),
        "costs_are_estimates": True,
        "planner_engine": row["planner_engine"] or "legacy saved plan",
        "created_at": str(row["created_at"]).replace(" ", "T", 1),
    }


def _save_trip(plan: dict[str, Any]) -> dict[str, Any]:
    created_at = datetime.now(timezone.utc).isoformat()
    planner_engine = str(plan.get("planner_engine") or f"Gemma ({os.getenv('GEMMA_MODEL', 'gemma-4-26b-a4b-it')}) + Geoapify Places")
    with _database_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO trips (
                destination, duration, total_budget, travelers, transport,
                interests, expense_breakdown, itinerary, created_at, planner_engine
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan["destination"], plan["duration"], plan["budget"], plan["travelers"],
                plan["transport"], json.dumps(plan["interests"], ensure_ascii=False),
                json.dumps(plan["budget_breakdown"], ensure_ascii=False),
                json.dumps(plan["itinerary"], ensure_ascii=False), created_at, planner_engine,
            ),
        )
        trip_id = int(cursor.lastrowid)
        row = connection.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        connection.commit()
    if row is None:
        raise ApiProblem("The trip was generated but could not be retrieved after saving.", 500, "trip_save_failed")
    return _trip_from_row(row)


def create_app(config_overrides: dict[str, Any] | None = None) -> Flask:
    app = Flask(__name__)
    origins = tuple(
        origin.strip()
        for origin in os.getenv("CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000").split(",")
        if origin.strip()
    )
    app.config.update(
        DATABASE_PATH=str(_default_database_path()),
        CORS_ORIGINS=origins,
        SERVER_HOST=os.getenv("ROAMWISE_HOST", "127.0.0.1"),
        SERVER_PORT=int(os.getenv("ROAMWISE_PORT", os.getenv("PORT", "5000"))),
        SERVER_DEBUG=os.getenv("FLASK_DEBUG", "false").lower() in {"1", "true", "yes"},
    )
    if config_overrides:
        app.config.update(config_overrides)

    CORS(app, resources={r"/api/*": {"origins": app.config["CORS_ORIGINS"]}}, methods=["GET", "POST", "DELETE", "OPTIONS"], allow_headers=["Content-Type", "Accept"])
    _init_database(app)

    @app.errorhandler(ApiProblem)
    def handle_api_problem(error: ApiProblem):
        payload: dict[str, Any] = {"error": {"code": error.code, "message": error.message}}
        if error.details:
            payload["error"]["details"] = error.details
        return jsonify(payload), error.status

    @app.errorhandler(HTTPException)
    def handle_http_error(error: HTTPException):
        # Keep routing errors such as 404 as real HTTP errors rather than
        # misleadingly converting them into generic 500 server failures.
        return jsonify({
            "error": {
                "code": (error.name or "http_error").lower().replace(" ", "_"),
                "message": error.description,
            }
        }), error.code or 500

    @app.errorhandler(Exception)
    def handle_unexpected_error(error: Exception):
        if app.testing:
            raise error
        app.logger.exception("Unexpected RoamWise API failure")
        return jsonify({"error": {"code": "server_error", "message": "An unexpected server error occurred. Please try again."}}), 500

    @app.get("/api/health")
    def health_check():
        try:
            with _database_connection() as connection:
                connection.execute("SELECT 1").fetchone()
            return jsonify({
                "status": "ok",
                "service": "RoamWise API",
                "database": "connected",
                "gemma_configured": bool(os.getenv("GEMMA_API_KEY", "").strip()),
                "places_provider_configured": bool(os.getenv("GEOAPIFY_API_KEY", "").strip()),
            })
        except sqlite3.Error:
            current_app.logger.exception("SQLite health check failed")
            return jsonify({"status": "error", "service": "RoamWise API", "database": "unavailable"}), 503

    @app.get("/api/destinations")
    def list_explore_destinations():
        # A curated set for the Explore page only; the planner accepts free text.
        query = request.args.get("q", "").strip().casefold()
        try:
            requested_limit = int(request.args.get("limit", 12))
        except ValueError:
            requested_limit = 12
        limit = max(1, min(requested_limit, 20))
        results = [item for item in EXPLORE_DESTINATIONS if not query or query in f"{item['name']} {item['region']} {item['description']} {item['tag']}".casefold()]
        results = results[:limit]
        return jsonify({"destinations": results, "count": len(results)})

    @app.get("/api/destination-suggestions")
    def destination_suggestions():
        """Live destination autocomplete powered by Geoapify Geocoding."""
        query = request.args.get("q", "").strip()
        if len(query) < 2:
            return jsonify({"suggestions": []})

        # Bound user input and results to keep autocomplete requests small.
        query = query[:120]
        api_key = _require_env("GEOAPIFY_API_KEY", "autocomplete destination names")
        try:
            response = requests.get(
                GEOAPIFY_AUTOCOMPLETE_URL,
                params={
                    "text": query,
                    "format": "json",
                    "limit": 8,
                    "lang": "en",
                    "apiKey": api_key,
                },
                headers=_service_headers(),
                timeout=(4, 10),
            )
        except requests.RequestException as error:
            current_app.logger.warning(
                "Geoapify autocomplete failed (%s).", type(error).__name__
            )
            raise ApiProblem(
                "Destination autocomplete is temporarily unavailable. Check your connection and retry.",
                503,
                "autocomplete_network_error",
            ) from error

        if not response.ok:
            raise _provider_error(response, "Geoapify autocomplete")

        try:
            payload = response.json()
        except ValueError as error:
            raise ApiProblem(
                "The destination service returned an unreadable response.",
                502,
                "autocomplete_invalid_response",
            ) from error

        results = payload.get("results", []) if isinstance(payload, dict) else []
        if not isinstance(results, list):
            raise ApiProblem(
                "The destination service returned an unexpected response.",
                502,
                "autocomplete_invalid_response",
            )

        suggestions: list[dict[str, Any]] = []
        seen: set[str] = set()
        for item in results:
            if not isinstance(item, dict):
                continue
            label = str(item.get("formatted") or "").strip()
            if not label:
                continue
            title = str(
                item.get("name")
                or item.get("city")
                or item.get("town")
                or item.get("village")
                or item.get("state")
                or item.get("country")
                or label.split(",")[0]
            ).strip()
            dedupe_key = label.casefold()
            if dedupe_key in seen:
                continue
            seen.add(dedupe_key)

            try:
                latitude = float(item["lat"]) if item.get("lat") is not None else None
            except (TypeError, ValueError):
                latitude = None
            try:
                longitude = float(item["lon"]) if item.get("lon") is not None else None
            except (TypeError, ValueError):
                longitude = None

            suggestions.append({
                "title": title,
                "label": label,
                "result_type": str(item.get("result_type") or "place"),
                "city": item.get("city") or item.get("town") or item.get("village"),
                "state": item.get("state"),
                "country": item.get("country"),
                "latitude": latitude,
                "longitude": longitude,
            })
            if len(suggestions) >= 8:
                break

        return jsonify({"suggestions": suggestions, "count": len(suggestions)})

    @app.post("/api/plan")
    def create_plan():
        if not request.is_json:
            raise ApiProblem("Request must contain a JSON object.", 400, "invalid_json")
        payload = request.get_json(silent=True)
        if payload is None:
            raise ApiProblem("Request body contains invalid JSON.", 400, "invalid_json")

        plan_request = _validate_plan(payload)
        # Check both keys before spending time or place-search credits on a plan that cannot be completed.
        _require_env("GEMMA_API_KEY", "generate personalized itineraries")
        _require_env("GEOAPIFY_API_KEY", "search real places and resolve destinations")
        places, resolved_destination = discover_places(plan_request["destination"], plan_request["interests"])
        ranked_places = _rank_places(places, plan_request["interests"])
        sight_count = sum(
            1 for place in ranked_places
            if any(str(category).startswith(SIGHT_CATEGORY_PREFIXES) for category in (place.get("categories") or []))
        )
        minimum_sights = max(MIN_VERIFIED_SIGHT_COUNT, min(plan_request["duration"], 5))
        if sight_count < minimum_sights:
            raise ApiProblem(
                f"RoamWise doesn't have enough verified tourist-place data for {plan_request['destination']} right now. Try a better-known nearby city or another destination.",
                422,
                "destination_not_available",
            )
        itinerary = _generate_gemma_itinerary(plan_request, ranked_places, resolved_destination)
        breakdown = _estimate_budget(plan_request, itinerary)
        plan = {
            **plan_request,
            "itinerary": itinerary,
            "budget_breakdown": breakdown,
            "planner_engine": f"Gemma ({os.getenv('GEMMA_MODEL', 'gemma-4-26b-a4b-it')}) + Geoapify Places",
        }
        trip = _save_trip(plan)
        return jsonify({"trip": trip}), 201

    @app.get("/api/trips")
    def list_saved_trips():
        def integer_query(name: str, default: int, minimum: int, maximum: int) -> int:
            try:
                value = int(request.args.get(name, default))
            except ValueError:
                value = default
            return max(minimum, min(value, maximum))

        limit = integer_query("limit", 20, 1, 50)
        offset = integer_query("offset", 0, 0, 10_000)
        with _database_connection() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM trips").fetchone()[0])
            rows = connection.execute(
                "SELECT * FROM trips ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?",
                (limit, offset),
            ).fetchall()
        return jsonify({"trips": [_trip_from_row(row) for row in rows], "pagination": {"limit": limit, "offset": offset, "total": total}})

    @app.get("/api/trips/<int:trip_id>")
    def get_saved_trip(trip_id: int):
        with _database_connection() as connection:
            row = connection.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        if row is None:
            raise ApiProblem("Saved trip not found.", 404, "not_found")
        return jsonify({"trip": _trip_from_row(row)})

    @app.delete("/api/trips/<int:trip_id>")
    def delete_saved_trip(trip_id: int):
        with _database_connection() as connection:
            cursor = connection.execute("DELETE FROM trips WHERE id = ?", (trip_id,))
            connection.commit()
        if cursor.rowcount == 0:
            raise ApiProblem("Saved trip not found.", 404, "not_found")
        return jsonify({"message": "Saved trip deleted.", "id": trip_id})

    return app


if __name__ == "__main__":
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
    application = create_app()
    application.run(
        host=application.config["SERVER_HOST"],
        port=application.config["SERVER_PORT"],
        debug=application.config["SERVER_DEBUG"],
        use_reloader=False,
        threaded=True,
    )
