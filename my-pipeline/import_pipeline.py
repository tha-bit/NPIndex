"""Validated, idempotent import pipeline for the NPIndex PostgreSQL schema.

This module is deliberately independent from the web API.  The API saves an
uploaded four-file CSV bundle and calls ``validate_import`` / ``run_import``;
the command-line entry point calls the same functions.
"""

from __future__ import annotations

import argparse
import csv
import difflib
import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, field
from datetime import date, datetime
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

from sqlalchemy import Engine, create_engine, text


ProgressCallback = Callable[[dict[str, Any]], None]
ROLES = ("lexicon", "phrases", "tokens", "annotations")
BundlePaths = Iterable[str | Path] | Mapping[str, str | Path]

ALIASES = {
    "lexicon": {
        "lexid": "lex_id",
        "wordform": "word_form",
        "phraseids": "phrase_ids",
        "senseid": "sense_id",
    },
    "phrases": {"phraseid": "phrase_id"},
    "tokens": {
        "tokenid": "token_id",
        "phraseid": "phrase_id",
        "wordform": "word_form",
        "lexid": "lex_id",
        "senseid": "sense_id",
    },
    "annotations": {
        "annotationid": "annotation_id",
        "phraseid": "phrase_id",
        "tokenids": "token_ids",
    },
}

REQUIRED_COLUMNS = {
    "lexicon": {"lex_id", "word_form", "language"},
    "phrases": {"phrase_id", "phrase", "language"},
    "tokens": {"token_id", "phrase_id", "position", "word_form"},
    "annotations": {"annotation_id", "phrase_id", "order", "category"},
}


@dataclass
class ValidationIssue:
    level: str
    message: str
    table: str | None = None
    row: int | None = None


@dataclass
class ValidationReport:
    valid: bool = True
    files: dict[str, str] = field(default_factory=dict)
    row_counts: dict[str, int] = field(default_factory=dict)
    languages: list[str] = field(default_factory=list)
    issues: list[ValidationIssue] = field(default_factory=list)

    def add_error(self, message: str, table: str | None = None, row: int | None = None) -> None:
        self.valid = False
        self.issues.append(ValidationIssue("error", message, table, row))

    def add_warning(self, message: str, table: str | None = None, row: int | None = None) -> None:
        self.issues.append(ValidationIssue("warning", message, table, row))

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class TableStats:
    processed: int = 0
    successful: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass
class ImportResult:
    status: str = "completed"
    processed: int = 0
    successful: int = 0
    skipped: int = 0
    failed: int = 0
    tables: dict[str, TableStats] = field(default_factory=dict)
    errors: list[dict[str, Any]] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    review_summary: dict[str, Any] = field(default_factory=dict)

    def table(self, name: str) -> TableStats:
        if name not in self.tables:
            self.tables[name] = TableStats()
        return self.tables[name]

    def finalize(self) -> None:
        self.processed = sum(item.processed for item in self.tables.values())
        self.successful = sum(item.successful for item in self.tables.values())
        self.skipped = sum(item.skipped for item in self.tables.values())
        self.failed = sum(item.failed for item in self.tables.values())
        if self.failed:
            self.status = "completed_with_errors"

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class PipelineValidationError(ValueError):
    def __init__(self, report: ValidationReport):
        super().__init__("The import bundle failed validation.")
        self.report = report


def _column_name(value: str) -> str:
    value = value.lstrip("\ufeff").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "_", value).strip("_")
    return value


def _clean_value(value: Any) -> Any:
    if value is None:
        return None
    cleaned = str(value).strip()
    return None if cleaned.lower() in {"", "nan", "none", "null"} else cleaned


def _read_headers(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle)
        try:
            return [_column_name(item) for item in next(reader)]
        except StopIteration:
            return []


def _headers_for_role(headers: Iterable[str], role: str) -> set[str]:
    aliases = ALIASES[role]
    return {aliases.get(header, header) for header in headers}


def classify_files(paths: Iterable[str | Path]) -> dict[str, Path]:
    classified: dict[str, Path] = {}
    errors: list[str] = []

    for raw_path in paths:
        path = Path(raw_path)
        headers = _read_headers(path)
        matches = [role for role in ROLES if REQUIRED_COLUMNS[role].issubset(_headers_for_role(headers, role))]
        if len(matches) != 1:
            errors.append(
                f"{path.name}: could not uniquely identify the CSV type from its columns "
                f"({', '.join(headers) or 'no headers'})."
            )
            continue
        role = matches[0]
        if role in classified:
            errors.append(f"Both {classified[role].name} and {path.name} look like the {role} table.")
        else:
            classified[role] = path

    missing = [role for role in ROLES if role not in classified]
    if missing:
        errors.append(f"Missing CSV file(s) for: {', '.join(missing)}.")
    if errors:
        raise ValueError(" ".join(errors))
    return classified


