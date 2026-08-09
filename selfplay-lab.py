#!/usr/bin/env python3
"""OneMonth OS V42 Self-Play Lab.

Consumes virtual candidate outcomes produced by build-ai-shadow.mjs and creates:
- ai-selfplay.json: forward-test / replay summary and learning state
- ai-thresholds.json: guarded auto-threshold recommendations
- ai-counterfactual.json: alternative entry/risk/RR geometry replay
- ai-autopsy.json: failure-mode analysis

Safety/data policy:
- Only Twelve Data PRIMARY shadow outcomes are allowed to tune the PRIMARY brain.
- MT5 fallback outcomes remain observational and never tune PRIMARY thresholds.
- Threshold changes are recommendations until enough chronological validation exists.
- No broker execution is performed.
"""
from __future__ import annotations

import json
import hashlib
import math
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np

ROOT = Path.cwd()
SHADOW = ROOT / "ai-shadow-journal.json"
PRIMARY = ROOT / "xauusd-primary.json"
BRAIN = ROOT / "ai-ml-brain.json"
OUT_SELF = ROOT / "ai-selfplay.json"
OUT_THRESH = ROOT / "ai-thresholds.json"
OUT_CF = ROOT / "ai-counterfactual.json"
OUT_AUTOPSY = ROOT / "ai-autopsy.json"
VERSION = "V42.0 SELF-PLAY LAB"
ARTIFACT_SCHEMA = "KAGE_AI_V42"
LABEL_SCHEMA = "M1_FIRST_HIT_V42"
LABEL_SCHEMA_HASH = "7c9ff5daadb124444d716c94"
MIN_NEW_COHORTS_CONFIRM = 4
FILL_MIN = 90
OUTCOME_MIN = 180


