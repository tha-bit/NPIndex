"""Secure API wrapper for the NPIndex Python import pipeline."""

from __future__ import annotations

import json
import os
import shutil
import ssl
import sys
import tempfile
import threading
import uuid
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_ROOT = PROJECT_ROOT / "my-pipeline"
sys.path.insert(0, str(PIPELINE_ROOT))

from import_pipeline import (  # noqa: E402
    PipelineValidationError,
    ROLES,
    create_database_engine,
    run_import,
    validate_import,
)


app = FastAPI(
    title="NPIndex Migration API",
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)

allowed_origins = [
    origin.strip()
    for origin in os.getenv(
        "NPINDEX_ADMIN_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type"],
)

MAX_UPLOAD_BYTES = int(os.getenv("NPINDEX_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
jobs: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
migration_lock = threading.Lock()


@lru_cache(maxsize=1)
def database_engine():
    return create_database_engine()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _admin_emails() -> set[str]:
    return {
        email.strip().casefold()
        for email in os.getenv("NPINDEX_ADMIN_EMAILS", "").split(",")
        if email.strip()
    }


def _load_supabase_user(access_token: str) -> dict[str, Any]:
    supabase_url = os.getenv("SUPABASE_URL", "").rstrip("/")
    anon_key = os.getenv("SUPABASE_ANON_KEY", "")
    if not supabase_url or not anon_key:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Admin authentication is not configured on the server.",
        )

    request = Request(
        f"{supabase_url}/auth/v1/user",
        headers={"apikey": anon_key, "Authorization": f"Bearer {access_token}"},
    )
    try:
        ssl_context = ssl.create_default_context(cafile=certifi.where())
        with urlopen(request, timeout=10, context=ssl_context) as response:
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        if exc.code in {401, 403}:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Your session is invalid or expired.") from exc
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Supabase authentication failed.") from exc
    except (URLError, TimeoutError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Could not verify the admin session.") from exc


async def require_admin(authorization: Annotated[str | None, Header()] = None) -> dict[str, Any]:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="An authenticated admin session is required.")
    user = await run_in_threadpool(_load_supabase_user, authorization.removeprefix("Bearer ").strip())
    email = str(user.get("email") or "").casefold()
    app_metadata = user.get("app_metadata") or {}
    roles = app_metadata.get("roles") or []
    is_admin_claim = app_metadata.get("role") == "admin" or "admin" in roles
    if not is_admin_claim and email not in _admin_emails():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="This account is not an NPIndex administrator.")
    return user


async def _save_upload_bundle(uploads: dict[str, UploadFile]) -> tuple[Path, dict[str, Path]]:
    temp_dir = Path(tempfile.mkdtemp(prefix="npindex-import-"))
    saved: dict[str, Path] = {}
    total_size = 0
    try:
        for role in ROLES:
            upload = uploads[role]
            filename = Path(upload.filename or f"{role}.csv").name
            if Path(filename).suffix.lower() != ".csv":
                raise HTTPException(status_code=400, detail=f"The file selected for {role} is not a CSV file.")
            target = temp_dir / f"{role}-{filename}"
            with target.open("wb") as output:
                while chunk := await upload.read(1024 * 1024):
                    total_size += len(chunk)
                    if total_size > MAX_UPLOAD_BYTES:
                        raise HTTPException(status_code=413, detail="The combined upload is too large.")
                    output.write(chunk)
            saved[role] = target
        return temp_dir, saved
    except Exception:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def _validation_payload(paths: dict[str, Path]) -> dict[str, Any]:
    try:
        report = validate_import(paths, database_engine())
        return report.to_dict()
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Migration validation could not reach the database: {exc}") from exc


def _update_job(job_id: str, **updates: Any) -> None:
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].update(updates)