def assign_files(paths: Mapping[str, str | Path]) -> dict[str, Path]:
    unexpected = sorted(set(paths) - set(ROLES))
    missing = [role for role in ROLES if role not in paths]
    errors: list[str] = []
    if unexpected:
        errors.append(f"Unsupported CSV role(s): {', '.join(unexpected)}.")
    if missing:
        errors.append(f"Missing CSV file(s) for: {', '.join(missing)}.")

    assigned: dict[str, Path] = {}
    used_paths: dict[Path, str] = {}
    for role in ROLES:
        if role not in paths:
            continue
        path = Path(paths[role])
        resolved_path = path.resolve()
        if resolved_path in used_paths:
            errors.append(f"{path.name} is selected for both {used_paths[resolved_path]} and {role}.")
            continue

        headers = _headers_for_role(_read_headers(path), role)
        missing_columns = sorted(REQUIRED_COLUMNS[role] - headers)
        if missing_columns:
            errors.append(
                f"{path.name}: selected for {role}, but missing required column(s): "
                f"{', '.join(missing_columns)}."
            )
            continue
        assigned[role] = path
        used_paths[resolved_path] = role

    if errors:
        raise ValueError(" ".join(errors))
    return assigned


def _read_role(path: Path, role: str) -> list[dict[str, Any]]:
    aliases = ALIASES[role]
    rows: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        if not reader.fieldnames:
            return rows
        for raw in reader:
            cleaned: dict[str, Any] = {}
            for original_name, value in raw.items():
                name = _column_name(original_name or "")
                name = aliases.get(name, name)
                cleaned[name] = _clean_value(value)
            rows.append(cleaned)
    return rows


def load_bundle(paths: BundlePaths) -> tuple[dict[str, Path], dict[str, list[dict[str, Any]]]]:
    files = assign_files(paths) if isinstance(paths, Mapping) else classify_files(paths)
    return files, {role: _read_role(path, role) for role, path in files.items()}


def _validate_required_values(report: ValidationReport, role: str, rows: list[dict[str, Any]]) -> None:
    for row_number, row in enumerate(rows, start=2):
        for column in REQUIRED_COLUMNS[role]:
            if row.get(column) is None:
                report.add_error(f"Required value '{column}' is empty.", role, row_number)


def _validate_unique(
    report: ValidationReport,
    role: str,
    rows: list[dict[str, Any]],
    key: str,
) -> None:
    seen: dict[str, int] = {}
    for row_number, row in enumerate(rows, start=2):
        value = row.get(key)
        if value is None:
            continue
        normalized = str(value)
        if normalized in seen:
            report.add_error(
                f"Duplicate {key} '{normalized}' (first seen on row {seen[normalized]}).",
                role,
                row_number,
            )
        else:
            seen[normalized] = row_number


def _validate_lexicon_ids(report: ValidationReport, rows: list[dict[str, Any]]) -> None:
    seen: dict[str, tuple[int, str, str]] = {}
    repeated: set[str] = set()
    for row_number, row in enumerate(rows, start=2):
        lexicon_id = str(row.get("lex_id") or "")
        if not lexicon_id:
            continue
        signature = (
            str(row.get("word_form") or "").strip().casefold(),
            str(row.get("language") or "").strip().casefold(),
        )
        if lexicon_id not in seen:
            seen[lexicon_id] = (row_number, *signature)
            continue
        first_row, first_word, first_language = seen[lexicon_id]
        if signature != (first_word, first_language):
            report.add_error(
                f"lex_id '{lexicon_id}' conflicts with its lexical form or language on row {first_row}.",
                "lexicon",
                row_number,
            )
        else:
            repeated.add(lexicon_id)
    if repeated:
        report.add_warning(
            f"{len(repeated)} lexicon ID(s) contain multiple sense rows; their tokens and glosses will be preserved.",
            "lexicon",
        )


def _positive_integer(report: ValidationReport, role: str, row: dict[str, Any], row_number: int, key: str) -> None:
    value = row.get(key)
    if value is None:
        return
    try:
        parsed = int(str(value))
        if parsed < 1:
            raise ValueError
        row[key] = parsed
    except (TypeError, ValueError):
        report.add_error(f"'{key}' must be a positive integer; received '{value}'.", role, row_number)


def _validate_database_languages(report: ValidationReport, rows: dict[str, list[dict[str, Any]]], engine: Engine) -> None:
    with engine.connect() as connection:
        database_languages = connection.execute(
            text("SELECT language_name FROM public.languages")
        ).scalars().all()
    known = {str(name).strip().casefold() for name in database_languages}
    unknown = sorted(language for language in report.languages if language.casefold() not in known)
    if unknown:
        report.add_error(
            "These languages are not present in public.languages: " + ", ".join(unknown) + "."
        )


