import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

PROV_SPEC = importlib.util.spec_from_file_location("ai_provenance_v44", ROOT / "ai_provenance_v42.py")
PROV = importlib.util.module_from_spec(PROV_SPEC)
assert PROV_SPEC and PROV_SPEC.loader
PROV_SPEC.loader.exec_module(PROV)
sys.modules["ai_provenance_v42"] = PROV
validate_training_pack_metadata = PROV.validate_training_pack_metadata

SPEC = importlib.util.spec_from_file_location("selfplay_lab_v44", ROOT / "selfplay-lab.py")
SELFPLAY = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
sys.modules[SPEC.name] = SELFPLAY
SPEC.loader.exec_module(SELFPLAY)

ML_SPEC = importlib.util.spec_from_file_location("ml_train_v44", ROOT / "ml-train.py")
ML = importlib.util.module_from_spec(ML_SPEC)
assert ML_SPEC and ML_SPEC.loader
sys.modules[ML_SPEC.name] = ML
ML_SPEC.loader.exec_module(ML)


def pack(active: str, source: str, feed: str):
    return {
        "source": source,
        "closedBarWatermark": 1_800_000_000_000,
        "feed": {
            "active": active,
            "trainingSource": "xauusd-training.json",
            "trainingFeed": feed,
            "switching": {"mergeFeeds": False},
        },
        "timeframes": {"M1": [{"ts": 1_799_999_940_000, "open": 2300, "high": 2301, "low": 2299, "close": 2300.5}]},
    }


def verified_entry(kind: str):
    return {
        "creationFeedKind": kind,
        "outcomeFeedKind": kind,
        "provenanceStatus": "VERIFIED",
        "modelArtifactSchema": SELFPLAY.ARTIFACT_SCHEMA,
        "labelSchema": SELFPLAY.LABEL_SCHEMA,
        "labelSchemaHash": SELFPLAY.LABEL_SCHEMA_HASH,
        "creationDataFingerprint": f"{kind.lower()}-create",
        "creationDataWatermark": 1_800_000_000_000,
        "outcomeDataFingerprint": f"{kind.lower()}-outcome",
        "outcomeDataWatermark": 1_800_000_060_000,
    }


def test_mt5_training_pack_validates():
    ok, reason, watermark, feed = validate_training_pack_metadata(
        pack("MT5_FALLBACK", "MT5 ACADEMY single-source training history", "MT5_ACADEMY")
    )
    assert ok is True, reason
    assert reason == "OK"
    assert watermark > 0
    assert feed == "MT5_ACADEMY"


def test_twelve_training_pack_validates():
    ok, reason, _, feed = validate_training_pack_metadata(
        pack("TWELVE_DATA", "Twelve Data PRIMARY single-source training history", "TWELVE_DATA_PRIMARY")
    )
    assert ok is True, reason
    assert feed == "TWELVE_DATA_PRIMARY"


def test_cross_source_pack_is_rejected():
    ok, reason, _, _ = validate_training_pack_metadata(
        pack("MT5_FALLBACK", "MT5 ACADEMY single-source training history", "TWELVE_DATA_PRIMARY")
    )
    assert ok is False
    assert reason == "TRAINING_SOURCE_PROVENANCE_INVALID"



def test_all_12_geometries_survive_extreme_structure():
    row = ML.pd.Series({
        "close": 100.0,
        "atr": 1.0,
        "ema21": 100.0,
        "swing_high20": 120.0,
        "swing_low20": 80.0,
        "m1_atr_pct": 0.0004,
    })
    geometries = [
        ML.candidate_geometry(row, order_type, variant)
        for order_type in ML.ORDER_TYPES
        for variant in ML.VARIANTS
    ]
    assert len(geometries) == 12
    assert all(g is not None for g in geometries)
    assert all(0.45 <= g["risk"] / row["atr"] <= 3.0 for g in geometries)
    assert all(g["geometrySchema"] == ML.GEOMETRY_SCHEMA for g in geometries)
    assert any(g["riskBounded"] for g in geometries)



def test_training_anchor_sampler_preserves_history_and_recent_tail():
    total = 2_000
    frame = ML.pd.DataFrame({
        "ts": ML.np.arange(total, dtype=ML.np.int64) * ML.M15_MS,
        "atr": ML.np.ones(total),
        "ema21": ML.np.ones(total),
        "swing_high20": ML.np.ones(total) * 2,
        "swing_low20": ML.np.ones(total) * 0.5,
    })
    sampled, report = ML.sample_training_anchors(frame)
    assert len(sampled) == ML.MAX_TRAIN_ANCHORS
    assert report["availableAnchors"] == total
    assert report["usedAnchors"] == ML.MAX_TRAIN_ANCHORS
    assert report["strategy"] == "UNIFORM_HISTORY_PLUS_RECENT_TAIL"
    assert int(sampled.iloc[0]["ts"]) == int(frame.iloc[0]["ts"])
    assert int(sampled.iloc[-1]["ts"]) == int(frame.iloc[-1]["ts"])
    expected_tail = frame.tail(ML.RECENT_TRAIN_ANCHORS)["ts"].astype(int).tolist()
    actual_tail = sampled.tail(ML.RECENT_TRAIN_ANCHORS)["ts"].astype(int).tolist()
    assert actual_tail == expected_tail
    assert sampled["ts"].is_monotonic_increasing


def test_selfplay_accepts_only_matching_verified_source():
    primary = verified_entry("PRIMARY")
    fallback = verified_entry("FALLBACK")
    assert SELFPLAY.training_entry(primary, "PRIMARY") is True
    assert SELFPLAY.training_entry(fallback, "FALLBACK") is True
    assert SELFPLAY.training_entry(primary, "FALLBACK") is False
    assert SELFPLAY.training_entry(fallback, "PRIMARY") is False


if __name__ == "__main__":
    tests = [
        test_mt5_training_pack_validates,
        test_twelve_training_pack_validates,
        test_cross_source_pack_is_rejected,
        test_all_12_geometries_survive_extreme_structure,
        test_training_anchor_sampler_preserves_history_and_recent_tail,
        test_selfplay_accepts_only_matching_verified_source,
    ]
    for test in tests:
        test()
    print(f"auto hybrid V44 Python: {len(tests)} tests passed")
