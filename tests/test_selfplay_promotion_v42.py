import importlib.util
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("selfplay_lab_v42", ROOT / "selfplay-lab.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(MODULE)


def identity(candidate="candidate-a", evidence="evidence-a", cohorts=80, watermark=1_000):
    return {
        "candidateHash": candidate,
        "evidenceHash": evidence,
        "cohortCount": cohorts,
        "rowCount": cohorts * 2,
        "watermark": watermark,
    }


def test_identical_evidence_does_not_advance():
    first = MODULE.advance_promotion({}, True, identity())
    assert first["promotionStreak"] == 1
    assert first["promotionAdvanced"] is True

    previous = {
        "promotionStreak": first["promotionStreak"],
        "candidateHash": "candidate-a",
        "evidenceHash": "evidence-a",
        "evidenceCohorts": 80,
        "evidenceWatermark": 1_000,
    }
    repeated = MODULE.advance_promotion(previous, True, identity())
    assert repeated["promotionStreak"] == 1
    assert repeated["trusted"] is False
    assert repeated["promotionAdvanced"] is False
    assert repeated["promotionReason"] == "IDENTICAL_EVIDENCE_NO_ADVANCE"


def test_new_hash_without_new_cohorts_does_not_advance():
    previous = {
        "promotionStreak": 1,
        "candidateHash": "candidate-a",
        "evidenceHash": "evidence-a",
        "evidenceCohorts": 80,
        "evidenceWatermark": 1_000,
    }
    result = MODULE.advance_promotion(previous, True, identity(evidence="evidence-b", cohorts=81, watermark=1_001))
    assert result["promotionStreak"] == 1
    assert result["trusted"] is False
    assert result["promotionReason"] == "INSUFFICIENT_NEW_COHORTS_NO_ADVANCE"


def test_distinct_chronological_evidence_can_confirm():
    previous = {
        "promotionStreak": 1,
        "candidateHash": "candidate-a",
        "evidenceHash": "evidence-a",
        "evidenceCohorts": 80,
        "evidenceWatermark": 1_000,
    }
    result = MODULE.advance_promotion(previous, True, identity(evidence="evidence-b", cohorts=84, watermark=2_000))
    assert result["promotionStreak"] == 2
    assert result["trusted"] is True
    assert result["promotionAdvanced"] is True
    assert result["promotionReason"] == "NEW_CHRONOLOGICAL_EVIDENCE_PASS"


def test_candidate_change_restarts_confirmation():
    previous = {
        "promotionStreak": 2,
        "candidateHash": "candidate-a",
        "evidenceHash": "evidence-a",
        "evidenceCohorts": 80,
        "evidenceWatermark": 1_000,
    }
    result = MODULE.advance_promotion(previous, True, identity(candidate="candidate-b", evidence="evidence-b", cohorts=90, watermark=2_000))
    assert result["promotionStreak"] == 1
    assert result["trusted"] is False
    assert result["promotionReason"] == "NEW_CANDIDATE_RESTART_CONFIRMATION"


def test_only_verified_primary_v42_outcomes_are_eligible():
    valid = {
        "creationFeedKind": "PRIMARY",
        "outcomeFeedKind": "PRIMARY",
        "provenanceStatus": "VERIFIED",
        "modelArtifactSchema": MODULE.ARTIFACT_SCHEMA,
        "labelSchema": MODULE.LABEL_SCHEMA,
        "labelSchemaHash": MODULE.LABEL_SCHEMA_HASH,
        "creationDataFingerprint": "primary-create",
        "creationDataWatermark": 1_000,
        "outcomeDataFingerprint": "primary-outcome",
        "outcomeDataWatermark": 2_000,
    }
    assert MODULE.primary_entry(valid) is True
    assert MODULE.primary_entry({**valid, "outcomeFeedKind": "FALLBACK"}) is False
    assert MODULE.primary_entry({**valid, "modelArtifactSchema": "LEGACY"}) is False


if __name__ == "__main__":
    tests = [
        test_identical_evidence_does_not_advance,
        test_new_hash_without_new_cohorts_does_not_advance,
        test_distinct_chronological_evidence_can_confirm,
        test_candidate_change_restarts_confirmation,
        test_only_verified_primary_v42_outcomes_are_eligible,
    ]
    for test in tests:
        test()
    print(f"self-play promotion V42: {len(tests)} tests passed")
