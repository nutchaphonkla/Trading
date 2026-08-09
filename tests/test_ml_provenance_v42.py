import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import ai_provenance_v42 as MODULE

VERSION = "V42 TEST ARTIFACT"


def valid_artifact():
    return {
        "version": VERSION,
        "ready": True,
        "status": "TRUSTED",
        "governance": {"trusted": True},
        "sourceFingerprint": "source-a",
        "artifactSchema": {
            "version": MODULE.ARTIFACT_SCHEMA_VERSION,
            "featureSchemaHash": "features-a",
            "labelSchemaHash": MODULE.LABEL_SCHEMA_HASH,
        },
        "artifactProvenance": {
            "schemaVersion": MODULE.ARTIFACT_SCHEMA_VERSION,
            "trainingSource": "xauusd-primary.json",
            "trainingFeed": "TWELVE_DATA_PRIMARY",
            "mergeFeeds": False,
            "featureSchemaHash": "features-a",
            "labelSchema": MODULE.LABEL_SCHEMA,
            "labelSchemaHash": MODULE.LABEL_SCHEMA_HASH,
            "sourceFingerprint": "source-a",
            "dataWatermark": 123,
            "candidateSchemaCount": 12,
        },
        "current": {"candidateCount": 12, "candidates": [{"id": i} for i in range(12)]},
    }


def test_artifact_contract_is_fail_closed():
    pack = valid_artifact()
    assert MODULE.compatible_artifact(pack) is True
    assert MODULE.compatible_artifact({**pack, "version": "V36.1"}) is False
    assert MODULE.compatible_artifact({**pack, "status": "QUARANTINED"}) is False
    assert MODULE.compatible_artifact({**pack, "current": {"candidateCount": 4, "candidates": pack["current"]["candidates"][:4]}}) is False
    assert MODULE.compatible_artifact({**pack, "current": {"candidateCount": 12, "candidates": pack["current"]["candidates"][:4]}}) is False
    bad = valid_artifact()
    bad["artifactProvenance"] = {**bad["artifactProvenance"], "mergeFeeds": True}
    assert MODULE.compatible_artifact(bad) is False
    bad = valid_artifact()
    bad["artifactProvenance"] = {**bad["artifactProvenance"], "sourceFingerprint": "different"}
    assert MODULE.compatible_artifact(bad) is False
    bad = valid_artifact()
    bad["artifactProvenance"] = {**bad["artifactProvenance"], "dataWatermark": None}
    assert MODULE.compatible_artifact(bad) is False
    bad = valid_artifact()
    bad["artifactSchema"] = {**bad["artifactSchema"], "featureSchemaHash": "different"}
    assert MODULE.compatible_artifact(bad) is False


def test_primary_pack_requires_explicit_isolation_and_watermark():
    pack = {
        "source": "Twelve Data PRIMARY isolated history",
        "closedBarWatermark": 10_000,
        "feed": {
            "active": "TWELVE_DATA",
            "switching": {"mergeFeeds": False},
        },
    }
    ok, reason, watermark = MODULE.validate_primary_pack_metadata(pack)
    assert ok is True
    assert reason == "OK"
    assert watermark == 10_000

    no_watermark = {**pack, "closedBarWatermark": None}
    assert MODULE.validate_primary_pack_metadata(no_watermark)[0] is False
    merged = {**pack, "feed": {**pack["feed"], "switching": {"mergeFeeds": True}}}
    assert MODULE.validate_primary_pack_metadata(merged)[0] is False
    fallback = {**pack, "feed": {**pack["feed"], "active": "MT5_FALLBACK"}}
    assert MODULE.validate_primary_pack_metadata(fallback)[0] is False


def test_feature_schema_hash_is_order_sensitive_and_stable():
    assert MODULE.feature_schema_hash(["a", "b"]) == MODULE.feature_schema_hash(["a", "b"])
    assert MODULE.feature_schema_hash(["a", "b"]) != MODULE.feature_schema_hash(["b", "a"])


if __name__ == "__main__":
    tests = [
        test_artifact_contract_is_fail_closed,
        test_primary_pack_requires_explicit_isolation_and_watermark,
        test_feature_schema_hash_is_order_sensitive_and_stable,
    ]
    for test in tests:
        test()
    print(f"ML provenance V42: {len(tests)} tests passed")
