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
from datetime import date, datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Annotated, Any
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import certifi
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError, SQLAlchemyError
from starlette.concurrency import run_in_threadpool


PROJECT_ROOT = Path(__file__).resolve().parents[1]
PIPELINE_ROOT = PROJECT_ROOT / "my-pipeline"
sys.path.insert(0, str(PIPELINE_ROOT))

from import_pipeline import (  # noqa: E402
    PipelineValidationError,
    ROLES,
    create_database_engine,
    detect_import_reviews,
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
    allow_methods=["GET", "POST", "PATCH", "DELETE"],
    allow_headers=["Authorization", "Content-Type"],
)

MAX_UPLOAD_BYTES = int(os.getenv("NPINDEX_MAX_UPLOAD_BYTES", str(25 * 1024 * 1024)))
jobs: dict[str, dict[str, Any]] = {}
job_contexts: dict[str, dict[str, Any]] = {}
jobs_lock = threading.Lock()
migration_lock = threading.Lock()


def _column(name: str, data_type: str = "text", *, nullable: bool = False, editable: bool = True, multiline: bool = False) -> dict[str, Any]:
    return {
        "name": name,
        "type": data_type,
        "nullable": nullable,
        "editable": editable,
        "multiline": multiline,
    }


MANAGED_TABLES: dict[str, dict[str, Any]] = {
    "phrases": {
        "label": "Phrases",
        "key": "phrase_id",
        "deletable": True,
        "columns": [
            _column("phrase_id", editable=False),
            _column("phrase_main", multiline=True),
            _column("phrase_translation", multiline=True),
            _column("language_id", "integer"),
            _column("session_id"),
            _column("tag_sequence", multiline=True),
        ],
    },
    "tokens": {
        "label": "Tokens",
        "key": "token_id",
        "columns": [
            _column("token_id", editable=False),
            _column("token"),
            _column("gloss", nullable=True),
            _column("gloss_id", nullable=True),
            _column("lexicon_id", nullable=True),
            _column("phrase_id", nullable=True),
        ],
    },
    "annotations": {
        "label": "Annotations",
        "key": "annotation_id",
        "columns": [
            _column("annotation_id", editable=False),
            _column("phrase_id"),
            _column("order", "integer", nullable=True),
            _column("tag", nullable=True),
            _column("category", nullable=True),
            _column("subcategory", nullable=True),
            _column("type", nullable=True),
            _column("token"),
        ],
    },
    "lexicon": {
        "label": "Lexicon",
        "key": "lexicon_id",
        "columns": [
            _column("lexicon_id", editable=False),
            _column("lexical_item"),
            _column("language_id", "integer", nullable=True),
            _column("gloss", nullable=True, multiline=True),
        ],
    },
    "glosses": {
        "label": "Glosses",
        "key": "gloss_id",
        "columns": [
            _column("gloss_id", editable=False),
            _column("gloss"),
            _column("lexicon_id", nullable=True),
            _column("language_id", "integer", nullable=True),
        ],
    },
    "languages": {
        "label": "Languages",
        "key": "language_id",
        "columns": [
            _column("language_id", "integer", editable=False),
            _column("iso_code"),
            _column("language_name"),
        ],
    },
    "sessions": {
        "label": "Sessions",
        "key": "session_id",
        "columns": [
            _column("session_id", editable=False),
            _column("language_id", "integer"),
            _column("source_id", "integer"),
            _column("annotator_id", "integer"),
            _column("session_date", "date"),
        ],
    },
    "contexts": {
        "label": "Contexts",
        "key": "context_id",
        "columns": [
            _column("context_id", "integer", editable=False),
            _column("context_full", multiline=True),
            _column("language_id", "integer"),
            _column("session_id"),
            _column("source_id", "integer", nullable=True),
            _column("source_code", nullable=True),
        ],
    },
    "sources": {
        "label": "Sources",
        "key": "source_id",
        "columns": [
            _column("source_id", "integer", editable=False),
            _column("source_name"),
            _column("language_id", "integer"),
        ],
    },
    "annotators": {
        "label": "Annotators",
        "key": "annotator_id",
        "columns": [
            _column("annotator_id", "integer", editable=False),
            _column("annotator_name"),
        ],
    },
}