def _run_job(job_id: str, paths: dict[str, Path], temp_dir: Path, source_name: str, annotator_name: str) -> None:
    _update_job(job_id, status="waiting", progress={"stage": "waiting", "message": "Waiting for the migration worker.", "percent": 0, "processed": 0, "total": 0})

    def on_progress(event: dict[str, Any]) -> None:
        progress_payload = {
            "stage": event.get("stage", "import"),
            "message": event.get("message", "Importing data."),
            "percent": event.get("percent", 0),
            "processed": event.get("processed", 0),
            "total": event.get("total", 0),
        }
        _update_job(job_id, progress=progress_payload)

    try:
        with migration_lock:
            _update_job(job_id, status="running", started_at=_utc_now())
            result = run_import(
                paths,
                engine=database_engine(),
                source_name=source_name,
                annotator_name=annotator_name,
                progress=on_progress,
            )
        _update_job(
            job_id,
            status=result.status,
            progress={
                "stage": "complete",
                "message": "Migration completed.",
                "percent": 100,
                "processed": result.processed,
                "total": result.processed,
            },
            result=result.to_dict(),
            completed_at=_utc_now(),
        )
    except PipelineValidationError as exc:
        _update_job(
            job_id,
            status="failed",
            error="The uploaded bundle failed validation.",
            validation=exc.report.to_dict(),
            completed_at=_utc_now(),
        )
    except Exception as exc:
        _update_job(job_id, status="failed", error=str(exc), completed_at=_utc_now())
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/admin/me")
async def admin_me(user: Annotated[dict[str, Any], Depends(require_admin)]) -> dict[str, Any]:
    return {"id": user.get("id"), "email": user.get("email")}


@app.post("/api/admin/migrations/validate")
async def validate_migration(
    lexicon: Annotated[UploadFile, File()],
    phrases: Annotated[UploadFile, File()],
    tokens: Annotated[UploadFile, File()],
    annotations: Annotated[UploadFile, File()],
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    temp_dir, paths = await _save_upload_bundle({
        "lexicon": lexicon,
        "phrases": phrases,
        "tokens": tokens,
        "annotations": annotations,
    })
    try:
        return await run_in_threadpool(_validation_payload, paths)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


@app.post("/api/admin/migrations", status_code=202)
async def start_migration(
    background_tasks: BackgroundTasks,
    lexicon: Annotated[UploadFile, File()],
    phrases: Annotated[UploadFile, File()],
    tokens: Annotated[UploadFile, File()],
    annotations: Annotated[UploadFile, File()],
    source_name: Annotated[str, Form()],
    annotator_name: Annotated[str, Form()],
    user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    source_name = source_name.strip()
    annotator_name = annotator_name.strip()
    if not source_name or not annotator_name:
        raise HTTPException(status_code=400, detail="Source name and annotator name are required.")

    temp_dir, paths = await _save_upload_bundle({
        "lexicon": lexicon,
        "phrases": phrases,
        "tokens": tokens,
        "annotations": annotations,
    })
    validation = await run_in_threadpool(_validation_payload, paths)
    if not validation["valid"]:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise HTTPException(status_code=422, detail={"message": "The uploaded bundle failed validation.", "validation": validation})

    job_id = str(uuid.uuid4())
    job = {
        "id": job_id,
        "status": "queued",
        "created_at": _utc_now(),
        "created_by": user.get("email"),
        "source_name": source_name,
        "annotator_name": annotator_name,
        "validation": validation,
        "progress": {
            "stage": "queued",
            "message": "Migration queued.",
            "percent": 0,
            "processed": 0,
            "total": sum(validation.get("row_counts", {}).values()),
        },
        "result": None,
        "error": None,
    }
    with jobs_lock:
        jobs[job_id] = job
    background_tasks.add_task(_run_job, job_id, paths, temp_dir, source_name, annotator_name)
    return job


@app.get("/api/admin/migrations/{job_id}")
async def migration_status(
    job_id: str,
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Migration job not found.")
        return dict(job)
