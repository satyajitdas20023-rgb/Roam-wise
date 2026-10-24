"""RoamWise Flask API in one file.

Gemma generates targeted search queries and plans an itinerary from Gemma recommendation candidates.
OpenStreetMap OSRM supplies route-time estimates and map route geometry. SQLite persists saved trips.
"""
from __future__ import annotations

import json
import math
import logging
import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
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
# Public OpenStreetMap-based OSRM instances. They may throttle or be unavailable;
# the planner labels and falls back to approximate times rather than pretending otherwise.
OSRM_CAR_BASE = os.getenv("ROAMWISE_OSRM_CAR_BASE", "https://routing.openstreetmap.de/routed-car")
OSRM_FOOT_BASE = os.getenv("ROAMWISE_OSRM_FOOT_BASE", "https://routing.openstreetmap.de/routed-foot")
MAX_CANDIDATES_FOR_ROUTING = 12
SUPPORTED_TRANSPORT = {"Flexible", "Public transport", "Walking", "Cab", "Rental vehicle"}
MAX_BUDGET_INR = 100_000
USD_INR_CACHE_SECONDS = 6 * 60 * 60
_USD_INR_CACHE: dict[str, Any] = {"rate": None, "updated_at": None, "fetched_at": 0.0}

# Respect the shared FOSSGIS OSRM demo limit (about one request per second).
_OSRM_REQUEST_LOCK = threading.Lock()
_OSRM_LAST_REQUEST_FINISHED = 0.0