def validate_import(paths: BundlePaths, engine: Engine | None = None) -> ValidationReport:
    report = ValidationReport()
    try:
        files, rows = load_bundle(paths)
    except (OSError, UnicodeError, csv.Error, ValueError) as exc:
        report.add_error(str(exc))
        return report

    report.files = {role: path.name for role, path in files.items()}
    report.row_counts = {role: len(items) for role, items in rows.items()}
    for role in ROLES:
        if not rows[role]:
            report.add_error("The file contains no data rows.", role)
        _validate_required_values(report, role, rows[role])

    _validate_lexicon_ids(report, rows["lexicon"])
    _validate_unique(report, "phrases", rows["phrases"], "phrase_id")
    _validate_unique(report, "tokens", rows["tokens"], "token_id")
    _validate_unique(report, "annotations", rows["annotations"], "annotation_id")

    phrase_ids = {str(row["phrase_id"]) for row in rows["phrases"] if row.get("phrase_id")}
    lexicon_ids = {str(row["lex_id"]) for row in rows["lexicon"] if row.get("lex_id")}

    token_positions: set[tuple[str, int]] = set()
    for row_number, row in enumerate(rows["tokens"], start=2):
        _positive_integer(report, "tokens", row, row_number, "position")
        phrase_id = str(row.get("phrase_id") or "")
        if phrase_id and phrase_id not in phrase_ids:
            report.add_error(f"Token references unknown phrase_id '{phrase_id}'.", "tokens", row_number)
        lexicon_id = row.get("lex_id")
        if lexicon_id and str(lexicon_id) not in lexicon_ids:
            report.add_error(f"Token references unknown lex_id '{lexicon_id}'.", "tokens", row_number)
        if phrase_id and isinstance(row.get("position"), int):
            signature = (phrase_id, row["position"])
            if signature in token_positions:
                report.add_error(
                    f"Duplicate token position {row['position']} for phrase_id '{phrase_id}'.",
                    "tokens",
                    row_number,
                )
            token_positions.add(signature)

    annotation_positions: set[tuple[str, int]] = set()
    for row_number, row in enumerate(rows["annotations"], start=2):
        _positive_integer(report, "annotations", row, row_number, "order")
        phrase_id = str(row.get("phrase_id") or "")
        if phrase_id and phrase_id not in phrase_ids:
            report.add_error(f"Annotation references unknown phrase_id '{phrase_id}'.", "annotations", row_number)
        if phrase_id and isinstance(row.get("order"), int):
            signature = (phrase_id, row["order"])
            if signature in annotation_positions:
                report.add_error(
                    f"Duplicate annotation order {row['order']} for phrase_id '{phrase_id}'.",
                    "annotations",
                    row_number,
                )
            annotation_positions.add(signature)

    phrase_languages = {str(row["language"]).strip() for row in rows["phrases"] if row.get("language")}
    lexicon_languages = {str(row["language"]).strip() for row in rows["lexicon"] if row.get("language")}
    report.languages = sorted(phrase_languages | lexicon_languages, key=str.casefold)
    if phrase_languages != lexicon_languages:
        report.add_warning("The phrase and lexicon files do not contain exactly the same language set.")

    if engine is not None and report.valid:
        try:
            _validate_database_languages(report, rows, engine)
        except Exception as exc:  # Database connectivity is a validation failure for API callers.
            report.add_error(f"Could not validate languages against the database: {exc}")
    return report


def _similarity_key(value: Any) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value or "").casefold())


def _exact_key(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip().casefold())


def _review_id(*parts: Any) -> str:
    return hashlib.sha256("|".join(str(part or "") for part in parts).encode("utf-8")).hexdigest()[:16]


def _metadata_review(
    record_type: str,
    field_name: str,
    incoming_value: str,
    existing_rows: list[dict[str, Any]],
    *,
    similarity_cutoff: float,
) -> tuple[dict[str, Any] | None, str | None]:
    normalized_input = _similarity_key(incoming_value)
    for row in existing_rows:
        if _similarity_key(row["value"]) == normalized_input:
            return None, str(row["value"])

    values = [str(row["value"]) for row in existing_rows]
    close_values = difflib.get_close_matches(
        incoming_value,
        values,
        n=3,
        cutoff=similarity_cutoff,
    )
    if not close_values:
        return None, None

    row_by_value = {str(row["value"]): row for row in existing_rows}
    matches = []
    for value in close_values:
        row = row_by_value[value]
        matches.append(
            {
                "id": str(row["id"]),
                "label": value,
                "similarity": round(difflib.SequenceMatcher(None, incoming_value, value).ratio(), 3),
                "fields": {field_name: value},
            }
        )
    return {
        "id": _review_id("similarity", record_type, incoming_value),
        "kind": "similarity",
        "reason": "possible_typo",
        "reason_label": "Possible typo / similar value",
        "record_type": record_type,
        "record_key": f"metadata:{record_type}",
        "row": None,
        "incoming": {field_name: incoming_value},
        "matches": matches,
        "allowed_actions": ["use_existing", "use_imported", "skip_record", "cancel"],
    }, None


