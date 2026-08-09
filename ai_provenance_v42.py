"""Dependency-free provenance contract shared by the V42 training pipeline."""

from __future__ import annotations

import hashlib
import json
import math
from typing import Iterable, Tuple


ARTIFACT_SCHEMA_VERSION = "KAGE_AI_V42"
LABEL_SCHEMA = "M1_FIRST_HIT_V42"
LABEL_SCHEMA_HASH = "7c9ff5daadb124444d716c94"


def _num(value, default=0.0) -> float:
    try:
        number = float(value)
        return number if math.isfinite(number) else default
    except Exception:
        return default


def feature_schema_hash(columns: Iterable[str]) -> str:
    payload = json.dumps(list(columns), ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def compatible_artifact(pack: dict) -> bool:
    if not isinstance(pack, dict) or not pack.get("ready"):
        return False
    provenance = pack.get("artifactProvenance") or {}
    schema = pack.get("artifactSchema") or {}
    current = pack.get("current") or {}
    candidates = current.get("candidates")
    schema_version = provenance.get("schemaVersion") or schema.get("version")
    feature_hash = provenance.get("featureSchemaHash")
    label_hash = provenance.get("labelSchemaHash")
    return bool(
        str(pack.get("version") or "").startswith("V42")
        and pack.get("status") == "TRUSTED"
        and (pack.get("governance") or {}).get("trusted") is True
        and schema_version == ARTIFACT_SCHEMA_VERSION
        and provenance.get("trainingSource") == "xauusd-primary.json"
        and provenance.get("trainingFeed") == "TWELVE_DATA_PRIMARY"
        and provenance.get("mergeFeeds") is False
        and provenance.get("labelSchema") == LABEL_SCHEMA
        and bool(feature_hash)
        and feature_hash == schema.get("featureSchemaHash")
        and label_hash == LABEL_SCHEMA_HASH
        and label_hash == schema.get("labelSchemaHash")
        and bool(provenance.get("sourceFingerprint"))
        and provenance.get("sourceFingerprint") == pack.get("sourceFingerprint")
        and _num(provenance.get("dataWatermark"), 0) > 0
        and _num(provenance.get("candidateSchemaCount"), 0) == 12
        and isinstance(candidates, list)
        and len(candidates) == 12
        and _num(current.get("candidateCount"), 0) == 12
    )


def validate_primary_pack_metadata(pack: dict) -> Tuple[bool, str, int]:
    if not isinstance(pack, dict) or not pack:
        return False, "MISSING_PRIMARY_PACK", 0
    feed = pack.get("feed") or {}
    switching = feed.get("switching") or {}
    active = str(feed.get("active") or "").upper()
    source = str(pack.get("source") or "").upper()
    watermark = int(_num(pack.get("closedBarWatermark") or feed.get("closedBarWatermark"), 0))
    if active != "TWELVE_DATA" or "PRIMARY" not in source:
        return False, "PRIMARY_SOURCE_PROVENANCE_INVALID", watermark
    if switching.get("mergeFeeds") is not False:
        return False, "PRIMARY_FEED_ISOLATION_NOT_EXPLICIT", watermark
    if watermark <= 0:
        return False, "PRIMARY_CLOSED_BAR_WATERMARK_MISSING", 0
    return True, "OK", watermark
