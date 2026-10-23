"""Safely diagnose Gemma API access without printing your API key.

Place this file beside backend/app.py and run:
    python diagnose_gemma.py

It tests a tiny plain-text request and a small structured-JSON request.
Do not paste your .env or API key into chat.
"""
import os
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

api_key = os.getenv("GEMMA_API_KEY", "").strip()
model = os.getenv("GEMMA_MODEL", "gemma-4-26b-a4b-it").strip() or "gemma-4-26b-a4b-it"
fallback = os.getenv("GEMMA_FALLBACK_MODEL", "").strip()

print("GEMMA_API_KEY loaded:", bool(api_key))
print("GEMMA_MODEL:", model)
print("GEMMA_FALLBACK_MODEL:", fallback or "(not set)")
print("Testing API requests; the key itself will not be printed.")

if not api_key:
    raise SystemExit(
        "FAIL: GEMMA_API_KEY is missing. Put GEMMA_API_KEY=... in backend/.env "
        "(no quotes required) and rerun."
    )

client = genai.Client(api_key=api_key)
schema = {
    "type": "OBJECT",
    "required": ["places"],
    "properties": {
        "places": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "required": ["name", "category", "reason", "area"],
                "properties": {
                    "name": {"type": "STRING"},
                    "category": {"type": "STRING"},
                    "reason": {"type": "STRING"},
                    "area": {"type": "STRING"},
                },
            },
        }
    },
}

def run_test(model_name: str, label: str, structured: bool) -> bool:
    try:
        if structured:
            response = client.models.generate_content(
                model=model_name,
                contents=(
                    "Suggest 2 real places to visit in Sambalpur/Burla, Odisha, India, "
                    "prioritizing water sports and boating. Return concise entries."
                ),
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=500,
                    response_mime_type="application/json",
                    response_schema=schema,
                ),
            )
        else:
            response = client.models.generate_content(
                model=model_name,
                contents="Reply with exactly: GEMMA_OK",
                config=types.GenerateContentConfig(
                    temperature=0,
                    max_output_tokens=32,
                ),
            )
        output = getattr(response, "text", None) or ""
        print(f"PASS: {label} ({model_name}); response chars={len(output)}")
        if output:
            print("Response preview:", output[:240].replace("\n", " "))
        else:
            print("NOTE: response text shortcut was empty; check the app's candidate parsing if this also happens there.")
        return True
    except Exception as exc:
        status = getattr(exc, "code", None) or getattr(exc, "status_code", None) or "unknown"
        # Show only a short exception message; never print environment variables or headers.
        message = " ".join(str(exc).split())
        print(f"FAIL: {label} ({model_name}); status={status}; type={type(exc).__name__}")
        print("Message:", message[:350])
        return False

for candidate in dict.fromkeys([model, fallback] if fallback else [model]):
    plain_ok = run_test(candidate, "plain-text request", structured=False)
    json_ok = run_test(candidate, "structured JSON request", structured=True)
    print(f"Summary for {candidate}: plain={'PASS' if plain_ok else 'FAIL'}, structured={'PASS' if json_ok else 'FAIL'}")
    print("-" * 60)

print("Send back this test output only. Never share the actual API key or your .env file.")