def detect_import_reviews(
    paths: BundlePaths,
    engine: Engine,
    *,
    source_name: str,
    annotator_name: str,
    similarity_cutoff: float = 0.6,
) -> dict[str, Any]:
    """Find human-review cases without opening a write transaction.

    Metadata matching deliberately preserves the original pipeline's
    ``difflib.get_close_matches(..., n=3, cutoff=0.6)`` behaviour.
    """
    _, rows = load_bundle(paths)
    source_name = str(source_name or "").strip()
    annotator_name = str(annotator_name or "").strip()
    items: list[dict[str, Any]] = []
    automatic_resolutions: dict[str, str] = {}

    with engine.connect() as connection:
        sources = [
            {"id": row["source_id"], "value": row["source_name"]}
            for row in connection.execute(
                text("SELECT source_id, source_name FROM public.sources ORDER BY source_name")
            ).mappings()
        ]
        annotators = [
            {"id": row["annotator_id"], "value": row["annotator_name"]}
            for row in connection.execute(
                text("SELECT annotator_id, annotator_name FROM public.annotators ORDER BY annotator_name")
            ).mappings()
        ]

        source_review, exact_source = _metadata_review(
            "source",
            "source_name",
            source_name,
            sources,
            similarity_cutoff=similarity_cutoff,
        )
        annotator_review, exact_annotator = _metadata_review(
            "annotator",
            "annotator_name",
            annotator_name,
            annotators,
            similarity_cutoff=similarity_cutoff,
        )
        if source_review:
            items.append(source_review)
        elif exact_source:
            automatic_resolutions["source_name"] = exact_source
        if annotator_review:
            items.append(annotator_review)
        elif exact_annotator:
            automatic_resolutions["annotator_name"] = exact_annotator

        incoming_languages = sorted(
            {_exact_key(row.get("language")) for row in rows["phrases"] if row.get("language")}
        )
        existing_phrases = connection.execute(
            text(
                """SELECT p.phrase_id, p.phrase_main, p.phrase_translation, p.tag_sequence,
                          l.language_id, l.language_name, l.iso_code,
                          src.source_id, src.source_name, ctx.context_full
                   FROM public.phrases AS p
                   JOIN public.languages AS l ON l.language_id = p.language_id
                   JOIN public.sessions AS ses ON ses.session_id = p.session_id
                   JOIN public.sources AS src ON src.source_id = ses.source_id
                   LEFT JOIN public.contexts AS ctx ON ctx.session_id = p.session_id
                   WHERE lower(trim(l.language_name)) = ANY(CAST(:languages AS text[]))
                   ORDER BY p.phrase_id"""
            ),
            {"languages": incoming_languages},
        ).mappings().all()
        database_languages = connection.execute(
            text("SELECT language_id, language_name, iso_code FROM public.languages")
        ).mappings().all()

    language_by_name = {_exact_key(row["language_name"]): row for row in database_languages}
    existing_by_language: dict[str, list[dict[str, Any]]] = {}
    existing_by_id: dict[str, dict[str, Any]] = {}
    for existing in existing_phrases:
        record = dict(existing)
        existing_by_language.setdefault(_exact_key(record["language_name"]), []).append(record)
        existing_by_id[str(record["phrase_id"])] = record

    possible_source_names = {
        _exact_key(automatic_resolutions.get("source_name") or source_name),
        _exact_key(source_name),
    }
    if source_review:
        possible_source_names.update(_exact_key(match["label"]) for match in source_review["matches"])

    for row_number, incoming in enumerate(rows["phrases"], start=2):
        old_phrase_id = str(incoming["phrase_id"])
        language_key = _exact_key(incoming.get("language"))
        language = language_by_name.get(language_key)
        candidates: dict[tuple[str, str], dict[str, Any]] = {}

        for existing in existing_by_language.get(language_key, []):
            data_same = (
                _exact_key(existing["phrase_main"]) == _exact_key(incoming.get("phrase"))
                and _exact_key(existing["phrase_translation"]) == _exact_key(incoming.get("phrase_translation"))
            )
            context_same = bool(
                incoming.get("context")
                and existing.get("context_full")
                and _exact_key(existing["context_full"]) == _exact_key(incoming.get("context"))
                and _exact_key(existing["source_name"]) in possible_source_names
            )
            if not data_same and not context_same:
                continue
            matched_on = "same data and context" if data_same and context_same else "same data" if data_same else "same context"
            candidates[(str(existing["phrase_id"]), str(existing.get("context_full") or ""))] = {
                "id": str(existing["phrase_id"]),
                "label": str(existing["phrase_main"]),
                "matched_on": matched_on,
                "fields": {
                    "phrase_id": existing["phrase_id"],
                    "phrase": existing["phrase_main"],
                    "phrase_translation": existing["phrase_translation"],
                    "context": existing.get("context_full"),
                    "language": existing["language_name"],
                    "source": existing["source_name"],
                },
            }

        if language:
            stable_key = incoming.get("code") or old_phrase_id
            for possible_source in possible_source_names:
                expected_id = _stable_id(
                    f"{_iso_prefix(language['iso_code'])}-PH-",
                    possible_source,
                    language["language_id"],
                    stable_key,
                )
                collision = existing_by_id.get(expected_id)
                if collision:
                    candidates[(str(collision["phrase_id"]), str(collision.get("context_full") or ""))] = {
                        "id": str(collision["phrase_id"]),
                        "label": str(collision["phrase_main"]),
                        "matched_on": "existing import identity",
                        "fields": {
                            "phrase_id": collision["phrase_id"],
                            "phrase": collision["phrase_main"],
                            "phrase_translation": collision["phrase_translation"],
                            "context": collision.get("context_full"),
                            "language": collision["language_name"],
                            "source": collision["source_name"],
                        },
                    }

        if not candidates:
            continue
        matches = list(candidates.values())
        has_same_data = any(match["matched_on"] in {"same data", "same data and context"} for match in matches)
        kind = "exact_duplicate" if has_same_data else "existing_related_record"
        reason_label = "Exact duplicate" if kind == "exact_duplicate" else "Existing related record"
        items.append(
            {
                "id": _review_id(kind, old_phrase_id, row_number),
                "kind": kind,
                "reason": "exact_data" if has_same_data else "exact_context",
                "reason_label": reason_label,
                "record_type": "phrase",
                "record_key": old_phrase_id,
                "row": row_number,
                "incoming": {
                    "phrase_id": old_phrase_id,
                    "phrase": incoming.get("phrase"),
                    "phrase_translation": incoming.get("phrase_translation"),
                    "context": incoming.get("context"),
                    "language": incoming.get("language"),
                    "source": source_name,
                },
                "matches": matches[:5],
                "allowed_actions": ["skip_duplicate", "import_anyway", "cancel"],
            }
        )

    return {
        "items": items,
        "automatic_resolutions": automatic_resolutions,
        "similarity_cutoff": similarity_cutoff,
    }