# These are Explore-page starter cards only. They are NOT an allowlist and are
# never used to generate itineraries; users can plan any destination.
EXPLORE_DESTINATIONS = [
    {
        "id": 1, "name": "Tokyo", "region": "Japan",
        "description": "Neon-lit streets, peaceful shrines, incredible food and pop culture.",
        "image_url": "https://images.unsplash.com/photo-1540959733332-eab4deabeeaf?auto=format&fit=crop&w=900&q=85",
        "tag": "City & culture",
    },
    {
        "id": 2, "name": "Paris", "region": "France",
        "description": "World-class art, café-lined streets, river walks and iconic landmarks.",
        "image_url": "https://images.unsplash.com/photo-1502602898657-3e91760cbb34?auto=format&fit=crop&w=900&q=85",
        "tag": "Art & romance",
    },
    {
        "id": 3, "name": "London", "region": "United Kingdom",
        "description": "Historic landmarks, lively markets, museums and theatre nights.",
        "image_url": "https://images.unsplash.com/photo-1513635269975-59663e0ac1ad?auto=format&fit=crop&w=900&q=85",
        "tag": "History & city life",
    },
    {
        "id": 4, "name": "New York", "region": "United States",
        "description": "Iconic parks, neighbourhoods, museums and skyline views.",
        "image_url": "https://images.unsplash.com/photo-1485871981521-5b1fd3805eee?auto=format&fit=crop&w=900&q=85",
        "tag": "City icons",
    },
    {
        "id": 5, "name": "Singapore", "region": "Singapore",
        "description": "Futuristic gardens, waterfront architecture and legendary hawker food.",
        "image_url": "https://images.unsplash.com/photo-1525625293386-3f8f99389edd?auto=format&fit=crop&w=900&q=85",
        "tag": "Food & skyline",
    },
    {
        "id": 6, "name": "Bali", "region": "Indonesia",
        "description": "Lush rice terraces, volcanic scenery, temples and surf beaches.",
        "image_url": "https://images.unsplash.com/photo-1537996194471-e657df975ab4?auto=format&fit=crop&w=900&q=85",
        "tag": "Island escape",
    },
    {
        "id": 7, "name": "Rome", "region": "Italy",
        "description": "Ancient ruins, grand piazzas, art and unforgettable Italian food.",
        "image_url": "https://images.unsplash.com/photo-1552832230-c0197dd311b5?auto=format&fit=crop&w=900&q=85",
        "tag": "Ancient history",
    },
    {
        "id": 8, "name": "Dubai", "region": "United Arab Emirates",
        "description": "Modern architecture, desert experiences, souks and waterfront dining.",
        "image_url": "https://images.unsplash.com/photo-1512453979798-5ea266f8880c?auto=format&fit=crop&w=900&q=85",
        "tag": "Modern & desert",
    },
    {
        "id": 9, "name": "Bangkok", "region": "Thailand",
        "description": "Golden temples, night markets, river trips and bold street food.",
        "image_url": "https://images.unsplash.com/photo-1508009603885-50cf7c579365?auto=format&fit=crop&w=900&q=85",
        "tag": "Food & temples",
    },
    {
        "id": 10, "name": "Puri", "region": "Odisha, India",
        "description": "Temple heritage, ocean sunsets and local Odia food.",
        "image_url": "https://images.unsplash.com/photo-1593693397690-362cb9666fc2?auto=format&fit=crop&w=900&q=85",
        "tag": "Culture & coast",
    },
    {
        "id": 11, "name": "Goa", "region": "India",
        "description": "Beach days, Portuguese heritage and laid-back cafés.",
        "image_url": "https://images.unsplash.com/photo-1512343879784-a960bf40e7f2?auto=format&fit=crop&w=900&q=85",
        "tag": "Beach escape",
    },
    {
        "id": 12, "name": "Jaipur", "region": "Rajasthan, India",
        "description": "Colourful markets, forts and beautiful architecture.",
        "image_url": "https://images.unsplash.com/photo-1599661046289-e31897846e41?auto=format&fit=crop&w=900&q=85",
        "tag": "History & culture",
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
    "popular / hot": ("popular", "famous", "iconic", "well known", "well-known", "must-see", "must see", "top attraction", "hotspot", "hot spot"),
    "wildlife": ("wildlife", "sanctuary", "national park", "nature reserve", "forest", "birding", "debrigarh", "safari", "eco tourism"),
    "wildlife sanctuary": ("wildlife", "sanctuary", "national park", "nature reserve", "forest", "birding", "debrigarh", "safari", "eco tourism"),
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
                planner_engine VARCHAR(120) NOT NULL DEFAULT 'legacy saved plan',
                budget_currency VARCHAR(3) NOT NULL DEFAULT 'INR',
                budget_input_amount REAL NOT NULL DEFAULT 0,
                budget_exchange_rate REAL
            )
            """
        )
        columns = {row[1] for row in connection.execute("PRAGMA table_info(trips)").fetchall()}
        # Existing SQLAlchemy-generated databases predate this optional column.
        if "planner_engine" not in columns:
            connection.execute(
                "ALTER TABLE trips ADD COLUMN planner_engine VARCHAR(120) NOT NULL DEFAULT 'legacy saved plan'"
            )
        if "budget_currency" not in columns:
            connection.execute("ALTER TABLE trips ADD COLUMN budget_currency VARCHAR(3) NOT NULL DEFAULT 'INR'")
        if "budget_input_amount" not in columns:
            connection.execute("ALTER TABLE trips ADD COLUMN budget_input_amount REAL NOT NULL DEFAULT 0")
        if "budget_exchange_rate" not in columns:
            connection.execute("ALTER TABLE trips ADD COLUMN budget_exchange_rate REAL")
        connection.execute("CREATE INDEX IF NOT EXISTS ix_trips_created_at ON trips (created_at)")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS exploration_routes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                destination VARCHAR(160) NOT NULL,
                interests JSON NOT NULL,
                transport VARCHAR(80) NOT NULL,
                route_data JSON NOT NULL,
                created_at DATETIME NOT NULL
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS ix_exploration_routes_created_at ON exploration_routes (created_at)")
        connection.commit()
    finally:
        connection.close()


def _get_usd_inr_rate() -> dict[str, Any]:
    """Return a cached daily USD→INR reference rate; no key or Google billing needed."""
    now = time.time()
    cached_rate = _USD_INR_CACHE.get("rate")
    cached_at = float(_USD_INR_CACHE.get("fetched_at") or 0.0)
    if cached_rate and now - cached_at < USD_INR_CACHE_SECONDS:
        return {"rate": float(cached_rate), "updated_at": _USD_INR_CACHE.get("updated_at"), "source": "ExchangeRate-API"}

    try:
        response = requests.get(
            "https://open.er-api.com/v6/latest/USD",
            headers=_service_headers(),
            timeout=(3, 7),
        )
        response.raise_for_status()
        payload = response.json()
        rates = payload.get("rates") if isinstance(payload, dict) else None
        rate = float((rates or {}).get("INR", 0))
        if not isinstance(payload, dict) or payload.get("result") != "success" or rate <= 0 or not math.isfinite(rate):
            raise ValueError("Currency endpoint did not provide a valid INR rate")
        _USD_INR_CACHE.update({"rate": rate, "updated_at": payload.get("time_last_update_utc"), "fetched_at": now})
        return {"rate": rate, "updated_at": payload.get("time_last_update_utc"), "source": "ExchangeRate-API"}
    except (requests.RequestException, ValueError, TypeError) as error:
        # An optional administrator-configured rate lets a developer keep USD input
        # usable when the public daily rate endpoint is temporarily unavailable.
        fallback = os.getenv("USD_INR_RATE", "").strip()
        try:
            fallback_rate = float(fallback) if fallback else 0.0
        except ValueError:
            fallback_rate = 0.0
        if cached_rate and float(cached_rate) > 0:
            current_app.logger.warning("Using the previously cached USD/INR rate after refresh failure (%s).", type(error).__name__)
            return {"rate": float(cached_rate), "updated_at": _USD_INR_CACHE.get("updated_at"), "source": "ExchangeRate-API (cached)"}
        if fallback_rate > 0 and math.isfinite(fallback_rate):
            current_app.logger.warning("Using USD_INR_RATE from backend/.env because the public exchange-rate endpoint failed.")
            return {"rate": fallback_rate, "updated_at": "configured fallback rate", "source": "backend configuration"}
        raise ApiProblem(
            "The USD/INR reference rate is temporarily unavailable. Try INR or retry in a moment.",
            503, "exchange_rate_unavailable",
        ) from error


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
    budget_currency = str(payload.get("budget_currency", "INR")).upper().strip()
    if budget_currency not in {"INR", "USD"}:
        errors["budget_currency"] = "Budget currency must be INR or USD."
    if not isinstance(budget, (int, float)) or isinstance(budget, bool) or not math.isfinite(float(budget)) or budget <= 0:
        errors["budget"] = "Enter a positive budget amount."
    elif budget_currency == "INR" and not 500 <= budget <= MAX_BUDGET_INR:
        errors["budget"] = f"INR budget must be between ₹500 and ₹{MAX_BUDGET_INR:,}."
    elif budget_currency == "USD" and not 1 <= budget <= 10000:
        errors["budget"] = "USD budget must be between $1 and $10,000; the INR equivalent will be checked before planning."

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
        # Internal planning and cost estimation use INR. The original entered
        # amount/currency are preserved separately for form restoration/display.
        "budget": int(round(budget)) if budget_currency == "INR" else 0,
        "budget_currency": budget_currency,
        "budget_input_amount": round(float(budget), 2),
        "budget_exchange_rate": None,
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




def _geoapify_key() -> str:
    return _require_env("GEOAPIFY_API_KEY", "resolve the destination and Gemma-recommended place coordinates")


def _geoapify_geocode(text: str, api_key: str, center: tuple[float, float] | None = None,
                      radius_km: float | None = None, limit: int = 5) -> list[dict[str, Any]]:
    """Geocode text only; Geoapify is not used to choose or recommend attractions."""
    params: dict[str, Any] = {"text": text, "format": "json", "apiKey": api_key, "limit": limit, "lang": "en"}
    if center:
        lat, lng = center
        params["bias"] = f"proximity:{lng},{lat}"
        if radius_km:
            params["filter"] = f"circle:{lng},{lat},{int(radius_km * 1000)}"
    response = None
    last_network_error: Exception | None = None
    for attempt in range(2):
        try:
            response = requests.get(GEOAPIFY_GEOCODE_URL, params=params, headers=_service_headers(), timeout=(5, 15))
            if response.status_code < 500 or attempt == 1:
                break
            current_app.logger.warning("Geoapify geocoding returned HTTP %s; retrying once.", response.status_code)
        except requests.RequestException as error:
            last_network_error = error
            if attempt == 0:
                current_app.logger.warning("Geoapify geocoding request failed (%s); retrying once.", type(error).__name__)
                time.sleep(0.8)
                continue
            current_app.logger.warning("Geoapify geocoding request failed after retry (%s).", type(error).__name__)
            raise ApiProblem("Place coordinates could not be resolved because the geocoding request failed twice. Please retry.", 503, "geocoding_network_error") from error
    if response is None:
        raise ApiProblem("Geoapify did not return a response. Please retry.", 503, "geocoding_network_error") from last_network_error
    if response.status_code == 429:
        raise ApiProblem("Geoapify geocoding quota was reached. Check your Geoapify dashboard and retry later.", 503, "geocoding_quota_exceeded")
    if response.status_code in (401, 403):
        current_app.logger.warning("Geoapify rejected the configured API key (HTTP %s).", response.status_code)
        raise ApiProblem("Geoapify rejected the API key. Check GEOAPIFY_API_KEY and the key's permissions.", 503, "geocoding_provider_error")
    if not response.ok:
        current_app.logger.warning("Geoapify geocoding returned HTTP %s.", response.status_code)
        if response.status_code >= 500:
            raise ApiProblem("Geoapify geocoding is temporarily unavailable. Please retry.", 503, "geocoding_server_error")
        raise ApiProblem("Geoapify rejected the geocoding request. Check the request parameters and API quota.", 503, "geocoding_provider_error")
    try:
        payload = response.json()
    except ValueError as error:
        raise ApiProblem("Geoapify returned an unreadable geocoding response.", 502, "geocoding_invalid_response") from error
    results = payload.get("results", []) if isinstance(payload, dict) else []
    return [item for item in results if isinstance(item, dict)] if isinstance(results, list) else []


def _geo_result_coordinates(result: dict[str, Any]) -> tuple[float, float] | None:
    try:
        lat, lng = float(result["lat"]), float(result["lon"])
    except (KeyError, TypeError, ValueError):
        return None
    if not (-90 <= lat <= 90 and -180 <= lng <= 180):
        return None
    return lat, lng


def _normalise_geo_label(label: str, result: dict[str, Any] | None = None) -> str:
    """Make Geoapify's abbreviated Odisha state label readable and unambiguous."""
    value = re.sub(r"\s+", " ", str(label or "")).strip()
    result = result or {}
    country = str(result.get("country") or "").strip().casefold()
    country_code = str(result.get("country_code") or "").strip().casefold()
    state = str(result.get("state") or "").strip().casefold()
    state_code = str(result.get("state_code") or "").strip().casefold()
    is_india = country == "india" or country_code == "in" or bool(re.search(r",\s*India\s*$", value, re.IGNORECASE))
    is_odisha = state in {"or", "odisha", "orissa"} or state_code in {"in-or", "or"}
    if is_india and (is_odisha or re.search(r",\s*(?:OR|Orissa)\s*,\s*India\s*$", value, re.IGNORECASE)):
        value = re.sub(r",\s*(?:OR|Orissa)\s*,\s*India\s*$", ", Odisha, India", value, flags=re.IGNORECASE)
    return value


def _query_mentions_india(query: str) -> bool:
    return bool(re.search(r"\bIndia\b", query, re.IGNORECASE))


def _result_matches_explicit_country(result: dict[str, Any], query: str) -> bool:
    """Do not let a global geocoder silently resolve an explicitly Indian destination elsewhere."""
    if not _query_mentions_india(query):
        return True
    country = str(result.get("country") or "").strip().casefold()
    country_code = str(result.get("country_code") or "").strip().casefold()
    formatted = str(result.get("formatted") or "").strip().casefold()
    if country:
        return country == "india"
    if country_code:
        return country_code == "in"
    return formatted.endswith(", india") or formatted == "india"


def _distance_km(a_lat: float, a_lng: float, b_lat: float, b_lng: float) -> float:
    radius_km = 6371.0088
    phi1, phi2 = math.radians(a_lat), math.radians(b_lat)
    d_phi = math.radians(b_lat - a_lat)
    d_lam = math.radians(b_lng - a_lng)
    h = math.sin(d_phi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(d_lam / 2) ** 2
    return 2 * radius_km * math.asin(min(1.0, math.sqrt(h)))


def _geocode_destination(destination: str, api_key: str) -> tuple[float, float, str]:
    """Resolve a destination, including nearby-area inputs such as 'Sambalpur/Burla'."""
    # Geoapify may abbreviate Odisha as "OR". In a country-qualified Indian
    # destination, that means Odisha (formerly Orissa), not Oregon, USA.
    destination = re.sub(r",\s*OR\s*,\s*India\s*$", ", Odisha, India", destination, flags=re.IGNORECASE).strip()
    parts = [part.strip() for part in destination.split("/") if part.strip()]
    if len(parts) > 1:
        suffix = next((part[part.find(",") + 1:].strip() for part in reversed(parts) if "," in part), "")
        if not suffix and any(term in destination.casefold() for term in ("sambalpur", "burla", "hirakud")):
            suffix = "Odisha, India"
        queries = [part if ("," in part or not suffix) else f"{part}, {suffix}" for part in parts]
    else:
        queries = [destination]

    resolved: list[dict[str, Any]] = []
    seen: set[tuple[float, float]] = set()
    for query in queries:
        results = _geoapify_geocode(query, api_key, limit=5)
        # Only retain the highest-ranked valid match for each typed locality.
        for result in results:
            if not _result_matches_explicit_country(result, query):
                current_app.logger.warning(
                    "Discarding geocoder result outside the explicitly requested country for %r.", query[:100]
                )
                continue
            coords = _geo_result_coordinates(result)
            if not coords:
                continue
            key = (round(coords[0], 4), round(coords[1], 4))
            if key not in seen:
                seen.add(key)
                resolved.append({"latitude": coords[0], "longitude": coords[1],
                                 "formatted": _normalise_geo_label(str(result.get("formatted") or query), result),
                                 "result_type": str(result.get("result_type") or "location"),
                                 "name": str(result.get("name") or "")})
            break
        if len(parts) == 1 and resolved:
            break

    if not resolved:
        raise ApiProblem(f"We couldn't identify '{destination}'. Add the state/country or choose a more specific destination.", 422, "destination_not_found")
    if len(parts) > 1 and len(resolved) > 1:
        first = resolved[0]
        nearby = [p for p in resolved if _distance_km(first["latitude"], first["longitude"], p["latitude"], p["longitude"]) <= 90]
        if len(nearby) > 1:
            lat = sum(p["latitude"] for p in nearby) / len(nearby)
            lng = sum(p["longitude"] for p in nearby) / len(nearby)
            names: list[str] = []
            for p in nearby:
                short = p["formatted"].split(",")[0].strip()
                if short and short.casefold() not in {n.casefold() for n in names}:
                    names.append(short)
            suffix = next((part[part.find(",") + 1:].strip() for part in reversed(parts) if "," in part), "")
            if not suffix and any(term in destination.casefold() for term in ("sambalpur", "burla", "hirakud")):
                suffix = "Odisha, India"
            return lat, lng, " / ".join(names) + (f", {suffix}" if suffix else "")
    best = resolved[0]
    return best["latitude"], best["longitude"], best["formatted"]


def _generate_gemma_place_recommendations(
    plan: dict[str, Any],
    resolved_destination: str,
    *,
    broaden_to_popular: bool = False,
    exclude_names: list[str] | None = None,
) -> list[dict[str, str]]:
    """Gemma is the recommender. In fallback mode, broaden to popular local sights matching interests."""
    count = 16 if broaden_to_popular else min(20, max(10, plan["duration"] * 4 + len(plan["interests"])))
    schema = {
        "type": "OBJECT", "required": ["places"],
        "properties": {"places": {"type": "ARRAY", "items": {"type": "OBJECT",
            "required": ["name", "category", "reason", "area"],
            "properties": {"name": {"type": "STRING"}, "category": {"type": "STRING"},
                           "reason": {"type": "STRING"}, "area": {"type": "STRING"}}}}}
    }
    interests = json.dumps(plan["interests"], ensure_ascii=False)
    exclusions = json.dumps((exclude_names or [])[:24], ensure_ascii=False)
    if broaden_to_popular:
        local_wildlife_hint = " For the Hirakud / Sambalpur / Burla area specifically, include Debrigarh Wildlife Sanctuary as one candidate because the user asked to see local wildlife options, even if the other selected interests are primary; Geoapify must still verify the name and coordinates within 100 km before the UI shows it. Also consider other real wildlife/nature destinations in range." if any(term in resolved_destination.casefold() for term in ("hirakud", "sambalpur", "burla")) else " Include wildlife sanctuaries, national parks, forest reserves and birding destinations where they genuinely exist within range; the geocoder must verify each name before it is shown."
        task = f"""FALLBACK / OTHER PLACES TO EXPLORE MODE: the first recommendation pass did not produce enough places that could be mapped, or the user requested optional nearby places. Broaden the search to well-known and popular tourist attractions, landmarks, public visitor areas, scenic viewpoints, parks, markets, heritage sites, temples, beaches, activity areas, wildlife sanctuaries, national parks, nature reserves, forest/wetland destinations, birding areas, eco-tourism sites and other genuinely visitable locations in or near {resolved_destination}. Use the selected interests as strong preferences: {interests}. Cover different selected interests where real options exist, rather than returning only one category. Include established nearby attractions within a practical day trip (up to approximately 100 km) if the destination itself has few mapped sites. Prioritize selected interests but also provide a few popular regional alternatives so the list remains useful when the destination has sparse listings.{local_wildlife_hint} Prefer commonly known places with stable names/geographic identities that a geocoder can resolve. Do not invent businesses, operator names, opening status, ratings, prices, or current activity availability. Avoid these names already considered: {exclusions}. Return enough distinct alternatives to build multi-stop routes, ideally at least 12 valid places if you genuinely know them. Do not pad with made-up places."""
    else:
        task = f"""Recommend {count} real, specific visitor places or activity locations for a trip. Return actual named attractions, landmarks, activity hubs/operators, nature sites, heritage sites, and other visitor locations that fit the interests. Use local knowledge to recommend places specifically in or around this destination, and include nearby towns only when genuinely practical. For water sports around Sambalpur/Burla/Hirakud, explicitly consider Hirakud Dam, Zero Point, the Right Dyke/Silat Road area, boat rides, boating and water-sports operators/launch points if known there. If the user selected \"Popular / hot\", prioritize widely recognized, iconic, frequently recommended must-visit places, not an unverified claim about today's live trends. Do not recommend places in unrelated cities or countries. Avoid generic filler and duplicates. Prefer well-known real places. Never invent exact addresses, coordinates, place IDs, opening hours, ratings, prices, or live availability. If a niche operator name is uncertain, recommend a recognizable public access point or visitor area and say the activity/operator needs confirmation. Do not claim water sports operate today."""

    prompt = f"""{task}
Destination: {resolved_destination}
User's original destination text: {plan['destination']}
Selected interests (all must guide relevance): {interests}
Trip duration: {plan['duration']} days
Total entered budget: {plan['budget_input_amount']} {plan.get('budget_currency', 'INR')} (internal comparison equivalent: INR {plan['budget']})
Transport preference: {plan['transport']}

For each place, return:
- name: the exact known name (or a specific named public area/access point if that is the genuine recommendation)
- category: short category such as Water sports, Boating, Landmark, Park, Museum, Temple, Viewpoint, Beach, Market
- reason: short explanation of why it fits the selected interests
- area: local neighbourhood/road/town name that helps resolve it geographically

Only use locations that are genuinely in or reasonably near the named destination. Never invent exact addresses, coordinates or activity availability. Return JSON only: {{"places":[{{"name":"...","category":"...","reason":"...","area":"..."}}]}}."""
    response = _call_gemma_json(prompt, schema, "popular-place fallback" if broaden_to_popular else "place recommendations", max_tokens=3000 if broaden_to_popular else 2400)
    raw_places = response.get("places", [])
    if not isinstance(raw_places, list):
        raise ApiProblem("Gemma did not return a valid place recommendation list. Please retry.", 502, "gemma_invalid_response")
    places: list[dict[str, str]] = []
    seen: set[str] = set()
    excluded = {_normal_name(x) for x in (exclude_names or [])}
    for item in raw_places:
        if not isinstance(item, dict):
            continue
        name = re.sub(r"\s+", " ", str(item.get("name") or "")).strip(" \t\r\n\"'`.-")
        normalized_name = _normal_name(name)
        if not name or len(name) > 140 or normalized_name in seen or (broaden_to_popular and normalized_name in excluded):
            continue
        seen.add(normalized_name)
        places.append({
            "name": name,
            "category": str(item.get("category") or "Point of interest").strip()[:80],
            "reason": str(item.get("reason") or "Suggested by Gemma for the selected interests.").strip()[:450],
            "area": str(item.get("area") or resolved_destination).strip()[:120],
        })
        if len(places) >= 24:
            break
    if not places:
        raise ApiProblem("Gemma did not return any usable place recommendations. Please retry.", 502, "gemma_no_place_recommendations")
    return places


def _normal_name(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", value.casefold()).strip()


def _name_match_score(wanted: str, result: dict[str, Any]) -> float:
    """Check that geocoding resolved the recommended name, not just the city centre."""
    from difflib import SequenceMatcher
    candidates = [str(result.get("name") or ""), str(result.get("address_line1") or ""),
                  str(result.get("formatted") or "").split(",")[0]]
    target = _normal_name(wanted)
    wanted_tokens = set(target.split())
    best = 0.0
    for value in candidates:
        normalized = _normal_name(value)
        if not normalized:
            continue
        if normalized == target:
            return 1.0
        result_tokens = set(normalized.split())
        overlap = len(wanted_tokens & result_tokens) / max(1, len(wanted_tokens))
        best = max(best, SequenceMatcher(None, target, normalized).ratio(), overlap)
    return best


def _resolve_gemma_recommendations(
    recommendations: list[dict[str, str]], plan: dict[str, Any], resolved_destination: str,
    latitude: float, longitude: float, api_key: str, by_id: dict[str, dict[str, Any]],
    radius_km: float = 50.0,
) -> tuple[list[str], int]:
    """Resolve model-chosen names, rejecting weak matches and locations outside the requested radius."""
    unmapped: list[str] = []
    geocoding_failures = 0
    consecutive_geocoding_failures = 0
    for recommendation in recommendations:
        query_parts = [recommendation["name"]]
        if recommendation["area"] and _normal_name(recommendation["area"]) not in _normal_name(recommendation["name"]):
            query_parts.append(recommendation["area"])
        query_parts.append(resolved_destination)
        primary_query = ", ".join(part for part in query_parts if part)
        fallback_query = ", ".join(part for part in [recommendation["name"], resolved_destination] if part)
        lookup_queries = list(dict.fromkeys([primary_query, fallback_query, recommendation["name"]]))
        scored: list[tuple[float, float, dict[str, Any], tuple[float, float]]] = []

        for query_index, query in enumerate(lookup_queries):
            try:
                results = _geoapify_geocode(query, api_key, center=(latitude, longitude), radius_km=radius_km, limit=5)
                consecutive_geocoding_failures = 0
            except ApiProblem as error:
                if error.code in {"geocoding_provider_error", "geocoding_quota_exceeded"}:
                    raise
                geocoding_failures += 1
                consecutive_geocoding_failures += 1
                current_app.logger.warning(
                    "Skipping coordinate lookup variant %d for %r after temporary geocoding failure (code=%s).",
                    query_index + 1, recommendation["name"][:100], error.code,
                )
                if consecutive_geocoding_failures >= 3 and not by_id:
                    raise ApiProblem(
                        "Geoapify is repeatedly failing to resolve recommended places. Check your connection and retry.",
                        503, "geocoding_temporarily_unavailable",
                    ) from error
                continue

            for result in results:
                if not _result_matches_explicit_country(result, query):
                    continue
                coords = _geo_result_coordinates(result)
                if not coords:
                    continue
                distance = _distance_km(latitude, longitude, coords[0], coords[1])
                if distance > radius_km:
                    continue
                score = _name_match_score(recommendation["name"], result)
                if score < 0.48:
                    continue
                scored.append((score, distance, result, coords))
            if scored:
                break

        if not scored:
            unmapped.append(recommendation["name"])
            current_app.logger.info("Could not verify coordinates for Gemma recommendation %r after %d query variant(s).", recommendation["name"][:100], len(lookup_queries))
            continue

        scored.sort(key=lambda entry: (-entry[0], entry[1]))
        score, distance, result, coords = scored[0]
        lat, lng = coords
        if any(_distance_km(lat, lng, float(p["latitude"]), float(p["longitude"])) < 0.08 for p in by_id.values()):
            continue
        place_id = "gemma-" + hashlib.sha1(f"{recommendation['name'].casefold()}|{lat:.5f}|{lng:.5f}".encode("utf-8")).hexdigest()[:16]
        formatted = _normalise_geo_label(str(result.get("formatted") or f"{recommendation['name']}, {resolved_destination}"), result)
        map_url = f"https://www.openstreetmap.org/?mlat={lat:.6f}&mlon={lng:.6f}#map=16/{lat:.6f}/{lng:.6f}"
        by_id[place_id] = {
            "id": place_id, "place_id": place_id, "name": recommendation["name"],
            "description": recommendation["reason"], "category": recommendation["category"],
            "categories": [recommendation["category"]], "types": [recommendation["category"]],
            "address": formatted, "latitude": lat, "longitude": lng,
            "rating": None, "maps_url": map_url, "map_url": map_url,
            "provider": "Gemma recommendation; Geoapify geocoding; OpenStreetMap map",
            "distance_from_destination_km": round(distance, 2),
            "matched_queries": [", ".join(plan["interests"]) or "general sightseeing"],
            "entry_fee_known": False, "estimated_entry_fee_per_person": 0,
            "visit_duration_minutes": 90, "visit_duration_is_estimate": True,
            "costs_are_estimates": True,
            "planning_notes": "Gemma suggested this location. Coordinates were resolved by geocoding; verify the venue, activity availability, opening hours and prices before travelling.",
            "recommendation_reason": recommendation["reason"],
            "coordinate_match_score": round(score, 2),
        }
    return unmapped, geocoding_failures


def _resolve_gemma_recommendations_parallel(
    recommendations: list[dict[str, str]], plan: dict[str, Any], resolved_destination: str,
    latitude: float, longitude: float, api_key: str, max_workers: int = 4,
) -> tuple[list[str], int, dict[str, dict[str, Any]]]:
    """Resolve independent recommendation names concurrently, preserving model order.

    Each worker gets its own Flask application context and result dictionary. Results
    are merged in the original recommendation order so the route planner remains
    deterministic and duplicate locations are discarded safely.
    """
    app = current_app._get_current_object()

    def resolve_one(recommendation: dict[str, str]):
        with app.app_context():
            local_by_id: dict[str, dict[str, Any]] = {}
            unmapped, failures = _resolve_gemma_recommendations(
                [recommendation], plan, resolved_destination, latitude, longitude,
                api_key, local_by_id,
            )
            return unmapped, failures, local_by_id

    if len(recommendations) <= 1:
        results = [resolve_one(item) for item in recommendations]
    else:
        # Four concurrent lookups speeds up the usual 10-place pass without
        # flooding Geoapify with a large burst of requests.
        with ThreadPoolExecutor(max_workers=min(max_workers, len(recommendations))) as pool:
            results = list(pool.map(resolve_one, recommendations))

    unmapped: list[str] = []
    failures = 0
    merged: dict[str, dict[str, Any]] = {}
    for missing, failed_count, local_places in results:
        unmapped.extend(missing)
        failures += failed_count
        for place in local_places.values():
            lat, lng = float(place["latitude"]), float(place["longitude"])
            if any(_distance_km(lat, lng, float(existing["latitude"]), float(existing["longitude"])) < 0.08
                   for existing in merged.values()):
                continue
            merged[str(place["id"])] = place
    return unmapped, failures, merged


def _discover_gemma_places(plan: dict[str, Any]) -> tuple[list[dict[str, Any]], str, dict[str, float]]:
    """Gemma recommends attractions; if too few can be mapped, ask it for broader popular local options."""
    api_key = _geoapify_key()
    latitude, longitude, resolved_destination = _geocode_destination(plan["destination"], api_key)
    recommendations = _generate_gemma_place_recommendations(plan, resolved_destination)
    current_app.logger.info("Gemma proposed %d named locations for %r; resolving their coordinates.", len(recommendations), resolved_destination)
    by_id: dict[str, dict[str, Any]] = {}
    geocode_started = time.perf_counter()
    unmapped, geocoding_failures, by_id = _resolve_gemma_recommendations_parallel(
        recommendations, plan, resolved_destination, latitude, longitude, api_key
    )
    current_app.logger.info(
        "Initial recommendation geocoding finished in %.2fs (%d/%d mapped).",
        time.perf_counter() - geocode_started, len(by_id), len(recommendations),
    )

    # For destinations where the first pass maps only a handful of names, run one
    # broader recommendation pass before planning. This is still Gemma choosing
    # places; Geoapify is used only to verify/map the names. More stops make road
    # paths useful (at least two stops per day where enough real places exist).
    target_count = min(MAX_CANDIDATES_FOR_ROUTING, max(4, plan["duration"] * 2))
    if len(by_id) < target_count:
        current_app.logger.warning(
            "Only %d places mapped near %r (target %d); requesting Gemma's popular-local-attractions fallback.",
            len(by_id), resolved_destination, target_count,
        )
        try:
            fallback_recommendations = _generate_gemma_place_recommendations(
                plan, resolved_destination, broaden_to_popular=True,
                exclude_names=[item["name"] for item in recommendations] + [place["name"] for place in by_id.values()],
            )
            fallback_started = time.perf_counter()
            fallback_unmapped, fallback_failures, fallback_places = _resolve_gemma_recommendations_parallel(
                fallback_recommendations, plan, resolved_destination, latitude, longitude, api_key
            )
            for place in fallback_places.values():
                lat, lng = float(place["latitude"]), float(place["longitude"])
                if any(_distance_km(lat, lng, float(existing["latitude"]), float(existing["longitude"])) < 0.08
                       for existing in by_id.values()):
                    continue
                by_id[str(place["id"])] = place
            unmapped.extend(fallback_unmapped)
            geocoding_failures += fallback_failures
            current_app.logger.info(
                "Fallback recommendation geocoding finished in %.2fs (%d additional mapped).",
                time.perf_counter() - fallback_started, len(fallback_places),
            )
        except ApiProblem as error:
            # If the first pass already returned verified places, do not discard the
            # usable trip just because the optional fallback model call failed.
            if not by_id:
                raise
            current_app.logger.warning("Popular-place fallback did not complete (code=%s); keeping %d verified original/fallback places.", error.code, len(by_id))

    current_app.logger.info(
        "Resolved %d Gemma recommendations near %r; %d names could not be mapped; %d geocoding attempts failed temporarily.",
        len(by_id), resolved_destination, len(unmapped), geocoding_failures,
    )
    if len(by_id) < 1:
        if geocoding_failures:
            raise ApiProblem(
                "Geoapify could not resolve Gemma's recommended places because geocoding requests failed or timed out. Please retry.",
                503, "geocoding_temporarily_unavailable",
            )
        missing = ", ".join(unmapped[:5])
        note = f" Unmapped model suggestions: {missing}." if missing else ""
        raise ApiProblem(f"Gemma suggested places, but none could be verified on the map near {resolved_destination}. Try a more specific destination or review the suggested names.{note}", 422, "not_enough_mappable_gemma_places")
    return _rank_places(list(by_id.values()), plan["interests"]), resolved_destination, {"latitude": latitude, "longitude": longitude}


INTEREST_TERMS: dict[str, tuple[str, ...]] = {
    "nature": ("nature", "wildlife", "sanctuary", "bird sanctuary", "birding", "national park", "nature reserve", "forest reserve", "eco-tourism", "ecotourism", "park", "garden", "forest", "mountain", "waterfall", "lake", "trail", "scenic", "dam", "reservoir"),
    "history": ("history", "historical", "museum", "monument", "fort", "palace", "landmark", "heritage", "memorial", "tower"),
    "temples": ("temple", "shrine", "worship", "religious", "church", "mosque", "monastery", "pagoda"),
    "beaches": ("beach", "coast", "seaside", "waterfront", "island", "bay"),
    "local food": ("food", "restaurant", "market", "cafe", "café", "bakery", "street food", "food court"),
    "adventure": ("adventure", "water sports", "watersport", "boating", "boat", "kayak", "jet ski", "rafting", "hiking", "climbing", "outdoor", "ski", "trail", "amusement", "operator"),
    "photography": ("viewpoint", "scenic", "lookout", "landmark", "garden", "skyline", "waterfront", "tower"),
    "popular / hot": ("famous", "iconic", "well known", "well-known", "must-see", "must see", "top attraction", "hotspot", "hot spot"),
    "hidden gems": ("local", "village", "craft", "neighbourhood", "neighborhood", "market", "art district"),
}


def _call_gemma_json(prompt: str, response_schema: dict[str, Any], purpose: str, max_tokens: int = 2400) -> dict[str, Any]:
    """Call hosted Gemma with structured output and a second-model fallback.

    Do not fall back to plain-text mode: this project's tested Gemma endpoint can
    fail on plain generation while succeeding with response_schema. For HTTP 5xx
    failures, retry briefly then try the other Gemma 4 model with the same schema.
    """
    api_key = _require_env("GEMMA_API_KEY", "generate a travel plan")
    primary = os.getenv("GEMMA_MODEL", "gemma-4-31b-it").strip() or "gemma-4-31b-it"
    configured_fallback = os.getenv("GEMMA_FALLBACK_MODEL", "").strip()
    known_gemma_models = ["gemma-4-31b-it", "gemma-4-26b-a4b-it"]
    model_names: list[str] = []
    for name in [primary, configured_fallback, *known_gemma_models]:
        if name and name not in model_names:
            model_names.append(name)

    client = genai.Client(api_key=api_key)
    system_instruction = (
        "You are a precise RoamWise travel-planning component. Follow the requested JSON schema. "
        "Never invent real-world place records. Return one JSON object matching the schema."
    )
    last_error: Exception | None = None

    for model_index, model_name in enumerate(model_names):
        request_prompt = prompt
        format_retry_used = False
        transient_retries = 0
        max_transient_retries = 2 if model_index == 0 else 1
        while True:
            try:
                response = client.models.generate_content(
                    model=model_name,
                    contents=request_prompt,
                    config=types.GenerateContentConfig(
                        system_instruction=system_instruction,
                        temperature=0.1 if purpose == "search-query generation" else 0.0,
                        max_output_tokens=max_tokens,
                        response_mime_type="application/json",
                        response_schema=response_schema,
                        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
                    ),
                )
                output = _gemma_response_text(response)
                try:
                    parsed = _parse_model_json(output)
                    if model_name != primary:
                        current_app.logger.warning(
                            "Gemma %s succeeded using fallback model=%s (primary=%s).", purpose, model_name, primary
                        )
                    return parsed
                except (ValueError, json.JSONDecodeError) as error:
                    last_error = error
                    if not format_retry_used:
                        format_retry_used = True
                        request_prompt = prompt + (
                            "\n\nRETRY: Return a complete JSON object that exactly follows the supplied response schema. "
                            "No markdown or prose. Keep the response concise and do not add extra fields."
                        )
                        current_app.logger.warning(
                            "Gemma %s JSON could not be parsed (model=%s); retrying once with structured output enabled.",
                            purpose, model_name,
                        )
                        continue
                    break
            except Exception as error:
                last_error = error
                message = str(error).lower()
                raw_status = getattr(error, "code", None) or getattr(error, "status_code", None)
                try:
                    status_code = int(raw_status) if raw_status is not None and not callable(raw_status) else None
                except (TypeError, ValueError):
                    status_code = None

                transient = status_code in (408, 429, 500, 502, 503, 504) or any(
                    marker in message for marker in (
                        "internal server error", "service unavailable", "resource_exhausted",
                        "too many requests", "timed out", "timeout", "connection reset",
                    )
                )
                # Don't waste requests on permanent credential/permission failures.
                if status_code in (401, 403):
                    break
                if transient and transient_retries < max_transient_retries:
                    delay = 1.5 * (2 ** transient_retries)
                    transient_retries += 1
                    current_app.logger.warning(
                        "Gemma %s call failed transiently (model=%s, status=%s); retry %d/%d in %.1fs.",
                        purpose, model_name, status_code or type(error).__name__,
                        transient_retries, max_transient_retries, delay,
                    )
                    time.sleep(delay)
                    continue
                # Any server-side failure moves to the next supported Gemma model.
                break

        if model_index < len(model_names) - 1:
            current_app.logger.warning(
                "Gemma %s failed with model=%s; trying fallback model=%s with structured output.",
                purpose, model_name, model_names[model_index + 1],
            )

    if isinstance(last_error, (ValueError, json.JSONDecodeError)):
        current_app.logger.error("Gemma %s returned invalid structured JSON across available models.", purpose)
        raise ApiProblem(
            f"Gemma returned invalid structured JSON for {purpose}. Please retry.",
            502, "gemma_invalid_response",
        ) from last_error

    raw_status = getattr(last_error, "code", None) or getattr(last_error, "status_code", None)
    current_app.logger.error(
        "Gemma %s failed across configured models=%s (last_status=%s, error_type=%s).",
        purpose, ",".join(model_names), raw_status or "unknown",
        type(last_error).__name__ if last_error else "unknown",
    )
    raise ApiProblem(
        f"Gemma could not complete {purpose} using any configured Gemma model. "
        "The hosted model API returned repeated errors; wait briefly and retry, or check Google AI Studio service health.",
        503, "gemma_unavailable",
    ) from last_error


def _rank_places(places: list[dict[str, Any]], interests: list[str]) -> list[dict[str, Any]]:
    def score(place: dict[str, Any]) -> tuple[float, float, str]:
        searchable = " ".join(
            [str(place.get(key) or "") for key in ("name", "category", "address")] +
            [str(value) for value in (place.get("categories") or [])] +
            [str(value) for value in (place.get("matched_queries") or [])]
        ).casefold()
        match_score = len(place.get("matched_queries") or []) * 8
        for interest in interests:
            terms = INTEREST_TERMS.get(interest.casefold(), (interest.casefold(),))
            match_score += sum(1 for term in terms if term in searchable)
        distance = float(place.get("distance_from_destination_km") or 0.0)
        return (-match_score, distance, str(place.get("name", "")).casefold())
    return sorted(places, key=score)





def _route_mode(transport: str) -> str:
    if transport == "Walking":
        return "WALK"
    if transport == "Public transport":
        return "TRANSIT"
    return "DRIVE"


def _approximate_minutes(distance_km: float, mode: str) -> int:
    speed = {"WALK": 4.5, "TRANSIT": 20.0, "DRIVE": 25.0}.get(mode, 25.0)
    return max(1, int(round((distance_km / speed) * 60 + 4)))


def _routing_base(transport: str) -> tuple[str, str]:
    if transport == "Walking":
        return OSRM_FOOT_BASE.rstrip("/"), "walking"
    if transport == "Public transport":
        return "", "public transport"
    return OSRM_CAR_BASE.rstrip("/"), "driving"


def _osrm_get(url: str, params: dict[str, Any], timeout: tuple[int, int]) -> requests.Response:
    """Throttled helper for community OSRM servers; no API key or billing required."""
    global _OSRM_LAST_REQUEST_FINISHED
    with _OSRM_REQUEST_LOCK:
        wait = 1.05 - (time.monotonic() - _OSRM_LAST_REQUEST_FINISHED)
        if _OSRM_LAST_REQUEST_FINISHED and wait > 0:
            time.sleep(wait)
        response = requests.get(url, params=params, headers=_service_headers(), timeout=timeout)
        _OSRM_LAST_REQUEST_FINISHED = time.monotonic()
        return response


def _compute_route_matrix(places: list[dict[str, Any]], transport: str) -> tuple[dict[str, dict[str, dict[str, Any]]], str]:
    """Use an OpenStreetMap OSRM table when supported, otherwise labelled estimates."""
    size = len(places)
    matrix: dict[str, dict[str, dict[str, Any]]] = {str(p["id"]): {} for p in places}
    base, mode_label = _routing_base(transport)
    source = "straight-line estimates (public-transit routing is not configured)" if not base else f"OpenStreetMap OSRM {mode_label} routes"
    if size == 0:
        return matrix, source
    if base and size >= 2:
        coords = ";".join(f"{float(p['longitude'])},{float(p['latitude'])}" for p in places)
        try:
            response = _osrm_get(f"{base}/table/v1/driving/{coords}", params={"annotations": "duration,distance"}, timeout=(2, 8))
            if response.ok:
                payload = response.json()
                durations = payload.get("durations") if isinstance(payload, dict) else None
                distances = payload.get("distances") if isinstance(payload, dict) else None
                if isinstance(durations, list) and len(durations) == size:
                    for i, origin in enumerate(places):
                        oid = str(origin["id"])
                        row_d = durations[i] if isinstance(durations[i], list) else []
                        row_k = distances[i] if isinstance(distances, list) and i < len(distances) and isinstance(distances[i], list) else []
                        for j, target in enumerate(places):
                            did = str(target["id"])
                            dseconds = row_d[j] if j < len(row_d) else None
                            dm = row_k[j] if j < len(row_k) else None
                            if i == j:
                                matrix[oid][did] = {"minutes": 0, "distance_km": 0.0, "source": source}
                            elif dseconds is not None:
                                matrix[oid][did] = {"minutes": max(1, int(round(float(dseconds) / 60)),),
                                                    "distance_km": round(float(dm) / 1000, 2) if dm is not None else round(_distance_km(float(origin["latitude"]), float(origin["longitude"]), float(target["latitude"]), float(target["longitude"])), 2),
                                                    "source": source}
                    if sum(len(row) for row in matrix.values()) >= size:
                        for i, origin in enumerate(places):
                            for j, target in enumerate(places):
                                oid, did = str(origin["id"]), str(target["id"])
                                if did not in matrix[oid]:
                                    dist = _distance_km(float(origin["latitude"]), float(origin["longitude"]), float(target["latitude"]), float(target["longitude"]))
                                    matrix[oid][did] = {"minutes": 0 if i == j else _approximate_minutes(dist, "WALK" if transport == "Walking" else "DRIVE"), "distance_km": round(dist, 2), "source": "straight-line estimate"}
                        return matrix, source + " (estimates for unreachable pairs)"
            else:
                current_app.logger.warning("OSRM table returned HTTP %s; using straight-line estimates.", response.status_code)
        except (requests.RequestException, ValueError, TypeError) as error:
            current_app.logger.warning("OSRM table unavailable (%s); using straight-line estimates.", type(error).__name__)
    for i, origin in enumerate(places):
        for j, target in enumerate(places):
            oid, did = str(origin["id"]), str(target["id"])
            dist = _distance_km(float(origin["latitude"]), float(origin["longitude"]), float(target["latitude"]), float(target["longitude"]))
            matrix[oid][did] = {"minutes": 0 if i == j else _approximate_minutes(dist, "WALK" if transport == "Walking" else "DRIVE"), "distance_km": round(dist, 2), "source": "straight-line estimate"}
    return matrix, source if base else source


def _optimize_activity_order(activities: list[dict[str, Any]], matrix: dict[str, dict[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Optimize each day's open route with OR-Tools; fall back to exact permutations for small days."""
    n = len(activities)
    if n < 3:
        return activities
    ids = [str(activity.get("place_id") or activity.get("attraction_id") or "") for activity in activities]
    def cost(i: int, j: int) -> int:
        return 0 if i == j else max(0, _matrix_minutes(matrix, ids[i], ids[j]))
    # A short day is small enough to solve exactly, including a free choice of start/end.
    if n <= 8:
        from itertools import permutations
        best_order = tuple(range(n))
        best_cost = float("inf")
        for order in permutations(range(n)):
            total = sum(cost(a, b) for a, b in zip(order, order[1:]))
            if total < best_cost:
                best_cost, best_order = total, order
        return [activities[i] for i in best_order]
    try:
        from ortools.constraint_solver import pywrapcp, routing_enums_pb2
        dummy = n
        manager = pywrapcp.RoutingIndexManager(n + 1, 1, [dummy], [dummy])
        routing = pywrapcp.RoutingModel(manager)
        def transit(from_index: int, to_index: int) -> int:
            i, j = manager.IndexToNode(from_index), manager.IndexToNode(to_index)
            if i == dummy or j == dummy:
                return 0  # open route: no fixed depot or return trip
            return cost(i, j)
        callback = routing.RegisterTransitCallback(transit)
        routing.SetArcCostEvaluatorOfAllVehicles(callback)
        search = pywrapcp.DefaultRoutingSearchParameters()
        search.first_solution_strategy = routing_enums_pb2.FirstSolutionStrategy.PATH_CHEAPEST_ARC
        search.local_search_metaheuristic = routing_enums_pb2.LocalSearchMetaheuristic.GUIDED_LOCAL_SEARCH
        search.time_limit.seconds = 2
        solution = routing.SolveWithParameters(search)
        if solution:
            ordered_indexes = []
            index = routing.Start(0)
            while not routing.IsEnd(index):
                node = manager.IndexToNode(index)
                if node != dummy:
                    ordered_indexes.append(node)
                index = solution.Value(routing.NextVar(index))
            if len(ordered_indexes) == n:
                return [activities[i] for i in ordered_indexes]
    except Exception as error:
        current_app.logger.warning("OR-Tools route optimization fell back (%s).", type(error).__name__)
    # Reliable heuristic fallback: try each start, then repeatedly take the nearest next stop.
    best: list[int] = []
    best_cost = float("inf")
    for start in range(n):
        remaining = set(range(n)) - {start}
        order = [start]
        while remaining:
            last = order[-1]
            nxt = min(remaining, key=lambda j: (cost(last, j), j))
            order.append(nxt)
            remaining.remove(nxt)
        total = sum(cost(a, b) for a, b in zip(order, order[1:]))
        if total < best_cost:
            best, best_cost = order, total
    return [activities[i] for i in best]


def _optimize_activity_order_from_origin(
    activities: list[dict[str, Any]], matrix: dict[str, dict[str, dict[str, Any]]], origin_id: str,
) -> list[dict[str, Any]]:
    """Minimize an open path that starts at the selected destination center."""
    n = len(activities)
    if n < 2:
        return activities
    ids = [str(activity.get("place_id") or activity.get("attraction_id") or "") for activity in activities]

    def cost_id(a: str, b: str) -> int:
        return max(0, _matrix_minutes(matrix, a, b))

    # Exploration routes are limited to eight selected stops, so exact permutations
    # keep the starting point fixed and are reliably optimal for the supplied matrix.
    if n <= 8:
        from itertools import permutations
        best_order = tuple(range(n))
        best_cost = float("inf")
        for order in permutations(range(n)):
            total = cost_id(origin_id, ids[order[0]])
            total += sum(cost_id(ids[a], ids[b]) for a, b in zip(order, order[1:]))
            if total < best_cost:
                best_cost, best_order = total, order
        return [activities[i] for i in best_order]

    remaining = set(range(n))
    first = min(remaining, key=lambda idx: (cost_id(origin_id, ids[idx]), idx))
    order = [first]
    remaining.remove(first)
    while remaining:
        last = order[-1]
        nxt = min(remaining, key=lambda idx: (cost_id(ids[last], ids[idx]), idx))
        order.append(nxt)
        remaining.remove(nxt)
    return [activities[i] for i in order]


def _matrix_minutes(matrix: dict[str, dict[str, dict[str, Any]]], origin_id: str, destination_id: str) -> int:
    try:
        return int(matrix[origin_id][destination_id]["minutes"])
    except (KeyError, TypeError, ValueError):
        return 30


def _generate_gemma_itinerary(plan: dict[str, Any], places: list[dict[str, Any]], resolved_destination: str, route_matrix: dict[str, dict[str, dict[str, Any]]], route_source: str) -> list[dict[str, Any]]:
    """Build the itinerary without a second LLM call, then optimize day routes locally.

    Gemma is the source of place recommendations. Route ordering/day allocation is a
    combinatorial optimization problem, so a second Gemma request adds latency and an
    unnecessary failure point without being needed to invent itinerary structure.
    """
    candidates = _rank_places(places, plan["interests"])
    # Plan approximately four stops per day, and never send every model suggestion
    # straight into an itinerary if the trip is short.
    candidate_limit = min(len(candidates), MAX_CANDIDATES_FOR_ROUTING, max(plan["duration"], plan["duration"] * 4))
    candidates = candidates[:candidate_limit]
    if not candidates:
        raise ApiProblem("No mapped Gemma recommendations are available to plan this trip.", 422, "no_mappable_places")

    day_count = min(plan["duration"], len(candidates))
    day_groups: list[list[dict[str, Any]]] = [[] for _ in range(day_count)]

    def make_activity(place: dict[str, Any]) -> dict[str, Any]:
        searchable = f"{place.get('name', '')} {place.get('category', '')} {place.get('recommendation_reason', '')}".casefold()
        if any(term in searchable for term in ("water sport", "watersport", "boating", "boat ride", "kayak", "jet ski", "rafting")):
            visit_minutes = 120
        elif any(term in searchable for term in ("museum", "fort", "palace", "dam tour", "guided tour")):
            visit_minutes = 90
        else:
            visit_minutes = 60
        return {
            "attraction_id": str(place["id"]), "place_id": str(place["id"]),
            "name": str(place["name"]),
            "description": str(place.get("recommendation_reason") or place.get("description") or f"Recommended by Gemma for {', '.join(plan['interests']) or 'your trip'}.")[:450],
            "category": str(place.get("category") or "Point of interest"),
            "estimated_cost": 0, "estimated_entry_fee_per_person": 0,
            "entry_fee_known": False, "visit_duration_minutes": visit_minutes,
            "visit_duration_is_estimate": True,
            "planning_notes": "Gemma recommended this location; the name was geocoded for mapping. Verify the exact venue, activity availability, opening hours, and prices before travelling.",
            "address": str(place.get("address") or ""),
            "latitude": float(place["latitude"]), "longitude": float(place["longitude"]),
            "rating": place.get("rating"), "maps_url": str(place.get("maps_url") or place.get("map_url") or ""),
            "provider": str(place.get("provider") or "Gemma recommendation"),
            "costs_are_estimates": True,
        }

    # Seed each day with a high-ranked recommendation. Then place each remaining
    # location where it adds the least route time, with a small balancing cost so
    # one day does not absorb every attraction.
    for idx, place in enumerate(candidates[:day_count]):
        day_groups[idx].append(make_activity(place))

    def route_cost(items: list[dict[str, Any]]) -> int:
        return sum(_matrix_minutes(route_matrix, str(a["place_id"]), str(b["place_id"]))
                   for a, b in zip(items, items[1:]))

    for place in candidates[day_count:]:
        activity = make_activity(place)
        best_choice: tuple[float, int, int, list[dict[str, Any]]] | None = None
        for day_idx, existing in enumerate(day_groups):
            old_cost = route_cost(existing)
            for insert_at in range(len(existing) + 1):
                proposed = existing[:insert_at] + [activity] + existing[insert_at:]
                delta = route_cost(proposed) - old_cost
                # Lightly balance the number of stops and planned duration per day.
                load_penalty = len(existing) * 12 + sum(int(x["visit_duration_minutes"]) for x in existing) * 0.04
                choice = (delta + load_penalty, day_idx, insert_at, proposed)
                if best_choice is None or choice[:3] < best_choice[:3]:
                    best_choice = choice
        if best_choice:
            _, day_idx, _insert_at, proposed = best_choice
            day_groups[day_idx] = proposed

    itinerary: list[dict[str, Any]] = []
    for day_idx, activities in enumerate(day_groups, start=1):
        activities = _optimize_activity_order(activities, route_matrix)
        # Stay within a realistic planned day. Keep the first/highest-value stop,
        # and trim the end of the optimized route if transfer + visit estimates exceed 8h.
        note = "Places were recommended by Gemma and mapped using geocoding. Confirm opening hours, activity operations, and prices before travelling."
        while len(activities) > 1:
            visit_total = sum(int(a["visit_duration_minutes"]) for a in activities)
            transfer_total = route_cost(activities)
            if visit_total + transfer_total <= 8 * 60:
                break
            activities = activities[:-1]
            note = "The final stop was omitted to keep estimated visits and transfers within an eight-hour day."
            activities = _optimize_activity_order(activities, route_matrix)
        categories = []
        for activity in activities:
            category = str(activity.get("category") or "Highlights")
            if category.casefold() not in {item.casefold() for item in categories}:
                categories.append(category)
        theme = " & ".join(categories[:2]) if categories else f"Day {day_idx} highlights"
        travel_minutes = sum(_matrix_minutes(route_matrix, str(a["place_id"]), str(b["place_id"])) for a, b in zip(activities, activities[1:]))
        travel_distance = sum(float(route_matrix.get(str(a["place_id"]), {}).get(str(b["place_id"]), {}).get("distance_km", 0)) for a, b in zip(activities, activities[1:]))
        itinerary.append({
            "day": day_idx,
            "theme": theme[:100],
            "activities": activities,
            "note": note,
            "travel_minutes_estimate": travel_minutes,
            "travel_distance_km_estimate": round(travel_distance, 1),
            "route_time_source": route_source,
        })

    # Preserve the API contract: exactly the requested number of day objects.
    while len(itinerary) < plan["duration"]:
        day_no = len(itinerary) + 1
        itinerary.append({
            "day": day_no, "theme": f"Day {day_no} highlights", "activities": [],
            "note": "Not enough verified mapped recommendations were available to add a stop on this day.",
            "travel_minutes_estimate": 0, "travel_distance_km_estimate": 0.0,
            "route_time_source": route_source,
        })
    return itinerary


def _attach_open_route_paths(
    itinerary: list[dict[str, Any]], plan: dict[str, Any],
    places_by_id: dict[str, dict[str, Any]], center: dict[str, float] | None = None,
    always_start_from_center: bool = False,
) -> None:
    """Attach OSRM road geometry; optional exploration routes always start at the destination center."""
    base, mode_label = _routing_base(plan.get("transport", "Flexible"))
    for day in itinerary:
        activities = day.get("activities", [])
        stops = [places_by_id.get(str(a.get("place_id") or a.get("attraction_id"))) for a in activities]
        stops = [p for p in stops if p and p.get("latitude") is not None and p.get("longitude") is not None]
        if not stops:
            day["route_path"] = []
            day["route_path_source"] = "no mapped stops"
            continue

        single_stop_origin = False
        route_stops = stops
        if always_start_from_center and center and center.get("latitude") is not None and center.get("longitude") is not None:
            origin = {"latitude": float(center["latitude"]), "longitude": float(center["longitude"])}
            if _distance_km(origin["latitude"], origin["longitude"], float(stops[0]["latitude"]), float(stops[0]["longitude"])) > 0.25:
                route_stops = [origin, *stops]
                single_stop_origin = True
            else:
                # Avoid drawing a fake zero-length segment at the origin.
                route_stops = stops
        elif len(stops) == 1:
            # When only one place can be verified, preserve a saved route path if present.
            existing_path = day.get("route_path") or []
            if len(existing_path) >= 2:
                continue
            if center and center.get("latitude") is not None and center.get("longitude") is not None:
                origin = {"latitude": float(center["latitude"]), "longitude": float(center["longitude"])}
                if _distance_km(origin["latitude"], origin["longitude"], float(stops[0]["latitude"]), float(stops[0]["longitude"])) > 0.25:
                    route_stops = [origin, stops[0]]
                    single_stop_origin = True
                else:
                    day["route_path"] = []
                    day["route_path_source"] = "destination center is at the stop"
                    continue
            else:
                day["route_path"] = []
                day["route_path_source"] = "single stop; no destination center available"
                continue

        coordinates = ";".join(f"{float(p['longitude'])},{float(p['latitude'])}" for p in route_stops)
        route_bases: list[tuple[str, str]] = []
        if base:
            provider_label = f"OpenStreetMap OSRM {mode_label}"
            if single_stop_origin:
                provider_label += " from destination center"
            route_bases.append((base.rstrip("/"), provider_label))
        # Public OSRM demo endpoint is a second no-key fallback for driving paths.
        # For walking/public-transport preferences this is only geometry fallback,
        # not a claim that the path or travel time matches that transport mode.
        if plan.get("transport") != "Walking":
            alt = "https://router.project-osrm.org"
            if all(url != alt for url, _ in route_bases):
                provider_label = "OSRM public driving geometry fallback"
                if single_stop_origin:
                    provider_label += " from destination center"
                route_bases.append((alt, provider_label))
        if plan.get("transport") == "Public transport":
            provider_label = "OSRM road geometry preview; transit times estimated"
            if single_stop_origin:
                provider_label += " from destination center"
            route_bases.append((OSRM_CAR_BASE.rstrip("/"), provider_label))

        got_path = False
        for route_base, provider_name in route_bases:
            try:
                response = _osrm_get(
                    f"{route_base}/route/v1/driving/{coordinates}",
                    params={"overview": "full", "geometries": "geojson", "steps": "false"},
                    timeout=(2, 7),
                )
                if not response.ok:
                    current_app.logger.warning("OSRM route geometry provider returned HTTP %s for day %s.", response.status_code, day.get("day"))
                    continue
                payload = response.json()
                routes = payload.get("routes", []) if isinstance(payload, dict) else []
                route = routes[0] if routes else {}
                coords = ((route.get("geometry") or {}).get("coordinates") or []) if isinstance(route, dict) else []
                if not isinstance(coords, list) or len(coords) < 2:
                    continue
                day["route_path"] = [{"latitude": float(pt[1]), "longitude": float(pt[0])} for pt in coords if isinstance(pt, (list, tuple)) and len(pt) >= 2]
                day["route_path_source"] = provider_name
                if route.get("duration") is not None and plan.get("transport") != "Public transport":
                    day["travel_minutes_estimate"] = int(round(float(route["duration"]) / 60))
                if route.get("distance") is not None:
                    day["travel_distance_km_estimate"] = round(float(route["distance"]) / 1000, 1)
                got_path = True
                break
            except (requests.RequestException, ValueError, TypeError, KeyError) as error:
                current_app.logger.warning("OSRM route geometry provider failed for day %s (%s).", day.get("day"), type(error).__name__)

        if not got_path:
            # At least show the planned order on the map. This is intentionally
            # labelled as a straight-line estimate, never as a road route.
            day["route_path"] = [
                {"latitude": float(stop["latitude"]), "longitude": float(stop["longitude"])}
                for stop in route_stops
            ]
            day["route_path_source"] = "straight-line estimate; road routing unavailable" + (" from destination center" if single_stop_origin else "")
            current_app.logger.warning("No OSRM path available for day %s; attached labelled straight-line fallback.", day.get("day"))


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


def _itinerary_for_storage(itinerary: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Store model recommendation text and verified coordinates; no provider billing key is needed to reopen it."""
    stored_days: list[dict[str, Any]] = []
    for day in itinerary:
        activities = []
        for activity in day.get("activities", []):
            activities.append({
                "place_id": str(activity.get("place_id") or activity.get("attraction_id") or ""),
                "attraction_id": str(activity.get("attraction_id") or activity.get("place_id") or ""),
                "name": str(activity.get("name") or "Place details unavailable")[:160],
                "description": str(activity.get("description") or "")[:450],
                "category": str(activity.get("category") or "Point of interest")[:100],
                "address": str(activity.get("address") or "")[:300],
                "latitude": activity.get("latitude"), "longitude": activity.get("longitude"),
                "maps_url": str(activity.get("maps_url") or activity.get("map_url") or "")[:500],
                "map_url": str(activity.get("map_url") or activity.get("maps_url") or "")[:500],
                "provider": str(activity.get("provider") or "Gemma recommendation")[:120],
                "rating": activity.get("rating"),
                "visit_duration_minutes": max(30, min(180, int(activity.get("visit_duration_minutes", 90)))),
                "visit_duration_is_estimate": True,
                "estimated_cost": 0, "estimated_entry_fee_per_person": 0,
                "entry_fee_known": False, "costs_are_estimates": True,
                "planning_notes": str(activity.get("planning_notes") or "Verify current access, opening hours and prices before visiting.")[:500],
                "recommendation_reason": str(activity.get("recommendation_reason") or activity.get("description") or "")[:450],
            })
        stored_days.append({"day": int(day.get("day", len(stored_days) + 1)),
                            "theme": str(day.get("theme") or "")[:100],
                            "note": str(day.get("note") or "")[:300],
                            "travel_minutes_estimate": day.get("travel_minutes_estimate"),
                            "travel_distance_km_estimate": day.get("travel_distance_km_estimate"),
                            "route_time_source": day.get("route_time_source", "saved estimate"),
                            "route_path": day.get("route_path", []),
                            "route_path_source": str(day.get("route_path_source") or "")[:160],
                            "activities": activities})
    return stored_days


def _hydrate_saved_trip(trip: dict[str, Any]) -> dict[str, Any]:
    """Saved trips already include mapped coordinates, so reopening does not call a paid places API."""
    for day in trip.get("itinerary", []):
        for activity in day.get("activities", []):
            if not activity.get("name"):
                activity["name"] = "Saved stop details unavailable"
                activity["planning_notes"] = "This older saved trip did not preserve the location coordinates. Generate a new trip to refresh it."
            activity.setdefault("maps_url", activity.get("map_url", ""))
            activity.setdefault("map_url", activity.get("maps_url", ""))
            activity.setdefault("entry_fee_known", False)
            activity.setdefault("visit_duration_is_estimate", True)
            activity.setdefault("costs_are_estimates", True)
    by_id = {
        str(activity.get("place_id") or activity.get("attraction_id")): activity
        for day in trip.get("itinerary", []) for activity in day.get("activities", [])
        if (activity.get("place_id") or activity.get("attraction_id")) and activity.get("latitude") is not None and activity.get("longitude") is not None
    }
    if by_id:
        _attach_open_route_paths(trip.get("itinerary", []), {"transport": trip.get("transport", "Flexible")}, by_id)
    return trip


def _trip_from_row(row: sqlite3.Row) -> dict[str, Any]:
    # Older database rows may contain illustrative cost breakdowns. Do not expose
    # those legacy estimates in newly returned trip payloads.
    itinerary = json.loads(row["itinerary"] or "[]")
    budget = int(row["total_budget"])
    return {
        "id": int(row["id"]),
        "destination": row["destination"],
        "duration": int(row["duration"]),
        "budget": budget,  # normalized planning budget in INR
        "budget_currency": str(row["budget_currency"] or "INR") if "budget_currency" in row.keys() else "INR",
        "budget_input_amount": (float(row["budget_input_amount"]) if "budget_input_amount" in row.keys() and float(row["budget_input_amount"] or 0) > 0 else float(budget)),
        "budget_exchange_rate": (float(row["budget_exchange_rate"]) if "budget_exchange_rate" in row.keys() and row["budget_exchange_rate"] is not None else None),
        "travelers": int(row["travelers"]),
        "transport": row["transport"],
        "interests": json.loads(row["interests"] or "[]"),
        "itinerary": itinerary,
        "planner_engine": row["planner_engine"] or "legacy saved plan",
        "created_at": str(row["created_at"]).replace(" ", "T", 1),
    }


def _save_trip(plan: dict[str, Any]) -> dict[str, Any]:
    created_at = datetime.now(timezone.utc).isoformat()
    planner_engine = str(plan.get("planner_engine") or f"Gemma ({os.getenv('GEMMA_MODEL', 'gemma-4-31b-it')}) + Geoapify geocoding + OpenStreetMap OSRM + OR-Tools")
    with _database_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO trips (
                destination, duration, total_budget, travelers, transport,
                interests, expense_breakdown, itinerary, created_at, planner_engine,
                budget_currency, budget_input_amount, budget_exchange_rate
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                plan["destination"], plan["duration"], plan["budget"], plan["travelers"],
                plan["transport"], json.dumps(plan["interests"], ensure_ascii=False),
                json.dumps(plan["budget_breakdown"], ensure_ascii=False),
                json.dumps(_itinerary_for_storage(plan["itinerary"]), ensure_ascii=False), created_at, planner_engine,
                str(plan.get("budget_currency") or "INR"),
                float(plan.get("budget_input_amount") if plan.get("budget_input_amount") is not None else plan["budget"]),
                plan.get("budget_exchange_rate"),
            ),
        )
        trip_id = int(cursor.lastrowid)
        row = connection.execute("SELECT * FROM trips WHERE id = ?", (trip_id,)).fetchone()
        connection.commit()
    if row is None:
        raise ApiProblem("The trip was generated but could not be retrieved after saving.", 500, "trip_save_failed")
    return _trip_from_row(row)



def _exploration_route_from_row(row: sqlite3.Row) -> dict[str, Any]:
    try:
        data = json.loads(row["route_data"] or "{}")
    except (ValueError, TypeError):
        data = {}
    if not isinstance(data, dict):
        data = {}
    data["id"] = int(row["id"])
    data["destination"] = str(row["destination"])
    data["interests"] = json.loads(row["interests"] or "[]")
    data["transport"] = str(row["transport"] or "Flexible")
    data["created_at"] = str(row["created_at"]).replace(" ", "T", 1)
    return data


def _save_exploration_route(route_data: dict[str, Any]) -> dict[str, Any]:
    created_at = datetime.now(timezone.utc).isoformat()
    destination = str(route_data.get("destination") or "").strip()[:160]
    interests = route_data.get("interests") if isinstance(route_data.get("interests"), list) else []
    transport = str(route_data.get("transport") or "Flexible")
    stored = dict(route_data)
    stored["id"] = None
    stored["created_at"] = created_at
    with _database_connection() as connection:
        cursor = connection.execute(
            "INSERT INTO exploration_routes (destination, interests, transport, route_data, created_at) VALUES (?, ?, ?, ?, ?)",
            (destination, json.dumps(interests, ensure_ascii=False), transport,
             json.dumps(stored, ensure_ascii=False), created_at),
        )
        route_id = int(cursor.lastrowid)
        stored["id"] = route_id
        connection.execute("UPDATE exploration_routes SET route_data = ? WHERE id = ?", (json.dumps(stored, ensure_ascii=False), route_id))
        row = connection.execute("SELECT * FROM exploration_routes WHERE id = ?", (route_id,)).fetchone()
    if row is None:
        raise ApiProblem("The exploration route was generated but could not be retrieved after saving.", 500, "exploration_route_save_failed")
    return _exploration_route_from_row(row)


def _validate_exploration_places(payload_places: object, center: dict[str, float]) -> list[dict[str, Any]]:
    if not isinstance(payload_places, list):
        raise ApiProblem("Select one or more places before generating a route.", 400, "exploration_places_required")
    if not 1 <= len(payload_places) <= 8:
        raise ApiProblem("Select between 1 and 8 places for an exploration route.", 400, "exploration_places_count_invalid")

    places: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    seen_names: set[str] = set()
    center_lat = float(center["latitude"])
    center_lng = float(center["longitude"])
    for raw in payload_places:
        if not isinstance(raw, dict):
            continue
        name = re.sub(r"\s+", " ", str(raw.get("name") or "")).strip()[:160]
        if not name:
            continue
        try:
            lat = float(raw.get("latitude"))
            lng = float(raw.get("longitude"))
        except (TypeError, ValueError):
            continue
        if not (-90 <= lat <= 90 and -180 <= lng <= 180):
            continue
        distance = _distance_km(center_lat, center_lng, lat, lng)
        if distance > 100:
            continue
        original_id = str(raw.get("id") or raw.get("place_id") or "").strip()
        identity = original_id or hashlib.sha1(f"{_normal_name(name)}|{lat:.5f}|{lng:.5f}".encode("utf-8")).hexdigest()[:16]
        normalized_name = _normal_name(name)
        if identity in seen_ids or normalized_name in seen_names:
            continue
        seen_ids.add(identity)
        seen_names.add(normalized_name)
        map_url = str(raw.get("maps_url") or raw.get("map_url") or f"https://www.openstreetmap.org/?mlat={lat:.6f}&mlon={lng:.6f}#map=15/{lat:.6f}/{lng:.6f}")[:500]
        try:
            visit_minutes = max(30, min(180, int(raw.get("visit_duration_minutes", 60) or 60)))
        except (TypeError, ValueError):
            visit_minutes = 60
        places.append({
            "id": identity, "place_id": identity, "name": name,
            "description": str(raw.get("description") or raw.get("recommendation_reason") or "A nearby place suggested for your selected interests.")[:450],
            "recommendation_reason": str(raw.get("recommendation_reason") or raw.get("description") or "")[:450],
            "category": str(raw.get("category") or "Point of interest")[:100],
            "categories": raw.get("categories") if isinstance(raw.get("categories"), list) else [str(raw.get("category") or "Point of interest")],
            "types": raw.get("types") if isinstance(raw.get("types"), list) else [str(raw.get("category") or "Point of interest")],
            "address": str(raw.get("address") or "")[:300],
            "latitude": lat, "longitude": lng,
            "maps_url": map_url, "map_url": map_url,
            "provider": str(raw.get("provider") or "Gemma recommendation; Geoapify geocoding; OpenStreetMap map")[:120],
            "distance_from_destination_km": round(distance, 2),
            "rating": raw.get("rating") if isinstance(raw.get("rating"), (int, float)) else None,
            "visit_duration_minutes": visit_minutes,
            "visit_duration_is_estimate": True,
            "entry_fee_known": False, "estimated_entry_fee_per_person": 0,
            "costs_are_estimates": True,
            "planning_notes": str(raw.get("planning_notes") or "Verify current access, opening hours, activity availability and prices before visiting.")[:500],
        })
    if not places:
        raise ApiProblem("None of the selected places could be validated within 100 km of this destination. Refresh the suggestions and try again.", 422, "no_valid_exploration_places")
    return places


def _build_exploration_route(
    destination: str, interests: list[str], transport: str, places: list[dict[str, Any]],
    resolved_destination: str, center: dict[str, float],
) -> dict[str, Any]:
    """Optimize selected extra places from the destination center and attach road geometry."""
    origin = {
        "id": "__exploration_destination_origin__",
        "place_id": "__exploration_destination_origin__",
        "name": f"Start · {resolved_destination}",
        "latitude": float(center["latitude"]),
        "longitude": float(center["longitude"]),
    }
    matrix_places = [origin, *places]
    matrix, route_source = _compute_route_matrix(matrix_places, transport)
    ordered_places = _optimize_activity_order_from_origin(places, matrix, str(origin["id"]))
    activities: list[dict[str, Any]] = []
    for stop_index, place in enumerate(ordered_places, start=1):
        activities.append({
            "attraction_id": str(place["id"]), "place_id": str(place["id"]),
            "name": str(place["name"]),
            "description": str(place.get("description") or place.get("recommendation_reason") or "Suggested for your selected interests."),
            "category": str(place.get("category") or "Point of interest"),
            "estimated_cost": 0, "estimated_entry_fee_per_person": 0,
            "entry_fee_known": False,
            "visit_duration_minutes": max(30, min(180, int(place.get("visit_duration_minutes", 60) or 60))),
            "visit_duration_is_estimate": True,
            "planning_notes": str(place.get("planning_notes") or "Verify access, opening hours and prices before travelling."),
            "address": str(place.get("address") or ""),
            "latitude": float(place["latitude"]), "longitude": float(place["longitude"]),
            "rating": place.get("rating"),
            "maps_url": place.get("maps_url") or place.get("map_url"),
            "provider": str(place.get("provider") or "Gemma recommendation"),
            "costs_are_estimates": True,
            "recommendation_reason": str(place.get("recommendation_reason") or place.get("description") or ""),
        })

    origin_id = str(origin["id"])
    travel_minutes = _matrix_minutes(matrix, origin_id, str(activities[0]["place_id"])) if activities else 0
    travel_distance = float(matrix.get(origin_id, {}).get(str(activities[0]["place_id"]), {}).get("distance_km", 0)) if activities else 0.0
    for prev, nxt in zip(activities, activities[1:]):
        travel_minutes += _matrix_minutes(matrix, str(prev["place_id"]), str(nxt["place_id"]))
        travel_distance += float(matrix.get(str(prev["place_id"]), {}).get(str(nxt["place_id"]), {}).get("distance_km", 0))

    day: dict[str, Any] = {
        "day": 1, "theme": "Other places to explore", "activities": activities,
        "note": "Optional places only. Your original itinerary was not changed.",
        "travel_minutes_estimate": travel_minutes,
        "travel_distance_km_estimate": round(travel_distance, 1),
        "route_time_source": route_source,
        "route_path": [], "route_path_source": "pending route geometry",
    }
    places_by_id = {str(place["id"]): place for place in places}
    _attach_open_route_paths(
        [day], {"transport": transport}, places_by_id, center, always_start_from_center=True
    )
    # Ensure the metadata stays useful when road geometry is unavailable.
    if day.get("route_path_source", "").lower().find("straight-line") >= 0:
        day["travel_minutes_estimate"] = max(1, int(travel_minutes))
        day["travel_distance_km_estimate"] = round(travel_distance, 1)

    return {
        "id": None,
        "title": f"Exploration route near {resolved_destination}",
        "destination": destination,
        "resolved_destination": resolved_destination,
        "interests": interests,
        "transport": transport,
        "radius_km": 100,
        "places": activities,
        "route_path": day.get("route_path") or [],
        "route_path_source": day.get("route_path_source") or route_source,
        "travel_minutes_estimate": int(day.get("travel_minutes_estimate") or travel_minutes),
        "travel_distance_km_estimate": float(day.get("travel_distance_km_estimate") or round(travel_distance, 1)),
        "route_time_source": route_source,
        "note": day["note"],
    }

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
                "geoapify_key_configured": bool(os.getenv("GEOAPIFY_API_KEY", "").strip()),
                "place_recommendation_engine": "Gemma",
                "route_optimizer": "OR-Tools with exact small-day search; heuristic fallback",
            })
        except sqlite3.Error:
            current_app.logger.exception("SQLite health check failed")
            return jsonify({"status": "error", "service": "RoamWise API", "database": "unavailable"}), 503

    @app.get("/api/exchange-rate")
    def exchange_rate():
        rate_info = _get_usd_inr_rate()
        return jsonify({
            "base_currency": "USD", "target_currency": "INR",
            "rate": rate_info["rate"], "updated_at": rate_info.get("updated_at"),
            "source": rate_info.get("source"),
            "attribution_url": "https://www.exchangerate-api.com/docs/free",
        })

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
        """Destination suggestions via Geoapify geocoding; no Google Maps API is used."""
        query = request.args.get("q", "").strip()[:120]
        if len(query) < 2:
            return jsonify({"suggestions": []})
        api_key = _geoapify_key()
        results = _geoapify_geocode(query, api_key, limit=8)
        suggestions: list[dict[str, Any]] = []
        seen: set[str] = set()
        for result in results:
            coords = _geo_result_coordinates(result)
            label = _normalise_geo_label(str(result.get("formatted") or "").strip(), result)
            if not coords or not label or label.casefold() in seen:
                continue
            seen.add(label.casefold())
            title = str(result.get("name") or result.get("address_line1") or label.split(",")[0]).strip()
            suggestions.append({
                "title": title, "label": label,
                "result_type": str(result.get("result_type") or "location"),
                "city": result.get("city"), "state": result.get("state"), "country": result.get("country"),
                "latitude": coords[0], "longitude": coords[1], "place_id": result.get("place_id"),
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
        if plan_request["budget_currency"] == "USD":
            fx = _get_usd_inr_rate()
            normalized_budget = int(round(plan_request["budget_input_amount"] * float(fx["rate"])))
            if not 500 <= normalized_budget <= MAX_BUDGET_INR:
                raise ApiProblem(
                    f"That USD budget converts to approximately ₹{normalized_budget:,}. Choose an amount that converts to ₹500–₹{MAX_BUDGET_INR:,}.",
                    400, "budget_out_of_range",
                )
            plan_request["budget"] = normalized_budget
            plan_request["budget_exchange_rate"] = float(fx["rate"])
            plan_request["budget_exchange_rate_updated_at"] = fx.get("updated_at")
        else:
            plan_request["budget"] = int(round(plan_request["budget_input_amount"]))
            plan_request["budget_exchange_rate"] = None
            plan_request["budget_exchange_rate_updated_at"] = None
        _require_env("GEMMA_API_KEY", "recommend real visitor places and optimize the itinerary")
        _require_env("GEOAPIFY_API_KEY", "resolve the destination and suggested places to coordinates")

        # Record stage timings so production logs identify the real latency source.
        plan_started = time.perf_counter()
        # Gemma chooses attractions/activity areas. Geoapify only resolves those names to map coordinates.
        discovery_started = time.perf_counter()
        all_places, resolved_destination, center = _discover_gemma_places(plan_request)
        current_app.logger.info("Plan stage discovery (Gemma + Geoapify): %.2fs; %d verified places.",
                                time.perf_counter() - discovery_started, len(all_places))
        # The broader Gemma fallback has already tried to supplement sparse results.
        # Keep any remaining verified stops instead of failing solely on a low count.

        candidates = _rank_places(all_places, plan_request["interests"])[:MAX_CANDIDATES_FOR_ROUTING]
        matrix_started = time.perf_counter()
        route_matrix, route_source = _compute_route_matrix(candidates, plan_request["transport"])
        current_app.logger.info("Plan stage route matrix: %.2fs.", time.perf_counter() - matrix_started)
        itinerary_started = time.perf_counter()
        itinerary = _generate_gemma_itinerary(plan_request, candidates, resolved_destination, route_matrix, route_source)
        current_app.logger.info("Plan stage local itinerary optimization: %.2fs.", time.perf_counter() - itinerary_started)
        by_id = {str(place["id"]): place for place in candidates}
        paths_started = time.perf_counter()
        _attach_open_route_paths(itinerary, plan_request, by_id, center)
        current_app.logger.info("Plan stage route geometry: %.2fs.", time.perf_counter() - paths_started)
        # Do not fabricate transport, lodging, food, or miscellaneous cost estimates.
        # Keep the submitted budget as planner context, but persist an empty legacy
        # breakdown object for compatibility with existing SQLite databases.
        plan = {
            **plan_request,
            "itinerary": itinerary,
            "budget_breakdown": {},
            "planner_engine": f"Gemma ({os.getenv('GEMMA_MODEL', 'gemma-4-31b-it')}) recommendations + Geoapify geocoding + OpenStreetMap OSRM + open route optimization ({route_source})",
        }
        save_started = time.perf_counter()
        trip = _save_trip(plan)
        current_app.logger.info("Plan stage SQLite save: %.2fs.", time.perf_counter() - save_started)
        trip["itinerary"] = itinerary
        current_app.logger.info("Plan request completed in %.2fs.", time.perf_counter() - plan_started)
        return jsonify({"trip": trip}), 201


    @app.post("/api/explore/places")
    def discover_other_places():
        """Return optional Gemma-recommended attractions within 100 km, separate from the core itinerary."""
        if not request.is_json:
            raise ApiProblem("Request must contain a JSON object.", 400, "invalid_json")
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise ApiProblem("Request body must be a JSON object.", 400, "invalid_json")
        destination = str(payload.get("destination") or "").strip()
        if not destination or len(destination) > 120:
            raise ApiProblem("A destination of 1–120 characters is required.", 400, "destination_required")
        interests = payload.get("interests", [])
        if not isinstance(interests, list) or len(interests) > 8 or any(not isinstance(x, str) or not x.strip() for x in interests):
            raise ApiProblem("Interests must be an array of up to 8 non-empty strings.", 400, "invalid_interests")
        interests = list(dict.fromkeys(str(x).strip()[:60] for x in interests)) or ["Popular / hot"]
        transport = str(payload.get("transport") or "Flexible")
        if transport not in SUPPORTED_TRANSPORT:
            transport = "Flexible"
        exclude_names = payload.get("exclude_names", [])
        if not isinstance(exclude_names, list):
            exclude_names = []
        exclude_names = [str(name).strip()[:160] for name in exclude_names[:80] if isinstance(name, str) and name.strip()]
        excluded_normalized = {_normal_name(name) for name in exclude_names}
        api_key = _geoapify_key()
        latitude, longitude, resolved_destination = _geocode_destination(destination, api_key)
        explore_plan = {
            "destination": destination, "duration": 1, "budget": 0, "budget_input_amount": 0,
            "budget_currency": "INR", "travelers": 1, "transport": transport, "interests": interests,
        }
        recommendations = _generate_gemma_place_recommendations(
            explore_plan, resolved_destination, broaden_to_popular=True, exclude_names=exclude_names,
        )
        # Keep the candidate pool separate from the saved/active trip, while avoiding visible repeats.
        recommendations = [item for item in recommendations if _normal_name(item.get("name", "")) not in excluded_normalized]

        # This well-established regional attraction is often omitted by generic model prompts.
        # For the Hirakud/Sambalpur/Burla area, explicitly attempt to resolve it even if Gemma
        # omitted it; it is only displayed if Geoapify confirms a matching location inside 100 km.
        destination_context = f"{destination} {resolved_destination}".casefold()
        in_hirakud_region = any(term in destination_context for term in ("hirakud", "sambalpur", "burla"))
        debrigarh_name = "Debrigarh Wildlife Sanctuary"
        if in_hirakud_region and _normal_name(debrigarh_name) not in excluded_normalized and not any(
            _normal_name(item.get("name", "")) == _normal_name(debrigarh_name)
            for item in recommendations
        ):
            recommendations.insert(0, {
                "name": debrigarh_name,
                "category": "Wildlife Sanctuary",
                "reason": "Wildlife sanctuary on the Hirakud Reservoir, suited to wildlife, birding and nature interests; confirm visitor access before travelling.",
                "area": "Hirakud Reservoir, Odisha",
            })
        by_id: dict[str, dict[str, Any]] = {}
        unmapped, geocoding_failures = _resolve_gemma_recommendations(
            recommendations, explore_plan, resolved_destination, latitude, longitude,
            api_key, by_id, radius_km=100,
        )
        places = [place for place in _rank_places(list(by_id.values()), interests)
                  if _normal_name(str(place.get("name") or "")) not in excluded_normalized]
        # A 100 km circle makes nearby wildlife/ecotourism options visible for sparse locations,
        # while geocoding and country/radius checks still prevent distant false matches.
        current_app.logger.info(
            "Other-places discovery resolved %d places within 100 km of %r; unmapped=%d temporary geocoding failures=%d.",
            len(places), resolved_destination, len(unmapped), geocoding_failures,
        )
        return jsonify({
            "destination": destination, "resolved_destination": resolved_destination,
            "radius_km": 100, "places": places[:24], "count": min(len(places), 24),
            "unmapped_count": len(unmapped),
            "note": "Optional extra places. They do not change the itinerary until you select them and generate a separate route.",
        })

    @app.post("/api/explore/route")
    def generate_exploration_route():
        """Optimize and separately save a route from the destination center through user-selected extra places."""
        if not request.is_json:
            raise ApiProblem("Request must contain a JSON object.", 400, "invalid_json")
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            raise ApiProblem("Request body must be a JSON object.", 400, "invalid_json")
        destination = str(payload.get("destination") or "").strip()
        if not destination or len(destination) > 120:
            raise ApiProblem("A destination of 1–120 characters is required.", 400, "destination_required")
        interests = payload.get("interests", [])
        if not isinstance(interests, list) or len(interests) > 8 or any(not isinstance(x, str) or not x.strip() for x in interests):
            raise ApiProblem("Interests must be an array of up to 8 non-empty strings.", 400, "invalid_interests")
        interests = list(dict.fromkeys(str(x).strip()[:60] for x in interests))
        transport = str(payload.get("transport") or "Flexible")
        if transport not in SUPPORTED_TRANSPORT:
            raise ApiProblem(f"Transport must be one of: {', '.join(sorted(SUPPORTED_TRANSPORT))}.", 400, "invalid_transport")
        api_key = _geoapify_key()
        latitude, longitude, resolved_destination = _geocode_destination(destination, api_key)
        center = {"latitude": latitude, "longitude": longitude}
        places = _validate_exploration_places(payload.get("places"), center)
        route_data = _build_exploration_route(destination, interests, transport, places, resolved_destination, center)
        saved = _save_exploration_route(route_data)
        return jsonify({"route": saved, "message": "Optimized exploration route generated and saved separately from the trip itinerary."}), 201

    @app.get("/api/exploration-routes")
    def list_saved_exploration_routes():
        try:
            requested_limit = int(request.args.get("limit", 10))
        except ValueError:
            requested_limit = 10
        limit = max(1, min(requested_limit, 50))
        with _database_connection() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM exploration_routes").fetchone()[0])
            rows = connection.execute(
                "SELECT * FROM exploration_routes ORDER BY created_at DESC, id DESC LIMIT ?", (limit,)
            ).fetchall()
        return jsonify({"routes": [_exploration_route_from_row(row) for row in rows], "count": total})

    @app.delete("/api/exploration-routes/<int:route_id>")
    def delete_saved_exploration_route(route_id: int):
        with _database_connection() as connection:
            cursor = connection.execute("DELETE FROM exploration_routes WHERE id = ?", (route_id,))
        if cursor.rowcount == 0:
            raise ApiProblem("Saved exploration route not found.", 404, "not_found")
        return jsonify({"message": "Saved exploration route deleted.", "id": route_id})

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
        return jsonify({"trip": _hydrate_saved_trip(_trip_from_row(row))})

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