def now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load(path: Path, default=None):
    if default is None:
        default = {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save(path: Path, obj) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")


def f(v, d=0.0) -> float:
    try:
        x = float(v)
        return x if math.isfinite(x) else d
    except Exception:
        return d


def ts_ms(v) -> int:
    x = f(v, math.nan)
    if not math.isfinite(x):
        return 0
    if x < 10_000_000_000:
        x *= 1000
    return int(x // 60000 * 60000)


def primary_entry(e: dict) -> bool:
    creation = str(e.get("creationFeedKind") or e.get("feedSource") or "").upper()
    outcome = str(e.get("outcomeFeedKind") or "").upper()
    creation_primary = creation == "PRIMARY" or "TWELVE" in creation
    return bool(
        creation_primary
        and outcome == "PRIMARY"
        and e.get("provenanceStatus") == "VERIFIED"
        and e.get("modelArtifactSchema") == ARTIFACT_SCHEMA
        and e.get("labelSchema") == LABEL_SCHEMA
        and e.get("labelSchemaHash") == LABEL_SCHEMA_HASH
        and bool(e.get("creationDataFingerprint"))
        and ts_ms(e.get("creationDataWatermark")) > 0
        and bool(e.get("outcomeDataFingerprint"))
        and ts_ms(e.get("outcomeDataWatermark")) > 0
    )


def completed_entries(entries: Iterable[dict]) -> List[dict]:
    out = []
    for e in entries:
        if not primary_entry(e):
            continue
        if e.get("status") != "COMPLETE":
            continue
        if e.get("result") not in {"TP1", "SL", "TIMEOUT"}:
            continue
        if not math.isfinite(f(e.get("resultR"), math.nan)):
            continue
        out.append(e)
    return sorted(out, key=lambda x: ts_ms(x.get("marketTs")))


def stable_hash(value) -> str:
    payload = json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:24]


def evidence_identity(rows: List[dict], recommended: dict) -> dict:
    ordered = sorted(rows, key=lambda x: (ts_ms(x.get("marketTs")), str(x.get("id") or "")))
    cohorts = sorted({ts_ms(x.get("marketTs")) for x in ordered if ts_ms(x.get("marketTs")) > 0})
    outcomes = [{
        "id": str(x.get("id") or ""),
        "marketTs": ts_ms(x.get("marketTs")),
        "result": str(x.get("result") or ""),
        "resultR": round(f(x.get("resultR")), 6),
        "outcomeFeedKind": str(x.get("outcomeFeedKind") or ""),
        "outcomeDataFingerprint": str(x.get("outcomeDataFingerprint") or ""),
    } for x in ordered]
    return {
        "candidateHash": stable_hash(recommended),
        "evidenceHash": stable_hash(outcomes),
        "cohortCount": len(cohorts),
        "rowCount": len(ordered),
        "watermark": cohorts[-1] if cohorts else 0,
    }


def advance_promotion(previous: dict, raw_activation: bool, identity: dict) -> dict:
    previous = previous or {}
    prev_streak = int(previous.get("promotionStreak") or 0)
    prev_candidate = str(previous.get("candidateHash") or "")
    prev_evidence = str(previous.get("evidenceHash") or "")
    prev_cohorts = int(previous.get("evidenceCohorts") or 0)
    prev_watermark = int(previous.get("evidenceWatermark") or 0)
    candidate_hash = str(identity.get("candidateHash") or "")
    evidence_hash = str(identity.get("evidenceHash") or "")
    cohorts = int(identity.get("cohortCount") or 0)
    watermark = int(identity.get("watermark") or 0)
    new_cohorts = max(0, cohorts - prev_cohorts)

    advanced = False
    if not raw_activation:
        streak, reason = 0, "ACTIVATION_GUARD_FAILED"
    elif not prev_candidate or prev_streak <= 0:
        streak, advanced, reason = 1, True, "FIRST_DISTINCT_EVIDENCE_PASS"
    elif candidate_hash != prev_candidate:
        streak, advanced, reason = 1, True, "NEW_CANDIDATE_RESTART_CONFIRMATION"
    elif evidence_hash == prev_evidence:
        streak, reason = prev_streak, "IDENTICAL_EVIDENCE_NO_ADVANCE"
    elif watermark <= prev_watermark or new_cohorts < MIN_NEW_COHORTS_CONFIRM:
        streak, reason = prev_streak, "INSUFFICIENT_NEW_COHORTS_NO_ADVANCE"
    else:
        streak, advanced, reason = prev_streak + 1, True, "NEW_CHRONOLOGICAL_EVIDENCE_PASS"

    return {
        "promotionStreak": streak,
        "trusted": bool(raw_activation and streak >= 2),
        "promotionAdvanced": advanced,
        "promotionReason": reason,
        "newCohortsSincePass": new_cohorts,
    }


def metrics(rows: List[dict]) -> dict:
    if not rows:
        return {"samples": 0, "winRate": None, "avgR": None, "sumR": 0, "maxDrawdownR": None, "profitFactor": None}
    rs = np.array([f(x.get("resultR")) for x in rows], dtype=float)
    wins = rs > 0
    eq = np.cumsum(rs)
    peak = np.maximum.accumulate(np.r_[0.0, eq])[:-1]
    dd = peak - eq
    gains = float(rs[rs > 0].sum())
    losses = float(-rs[rs < 0].sum())
    return {
        "samples": int(len(rows)),
        "winRate": round(float(100 * wins.mean()), 1),
        "avgR": round(float(rs.mean()), 4),
        "sumR": round(float(rs.sum()), 3),
        "maxDrawdownR": round(float(dd.max(initial=0.0)), 3),
        "profitFactor": round(gains / losses, 3) if losses > 1e-9 else None,
    }


def rule_pass(e: dict, t: dict) -> bool:
    return (
        f(e.get("score")) >= t["minPlanScore"]
        and f(e.get("pTp1")) >= t["minTp1Probability"]
        and f(e.get("pCleanWin")) >= t["minCleanWinProbability"]
        and f(e.get("pSl")) <= t["maxSlProbability"]
        and f(e.get("evR")) >= t["minExpectedValueR"]
        and (f(e.get("pTp1")) - f(e.get("pSl"))) >= t["minTp1SlEdgePts"]
        and f(e.get("disagreementPts")) <= t["maxDisagreementPts"]
        and f(e.get("oodScore")) <= t["maxOodScore"]
    )


def objective(m: dict) -> float:
    n = int(m.get("samples") or 0)
    if n < 15:
        return -999.0
    avg = f(m.get("avgR"), -9)
    dd = f(m.get("maxDrawdownR"), 99)
    wr = f(m.get("winRate"), 0) / 100
    size = min(1.0, math.sqrt(n / 80))
    return avg * 1.8 * size + (wr - 0.5) * 0.22 - dd * 0.015


def baseline_thresholds(brain: dict) -> dict:
    p = brain.get("policy") or {}
    return {
        "minPlanScore": f(p.get("minimumPlanScore"), 64),
        "minTp1Probability": f(p.get("minimumTp1Probability"), 30),
        "minCleanWinProbability": f(p.get("minimumCleanWinProbability"), 28),
        "maxSlProbability": f(p.get("maximumSlProbability"), 42),
        "minExpectedValueR": f(p.get("minimumExpectedValueR"), 0.16),
        "minTp1SlEdgePts": f(p.get("minimumTp1SlEdgePts"), 6),
        "maxDisagreementPts": f(p.get("maximumDisagreementPts"), 17),
        "maxOodScore": f(p.get("maximumOodScore"), 55),
    }


def search_thresholds(rows: List[dict], base: dict) -> Tuple[dict, dict]:
    if len(rows) < 80:
        return base, {"ready": False, "reason": "NEED_AT_LEAST_80_PRIMARY_SHADOW_OUTCOMES"}
    cut = max(50, int(len(rows) * 0.70))
    train, valid = rows[:cut], rows[cut:]
    if len(valid) < 24:
        return base, {"ready": False, "reason": "VALIDATION_TAIL_TOO_SMALL"}

    grids = {
        "minPlanScore": sorted(set([58, 62, 66, 70, 74, round(base["minPlanScore"], 1)])),
        "minTp1Probability": sorted(set([28, 34, 40, 46, 52, round(base["minTp1Probability"], 1)])),
        "minCleanWinProbability": sorted(set([22, 28, 34, 40, 46, round(base["minCleanWinProbability"], 1)])),
        "maxSlProbability": sorted(set([28, 34, 40, 46, round(base["maxSlProbability"], 1)])),
        "minExpectedValueR": sorted(set([0.00, 0.08, 0.16, 0.24, 0.32, round(base["minExpectedValueR"], 2)])),
    }
    # Keep stability/OOD gates fixed; optimize the trade-quality gates only.
    fixed = {k: base[k] for k in ["minTp1SlEdgePts", "maxDisagreementPts", "maxOodScore"]}
    best = None
    for score in grids["minPlanScore"]:
        for tp in grids["minTp1Probability"]:
            for clean in grids["minCleanWinProbability"]:
                for sl in grids["maxSlProbability"]:
                    for ev in grids["minExpectedValueR"]:
                        t = {**fixed, "minPlanScore": score, "minTp1Probability": tp,
                             "minCleanWinProbability": clean, "maxSlProbability": sl,
                             "minExpectedValueR": ev}
                        chosen = [x for x in train if rule_pass(x, t)]
                        m = metrics(chosen)
                        obj = objective(m)
                        if best is None or obj > best[0]:
                            best = (obj, t, m)
    assert best is not None
    _, candidate, train_m = best
    valid_m = metrics([x for x in valid if rule_pass(x, candidate)])
    base_train = metrics([x for x in train if rule_pass(x, base)])
    base_valid = metrics([x for x in valid if rule_pass(x, base)])

    # Promotion guard: new thresholds need enough unseen tail trades and materially
    # better average R without a severe drawdown increase.
    improvement = f(valid_m.get("avgR"), -9) - f(base_valid.get("avgR"), -9)
    enough = int(valid_m.get("samples") or 0) >= 18
    dd_ok = (base_valid.get("maxDrawdownR") is None or valid_m.get("maxDrawdownR") is None
             or f(valid_m.get("maxDrawdownR")) <= max(2.0, f(base_valid.get("maxDrawdownR")) * 1.20))
    positive = f(valid_m.get("avgR"), -9) > 0.02 and f(valid_m.get("winRate"), 0) >= 42
    activation = bool(enough and dd_ok and positive and improvement >= 0.03)
    evidence = {
        "ready": True,
        "activationReady": activation,
        "train": train_m,
        "validation": valid_m,
        "baselineTrain": base_train,
        "baselineValidation": base_valid,
        "validationAvgRImprovement": round(improvement, 4),
        "chronologicalSplit": "70/30",
        "note": "Thresholds auto-activate only after unseen-tail improvement and drawdown guards pass.",
    }
    return candidate, evidence


def context_modifiers(rows: List[dict]) -> dict:
    out = {"orderType": {}, "regime": {}, "session": {}}
    for field, target in [("type", "orderType"), ("regime", "regime"), ("session", "session")]:
        groups = defaultdict(list)
        for e in rows:
            groups[str(e.get(field) or "UNKNOWN")].append(e)
        for k, g in groups.items():
            m = metrics(g)
            if len(g) < 35:
                continue
            avg = f(m.get("avgR"))
            wr = f(m.get("winRate"), 50)
            # Small bounded deltas only. This is deliberately conservative.
            score_delta = float(np.clip(-avg * 8 + (50 - wr) * 0.05, -4, 5))
            tp_delta = float(np.clip(-avg * 5 + (50 - wr) * 0.035, -3, 4))
            out[target][k] = {
                "samples": len(g),
                "avgR": m["avgR"],
                "winRate": m["winRate"],
                "minPlanScoreDelta": round(score_delta, 2),
                "minTp1ProbabilityDelta": round(tp_delta, 2),
            }
    return out


def normalize_primary_bars(pack: dict) -> List[dict]:
    raw = (pack.get("timeframes") or pack.get("data") or {}).get("M1") or []
    out = []
    for x in raw:
        ts = ts_ms(x.get("ts"))
        o, h, l, c = map(lambda k: f(x.get(k), math.nan), ["open", "high", "low", "close"])
        if ts and all(math.isfinite(v) and v > 0 for v in [o, h, l, c]) and h >= max(o, c) and l <= min(o, c):
            out.append({"ts": ts, "open": o, "high": h, "low": l, "close": c})
    dedup = {x["ts"]: x for x in out}
    return sorted(dedup.values(), key=lambda x: x["ts"])


def first_index(bars: List[dict], ts: int) -> int:
    lo, hi, ans = 0, len(bars) - 1, -1
    while lo <= hi:
        mid = (lo + hi) // 2
        if bars[mid]["ts"] >= ts:
            ans, hi = mid, mid - 1
        else:
            lo = mid + 1
    return ans


def simulate(bars: List[dict], e: dict, entry: float, risk: float, rr: float) -> Optional[dict]:
    side = str(e.get("side") or "").upper()
    kind = "STOP" if "STOP" in str(e.get("type") or "").upper() else "LIMIT"
    if side not in {"BUY", "SELL"} or risk <= 0:
        return None
    sl = entry - risk if side == "BUY" else entry + risk
    tp = entry + rr * risk if side == "BUY" else entry - rr * risk
    created = ts_ms(e.get("marketTs"))
    i0 = first_index(bars, created + 60000)
    if i0 < 0:
        return None
    fill_deadline = created + FILL_MIN * 60000
    fill = -1
    for i in range(i0, len(bars)):
        b = bars[i]
        if b["ts"] > fill_deadline:
            break
        touched = (b["high"] >= entry if side == "BUY" else b["low"] <= entry) if kind == "STOP" else (b["low"] <= entry <= b["high"])
        if touched:
            fill = i
            break
    if fill < 0:
        return {"filled": False, "result": "NO_FILL", "resultR": 0.0}
    deadline = bars[fill]["ts"] + OUTCOME_MIN * 60000
    mfe = mae = 0.0
    last = bars[fill]
    for i in range(fill, len(bars)):
        b = bars[i]
        if b["ts"] > deadline:
            break
        last = b
        if side == "BUY":
            mfe = max(mfe, (b["high"] - entry) / risk); mae = max(mae, (entry - b["low"]) / risk)
            sl_hit, tp_hit = b["low"] <= sl, b["high"] >= tp
        else:
            mfe = max(mfe, (entry - b["low"]) / risk); mae = max(mae, (b["high"] - entry) / risk)
            sl_hit, tp_hit = b["high"] >= sl, b["low"] <= tp
        # Conservative same-M1 ordering.
        if sl_hit:
            return {"filled": True, "result": "SL", "resultR": -1.0, "mfeR": mfe, "maeR": mae}
        if tp_hit:
            return {"filled": True, "result": "TP1", "resultR": rr, "mfeR": mfe, "maeR": mae}
    mark = (last["close"] - entry) / risk if side == "BUY" else (entry - last["close"]) / risk
    return {"filled": True, "result": "TIMEOUT", "resultR": float(mark), "mfeR": mfe, "maeR": mae}


def counterfactual(rows: List[dict], bars: List[dict]) -> dict:
    # Limit cost: newest 600 resolved primary shadow ideas that still exist in PRIMARY M1 history.
    candidates = rows[-600:]
    variants = []
    for shift in [-0.10, 0.0, 0.10]:
        for risk_mult in [0.85, 1.0, 1.15]:
            for rr_mult in [0.85, 1.0, 1.15]:
                variants.append((shift, risk_mult, rr_mult))
    scores = {v: [] for v in variants}
    fills = Counter()
    used = 0
    for e in candidates:
        original_risk = abs(f(e.get("entry")) - f(e.get("sl")))
        rr0 = f(e.get("rr1"), 1.5)
        if original_risk <= 0:
            continue
        side = str(e.get("side") or "").upper()
        kind = "STOP" if "STOP" in str(e.get("type") or "").upper() else "LIMIT"
        direction = 1 if side == "BUY" else -1
        geometry_dir = 1 if kind == "STOP" else -1
        for v in variants:
            shift, risk_mult, rr_mult = v
            entry = f(e.get("entry")) + direction * geometry_dir * shift * original_risk
            sim = simulate(bars, e, entry, original_risk * risk_mult, max(0.7, rr0 * rr_mult))
            if sim is None:
                continue
            scores[v].append(f(sim.get("resultR")))
            if sim.get("filled"):
                fills[v] += 1
        used += 1
    ranked = []
    for v, rs in scores.items():
        if len(rs) < 20:
            continue
        arr = np.asarray(rs, dtype=float)
        ranked.append({
            "entryShiftRisk": v[0], "riskMultiplier": v[1], "rrMultiplier": v[2],
            "samples": len(rs), "fillRate": round(100 * fills[v] / len(rs), 1),
            "avgR": round(float(arr.mean()), 4), "positiveRate": round(float(100 * (arr > 0).mean()), 1),
        })
    ranked.sort(key=lambda x: (x["avgR"], x["positiveRate"]), reverse=True)
    baseline = next((x for x in ranked if x["entryShiftRisk"] == 0 and x["riskMultiplier"] == 1 and x["rrMultiplier"] == 1), None)
    best = ranked[0] if ranked else None
    improvement = (f(best.get("avgR")) - f(baseline.get("avgR"))) if best and baseline else None
    return {
        "ready": bool(best and baseline and used >= 30),
        "source": "TWELVE_DATA_PRIMARY_M1_ONLY",
        "ideasReplayed": used,
        "variantsTested": len(variants),
        "best": best,
        "baseline": baseline,
        "avgRImprovement": round(improvement, 4) if improvement is not None else None,
        "top": ranked[:8],
        "note": "Counterfactual geometry is advisory. It is never applied unless future chronological evidence also supports it.",
    }


def autopsy(rows: List[dict]) -> dict:
    failures = [e for e in rows if e.get("result") == "SL"]
    causes = Counter()
    by_type = defaultdict(Counter)
    examples = []
    for e in failures:
        c = []
        typ = str(e.get("type") or "UNKNOWN")
        if "STOP" in typ:
            c.append("FALSE_BREAKOUT")
        else:
            c.append("REVERSION_FAILED")
        if f(e.get("disagreementPts")) > 17:
            c.append("MODEL_DISAGREEMENT")
        if f(e.get("oodScore")) > 32:
            c.append("REGIME_SHIFT")
        if f(e.get("pTp1")) - f(e.get("pSl")) < 8:
            c.append("WEAK_TP1_SL_EDGE")
        if f(e.get("score")) < 65:
            c.append("LOW_PLAN_QUALITY")
        if f(e.get("pTp1")) >= 60:
            c.append("OVERCONFIDENT_TP1")
        if f(e.get("maeR")) >= 0.9 and f(e.get("mfeR")) < 0.35:
            c.append("IMMEDIATE_ADVERSE_EXCURSION")
        if f(e.get("fillMinutes"), 0) > 45:
            c.append("LATE_FILL")
        for x in set(c):
            causes[x] += 1; by_type[typ][x] += 1
        if len(examples) < 12:
            examples.append({"id": e.get("id"), "type": typ, "regime": e.get("regime"), "session": e.get("session"), "causes": c})
    return {
        "ready": len(failures) >= 10,
        "failures": len(failures),
        "topCauses": [{"cause": k, "count": v, "share": round(100 * v / max(1, len(failures)), 1)} for k, v in causes.most_common(10)],
        "byType": {k: dict(v.most_common()) for k, v in by_type.items()},
        "examples": examples,
        "note": "Autopsy labels are diagnostic heuristics, not causal proof.",
    }


def group_performance(rows: List[dict], field: str) -> dict:
    groups = defaultdict(list)
    for e in rows:
        groups[str(e.get(field) or "UNKNOWN")].append(e)
    return {k: metrics(v) for k, v in groups.items() if len(v) >= 5}


def main() -> None:
    shadow = load(SHADOW, {"entries": []})
    entries = shadow.get("entries") or []
    primary_rows = completed_entries(entries)
    brain = load(BRAIN, {})
    base = baseline_thresholds(brain)
    recommended, evidence = search_thresholds(primary_rows, base)
    modifiers = context_modifiers(primary_rows)
    primary_pack = load(PRIMARY, {})
    bars = normalize_primary_bars(primary_pack)
    cf = counterfactual(primary_rows, bars) if bars else {"ready": False, "reason": "PRIMARY_M1_NOT_READY"}
    au = autopsy(primary_rows)

    # Chronological forward replay: last 30% is treated as unseen tail.
    split = max(0, int(len(primary_rows) * 0.70))
    tail = primary_rows[split:] if split else []
    replay_base = metrics([x for x in tail if rule_pass(x, base)]) if tail else metrics([])
    replay_new = metrics([x for x in tail if rule_pass(x, recommended)]) if tail else metrics([])

    previous_thresholds = load(OUT_THRESH, {})
    raw_activation = bool(evidence.get("activationReady"))
    identity = evidence_identity(primary_rows, recommended)
    promotion = advance_promotion(previous_thresholds, raw_activation, identity)
    promotion_streak = promotion["promotionStreak"]
    trusted_activation = promotion["trusted"]
    threshold_pack = {
        "version": VERSION,
        "generatedAt": now(),
        "artifactSchema": ARTIFACT_SCHEMA,
        "labelSchema": LABEL_SCHEMA,
        "labelSchemaHash": LABEL_SCHEMA_HASH,
        "source": "PRIMARY_SHADOW_OUTCOMES_ONLY",
        "trusted": trusted_activation,
        "activationReady": raw_activation,
        "promotionStreak": promotion_streak,
        "requiredPromotionStreak": 2,
        "candidateHash": identity["candidateHash"],
        "evidenceHash": identity["evidenceHash"],
        "evidenceRows": identity["rowCount"],
        "evidenceCohorts": identity["cohortCount"],
        "evidenceWatermark": identity["watermark"],
        "promotionAdvanced": promotion["promotionAdvanced"],
        "promotionReason": promotion["promotionReason"],
        "newCohortsSincePass": promotion["newCohortsSincePass"],
        "baseline": base,
        "recommended": recommended,
        "contextModifiers": modifiers,
        "evidence": evidence,
        "policy": {
            "autoApply": True,
            "rule": f"ml-train.py may use recommended thresholds only after two distinct chronological evidence passes with at least {MIN_NEW_COHORTS_CONFIRM} new decision cohorts; identical workflow reruns never advance promotion.",
            "fallback": "Use V37/V38 static guarded thresholds when evidence is insufficient.",
        },
    }
    save(OUT_THRESH, threshold_pack)
    save(OUT_CF, {"version": VERSION, "generatedAt": now(), **cf})
    save(OUT_AUTOPSY, {"version": VERSION, "generatedAt": now(), **au})

    summary = shadow.get("summary") or {}
    self_pack = {
        "version": VERSION,
        "generatedAt": now(),
        "ready": len(primary_rows) >= 10,
        "mode": "SHADOW_SELF_PLAY",
        "dataIsolation": {
            "allShadowIdeas": int(summary.get("total") or len(entries)),
            "primaryLearningOutcomes": len(primary_rows),
            "fallbackUsedForPrimaryLearning": False,
            "artifactSchema": ARTIFACT_SCHEMA,
            "labelSchema": LABEL_SCHEMA,
            "labelSchemaHash": LABEL_SCHEMA_HASH,
        },
        "shadow": summary,
        "primaryResolved": metrics(primary_rows),
        "forwardReplay": {
            "chronological": True,
            "tailFraction": 0.30,
            "baselineGate": replay_base,
            "candidateGate": replay_new,
            "candidateActivationReady": bool(evidence.get("activationReady")),
            "evidenceHash": identity["evidenceHash"],
            "evidenceCohorts": identity["cohortCount"],
            "promotionAdvanced": promotion["promotionAdvanced"],
            "promotionReason": promotion["promotionReason"],
        },
        "thresholdOptimizer": {
            "ready": bool(evidence.get("ready")),
            "activationReady": bool(evidence.get("activationReady")),
            "validationAvgRImprovement": evidence.get("validationAvgRImprovement"),
        },
        "counterfactual": {
            "ready": bool(cf.get("ready")),
            "ideasReplayed": cf.get("ideasReplayed"),
            "best": cf.get("best"),
            "avgRImprovement": cf.get("avgRImprovement"),
        },
        "autopsy": {
            "ready": bool(au.get("ready")),
            "failures": au.get("failures"),
            "topCauses": au.get("topCauses", [])[:5],
        },
        "performance": {
            "byType": group_performance(primary_rows, "type"),
            "byRegime": group_performance(primary_rows, "regime"),
            "bySession": group_performance(primary_rows, "session"),
            "byVariant": group_performance(primary_rows, "variant"),
        },
        "learningLoop": [
            "GENERATE_ALL_12_VIRTUAL_CANDIDATES",
            "WAIT_FOR_FUTURE_M1_GROUND_TRUTH",
            "FIRST_HIT_TP1_OR_SL",
            "STORE_MFE_MAE_FILL_TIME",
            "AUTOPSY_FAILURES",
            "COUNTERFACTUAL_GEOMETRY_REPLAY",
            "CHRONOLOGICAL_THRESHOLD_VALIDATION",
            "GUARDED_PROMOTION_TO_NEXT_TRAIN",
        ],
    }
    save(OUT_SELF, self_pack)
    print("V38 Self-Play Lab", {
        "shadow": summary.get("total", len(entries)),
        "primaryResolved": len(primary_rows),
        "thresholdReady": threshold_pack["activationReady"],
        "counterfactualReady": bool(cf.get("ready")),
        "autopsyFailures": au.get("failures"),
    })


if __name__ == "__main__":
    main()