def _stable_id(prefix: str, *parts: Any, length: int = 12) -> str:
    normalized = "|".join(str(part or "").strip().casefold() for part in parts)
    digest = hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:length].upper()
    return f"{prefix}{digest}"


def _iso_prefix(value: Any) -> str:
    cleaned = re.sub(r"[^a-z0-9]", "", str(value or "und").lower())
    return cleaned or "und"


def _session_date(saved_at: Any) -> date:
    if not saved_at:
        return date.today()
    try:
        return datetime.fromisoformat(str(saved_at).replace("Z", "+00:00")).date()
    except ValueError:
        return date.today()


def _emit(callback: ProgressCallback | None, **payload: Any) -> None:
    if callback:
        callback(payload)


def _record_failure(
    result: ImportResult,
    table_name: str,
    row_number: int | None,
    identifier: Any,
    exc: Exception,
) -> None:
    stats = result.table(table_name)
    stats.failed += 1
    if len(result.errors) < 200:
        result.errors.append(
            {
                "table": table_name,
                "row": row_number,
                "identifier": str(identifier or ""),
                "message": str(exc),
            }
        )


def _execute_row(
    connection: Any,
    result: ImportResult,
    table_name: str,
    row_number: int | None,
    identifier: Any,
    statement: Any,
    parameters: dict[str, Any],
) -> bool:
    stats = result.table(table_name)
    stats.processed += 1
    try:
        with connection.begin_nested():
            connection.execute(statement, parameters)
        stats.successful += 1
        return True
    except Exception as exc:
        _record_failure(result, table_name, row_number, identifier, exc)
        return False


