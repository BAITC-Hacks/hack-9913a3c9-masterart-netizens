"""Импорт нового набора данных по схеме кейса: nodes.parquet, edges.parquet, transactions.parquet."""

from .ingest import (
    MAX_FILE_BYTES,
    MAX_REQUEST_BYTES,
    MAX_ROWS,
    MAX_TOTAL_BYTES,
    REQUIRED_FILES,
    ImportRejected,
    decode_request,
    handle_import_request,
    ingest_files,
)

__all__ = [
    "MAX_FILE_BYTES",
    "MAX_REQUEST_BYTES",
    "MAX_ROWS",
    "MAX_TOTAL_BYTES",
    "REQUIRED_FILES",
    "ImportRejected",
    "decode_request",
    "handle_import_request",
    "ingest_files",
]