class RecordUpdate(BaseModel):
    values: dict[str, Any] = Field(default_factory=dict)


class DeleteConfirmation(BaseModel):
    confirmation: str


class ReviewDecisionRequest(BaseModel):
    review_id: str
    action: str
    match_id: str | None = None
    apply_to_all: bool = False


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


def _review_summary(review: dict[str, Any] | None) -> dict[str, Any]:
    review = review or {}
    items = review.get("items") or []
    actions: dict[str, int] = {}
    for item in items:
        action = (item.get("decision") or {}).get("action")
        if action:
            actions[action] = actions.get(action, 0) + 1
    return {
        "total_flagged": len(items),
        "resolved": sum(actions.values()),
        "pending": sum(1 for item in items if not item.get("decision")),
        "automatic_matches": len(review.get("automatic_resolutions") or {}),
        "actions": actions,
    }


def _cleanup_job_context(job_id: str) -> None:
    with jobs_lock:
        context = job_contexts.pop(job_id, None)
    if context:
        shutil.rmtree(context["temp_dir"], ignore_errors=True)


def _execution_options(context: dict[str, Any], review: dict[str, Any] | None) -> dict[str, Any]:
    source_name = context["source_name"]
    annotator_name = context["annotator_name"]
    automatic = (review or {}).get("automatic_resolutions") or {}
    source_name = automatic.get("source_name", source_name)
    annotator_name = automatic.get("annotator_name", annotator_name)
    skip_phrase_ids: set[str] = set()
    force_duplicate_phrase_ids: set[str] = set()
    skip_all = False

    for item in (review or {}).get("items") or []:
        decision = item.get("decision") or {}
        action = decision.get("action")
        if item["kind"] == "similarity":
            if action == "use_existing":
                match = next(
                    (candidate for candidate in item["matches"] if candidate["id"] == decision.get("match_id")),
                    None,
                )
                if match and item["record_type"] == "source":
                    source_name = match["label"]
                elif match and item["record_type"] == "annotator":
                    annotator_name = match["label"]
            elif action == "skip_record":
                skip_all = True
        elif item["record_type"] == "phrase":
            if action == "skip_duplicate":
                skip_phrase_ids.add(str(item["record_key"]))
            elif action == "import_anyway":
                force_duplicate_phrase_ids.add(str(item["record_key"]))

    return {
        "source_name": source_name,
        "annotator_name": annotator_name,
        "skip_phrase_ids": skip_phrase_ids,
        "force_duplicate_phrase_ids": force_duplicate_phrase_ids,
        "skip_all": skip_all,
        "review_summary": _review_summary(review),
    }