def run_import(
    paths: BundlePaths,
    *,
    engine: Engine,
    source_name: str,
    annotator_name: str,
    progress: ProgressCallback | None = None,
    skip_phrase_ids: Iterable[str] = (),
    force_duplicate_phrase_ids: Iterable[str] = (),
    duplicate_nonce: str | None = None,
    skip_all: bool = False,
    review_summary: dict[str, Any] | None = None,
) -> ImportResult:
    source_name = str(source_name or "").strip()
    annotator_name = str(annotator_name or "").strip()
    if not source_name or not annotator_name:
        report = ValidationReport(valid=False)
        report.add_error("Source name and annotator name are required.")
        raise PipelineValidationError(report)

    report = validate_import(paths, engine)
    if not report.valid:
        raise PipelineValidationError(report)
    _, rows = load_bundle(paths)

    result = ImportResult(
        warnings=[issue.message for issue in report.issues if issue.level == "warning"],
        review_summary=dict(review_summary or {}),
    )
    original_counts = {role: len(rows[role]) for role in ROLES}
    if skip_all:
        for role, count in original_counts.items():
            stats = result.table(role)
            stats.processed = count
            stats.skipped = count
        result.warnings.append("The import was skipped by an administrator during metadata review.")
        result.finalize()
        _emit(
            progress,
            stage="complete",
            message="Migration review completed; dependent records were skipped.",
            processed=result.processed,
            total=result.processed,
            percent=100,
            result=result.to_dict(),
        )
        return result

    skipped_phrase_ids = {str(value) for value in skip_phrase_ids}
    forced_phrase_ids = {str(value) for value in force_duplicate_phrase_ids}
    skipped_counts = {role: 0 for role in ROLES}
    if skipped_phrase_ids:
        for role in ("phrases", "tokens", "annotations"):
            kept_rows = []
            for row in rows[role]:
                if str(row.get("phrase_id") or "") in skipped_phrase_ids:
                    skipped_counts[role] += 1
                else:
                    kept_rows.append(row)
            rows[role] = kept_rows
            if skipped_counts[role]:
                stats = result.table(role)
                stats.processed += skipped_counts[role]
                stats.skipped += skipped_counts[role]

    if not rows["phrases"]:
        skipped_counts["lexicon"] = len(rows["lexicon"])
        lexicon_stats = result.table("lexicon")
        lexicon_stats.processed += skipped_counts["lexicon"]
        lexicon_stats.skipped += skipped_counts["lexicon"]
        result.warnings.append("All phrase records were skipped during duplicate review.")
        result.finalize()
        _emit(
            progress,
            stage="complete",
            message="Migration review completed; all phrase records were skipped.",
            processed=result.processed,
            total=result.processed,
            percent=100,
            result=result.to_dict(),
        )
        return result

    source_key = source_name.casefold()
    total_input_rows = sum(original_counts.values())
    completed_input_rows = sum(skipped_counts.values())
    duplicate_nonce = duplicate_nonce or datetime.now().isoformat()

    def progress_row(stage: str, message: str) -> None:
        nonlocal completed_input_rows
        completed_input_rows += 1
        _emit(
            progress,
            stage=stage,
            message=message,
            processed=completed_input_rows,
            total=total_input_rows,
            percent=min(99, round((completed_input_rows / max(total_input_rows, 1)) * 100)),
        )

    _emit(progress, stage="validation", message="Validation passed.", processed=0, total=total_input_rows, percent=2)

    with engine.begin() as connection:
        database_languages = connection.execute(
            text("SELECT language_id, language_name, iso_code FROM public.languages")
        ).mappings().all()
        language_by_name = {
            str(item["language_name"]).strip().casefold(): {
                "id": item["language_id"],
                "name": item["language_name"],
                "iso": _iso_prefix(item["iso_code"]),
            }
            for item in database_languages
        }

        phrase_language = {
            str(row["phrase_id"]): language_by_name[str(row["language"]).strip().casefold()]
            for row in rows["phrases"]
        }
        primary_language_id = phrase_language[str(rows["phrases"][0]["phrase_id"])]["id"]

        _emit(progress, stage="metadata", message="Resolving source and annotator.", percent=4)
        source_id = connection.execute(
            text("SELECT source_id FROM public.sources WHERE lower(trim(source_name)) = :name LIMIT 1"),
            {"name": source_key},
        ).scalar_one_or_none()
        if source_id is None:
            source_id = connection.execute(
                text(
                    "INSERT INTO public.sources (source_name, language_id) "
                    "VALUES (:name, :language_id) RETURNING source_id"
                ),
                {"name": source_name, "language_id": primary_language_id},
            ).scalar_one()

        annotator_id = connection.execute(
            text("SELECT annotator_id FROM public.annotators WHERE lower(trim(annotator_name)) = :name LIMIT 1"),
            {"name": annotator_name.casefold()},
        ).scalar_one_or_none()
        if annotator_id is None:
            annotator_id = connection.execute(
                text("INSERT INTO public.annotators (annotator_name) VALUES (:name) RETURNING annotator_id"),
                {"name": annotator_name},
            ).scalar_one()

        lexicon_id_map: dict[tuple[str, str], str] = {}
        _emit(progress, stage="lexicon", message="Importing lexicon entries.", percent=5)
        for row_number, row in enumerate(rows["lexicon"], start=2):
            language = language_by_name[str(row["language"]).strip().casefold()]
            old_lexicon_id = str(row["lex_id"])
            new_lexicon_id = _stable_id(
                f"{language['iso']}-LEX-",
                source_key,
                language["id"],
                old_lexicon_id,
            )
            lexicon_id_map[(str(row["language"]).strip().casefold(), old_lexicon_id)] = new_lexicon_id
            _execute_row(
                connection,
                result,
                "lexicon",
                row_number,
                old_lexicon_id,
                text(
                    """INSERT INTO public.lexicon (lexicon_id, lexical_item, language_id, gloss)
                       VALUES (:id, :item, :language_id, :gloss)
                       ON CONFLICT (lexicon_id) DO UPDATE SET
                         lexical_item = EXCLUDED.lexical_item,
                         language_id = EXCLUDED.language_id,
                         gloss = EXCLUDED.gloss"""
                ),
                {
                    "id": new_lexicon_id,
                    "item": row["word_form"],
                    "language_id": language["id"],
                    "gloss": row.get("gloss"),
                },
            )
            progress_row("lexicon", f"Processed lexicon row {row_number}.")

        phrase_id_map: dict[str, str] = {}
        session_id_map: dict[str, str] = {}
        for row in rows["phrases"]:
            old_phrase_id = str(row["phrase_id"])
            language = phrase_language[old_phrase_id]
            stable_key = row.get("code") or old_phrase_id
            identity_parts = [source_key, language["id"], stable_key]
            if old_phrase_id in forced_phrase_ids:
                identity_parts.extend(["manual-duplicate", duplicate_nonce, old_phrase_id])
            phrase_id_map[old_phrase_id] = _stable_id(
                f"{language['iso']}-PH-", *identity_parts
            )
            session_id_map[old_phrase_id] = _stable_id(
                f"{language['iso']}-S-", *identity_parts
            )

        gloss_id_by_value: dict[tuple[str, str], str] = {}
        _emit(progress, stage="glosses", message="Resolving glosses.", percent=20)
        for row in rows["tokens"]:
            gloss = row.get("gloss")
            old_phrase_id = str(row["phrase_id"])
            old_lexicon_id = str(row.get("lex_id") or "")
            language_row = next(item for item in rows["phrases"] if str(item["phrase_id"]) == old_phrase_id)
            language_key = str(language_row["language"]).strip().casefold()
            lexicon_id = lexicon_id_map.get((language_key, old_lexicon_id))
            if not gloss or not lexicon_id:
                continue
            gloss_value = str(gloss)
            gloss_key = (gloss_value, lexicon_id)
            if gloss_key in gloss_id_by_value:
                continue
            existing_gloss_id = connection.execute(
                text(
                    "SELECT gloss_id FROM public.glosses "
                    "WHERE gloss = :gloss AND lexicon_id = :lexicon_id LIMIT 1"
                ),
                {"gloss": gloss_value, "lexicon_id": lexicon_id},
            ).scalar_one_or_none()
            if existing_gloss_id:
                gloss_id_by_value[gloss_key] = existing_gloss_id
                gloss_stats = result.table("glosses")
                gloss_stats.processed += 1
                gloss_stats.skipped += 1
                continue
            language = language_by_name[language_key]
            gloss_id = _stable_id(f"{language['iso']}-GL-", lexicon_id, gloss_value)
            if _execute_row(
                connection,
                result,
                "glosses",
                None,
                gloss,
                text(
                    """INSERT INTO public.glosses (gloss_id, gloss, lexicon_id, language_id)
                       VALUES (:id, :gloss, :lexicon_id, :language_id)
                       ON CONFLICT (gloss_id) DO UPDATE SET
                         gloss = EXCLUDED.gloss,
                         lexicon_id = EXCLUDED.lexicon_id,
                         language_id = EXCLUDED.language_id"""
                ),
                {
                    "id": gloss_id,
                    "gloss": gloss_value,
                    "lexicon_id": lexicon_id,
                    "language_id": language["id"],
                },
            ):
                gloss_id_by_value[gloss_key] = gloss_id

        _emit(progress, stage="phrases", message="Importing sessions, contexts, and phrases.", percent=25)
        for row_number, row in enumerate(rows["phrases"], start=2):
            old_phrase_id = str(row["phrase_id"])
            phrase_id = phrase_id_map[old_phrase_id]
            session_id = session_id_map[old_phrase_id]
            language = phrase_language[old_phrase_id]

            _execute_row(
                connection,
                result,
                "sessions",
                row_number,
                session_id,
                text(
                    """INSERT INTO public.sessions
                         (session_id, language_id, source_id, annotator_id, session_date)
                       VALUES (:id, :language_id, :source_id, :annotator_id, :session_date)
                       ON CONFLICT (session_id) DO UPDATE SET
                         language_id = EXCLUDED.language_id,
                         source_id = EXCLUDED.source_id,
                         annotator_id = EXCLUDED.annotator_id,
                         session_date = EXCLUDED.session_date"""
                ),
                {
                    "id": session_id,
                    "language_id": language["id"],
                    "source_id": source_id,
                    "annotator_id": annotator_id,
                    "session_date": _session_date(row.get("saved_at")),
                },
            )

            context = row.get("context")
            if context:
                existing_context = connection.execute(
                    text("SELECT context_id FROM public.contexts WHERE session_id = :session_id LIMIT 1"),
                    {"session_id": session_id},
                ).scalar_one_or_none()
                if existing_context is None:
                    statement = text(
                        """INSERT INTO public.contexts
                             (context_full, language_id, session_id, source_id, source_code)
                           VALUES (:context, :language_id, :session_id, :source_id, :source_code)"""
                    )
                    parameters = {
                        "context": context,
                        "language_id": language["id"],
                        "session_id": session_id,
                        "source_id": source_id,
                        "source_code": row.get("code"),
                    }
                else:
                    statement = text(
                        """UPDATE public.contexts SET
                             context_full = :context,
                             language_id = :language_id,
                             source_id = :source_id,
                             source_code = :source_code
                           WHERE context_id = :context_id"""
                    )
                    parameters = {
                        "context": context,
                        "language_id": language["id"],
                        "source_id": source_id,
                        "source_code": row.get("code"),
                        "context_id": existing_context,
                    }
                _execute_row(
                    connection,
                    result,
                    "contexts",
                    row_number,
                    session_id,
                    statement,
                    parameters,
                )
            else:
                context_stats = result.table("contexts")
                context_stats.processed += 1
                context_stats.skipped += 1

            _execute_row(
                connection,
                result,
                "phrases",
                row_number,
                old_phrase_id,
                text(
                    """INSERT INTO public.phrases
                         (phrase_id, phrase_main, phrase_translation, language_id, session_id, tag_sequence)
                       VALUES (:id, :main, :translation, :language_id, :session_id, :tag_sequence)
                       ON CONFLICT (phrase_id) DO UPDATE SET
                         phrase_main = EXCLUDED.phrase_main,
                         phrase_translation = EXCLUDED.phrase_translation,
                         language_id = EXCLUDED.language_id,
                         session_id = EXCLUDED.session_id,
                         tag_sequence = EXCLUDED.tag_sequence"""
                ),
                {
                    "id": phrase_id,
                    "main": row["phrase"],
                    "translation": row.get("phrase_translation"),
                    "language_id": language["id"],
                    "session_id": session_id,
                    "tag_sequence": row.get("tag_sequence"),
                },
            )
            progress_row("phrases", f"Processed phrase row {row_number}.")

        phrase_language_key = {
            str(row["phrase_id"]): str(row["language"]).strip().casefold() for row in rows["phrases"]
        }
        _emit(progress, stage="tokens", message="Importing tokens.", percent=55)
        for row_number, row in enumerate(rows["tokens"], start=2):
            old_phrase_id = str(row["phrase_id"])
            phrase_id = phrase_id_map.get(old_phrase_id)
            language_key = phrase_language_key.get(old_phrase_id)
            lexicon_id = lexicon_id_map.get((language_key or "", str(row.get("lex_id") or "")))
            if not phrase_id:
                stats = result.table("tokens")
                stats.processed += 1
                stats.skipped += 1
                progress_row("tokens", f"Skipped token row {row_number} with no phrase mapping.")
                continue
            token_id = f"{phrase_id}-T{int(row['position'])}"
            _execute_row(
                connection,
                result,
                "tokens",
                row_number,
                row.get("token_id"),
                text(
                    """INSERT INTO public.tokens
                         (token_id, token, gloss, gloss_id, lexicon_id, phrase_id)
                       VALUES (:id, :token, :gloss, :gloss_id, :lexicon_id, :phrase_id)
                       ON CONFLICT (token_id) DO UPDATE SET
                         token = EXCLUDED.token,
                         gloss = EXCLUDED.gloss,
                         gloss_id = EXCLUDED.gloss_id,
                         lexicon_id = EXCLUDED.lexicon_id,
                         phrase_id = EXCLUDED.phrase_id"""
                ),
                {
                    "id": token_id,
                    "token": row["word_form"],
                    "gloss": row.get("gloss"),
                    "gloss_id": gloss_id_by_value.get((str(row.get("gloss")), lexicon_id)),
                    "lexicon_id": lexicon_id,
                    "phrase_id": phrase_id,
                },
            )
            progress_row("tokens", f"Processed token row {row_number}.")

        _emit(progress, stage="annotations", message="Importing annotations.", percent=78)
        for row_number, row in enumerate(rows["annotations"], start=2):
            old_phrase_id = str(row["phrase_id"])
            phrase_id = phrase_id_map.get(old_phrase_id)
            if not phrase_id:
                stats = result.table("annotations")
                stats.processed += 1
                stats.skipped += 1
                progress_row("annotations", f"Skipped annotation row {row_number} with no phrase mapping.")
                continue
            annotation_id = f"{phrase_id}-A{int(row['order'])}"
            _execute_row(
                connection,
                result,
                "annotations",
                row_number,
                row.get("annotation_id"),
                text(
                    """INSERT INTO public.annotations
                         (annotation_id, phrase_id, "order", tag, category, subcategory, type, token)
                       VALUES (:id, :phrase_id, :order, :tag, :category, :subcategory, :type, :token)
                       ON CONFLICT (annotation_id) DO UPDATE SET
                         phrase_id = EXCLUDED.phrase_id,
                         "order" = EXCLUDED."order",
                         tag = EXCLUDED.tag,
                         category = EXCLUDED.category,
                         subcategory = EXCLUDED.subcategory,
                         type = EXCLUDED.type,
                         token = EXCLUDED.token"""
                ),
                {
                    "id": annotation_id,
                    "phrase_id": phrase_id,
                    "order": int(row["order"]),
                    "tag": row.get("tag"),
                    "category": row.get("category"),
                    "subcategory": row.get("subcategory"),
                    "type": row.get("type"),
                    "token": row.get("tokens") or row.get("token"),
                },
            )
            progress_row("annotations", f"Processed annotation row {row_number}.")

    result.finalize()
    _emit(
        progress,
        stage="complete",
        message="Migration completed.",
        processed=result.processed,
        total=result.processed,
        percent=100,
        result=result.to_dict(),
    )
    return result


