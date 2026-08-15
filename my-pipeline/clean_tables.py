"""Explicit maintenance command for clearing imported NPIndex data.

This destructive operation is intentionally not imported by, or exposed from,
the migration API.  It requires both a server-side database URL and an exact
command-line confirmation phrase.
"""

import argparse

from import_pipeline import create_database_engine
from sqlalchemy import text


CONFIRMATION = "TRUNCATE NPINDEX IMPORT TABLES"


def main() -> int:
    parser = argparse.ArgumentParser(description="Destructively clear NPIndex import tables.")
    parser.add_argument(
        "--confirm",
        required=True,
        help=f"Required confirmation phrase: {CONFIRMATION}",
    )
    args = parser.parse_args()
    if args.confirm != CONFIRMATION:
        parser.error("Confirmation phrase did not match; no database changes were made.")

    engine = create_database_engine()
    with engine.begin() as connection:
        connection.execute(
            text(
                """TRUNCATE TABLE
                     public.annotations,
                     public.tokens,
                     public.phrases,
                     public.glosses,
                     public.lexicon,
                     public.contexts,
                     public.sessions,
                     public.sources,
                     public.annotators
                   RESTART IDENTITY CASCADE"""
            )
        )

    print("NPIndex import tables were cleared and their owned identities reset.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