def _execute_job(job_id: str) -> None:
    with jobs_lock:
        context = job_contexts.get(job_id)
        job = jobs.get(job_id)
        review = dict(job.get("review") or {}) if job else None
    if not context or not job:
        return

    def on_progress(event: dict[str, Any]) -> None:
        _update_job(
            job_id,
            progress={
                "stage": event.get("stage", "import"),
                "message": event.get("message", "Importing data."),
                "percent": event.get("percent", 0),
                "processed": event.get("processed", 0),
                "total": event.get("total", 0),
            },
        )

    try:
        options = _execution_options(context, review)
        _update_job(
            job_id,
            status="waiting",
            review_summary=options["review_summary"],
            progress={
                "stage": "waiting",
                "message": "Review decisions saved. Waiting for the migration worker.",
                "percent": 3,
                "processed": 0,
                "total": job["progress"].get("total", 0),
            },
        )
        with migration_lock:
            _update_job(job_id, status="running", resumed_at=_utc_now())
            result = run_import(
                context["paths"],
                engine=database_engine(),
                source_name=options["source_name"],
                annotator_name=options["annotator_name"],
                progress=on_progress,
                skip_phrase_ids=options["skip_phrase_ids"],
                force_duplicate_phrase_ids=options["force_duplicate_phrase_ids"],
                duplicate_nonce=job_id,
                skip_all=options["skip_all"],
                review_summary=options["review_summary"],
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
        _cleanup_job_context(job_id)


def _run_job(job_id: str) -> None:
    with jobs_lock:
        context = job_contexts.get(job_id)
    if not context:
        return
    _update_job(
        job_id,
        status="running",
        started_at=_utc_now(),
        progress={
            "stage": "review_scan",
            "message": "Checking for similar values and duplicate records.",
            "percent": 2,
            "processed": 0,
            "total": 0,
        },
    )
    try:
        review_scan = detect_import_reviews(
            context["paths"],
            database_engine(),
            source_name=context["source_name"],
            annotator_name=context["annotator_name"],
        )
        review = {
            "items": [{**item, "decision": None} for item in review_scan["items"]],
            "automatic_resolutions": review_scan["automatic_resolutions"],
            "similarity_cutoff": review_scan["similarity_cutoff"],
        }
        if review["items"]:
            summary = _review_summary(review)
            _update_job(
                job_id,
                status="review_required",
                review=review,
                review_summary=summary,
                progress={
                    "stage": "review",
                    "message": f"Administrator review required for {summary['pending']} item(s).",
                    "percent": 3,
                    "processed": 0,
                    "total": len(review["items"]),
                },
            )
            return
        _update_job(job_id, review=review, review_summary=_review_summary(review))
        _execute_job(job_id)
    except Exception as exc:
        _update_job(job_id, status="failed", error=str(exc), completed_at=_utc_now())
        _cleanup_job_context(job_id)


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/admin/me")
async def admin_me(user: Annotated[dict[str, Any], Depends(require_admin)]) -> dict[str, Any]:
    return {"id": user.get("id"), "email": user.get("email")}


def _managed_table(table_name: str) -> dict[str, Any]:
    table = MANAGED_TABLES.get(table_name)
    if table is None:
        raise HTTPException(status_code=404, detail="This table is not available for data management.")
    return table


def _quote(connection: Any, identifier: str) -> str:
    return connection.dialect.identifier_preparer.quote(identifier)


def _column_by_name(table: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {column["name"]: column for column in table["columns"]}


def _coerce_value(column: dict[str, Any], value: Any) -> Any:
    if value is None or (value == "" and column["nullable"]):
        if column["nullable"]:
            return None
        if value is None:
            raise ValueError(f"{column['name']} is required.")
    if column["type"] == "integer":
        if isinstance(value, bool):
            raise ValueError(f"{column['name']} must be an integer.")
        try:
            return int(value)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{column['name']} must be an integer.") from exc
    if column["type"] == "date":
        try:
            return date.fromisoformat(str(value))
        except ValueError as exc:
            raise ValueError(f"{column['name']} must be a date in YYYY-MM-DD format.") from exc
    return str(value)


def _coerce_record_key(table: dict[str, Any], record_id: str) -> Any:
    key_column = _column_by_name(table)[table["key"]]
    return _coerce_value(key_column, record_id)


def _database_error_detail(exc: SQLAlchemyError, action: str) -> str:
    diagnostic = getattr(getattr(exc, "orig", None), "diag", None)
    message = getattr(diagnostic, "message_primary", None)
    if message:
        return f"The record could not be {action}: {message}"
    return f"The record could not be {action} because it conflicts with the database schema or related records."


def _list_managed_records(table_name: str, search: str, limit: int, offset: int) -> dict[str, Any]:
    table = _managed_table(table_name)
    with database_engine().connect() as connection:
        quoted_table = _quote(connection, table_name)
        quoted_columns = [_quote(connection, column["name"]) for column in table["columns"]]
        where = ""
        parameters: dict[str, Any] = {"limit": limit, "offset": offset}
        if search:
            comparisons = [f"CAST({column} AS TEXT) ILIKE :search" for column in quoted_columns]
            where = " WHERE " + " OR ".join(comparisons)
            parameters["search"] = f"%{search}%"
        total = connection.execute(
            text(f"SELECT count(*) FROM public.{quoted_table}{where}"),
            parameters,
        ).scalar_one()
        rows = connection.execute(
            text(
                f"SELECT {', '.join(quoted_columns)} FROM public.{quoted_table}{where} "
                f"ORDER BY {_quote(connection, table['key'])} LIMIT :limit OFFSET :offset"
            ),
            parameters,
        ).mappings().all()
    return {
        "table": table_name,
        "key": table["key"],
        "items": [dict(row) for row in rows],
        "total": total,
        "limit": limit,
        "offset": offset,
    }


def _update_managed_record(table_name: str, record_id: str, values: dict[str, Any]) -> dict[str, Any]:
    table = _managed_table(table_name)
    columns = _column_by_name(table)
    if not values:
        raise HTTPException(status_code=400, detail="Provide at least one field to update.")

    unknown = sorted(set(values) - set(columns))
    immutable = sorted(name for name in values if name in columns and not columns[name]["editable"])
    if unknown:
        raise HTTPException(status_code=400, detail=f"Unsupported field(s): {', '.join(unknown)}.")
    if immutable:
        raise HTTPException(status_code=400, detail=f"Primary key field(s) cannot be changed: {', '.join(immutable)}.")

    try:
        prepared = {name: _coerce_value(columns[name], value) for name, value in values.items()}
        key_value = _coerce_record_key(table, record_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        with database_engine().begin() as connection:
            quoted_table = _quote(connection, table_name)
            assignments = []
            parameters: dict[str, Any] = {"record_key": key_value}
            for index, (name, value) in enumerate(prepared.items()):
                parameter = f"value_{index}"
                assignments.append(f"{_quote(connection, name)} = :{parameter}")
                parameters[parameter] = value
            returning = ", ".join(_quote(connection, column["name"]) for column in table["columns"])
            row = connection.execute(
                text(
                    f"UPDATE public.{quoted_table} SET {', '.join(assignments)} "
                    f"WHERE {_quote(connection, table['key'])} = :record_key RETURNING {returning}"
                ),
                parameters,
            ).mappings().one_or_none()
            if row is None:
                raise HTTPException(status_code=404, detail="Record not found.")
            return dict(row)
    except HTTPException:
        raise
    except (IntegrityError, SQLAlchemyError) as exc:
        raise HTTPException(status_code=409, detail=_database_error_detail(exc, "updated")) from exc


def _delete_phrase_graph(connection: Any, phrase_id: str) -> dict[str, int]:
    phrase = connection.execute(
        text("SELECT session_id FROM public.phrases WHERE phrase_id = :phrase_id"),
        {"phrase_id": phrase_id},
    ).mappings().one_or_none()
    if phrase is None:
        raise HTTPException(status_code=404, detail="Phrase record not found.")

    lexicon_ids = connection.execute(
        text(
            "SELECT DISTINCT lexicon_id FROM public.tokens "
            "WHERE phrase_id = :phrase_id AND lexicon_id IS NOT NULL"
        ),
        {"phrase_id": phrase_id},
    ).scalars().all()
    gloss_ids = connection.execute(
        text(
            "SELECT DISTINCT gloss_id FROM public.tokens "
            "WHERE phrase_id = :phrase_id AND gloss_id IS NOT NULL"
        ),
        {"phrase_id": phrase_id},
    ).scalars().all()

    deleted = {
        "annotations": connection.execute(
            text("DELETE FROM public.annotations WHERE phrase_id = :phrase_id"),
            {"phrase_id": phrase_id},
        ).rowcount,
        "tokens": connection.execute(
            text("DELETE FROM public.tokens WHERE phrase_id = :phrase_id"),
            {"phrase_id": phrase_id},
        ).rowcount,
    }
    deleted["phrases"] = connection.execute(
        text("DELETE FROM public.phrases WHERE phrase_id = :phrase_id"),
        {"phrase_id": phrase_id},
    ).rowcount

    deleted["glosses"] = connection.execute(
        text(
            """DELETE FROM public.glosses AS gloss
               WHERE (
                   gloss.gloss_id = ANY(CAST(:gloss_ids AS text[]))
                   OR gloss.lexicon_id = ANY(CAST(:lexicon_ids AS text[]))
               )
               AND NOT EXISTS (
                   SELECT 1 FROM public.tokens AS token WHERE token.gloss_id = gloss.gloss_id
               )"""
        ),
        {"gloss_ids": list(gloss_ids), "lexicon_ids": list(lexicon_ids)},
    ).rowcount
    deleted["lexicon"] = connection.execute(
        text(
            """DELETE FROM public.lexicon AS lexicon
               WHERE lexicon.lexicon_id = ANY(CAST(:lexicon_ids AS text[]))
               AND NOT EXISTS (
                   SELECT 1 FROM public.tokens AS token WHERE token.lexicon_id = lexicon.lexicon_id
               )
               AND NOT EXISTS (
                   SELECT 1 FROM public.glosses AS gloss WHERE gloss.lexicon_id = lexicon.lexicon_id
               )"""
        ),
        {"lexicon_ids": list(lexicon_ids)},
    ).rowcount

    session_id = phrase["session_id"]
    session_is_used = connection.execute(
        text("SELECT EXISTS(SELECT 1 FROM public.phrases WHERE session_id = :session_id)"),
        {"session_id": session_id},
    ).scalar_one()
    if session_is_used:
        deleted["contexts"] = 0
        deleted["sessions"] = 0
    else:
        deleted["contexts"] = connection.execute(
            text("DELETE FROM public.contexts WHERE session_id = :session_id"),
            {"session_id": session_id},
        ).rowcount
        deleted["sessions"] = connection.execute(
            text("DELETE FROM public.sessions WHERE session_id = :session_id"),
            {"session_id": session_id},
        ).rowcount
    return {name: count or 0 for name, count in deleted.items()}


def _delete_managed_record(table_name: str, record_id: str, confirmation: str) -> dict[str, Any]:
    table = _managed_table(table_name)
    if not table.get("deletable"):
        raise HTTPException(status_code=405, detail="Only phrase records can be deleted from Data Management.")
    if confirmation != record_id:
        raise HTTPException(status_code=400, detail="The confirmation value does not match the record ID.")
    try:
        key_value = _coerce_record_key(table, record_id)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    try:
        with database_engine().begin() as connection:
            deleted_records = _delete_phrase_graph(connection, str(key_value))
        return {
            "deleted": True,
            "table": table_name,
            "record_id": record_id,
            "deleted_records": deleted_records,
            "preserved": ["sources", "annotators", "shared related records"],
        }
    except HTTPException:
        raise
    except (IntegrityError, SQLAlchemyError) as exc:
        raise HTTPException(status_code=409, detail=_database_error_detail(exc, "deleted")) from exc


@app.get("/api/admin/data-management/tables")
async def managed_tables(
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    return {
        "tables": [
            {
                "name": name,
                "label": table["label"],
                "key": table["key"],
                "deletable": bool(table.get("deletable")),
                "columns": table["columns"],
            }
            for name, table in MANAGED_TABLES.items()
        ]
    }


@app.get("/api/admin/data-management/{table_name}")
async def managed_records(
    table_name: str,
    _user: Annotated[dict[str, Any], Depends(require_admin)],
    search: Annotated[str, Query(max_length=200)] = "",
    limit: Annotated[int, Query(ge=1, le=100)] = 25,
    offset: Annotated[int, Query(ge=0)] = 0,
) -> dict[str, Any]:
    return await run_in_threadpool(_list_managed_records, table_name, search.strip(), limit, offset)


@app.patch("/api/admin/data-management/{table_name}/{record_id}")
async def update_managed_record(
    table_name: str,
    record_id: str,
    payload: RecordUpdate,
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    record = await run_in_threadpool(_update_managed_record, table_name, record_id, payload.values)
    return {"record": record}


@app.delete("/api/admin/data-management/{table_name}/{record_id}")
async def delete_managed_record(
    table_name: str,
    record_id: str,
    payload: DeleteConfirmation,
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    return await run_in_threadpool(_delete_managed_record, table_name, record_id, payload.confirmation)


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
        "review": None,
        "review_summary": {
            "total_flagged": 0,
            "resolved": 0,
            "pending": 0,
            "automatic_matches": 0,
            "actions": {},
        },
    }
    with jobs_lock:
        jobs[job_id] = job
        job_contexts[job_id] = {
            "paths": paths,
            "temp_dir": temp_dir,
            "source_name": source_name,
            "annotator_name": annotator_name,
        }
    background_tasks.add_task(_run_job, job_id)
    return job


@app.post("/api/admin/migrations/{job_id}/review")
async def resolve_migration_review(
    job_id: str,
    payload: ReviewDecisionRequest,
    background_tasks: BackgroundTasks,
    _user: Annotated[dict[str, Any], Depends(require_admin)],
) -> dict[str, Any]:
    cleanup_context: dict[str, Any] | None = None
    resume = False
    with jobs_lock:
        job = jobs.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail="Migration job not found.")
        if job["status"] != "review_required":
            raise HTTPException(status_code=409, detail="This migration is not waiting for a review decision.")
        review = job.get("review") or {}
        item = next((candidate for candidate in review.get("items", []) if candidate["id"] == payload.review_id), None)
        if not item:
            raise HTTPException(status_code=404, detail="Review item not found.")
        if item.get("decision"):
            raise HTTPException(status_code=409, detail="This review item has already been resolved.")
        if payload.action not in item["allowed_actions"]:
            raise HTTPException(status_code=400, detail="That decision is not valid for this review item.")
        if payload.action == "use_existing":
            if not payload.match_id or not any(match["id"] == payload.match_id for match in item["matches"]):
                raise HTTPException(status_code=400, detail="Choose one of the suggested existing values.")
        if payload.apply_to_all and (
            item["kind"] != "exact_duplicate" or payload.action not in {"skip_duplicate", "import_anyway"}
        ):
            raise HTTPException(status_code=400, detail="Apply to all is available only for exact duplicate decisions.")

        targets = [item]
        if payload.apply_to_all:
            targets = [
                candidate
                for candidate in review["items"]
                if candidate["kind"] == "exact_duplicate" and not candidate.get("decision")
            ]
        decision = {
            "action": payload.action,
            "match_id": payload.match_id,
            "decided_at": _utc_now(),
            "applied_to_all": payload.apply_to_all,
        }
        for target in targets:
            target["decision"] = dict(decision)

        summary = _review_summary(review)
        job["review_summary"] = summary
        if payload.action == "cancel":
            job["status"] = "canceled"
            job["error"] = "Migration canceled by the administrator during review. No records were imported."
            job["completed_at"] = _utc_now()
            job["progress"] = {
                "stage": "canceled",
                "message": "Migration canceled. No records were imported.",
                "percent": 0,
                "processed": 0,
                "total": 0,
            }
            job["result"] = {
                "status": "canceled",
                "processed": 0,
                "successful": 0,
                "skipped": 0,
                "failed": 0,
                "tables": {},
                "errors": [],
                "warnings": ["Migration canceled during administrator review."],
                "review_summary": summary,
            }
            cleanup_context = job_contexts.pop(job_id, None)
        elif summary["pending"] == 0:
            job["status"] = "waiting"
            job["progress"] = {
                "stage": "waiting",
                "message": "All review decisions saved. Resuming migration.",
                "percent": 3,
                "processed": summary["resolved"],
                "total": summary["total_flagged"],
            }
            resume = True
        else:
            job["progress"] = {
                "stage": "review",
                "message": f"Administrator review required for {summary['pending']} item(s).",
                "percent": 3,
                "processed": summary["resolved"],
                "total": summary["total_flagged"],
            }
        response = dict(job)

    if cleanup_context:
        shutil.rmtree(cleanup_context["temp_dir"], ignore_errors=True)
    if resume:
        background_tasks.add_task(_execute_job, job_id)
    return response


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