def create_database_engine(database_url: str | None = None) -> Engine:
    url = database_url or os.getenv("NPINDEX_DATABASE_URL") or os.getenv("DATABASE_URL")
    if not url:
        raise RuntimeError("Set NPINDEX_DATABASE_URL to the server-side PostgreSQL connection string.")
    return create_engine(url, pool_pre_ping=True)


def _cli() -> int:
    parser = argparse.ArgumentParser(description="Validate and import an NPIndex four-file CSV bundle.")
    parser.add_argument("files", nargs="+", help="The lexicon, phrases, tokens, and annotations CSV files.")
    parser.add_argument("--source", required=True, help="Dataset source/corpus name.")
    parser.add_argument("--annotator", required=True, help="Annotator full name.")
    parser.add_argument("--validate-only", action="store_true", help="Validate without writing to PostgreSQL.")
    args = parser.parse_args()

    engine = None if args.validate_only else create_database_engine()
    report = validate_import(args.files, engine)
    print(json.dumps(report.to_dict(), indent=2, default=str))
    if not report.valid or args.validate_only:
        return 0 if report.valid else 1

    result = run_import(
        args.files,
        engine=engine,
        source_name=args.source,
        annotator_name=args.annotator,
        progress=lambda event: print(f"[{event.get('percent', 0):>3}%] {event.get('message', '')}"),
    )
    print(json.dumps(result.to_dict(), indent=2, default=str))
    return 0 if result.failed == 0 else 2


if __name__ == "__main__":
    raise SystemExit(_cli())
