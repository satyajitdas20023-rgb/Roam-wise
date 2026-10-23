# RoamWise Flask API

This is the local Flask API used by the Next.js RoamWise interface. It uses a
rules-based demonstration planner and a SQLite database; it does **not** call
Gemma, an AI API, or live travel services.

## Run locally on Windows

From the project root, open one PowerShell terminal:

```powershell
cd backend
python -m venv .venv
.venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python seed.py
python app.py
```

The server stays in the foreground and listens at `http://127.0.0.1:5000`; do
not close that terminal while using the frontend. It initializes/seeds the same
database at startup as a safeguard. The SQLite file is
`backend/instance/data/roamwise.db`.

In a second PowerShell terminal from the project root:

```powershell
npm install
npm run dev
```

Open the URL printed by Next.js (normally `http://localhost:3000`). The
frontend reads `NEXT_PUBLIC_API_BASE_URL` from `.env.local`; its supplied value
is `http://127.0.0.1:5000/api`.

## Verify the API

```powershell
Invoke-RestMethod http://127.0.0.1:5000/api/health
Invoke-RestMethod "http://127.0.0.1:5000/api/destinations?q=new"
```

To generate a first saved trip, start both processes, open **Plan a trip**, and
submit the form with a seeded destination such as New York or Puri. Plans are
saved automatically. The Saved trips section can reopen a plan after refresh.

## Endpoints

| Method | Endpoint | Purpose |
| --- | --- | --- |
| GET | `/api/health` | Service and real database connection check |
| GET | `/api/destinations?q=&limit=` | Search sample destinations by name or region |
| GET | `/api/destinations/<id>` | Destination with attractions |
| POST | `/api/plan` | Validate, generate and persist a rules-based plan |
| GET | `/api/trips?limit=&offset=` | Recent saved trips |
| GET | `/api/trips/<id>` | One saved plan |
| DELETE | `/api/trips/<id>` | Delete a saved plan |

`POST /api/plan` accepts:

```json
{
  "destination": "Puri",
  "duration": 2,
  "budget": 12000,
  "travelers": 2,
  "transport": "Flexible",
  "interests": ["Temples", "Local food"]
}
```

All pricing is clearly marked as illustrative whole-group INR estimates, not
current verified prices or availability.

## Tests

From `backend` with the virtual environment activated:

```powershell
python -m pytest
```

Tests use a separate temporary SQLite database and do not modify the local
development database.

## Troubleshooting

- If PowerShell prevents activation, use `Set-ExecutionPolicy -Scope Process Bypass`
  for that one shell, then rerun the activate command.
- If the frontend shows an API error, ensure Flask is running on port 5000 and
  that `.env.local` contains the documented API URL. Restart `npm run dev` after
  changing `.env.local`.
- For a fresh local dataset, stop Flask and delete only
  `backend/instance/data/roamwise.db`; the next startup reseeds it. This removes
  locally saved trips.
