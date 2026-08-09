#!/usr/bin/env python3
"""OneMonth OS V42 Autonomous Self-Play Precision Brain.

Design goals:
- Train on Twelve Data PRIMARY history only when an isolated primary pack exists.
- Score the currently ACTIVE feed (Twelve or MT5 fallback) without blending feed prices.
- Use completed-bar timestamps to reduce timeframe look-ahead.
- Label pending orders with M1 first-hit sequencing.
- Generate 12 dynamic pending geometries (4 order types x 3 variants).
- Walk-forward + time purge, recency weighting, calibrated probabilities.
- Context expert layer (regime/session/order/variant), OOD drift guard, news guard.
- Quantile excursion uncertainty, block-bootstrap robustness and low-weight path stress.
- Hard NO-TRADE quality gate. No order execution is performed by this script.

The model can improve statistical decision quality but cannot guarantee profitable trades.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import (
    ExtraTreesClassifier,
    ExtraTreesRegressor,
    HistGradientBoostingClassifier,
    HistGradientBoostingRegressor,
)
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, roc_auc_score

from ai_provenance_v42 import (
    ARTIFACT_SCHEMA_VERSION,
    LABEL_SCHEMA,
    LABEL_SCHEMA_HASH,
    compatible_artifact,
    feature_schema_hash,
    validate_primary_pack_metadata,
)

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except Exception:
    XGBClassifier = None
    HAS_XGBOOST = False

ROOT = Path(os.environ.get("GITHUB_WORKSPACE", Path.cwd()))
LIVE_DATA_PATH = ROOT / "xauusd.json"
PRIMARY_DATA_PATH = ROOT / "xauusd-primary.json"
NEWS_PATH = ROOT / "news.json"
OUT_PATH = ROOT / "ai-ml-brain.json"
CANDIDATE_PATH = ROOT / "ai-ml-candidate.json"
GOV_PATH = ROOT / "ai-ml-governance.json"
JOURNAL_PATH = ROOT / "ai-outcome-journal.json"
SHADOW_PATH = ROOT / "ai-shadow-journal.json"
SELFPLAY_PATH = ROOT / "ai-selfplay.json"
THRESHOLD_PATH = ROOT / "ai-thresholds.json"
COUNTERFACTUAL_PATH = ROOT / "ai-counterfactual.json"
AUTOPSY_PATH = ROOT / "ai-autopsy.json"

VERSION = "V42 AUTONOMOUS SELF-PLAY PRECISION BRAIN"
SEED = 3809
RNG = np.random.default_rng(SEED)
MIN_M15 = 420
MIN_M1 = 1800
N_FOLDS = 3
M1_MS = 60_000
M5_MS = 5 * M1_MS
M15_MS = 15 * M1_MS
H1_MS = 60 * M1_MS
FILL_HORIZON_MIN = 90
OUTCOME_HORIZON_MIN = 180
PURGE_MS = (FILL_HORIZON_MIN + OUTCOME_HORIZON_MIN + 30) * M1_MS

ORDER_TYPES = ("BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP")
ORDER_ONEHOT = {k: i for i, k in enumerate(ORDER_TYPES)}
VARIANTS = ("TIGHT", "BALANCED", "DEEP")
VARIANT_PARAMS = {
    "TIGHT": {"entry_atr": 0.06, "risk_atr": 0.78, "rr1": 1.25, "rr2": 1.90, "zone": 0.035},
    "BALANCED": {"entry_atr": 0.14, "risk_atr": 0.98, "rr1": 1.50, "rr2": 2.30, "zone": 0.050},
    "DEEP": {"entry_atr": 0.27, "risk_atr": 1.18, "rr1": 1.80, "rr2": 2.75, "zone": 0.065},
}
REGIMES = ("TREND_UP", "TREND_DOWN", "RANGE", "BREAKOUT", "HIGH_VOL", "COMPRESSION")
SESSIONS = ("ASIA", "LONDON", "NEW_YORK", "OFF_HOURS")


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def safe_num(v, default=0.0) -> float:
    try:
        x = float(v)
        return x if math.isfinite(x) else default
    except Exception:
        return default


def wait_data(reason: str, counts: Optional[dict] = None) -> None:
    pack = {
        "version": VERSION,
        "generatedAt": utc_now(),
        "ready": False,
        "status": "WAIT_DATA",
        "reason": reason,
        "engine": "V42_PRIMARY_ISOLATED_AUTOML",
        "artifactSchema": {
            "version": ARTIFACT_SCHEMA_VERSION,
            "featureSchemaHash": None,
            "labelSchemaHash": LABEL_SCHEMA_HASH,
        },
        "artifactProvenance": {
            "schemaVersion": ARTIFACT_SCHEMA_VERSION,
            "trainingFeed": "TWELVE_DATA_PRIMARY",
            "mergeFeeds": False,
            "featureSchemaHash": None,
            "labelSchema": LABEL_SCHEMA,
            "labelSchemaHash": LABEL_SCHEMA_HASH,
            "sourceFingerprint": None,
            "dataWatermark": None,
        },
        "training": {
            "counts": counts or {},
            "minimum": {"M1": MIN_M1, "M15": MIN_M15, "M5": 180, "H1": 80},
            "shortfall": {
                "M1": max(0, MIN_M1 - int(safe_num((counts or {}).get("primaryM1", (counts or {}).get("M1", 0)), 0))),
                "M15": max(0, MIN_M15 - int(safe_num((counts or {}).get("primaryM15", (counts or {}).get("M15", 0)), 0))),
            },
        },
    }
    write_json(CANDIDATE_PATH, pack)
    # Do not destroy a previously valid active brain merely because a new training
    # run is temporarily waiting for more isolated PRIMARY data.
    if not compatible_artifact(load_json(OUT_PATH)):
        write_json(OUT_PATH, pack)
    write_json(GOV_PATH, {
        "version": VERSION,
        "updatedAt": utc_now(),
        "action": "WAIT_DATA",
        "trusted": False,
        "reason": reason,
        "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
        "labelSchemaHash": LABEL_SCHEMA_HASH,
    })
    print("ML WAIT_DATA:", reason, counts or {})
    raise SystemExit(0)


def frame_from_rows(rows: Iterable[dict]) -> pd.DataFrame:
    df = pd.DataFrame(list(rows or []))
    if df.empty:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close"])
    for c in ["ts", "open", "high", "low", "close"]:
        if c not in df.columns:
            df[c] = np.nan
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["ts", "open", "high", "low", "close"])
    valid = (df[["open", "high", "low", "close"]] > 0).all(axis=1)
    valid &= df["high"] >= df[["open", "close"]].max(axis=1)
    valid &= df["low"] <= df[["open", "close"]].min(axis=1)
    df = df[valid].sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)
    return df[["ts", "open", "high", "low", "close"]]


def pack_frames(pack: dict) -> Dict[str, pd.DataFrame]:
    raw = pack.get("timeframes") or pack.get("data") or {}
    frames = {k: frame_from_rows(raw.get(k, [])) for k in ["M1", "M5", "M15", "H1"]}
    watermark = int(safe_num(pack.get("closedBarWatermark") or (pack.get("feed") or {}).get("closedBarWatermark"), 0))
    if watermark > 0:
        widths = {"M1": M1_MS, "M5": M5_MS, "M15": M15_MS, "H1": H1_MS}
        frames = {
            key: df[df["ts"] + widths[key] <= watermark].reset_index(drop=True)
            for key, df in frames.items()
        }
    return frames


def load_packs() -> Tuple[dict, dict, str]:
    live = load_json(LIVE_DATA_PATH)
    if not live:
        wait_data("MISSING_XAUUSD_JSON")
    live_feed = live.get("feed") or {}
    live_watermark = int(safe_num(live.get("closedBarWatermark") or live_feed.get("closedBarWatermark"), 0))
    if (live_feed.get("switching") or {}).get("mergeFeeds") is not False:
        wait_data("LIVE_FEED_ISOLATION_NOT_EXPLICIT")
    if live_watermark <= 0:
        wait_data("LIVE_CLOSED_BAR_WATERMARK_MISSING")
    primary = load_json(PRIMARY_DATA_PATH)
    if primary:
        metadata_ok, metadata_reason, primary_watermark = validate_primary_pack_metadata(primary)
        if not metadata_ok:
            wait_data(metadata_reason, {"primaryPack": True})
        pf = pack_frames(primary)
        widths = {"M1": M1_MS, "M5": M5_MS, "M15": M15_MS, "H1": H1_MS}
        if any(len(df) and int(df.iloc[-1]["ts"]) + widths[key] > primary_watermark for key, df in pf.items()):
            wait_data("PRIMARY_CONTAINS_UNCLOSED_BARS", {key: len(df) for key, df in pf.items()})
        if len(pf["M15"]) >= MIN_M15 and len(pf["M1"]) >= MIN_M1:
            return live, primary, "xauusd-primary.json"
    active = str((live.get("feed") or {}).get("active") or "").upper()
    lf = pack_frames(live)
    pf = pack_frames(primary) if primary else {k: pd.DataFrame() for k in ["M1", "M5", "M15", "H1"]}
    wait_data("PRIMARY_TRAINING_PACK_NOT_READY", {
        "liveActive": active or "UNKNOWN",
        "liveM1": len(lf["M1"]),
        "liveM15": len(lf["M15"]),
        "primaryM1": len(pf["M1"]),
        "primaryM5": len(pf["M5"]),
        "primaryM15": len(pf["M15"]),
        "primaryH1": len(pf["H1"]),
        "primaryPack": bool(primary),
        "rule": "V42 trains only on xauusd-primary.json; active MT5 fallback is inference-only",
    })
    raise AssertionError


def ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=max(3, span // 3)).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def atr(df: pd.DataFrame, period: int = 14) -> pd.Series:
    prev = df["close"].shift(1)
    tr = pd.concat([
        df["high"] - df["low"],
        (df["high"] - prev).abs(),
        (df["low"] - prev).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def adx(df: pd.DataFrame, period: int = 14) -> pd.Series:
    up_move = df["high"].diff()
    down_move = -df["low"].diff()
    plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=df.index)
    a = atr(df, period).replace(0, np.nan)
    plus_di = 100 * plus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / a
    minus_di = 100 * minus_dm.ewm(alpha=1 / period, adjust=False, min_periods=period).mean() / a
    dx = 100 * (plus_di - minus_di).abs() / (plus_di + minus_di).replace(0, np.nan)
    return dx.ewm(alpha=1 / period, adjust=False, min_periods=period).mean().fillna(0)


def tf_features(df: pd.DataFrame, prefix: str, tf_ms: int) -> pd.DataFrame:
    if df.empty:
        return pd.DataFrame()
    x = df.copy()
    close = x["close"]
    a = atr(x).replace(0, np.nan)
    e9, e21, e50, e200 = ema(close, 9), ema(close, 21), ema(close, 50), ema(close, 200)
    rng = (x["high"] - x["low"]).replace(0, np.nan)
    body = x["close"] - x["open"]
    hi20 = x["high"].rolling(20, min_periods=8).max()
    lo20 = x["low"].rolling(20, min_periods=8).min()
    hi50 = x["high"].rolling(50, min_periods=15).max()
    lo50 = x["low"].rolling(50, min_periods=15).min()
    width20 = (hi20 - lo20).replace(0, np.nan)
    width50 = (hi50 - lo50).replace(0, np.nan)
    logret = np.log(close).diff()

    o = pd.DataFrame({"available_ts": x["ts"] + tf_ms})
    o[f"{prefix}_ret1"] = close.pct_change(1)
    o[f"{prefix}_ret4"] = close.pct_change(4)
    o[f"{prefix}_ret12"] = close.pct_change(12)
    o[f"{prefix}_rsi14"] = rsi(close)
    o[f"{prefix}_adx14"] = adx(x)
    o[f"{prefix}_atr_pct"] = a / close
    o[f"{prefix}_ema9_atr"] = (close - e9) / a
    o[f"{prefix}_ema21_atr"] = (close - e21) / a
    o[f"{prefix}_ema50_atr"] = (close - e50) / a
    o[f"{prefix}_ema200_atr"] = (close - e200) / a
    o[f"{prefix}_ema9_21_atr"] = (e9 - e21) / a
    o[f"{prefix}_ema21_50_atr"] = (e21 - e50) / a
    o[f"{prefix}_slope21_atr"] = (e21 - e21.shift(4)) / a
    o[f"{prefix}_body_ratio"] = body / rng
    o[f"{prefix}_upper_wick"] = (x["high"] - x[["open", "close"]].max(axis=1)) / rng
    o[f"{prefix}_lower_wick"] = (x[["open", "close"]].min(axis=1) - x["low"]) / rng
    o[f"{prefix}_range_atr"] = rng / a
    o[f"{prefix}_pos20"] = (close - lo20) / width20
    o[f"{prefix}_pos50"] = (close - lo50) / width50
    o[f"{prefix}_dist_hi20_atr"] = (hi20 - close) / a
    o[f"{prefix}_dist_lo20_atr"] = (close - lo20) / a
    o[f"{prefix}_vol12"] = logret.rolling(12, min_periods=6).std()
    o[f"{prefix}_vol48"] = logret.rolling(48, min_periods=12).std()
    o[f"{prefix}_break_hi20"] = (close > hi20.shift(1)).astype(float)
    o[f"{prefix}_break_lo20"] = (close < lo20.shift(1)).astype(float)
    o[f"{prefix}_trend_strength"] = ((e21 - e50).abs() / a).clip(0, 8)
    o[f"{prefix}_compression"] = (rng / a).rolling(6, min_periods=3).mean()
    return o.replace([np.inf, -np.inf], np.nan)


def session_name(ts_ms: int) -> str:
    h = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).hour
    if 0 <= h < 7:
        return "ASIA"
    if 7 <= h < 13:
        return "LONDON"
    if 13 <= h < 21:
        return "NEW_YORK"
    return "OFF_HOURS"


def regime_name(row: pd.Series) -> str:
    ad = safe_num(row.get("m15_adx14"), 0)
    trend_h1 = safe_num(row.get("h1_ema21_50_atr"), 0)
    slope = safe_num(row.get("m15_slope21_atr"), 0)
    pos = safe_num(row.get("m15_pos20"), 0.5)
    rng = safe_num(row.get("m15_range_atr"), 1.0)
    comp = safe_num(row.get("m15_compression"), 1.0)
    br_hi = safe_num(row.get("m15_break_hi20"), 0)
    br_lo = safe_num(row.get("m15_break_lo20"), 0)
    if rng >= 1.75:
        return "HIGH_VOL"
    if (br_hi > 0.5 or br_lo > 0.5 or pos > 0.96 or pos < 0.04) and ad >= 20:
        return "BREAKOUT"
    if comp < 0.72 and ad < 20:
        return "COMPRESSION"
    if ad >= 23 and trend_h1 > 0.12 and slope > 0.03:
        return "TREND_UP"
    if ad >= 23 and trend_h1 < -0.12 and slope < -0.03:
        return "TREND_DOWN"
    return "RANGE"


def merged_anchor_features(tfs: Dict[str, pd.DataFrame]) -> Tuple[pd.DataFrame, dict]:
    m15 = tfs["M15"]
    if m15.empty:
        return pd.DataFrame(), {k: len(v) for k, v in tfs.items()}

    base = tf_features(m15, "m15", M15_MS).rename(columns={"available_ts": "ts"})
    a = atr(m15)
    base["m15_bar_ts"] = m15["ts"].values
    base["close"] = m15["close"].values
    base["high"] = m15["high"].values
    base["low"] = m15["low"].values
    base["atr"] = a.values
    base["ema21"] = ema(m15["close"], 21).values
    base["swing_high20"] = m15["high"].rolling(20, min_periods=8).max().values
    base["swing_low20"] = m15["low"].rolling(20, min_periods=8).min().values
    base["swing_high50"] = m15["high"].rolling(50, min_periods=15).max().values
    base["swing_low50"] = m15["low"].rolling(50, min_periods=15).min().values

    for tf, prefix, ms in [("M1", "m1", M1_MS), ("M5", "m5", M5_MS), ("H1", "h1", H1_MS)]:
        f = tf_features(tfs.get(tf, pd.DataFrame()), prefix, ms)
        if not f.empty:
            base = pd.merge_asof(
                base.sort_values("ts"), f.sort_values("available_ts"),
                left_on="ts", right_on="available_ts", direction="backward",
                allow_exact_matches=True,
            ).drop(columns=["available_ts"], errors="ignore")

    ts_dt = pd.to_datetime(base["ts"], unit="ms", utc=True)
    hour = ts_dt.dt.hour + ts_dt.dt.minute / 60.0
    dow = ts_dt.dt.dayofweek.astype(float)
    base["hour_sin"] = np.sin(2 * np.pi * hour / 24)
    base["hour_cos"] = np.cos(2 * np.pi * hour / 24)
    base["dow_sin"] = np.sin(2 * np.pi * dow / 7)
    base["dow_cos"] = np.cos(2 * np.pi * dow / 7)
    base["session_asia"] = ((hour >= 0) & (hour < 7)).astype(float)
    base["session_london"] = ((hour >= 7) & (hour < 13)).astype(float)
    base["session_ny"] = ((hour >= 13) & (hour < 21)).astype(float)

    # Microstructure summaries intentionally use only already-closed M1 values.
    base["micro_momentum"] = (
        safe_series(base, "m1_ret4") * 0.45 + safe_series(base, "m1_ret12") * 0.55
    )
    base["micro_rejection_buy"] = safe_series(base, "m1_lower_wick") - safe_series(base, "m1_upper_wick")
    base["micro_rejection_sell"] = -base["micro_rejection_buy"]
    base["micro_breakout"] = safe_series(base, "m1_break_hi20") - safe_series(base, "m1_break_lo20")

    counts = {k: len(v) for k, v in tfs.items()}
    return base.replace([np.inf, -np.inf], np.nan), counts


def safe_series(df: pd.DataFrame, name: str) -> pd.Series:
    if name in df.columns:
        return pd.to_numeric(df[name], errors="coerce").fillna(0.0)
    return pd.Series(np.zeros(len(df)), index=df.index)


def estimate_execution_cost(row: pd.Series, risk: float) -> Tuple[float, float]:
    close = max(safe_num(row.get("close"), 1.0), 1e-9)
    m1_atr = abs(safe_num(row.get("m1_atr_pct"), 0.0)) * close
    # Conservative proxy only. Twelve time_series does not provide executable bid/ask.
    roundtrip_price = max(close * 0.000025, m1_atr * 0.10)
    cost_r = min(0.35, roundtrip_price / max(risk, 1e-9))
    return float(roundtrip_price), float(cost_r)


def candidate_geometry(row: pd.Series, order_type: str, variant: str) -> Optional[dict]:
    p = VARIANT_PARAMS[variant]
    close = safe_num(row.get("close"), np.nan)
    a = safe_num(row.get("atr"), np.nan)
    e21 = safe_num(row.get("ema21"), np.nan)
    hi = safe_num(row.get("swing_high20"), np.nan)
    lo = safe_num(row.get("swing_low20"), np.nan)
    if not all(math.isfinite(x) and x > 0 for x in [close, a, e21, hi, lo]):
        return None
    side = 1 if order_type.startswith("BUY") else -1
    is_limit = order_type.endswith("LIMIT")
    d = p["entry_atr"] * a
    r = p["risk_atr"] * a

    if order_type == "BUY_LIMIT":
        structural = max(lo + 0.07 * a, min(e21, close - d))
        entry = min(close - 0.035 * a, structural)
        sl = min(lo - 0.10 * a, entry - r)
    elif order_type == "SELL_LIMIT":
        structural = min(hi - 0.07 * a, max(e21, close + d))
        entry = max(close + 0.035 * a, structural)
        sl = max(hi + 0.10 * a, entry + r)
    elif order_type == "BUY_STOP":
        entry = max(hi + d * 0.65, close + d)
        sl = min(entry - r, close - 0.08 * a)
    elif order_type == "SELL_STOP":
        entry = min(lo - d * 0.65, close - d)
        sl = max(entry + r, close + 0.08 * a)
    else:
        return None

    risk = abs(entry - sl)
    if not math.isfinite(risk) or risk < 0.35 * a or risk > 3.2 * a:
        return None
    tp1 = entry + side * risk * p["rr1"]
    tp2 = entry + side * risk * p["rr2"]
    zone_half = max(a * p["zone"], close * 0.00002)
    cancel = (lo - 0.30 * a) if side > 0 else (hi + 0.30 * a)
    cost_price, cost_r = estimate_execution_cost(row, risk)
    return {
        "id": f"{order_type}:{variant}",
        "type": order_type,
        "variant": variant,
        "side": "BUY" if side > 0 else "SELL",
        "side_num": side,
        "is_limit": 1.0 if is_limit else 0.0,
        "is_stop": 0.0 if is_limit else 1.0,
        "entry": float(entry),
        "entryLow": float(entry - zone_half),
        "entryHigh": float(entry + zone_half),
        "sl": float(sl),
        "tp1": float(tp1),
        "tp2": float(tp2),
        "risk": float(risk),
        "rr": float(p["rr1"]),
        "rr2": float(p["rr2"]),
        "cancelLevel": float(cancel),
        "estimatedRoundTripCost": float(cost_price),
        "estimatedCostR": float(cost_r),
    }


def order_feature_values(row: pd.Series, geom: dict, regime: str, session: str) -> dict:
    a = max(safe_num(row.get("atr"), 0), 1e-9)
    close = safe_num(row.get("close"), geom["entry"])
    side = geom["side_num"]
    out = {
        "order_side": float(side),
        "order_is_limit": geom["is_limit"],
        "order_is_stop": geom["is_stop"],
        "order_entry_dist_atr": (geom["entry"] - close) / a,
        "order_entry_abs_dist_atr": abs(geom["entry"] - close) / a,
        "order_risk_atr": geom["risk"] / a,
        "order_rr1": geom["rr"],
        "order_rr2": geom["rr2"],
        "order_cost_r": geom["estimatedCostR"],
        "order_side_entry_dist_atr": side * (geom["entry"] - close) / a,
        "order_side_ema21_atr": side * (close - safe_num(row.get("ema21"), close)) / a,
        "order_side_hi20_atr": side * (safe_num(row.get("swing_high20"), close) - close) / a,
        "order_side_lo20_atr": side * (close - safe_num(row.get("swing_low20"), close)) / a,
    }
    for k in ORDER_TYPES:
        out[f"order_{k.lower()}"] = 1.0 if geom["type"] == k else 0.0
    for v in VARIANTS:
        out[f"variant_{v.lower()}"] = 1.0 if geom["variant"] == v else 0.0
    for r in REGIMES:
        out[f"regime_{r.lower()}"] = 1.0 if regime == r else 0.0
    for s in SESSIONS:
        out[f"session_ctx_{s.lower()}"] = 1.0 if session == s else 0.0
    return out


def is_filled_bar(bar, geom: dict) -> bool:
    """Scalar compatibility helper used only by diagnostics/path stress."""
    typ = geom["type"]
    low = safe_num(bar["low"] if isinstance(bar, dict) else bar["low"], math.inf)
    high = safe_num(bar["high"] if isinstance(bar, dict) else bar["high"], -math.inf)
    if typ == "BUY_LIMIT":
        return low <= geom["entry"]
    if typ == "SELL_LIMIT":
        return high >= geom["entry"]
    if typ == "BUY_STOP":
        return high >= geom["entry"]
    return low <= geom["entry"]


def m1_cache(m1: pd.DataFrame) -> dict:
    """One NumPy conversion per dataset build; avoids millions of pandas .iloc calls."""
    if m1.empty:
        return {"ts": np.array([], dtype=np.int64), "high": np.array([], dtype=float), "low": np.array([], dtype=float)}
    return {
        "ts": m1["ts"].to_numpy(dtype=np.int64, copy=False),
        "high": m1["high"].to_numpy(dtype=float, copy=False),
        "low": m1["low"].to_numpy(dtype=float, copy=False),
    }


def _first_true(mask: np.ndarray) -> Optional[int]:
    idx = np.flatnonzero(mask)
    return int(idx[0]) if len(idx) else None


def simulate_outcome_m1(cache: dict, decision_ts: int, geom: dict) -> dict:
    """Vectorized M1 first-hit labeling with conservative same-minute SL priority."""
    ts_arr = cache["ts"]
    high_arr = cache["high"]
    low_arr = cache["low"]
    if len(ts_arr) == 0:
        return {"complete": False}
    # Do not label an old M15 anchor with a later M1 window. Historical M1 must
    # actually cover the decision timestamp, otherwise the label is unknown.
    if decision_ts < int(ts_arr[0]) - M1_MS:
        return {"complete": False}

    start = int(np.searchsorted(ts_arr, decision_ts, side="left"))
    fill_end_ts = decision_ts + FILL_HORIZON_MIN * M1_MS
    full_end_ts = fill_end_ts + OUTCOME_HORIZON_MIN * M1_MS
    if start >= len(ts_arr) or int(ts_arr[-1]) < full_end_ts:
        return {"complete": False}

    fill_end = int(np.searchsorted(ts_arr, fill_end_ts, side="right"))
    hs = high_arr[start:fill_end]
    ls = low_arr[start:fill_end]
    typ = geom["type"]
    if typ == "BUY_LIMIT":
        mask = ls <= geom["entry"]
    elif typ == "SELL_LIMIT":
        mask = hs >= geom["entry"]
    elif typ == "BUY_STOP":
        mask = hs >= geom["entry"]
    else:
        mask = ls <= geom["entry"]
    rel_fill = _first_true(mask)
    if rel_fill is None:
        return {
            "complete": True, "filled": 0, "tp1": 0, "tp2": 0, "sl": 0, "clean_win": 0,
            "mfe_r": 0.0, "mae_r": 0.0, "fill_delay_min": float(FILL_HORIZON_MIN + 1),
            "time_to_tp1_min": np.nan, "time_to_sl_min": np.nan, "first_terminal": "EXPIRED",
        }

    fill_i = start + rel_fill
    fill_ts = int(ts_arr[fill_i])
    outcome_end_ts = fill_ts + OUTCOME_HORIZON_MIN * M1_MS
    outcome_end = int(np.searchsorted(ts_arr, outcome_end_ts, side="right"))
    oh = high_arr[fill_i:outcome_end]
    ol = low_arr[fill_i:outcome_end]
    risk = max(1e-12, float(geom["risk"]))
    side = geom["side_num"]

    if side > 0:
        sl_mask = ol <= geom["sl"]
        tp1_mask = oh >= geom["tp1"]
        tp2_mask = oh >= geom["tp2"]
        favorable = (oh - geom["entry"]) / risk
        adverse = (geom["entry"] - ol) / risk
    else:
        sl_mask = oh >= geom["sl"]
        tp1_mask = ol <= geom["tp1"]
        tp2_mask = ol <= geom["tp2"]
        favorable = (geom["entry"] - ol) / risk
        adverse = (oh - geom["entry"]) / risk

    sl_rel = _first_true(sl_mask)
    tp1_rel = _first_true(tp1_mask)
    # SL wins a same-minute tie because intrabar tick ordering is unknown.
    sl_first = sl_rel is not None and (tp1_rel is None or sl_rel <= tp1_rel)

    tp1_hit = tp2_hit = sl_hit = 0
    first_terminal = "OPEN"
    time_tp1 = np.nan
    time_sl = np.nan
    cutoff = len(oh) - 1

    if sl_first:
        sl_hit = 1
        first_terminal = "SL"
        cutoff = sl_rel
        time_sl = (int(ts_arr[fill_i + sl_rel]) - fill_ts) / M1_MS
    elif tp1_rel is not None:
        tp1_hit = 1
        first_terminal = "TP1"
        time_tp1 = (int(ts_arr[fill_i + tp1_rel]) - fill_ts) / M1_MS
        tp2_after = np.flatnonzero(tp2_mask[tp1_rel:])
        if len(tp2_after):
            tp2_rel = tp1_rel + int(tp2_after[0])
            # If SL and TP2 first occur in the same M1 after TP1, retain the conservative tie rule.
            later_sl = np.flatnonzero(sl_mask[tp1_rel:tp2_rel + 1])
            tie_sl_at_tp2 = len(later_sl) and (tp1_rel + int(later_sl[0]) == tp2_rel)
            if not tie_sl_at_tp2:
                tp2_hit = 1
                first_terminal = "TP2"
                cutoff = tp2_rel

    cutoff = max(0, min(int(cutoff), len(oh) - 1))
    mfe = max(0.0, float(np.nanmax(favorable[:cutoff + 1]))) if len(favorable) else 0.0
    mae = max(0.0, float(np.nanmax(adverse[:cutoff + 1]))) if len(adverse) else 0.0
    clean = int(tp1_hit == 1 and first_terminal in {"TP1", "TP2"})
    return {
        "complete": True, "filled": 1, "tp1": int(tp1_hit), "tp2": int(tp2_hit), "sl": int(sl_hit),
        "clean_win": clean, "mfe_r": float(min(mfe, 8.0)), "mae_r": float(min(mae, 5.0)),
        "fill_delay_min": float((fill_ts - decision_ts) / M1_MS),
        "time_to_tp1_min": float(time_tp1) if np.isfinite(time_tp1) else np.nan,
        "time_to_sl_min": float(time_sl) if np.isfinite(time_sl) else np.nan,
        "first_terminal": first_terminal,
    }

def build_dataset(anchor: pd.DataFrame, m1: pd.DataFrame) -> Tuple[pd.DataFrame, List[str], List[dict]]:
    exclude = {
        "ts", "m15_bar_ts", "open", "high", "low", "close", "atr", "ema21",
        "swing_high20", "swing_low20", "swing_high50", "swing_low50",
    }
    market_cols = [c for c in anchor.columns if c not in exclude and pd.api.types.is_numeric_dtype(anchor[c])]
    rows: List[dict] = []
    current: List[dict] = []
    cache = m1_cache(m1)

    for _, r in anchor.iterrows():
        decision_ts = int(r["ts"])
        regime = regime_name(r)
        session = session_name(decision_ts)
        market_values = {c: safe_num(r.get(c), np.nan) for c in market_cols}
        for typ in ORDER_TYPES:
            for variant in VARIANTS:
                geom = candidate_geometry(r, typ, variant)
                if not geom:
                    continue
                feats = {**market_values, **order_feature_values(r, geom, regime, session)}
                outcome = simulate_outcome_m1(cache, decision_ts, geom)
                if outcome.get("complete"):
                    reward = (
                        geom["rr2"] if outcome.get("tp2") else
                        geom["rr"] if outcome.get("tp1") else
                        -1.0 if outcome.get("sl") else 0.0
                    ) - geom["estimatedCostR"]
                    rows.append({
                        "ts": decision_ts,
                        "order_type": typ,
                        "variant": variant,
                        "regime": regime,
                        "session": session,
                        "rr1": geom["rr"],
                        "rr2": geom["rr2"],
                        "cost_r": geom["estimatedCostR"],
                        "reward_r": float(reward),
                        **feats,
                        **outcome,
                    })

    if not anchor.empty:
        r = anchor.iloc[-1]
        decision_ts = int(r["ts"])
        regime = regime_name(r)
        session = session_name(decision_ts)
        for typ in ORDER_TYPES:
            for variant in VARIANTS:
                geom = candidate_geometry(r, typ, variant)
                if not geom:
                    continue
                feats = {c: safe_num(r.get(c), np.nan) for c in market_cols}
                feats.update(order_feature_values(r, geom, regime, session))
                current.append({
                    "ts": decision_ts,
                    "geometry": geom,
                    "features": feats,
                    "regime": regime,
                    "session": session,
                })

    ds = pd.DataFrame(rows)
    if current:
        feature_cols = list(current[0]["features"].keys())
    else:
        feature_cols = market_cols
    return ds, list(dict.fromkeys(feature_cols)), current


def prune_features(ds: pd.DataFrame, cols: List[str]) -> Tuple[List[str], dict]:
    kept, dropped = [], {}
    for c in cols:
        if c not in ds.columns:
            dropped[c] = "missing_column"
            continue
        s = pd.to_numeric(ds[c], errors="coerce")
        miss = float(s.isna().mean())
        finite = s[np.isfinite(s)]
        if miss > 0.45:
            dropped[c] = f"missing_{miss:.2f}"
        elif len(finite) < 50:
            dropped[c] = "too_few_values"
        elif float(np.nanstd(finite)) < 1e-12:
            dropped[c] = "near_constant"
        else:
            kept.append(c)
    return kept, {"kept": len(kept), "dropped": len(dropped), "examples": list(dropped.items())[:20]}


class IdentityCalibrator:
    name = "IDENTITY"
    def fit(self, raw: np.ndarray, y: np.ndarray):
        return self
    def transform(self, raw: np.ndarray) -> np.ndarray:
        return np.clip(np.asarray(raw, dtype=float), 0.005, 0.995)


class PlattCalibrator:
    name = "PLATT"
    def __init__(self):
        self.model = LogisticRegression(C=1.0, solver="lbfgs", max_iter=500, random_state=SEED)
        self.ok = False
    def fit(self, raw: np.ndarray, y: np.ndarray):
        if len(np.unique(y)) < 2:
            return self
        x = np.asarray(raw, dtype=float).reshape(-1, 1)
        self.model.fit(x, y)
        self.ok = True
        return self
    def transform(self, raw: np.ndarray) -> np.ndarray:
        r = np.asarray(raw, dtype=float)
        if not self.ok:
            return np.clip(r, 0.005, 0.995)
        return np.clip(self.model.predict_proba(r.reshape(-1, 1))[:, 1], 0.005, 0.995)


class IsotonicCalibrator:
    name = "ISOTONIC"
    def __init__(self):
        self.model = IsotonicRegression(out_of_bounds="clip")
        self.ok = False
    def fit(self, raw: np.ndarray, y: np.ndarray):
        if len(np.unique(y)) < 2 or len(y) < 80:
            return self
        self.model.fit(np.asarray(raw, dtype=float), np.asarray(y, dtype=float))
        self.ok = True
        return self
    def transform(self, raw: np.ndarray) -> np.ndarray:
        r = np.asarray(raw, dtype=float)
        if not self.ok:
            return np.clip(r, 0.005, 0.995)
        return np.clip(self.model.predict(r), 0.005, 0.995)


def recency_weights(ts: np.ndarray, half_life_days: float = 45.0) -> np.ndarray:
    t = np.asarray(ts, dtype=float)
    age_days = (np.nanmax(t) - t) / 86_400_000.0
    return np.clip(0.25 + 0.75 * np.power(0.5, age_days / half_life_days), 0.25, 1.0)


def classification_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    y = np.asarray(y, dtype=int)
    p = np.clip(np.asarray(p, dtype=float), 1e-5, 1 - 1e-5)
    out = {
        "samples": int(len(y)),
        "baseRate": round(float(np.mean(y)), 5) if len(y) else None,
        "brier": round(float(brier_score_loss(y, p)), 5) if len(y) else None,
    }
    try:
        out["auc"] = round(float(roc_auc_score(y, p)), 5) if len(np.unique(y)) == 2 else None
    except Exception:
        out["auc"] = None
    bins = np.linspace(0, 1, 11)
    ece = 0.0
    for i in range(10):
        mask = (p >= bins[i]) & (p < bins[i + 1] if i < 9 else p <= bins[i + 1])
        if mask.any():
            ece += mask.mean() * abs(float(p[mask].mean()) - float(y[mask].mean()))
    out["ece"] = round(float(ece), 5)
    return out


def make_hgb_classifier() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        learning_rate=0.065, max_iter=125, max_leaf_nodes=17, min_samples_leaf=30,
        l2_regularization=1.3, early_stopping=True, validation_fraction=0.12,
        n_iter_no_change=14, random_state=SEED,
    )


def make_extra_classifier() -> ExtraTreesClassifier:
    return ExtraTreesClassifier(
        n_estimators=150, max_depth=11, min_samples_leaf=6, max_features=0.70,
        class_weight="balanced", n_jobs=-1, random_state=SEED,
    )


def make_xgb_classifier():
    if not HAS_XGBOOST:
        return None
    return XGBClassifier(
        n_estimators=165, max_depth=4, learning_rate=0.06, min_child_weight=5,
        subsample=0.82, colsample_bytree=0.78, reg_alpha=0.08, reg_lambda=1.8,
        objective="binary:logistic", eval_metric="logloss", tree_method="hist",
        n_jobs=-1, random_state=SEED,
    )


def classifier_factories() -> Dict[str, object]:
    # Three deliberately diverse tree families are enough for the tournament.
    # RandomForest was removed in V37 release to cut CI runtime without reducing model-family diversity materially.
    out = {"HGB": make_hgb_classifier, "ExtraTrees": make_extra_classifier}
    if HAS_XGBOOST:
        out["XGBoost"] = make_xgb_classifier
    return out


def walk_forward_slices(times: np.ndarray, n_folds: int = N_FOLDS) -> List[Tuple[np.ndarray, np.ndarray]]:
    times = np.asarray(times, dtype=float)
    uniq = np.array(sorted(set(int(x) for x in times)), dtype=np.int64)
    if len(uniq) < 220:
        return []
    initial = max(120, int(len(uniq) * 0.48))
    remaining = len(uniq) - initial
    chunk = max(24, remaining // n_folds)
    folds = []
    for k in range(n_folds):
        start_i = initial + k * chunk
        end_i = len(uniq) if k == n_folds - 1 else min(len(uniq), start_i + chunk)
        if end_i - start_i < 15:
            continue
        test_start_ts = int(uniq[start_i])
        train_cut_ts = test_start_ts - PURGE_MS
        test_end_ts = int(uniq[end_i - 1])
        tr = np.where(times < train_cut_ts)[0]
        te = np.where((times >= test_start_ts) & (times <= test_end_ts))[0]
        if len(tr) >= 240 and len(te) >= 80:
            folds.append((tr.astype(int), te.astype(int)))
    return folds


def oof_for_factory(factory, X: np.ndarray, y: np.ndarray, times: np.ndarray) -> Tuple[np.ndarray, np.ndarray, int]:
    pred = np.full(len(y), np.nan, dtype=float)
    used = np.zeros(len(y), dtype=bool)
    folds = walk_forward_slices(times)
    for tr, te in folds:
        if len(np.unique(y[tr])) < 2:
            continue
        model = factory()
        if model is None:
            continue
        model.fit(X[tr], y[tr], sample_weight=recency_weights(times[tr]))
        pred[te] = model.predict_proba(X[te])[:, 1]
        used[te] = True
    return pred, used, len(folds)


def quality_from_metrics(m: dict) -> float:
    auc = safe_num(m.get("auc"), 0.5)
    brier = safe_num(m.get("brier"), 0.35)
    ece = safe_num(m.get("ece"), 0.20)
    auc_term = np.clip((auc - 0.50) / 0.25, 0, 1)
    brier_term = np.clip((0.25 - brier) / 0.16, 0, 1)
    ece_term = np.clip((0.14 - ece) / 0.12, 0, 1)
    return float(0.48 * auc_term + 0.34 * brier_term + 0.18 * ece_term)


def normalize_weights(scores: Dict[str, float]) -> Dict[str, float]:
    if not scores:
        return {}
    best = max(scores.values())
    kept = {k: v for k, v in sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:3] if v >= best - 0.15}
    if not kept:
        kept = {max(scores, key=scores.get): best}
    vals = {k: math.exp((v - best) * 4.7) for k, v in kept.items()}
    total = sum(vals.values()) or 1.0
    return {k: v / total for k, v in vals.items()}


def calibration_score(metrics: dict) -> float:
    return safe_num(metrics.get("brier"), 1) + 0.60 * safe_num(metrics.get("ece"), 1)


def choose_calibrator(raw: np.ndarray, y: np.ndarray, times: np.ndarray):
    order = np.argsort(times)
    raw, y = np.asarray(raw)[order], np.asarray(y)[order]
    split = min(max(90, int(len(y) * 0.62)), max(1, len(y) - 60))
    tr_raw, tr_y = raw[:split], y[:split]
    ev_raw, ev_y = raw[split:], y[split:]
    candidates = [IdentityCalibrator(), PlattCalibrator(), IsotonicCalibrator()]
    results = []
    for cal in candidates:
        try:
            cal.fit(tr_raw, tr_y)
            m = classification_metrics(ev_y, cal.transform(ev_raw))
            penalty = 0.003 if cal.name == "ISOTONIC" and len(tr_y) < 1000 else 0.0
            results.append((calibration_score(m) + penalty, cal.name, m))
        except Exception:
            pass
    if not results:
        chosen = IdentityCalibrator()
        selection = {"selected": "IDENTITY", "evaluation": []}
    else:
        results.sort(key=lambda x: x[0])
        cls = {"IDENTITY": IdentityCalibrator, "PLATT": PlattCalibrator, "ISOTONIC": IsotonicCalibrator}
        chosen = cls[results[0][1]]()
        selection = {
            "selected": results[0][1],
            "evaluation": [{"name": n, "score": round(float(s), 5), "metrics": m} for s, n, m in results],
        }
    chosen.fit(raw, y)
    return chosen, selection


@dataclass
class ClassifierHead:
    name: str
    models: Dict[str, object]
    weights: Dict[str, float]
    calibrator: object
    metrics: dict
    model_metrics: dict
    selection: dict
    calibration: dict

    def predict_ensemble(self, X: np.ndarray) -> Tuple[np.ndarray, Dict[str, np.ndarray], np.ndarray]:
        preds = {name: model.predict_proba(X)[:, 1] for name, model in self.models.items()}
        raw = np.zeros(X.shape[0], dtype=float)
        for name, w in self.weights.items():
            raw += float(w) * preds[name]
        if not self.weights and preds:
            raw = np.mean(list(preds.values()), axis=0)
        calibrated = self.calibrator.transform(raw)
        stack = np.vstack([preds[n] for n in self.weights if n in preds]) if self.weights else np.vstack(list(preds.values()))
        disagreement = np.std(stack, axis=0) * 100 if len(stack) else np.full(X.shape[0], 100.0)
        return calibrated, preds, disagreement


def fit_head(name: str, X: np.ndarray, y: np.ndarray, times: np.ndarray) -> ClassifierHead:
    factories = classifier_factories()
    oofs, useds, model_metrics, quality = {}, {}, {}, {}
    folds = 0
    for model_name, factory in factories.items():
        try:
            pred, used, f = oof_for_factory(factory, X, y, times)
            folds = max(folds, f)
            if used.any():
                m = classification_metrics(y[used], pred[used])
                oofs[model_name], useds[model_name] = pred, used
                model_metrics[model_name] = m
                quality[model_name] = quality_from_metrics(m)
        except Exception as exc:
            model_metrics[model_name] = {"error": str(exc)[:180]}
    if not oofs:
        raise RuntimeError(f"NO_WALK_FORWARD_MODELS:{name}")
    weights = normalize_weights(quality)
    common = np.ones(len(y), dtype=bool)
    for model_name in weights:
        common &= useds[model_name]
    if common.sum() < 100:
        best = max(weights, key=weights.get)
        common = useds[best].copy()
        weights = {best: 1.0}
    raw_oof = np.zeros(common.sum(), dtype=float)
    for model_name, w in weights.items():
        raw_oof += float(w) * oofs[model_name][common]
    cal, cal_selection = choose_calibrator(raw_oof, y[common], times[common])
    metrics = classification_metrics(y[common], cal.transform(raw_oof))
    metrics["folds"] = folds

    models = {}
    w_all = recency_weights(times)
    for model_name in weights:
        model = factories[model_name]()
        model.fit(X, y, sample_weight=w_all)
        models[model_name] = model
    selection = {
        "selectedModels": list(weights.keys()),
        "weights": {k: round(float(v), 4) for k, v in weights.items()},
        "oofQuality": {k: round(float(quality[k]), 4) for k in weights},
        "availableModels": list(factories.keys()),
        "xgboostAvailable": HAS_XGBOOST,
    }
    return ClassifierHead(name, models, weights, cal, metrics, model_metrics, selection, cal_selection)


def fit_point_regressors(X: np.ndarray, y: np.ndarray, times: np.ndarray):
    h = HistGradientBoostingRegressor(
        learning_rate=0.065, max_iter=150, max_leaf_nodes=17, min_samples_leaf=28,
        l2_regularization=1.0, early_stopping=True, random_state=SEED,
    )
    e = ExtraTreesRegressor(
        n_estimators=190, max_depth=11, min_samples_leaf=6, max_features=0.72,
        n_jobs=-1, random_state=SEED,
    )
    w = recency_weights(times)
    h.fit(X, y, sample_weight=w)
    e.fit(X, y, sample_weight=w)
    return h, e


def fit_quantile_bundle(X: np.ndarray, y: np.ndarray, times: np.ndarray) -> Dict[str, object]:
    out = {}
    w = recency_weights(times)
    for q, name in [(0.10, "q10"), (0.90, "q90")]:
        m = HistGradientBoostingRegressor(
            loss="quantile", quantile=q, learning_rate=0.065, max_iter=130,
            max_leaf_nodes=15, min_samples_leaf=30, l2_regularization=1.0,
            early_stopping=True, random_state=SEED,
        )
        m.fit(X, y, sample_weight=w)
        out[name] = m
    return out


def quantile_predict(bundle: Dict[str, object], X: np.ndarray, point: Optional[float] = None) -> dict:
    vals = {k: max(0.0, float(m.predict(X)[0])) for k, m in bundle.items()}
    q10 = vals.get("q10", 0.0)
    q90 = vals.get("q90", max(q10, 0.0))
    q50 = max(0.0, float(point)) if point is not None else (q10 + q90) / 2.0
    ordered = sorted([q10, q50, q90])
    return {"q10": ordered[0], "q50": ordered[1], "q90": ordered[2]}


def feature_importance(head: ClassifierHead, names: List[str], n: int = 18) -> List[dict]:
    vals = np.zeros(len(names), dtype=float)
    used = 0.0
    for model_name, weight in head.weights.items():
        model = head.models.get(model_name)
        imp = getattr(model, "feature_importances_", None)
        if imp is None:
            continue
        arr = np.asarray(imp, dtype=float)
        if len(arr) != len(names):
            continue
        vals += float(weight) * arr
        used += float(weight)
    if used <= 0:
        return []
    vals /= used
    idx = np.argsort(vals)[::-1][:n]
    return [{"feature": names[i], "importance": round(float(vals[i]), 6)} for i in idx]


def robust_current_drift(X_train: np.ndarray, current: np.ndarray) -> float:
    med = np.nanmedian(X_train, axis=0)
    q25 = np.nanpercentile(X_train, 25, axis=0)
    q75 = np.nanpercentile(X_train, 75, axis=0)
    scale = np.maximum(q75 - q25, 1e-6)
    z = np.abs((current - med) / scale)
    z = z[np.isfinite(z)]
    if not len(z):
        return 100.0
    return float(np.clip(np.nanmedian(np.clip(z, 0, 8)) * 17.0, 0, 100))


def psi_value(base: np.ndarray, recent: np.ndarray) -> float:
    base = base[np.isfinite(base)]
    recent = recent[np.isfinite(recent)]
    if len(base) < 100 or len(recent) < 40:
        return 0.0
    edges = np.unique(np.nanquantile(base, np.linspace(0, 1, 11)))
    if len(edges) < 4:
        return 0.0
    edges[0], edges[-1] = -np.inf, np.inf
    b, _ = np.histogram(base, bins=edges)
    r, _ = np.histogram(recent, bins=edges)
    bp = np.clip(b / max(1, b.sum()), 1e-4, 1)
    rp = np.clip(r / max(1, r.sum()), 1e-4, 1)
    return float(np.sum((rp - bp) * np.log(rp / bp)))


def population_drift(X: np.ndarray, times: np.ndarray) -> dict:
    order = np.argsort(times)
    Xs = X[order]
    n = len(Xs)
    if n < 500:
        return {"psiMedian": 0.0, "psiP90": 0.0, "score": 0.0}
    base = Xs[: max(300, int(n * 0.65))]
    recent = Xs[max(0, int(n * 0.85)):]
    # Use highest-variance columns only to avoid noisy PSI aggregation.
    var = np.nanvar(base, axis=0)
    idx = np.argsort(var)[::-1][: min(32, X.shape[1])]
    psis = [psi_value(base[:, i], recent[:, i]) for i in idx]
    psis = [x for x in psis if math.isfinite(x)] or [0.0]
    med, p90 = float(np.median(psis)), float(np.percentile(psis, 90))
    score = float(np.clip((0.55 * med + 0.45 * p90) / 0.30 * 100, 0, 100))
    return {"psiMedian": round(med, 4), "psiP90": round(p90, 4), "score": round(score, 1)}


def health_score(metrics: dict, filled_samples: int, ood_pts: float, disagreement_pts: float) -> float:
    b = safe_num(metrics.get("brier"), 0.35)
    ece = safe_num(metrics.get("ece"), 0.25)
    auc = safe_num(metrics.get("auc"), 0.50)
    sample_bonus = min(18.0, math.log10(max(10, filled_samples)) * 8.0 - 6.0)
    score = 53.0 + sample_bonus + max(0, auc - 0.5) * 66.0
    score -= max(0, b - 0.16) * 105.0
    score -= ece * 72.0
    score -= max(0, ood_pts - 18) * 0.48
    score -= max(0, disagreement_pts - 10) * 0.42
    return float(np.clip(score, 0, 100))


def governance(candidate_score: float, metrics: dict, source_fp: str, provenance: dict) -> dict:
    old = load_json(GOV_PATH)
    if old.get("artifactSchemaVersion") != ARTIFACT_SCHEMA_VERSION:
        old = {}
    best = safe_num(old.get("bestScore"), -1)
    best_brier = safe_num(old.get("bestBrier"), 9)
    cur_brier = safe_num(metrics.get("brier"), 9)
    streak = int(safe_num(old.get("promotionStreak"), 0))
    same_evidence = bool(
        old.get("sourceFingerprint") == source_fp
        and int(safe_num(old.get("dataWatermark"), 0)) == int(safe_num(provenance.get("dataWatermark"), 0))
    )
    if same_evidence:
        action = "KEEP_IDENTICAL_EVIDENCE"
        trusted = bool(old.get("trusted"))
    elif best < 0:
        action = "BOOTSTRAP"
        trusted = candidate_score >= 50 and cur_brier <= 0.28
        streak = 1 if trusted else 0
        if trusted:
            best, best_brier = candidate_score, cur_brier
    elif candidate_score < best - 8.0 or cur_brier > best_brier + 0.040:
        action = "ROLLBACK_GUARD_QUARANTINE"
        trusted = False
        streak = 0
    elif candidate_score >= best + 1.0 and cur_brier <= best_brier + 0.018:
        streak += 1
        if streak >= 2:
            action = "PROMOTE"
            trusted = True
            best = candidate_score
            best_brier = min(best_brier, cur_brier)
            streak = 0
        else:
            action = "SHADOW_CONFIRM"
            trusted = candidate_score >= 55
    elif candidate_score >= best - 4.5 and cur_brier <= best_brier + 0.030:
        action = "KEEP_TRUSTED"
        trusted = candidate_score >= 53
        streak = 0
    else:
        action = "QUARANTINE"
        trusted = False
        streak = 0
    return {
        "version": VERSION,
        "updatedAt": utc_now(),
        "action": action,
        "trusted": bool(trusted),
        "candidateScore": round(candidate_score, 2),
        "bestScore": round(best, 2) if best >= 0 else None,
        "candidateBrier": None if cur_brier >= 8 else round(cur_brier, 5),
        "bestBrier": None if best_brier >= 8 else round(best_brier, 5),
        "promotionStreak": streak,
        "evidenceAdvanced": not same_evidence,
        "sourceFingerprint": source_fp,
        "artifactSchemaVersion": ARTIFACT_SCHEMA_VERSION,
        "featureSchemaHash": provenance.get("featureSchemaHash"),
        "labelSchemaHash": LABEL_SCHEMA_HASH,
        "dataWatermark": provenance.get("dataWatermark"),
        "note": "Governance can quarantine a weak challenger; models are retrained from source data rather than serialized broker execution models.",
    }


def context_stats(ds_filled: pd.DataFrame) -> dict:
    if ds_filled.empty:
        return {"global": {}, "groups": {}}
    global_tp1 = float(ds_filled["tp1"].mean())
    global_sl = float(ds_filled["sl"].mean())
    global_clean = float(ds_filled["clean_win"].mean())
    global_ev = float(ds_filled["reward_r"].mean())
    prior = 45.0
    groups = {}
    levels = [
        ["order_type", "variant", "regime", "session"],
        ["order_type", "variant", "regime"],
        ["order_type", "variant"],
        ["order_type"],
    ]
    for keys in levels:
        for vals, g in ds_filled.groupby(keys, dropna=False):
            vals = vals if isinstance(vals, tuple) else (vals,)
            n = len(g)
            if n < 12:
                continue
            name = "|".join([str(x) for x in vals])
            depth = len(keys)
            p_tp1 = (g["tp1"].sum() + prior * global_tp1) / (n + prior)
            p_sl = (g["sl"].sum() + prior * global_sl) / (n + prior)
            p_clean = (g["clean_win"].sum() + prior * global_clean) / (n + prior)
            ev = (g["reward_r"].sum() + prior * global_ev) / (n + prior)
            groups[f"{depth}:{name}"] = {
                "samples": int(n), "pTp1": float(p_tp1), "pSl": float(p_sl),
                "pClean": float(p_clean), "evR": float(ev),
            }
    return {
        "global": {"pTp1": global_tp1, "pSl": global_sl, "pClean": global_clean, "evR": global_ev, "samples": int(len(ds_filled))},
        "groups": groups,
    }


def lookup_context(experts: dict, item: dict) -> dict:
    typ = item["geometry"]["type"]
    variant = item["geometry"]["variant"]
    regime = item["regime"]
    session = item["session"]
    keys = [
        f"4:{typ}|{variant}|{regime}|{session}",
        f"3:{typ}|{variant}|{regime}",
        f"2:{typ}|{variant}",
        f"1:{typ}",
    ]
    for k in keys:
        if k in experts.get("groups", {}):
            return {"key": k, **experts["groups"][k]}
    return {"key": "GLOBAL", **experts.get("global", {})}


def load_news_guard(reference_ts: int) -> dict:
    news = load_json(NEWS_PATH)
    events = news.get("events") or []
    closest = None
    for e in events:
        try:
            ts = int(pd.Timestamp(e.get("date"), tz="UTC").timestamp() * 1000) if pd.Timestamp(e.get("date")).tzinfo is None else int(pd.Timestamp(e.get("date")).timestamp() * 1000)
        except Exception:
            try:
                ts = int(pd.Timestamp(e.get("date")).tz_localize("UTC").timestamp() * 1000)
            except Exception:
                continue
        delta = (ts - reference_ts) / M1_MS
        imp = int(safe_num(e.get("importance"), 2))
        row = {"event": e.get("event") or "US Event", "importance": imp, "minutes": round(delta, 1), "ts": ts}
        if closest is None or abs(delta) < abs(closest["minutes"]):
            closest = row
    if not closest:
        return {"state": "CLEAR", "lock": False, "caution": False, "closest": None}
    lock = closest["importance"] >= 3 and -15 <= closest["minutes"] <= 30
    caution = lock or (closest["importance"] >= 2 and -25 <= closest["minutes"] <= 45)
    return {"state": "LOCK" if lock else "CAUTION" if caution else "CLEAR", "lock": lock, "caution": caution, "closest": closest}


def journal_loss_streak() -> int:
    j = load_json(JOURNAL_PATH)
    rows = list(j.get("planEntries") or [])
    resolved = []
    for e in rows:
        h = (e.get("horizons") or {}).get("M30") or {}
        if h.get("resolved") and h.get("correct") is not None:
            resolved.append((safe_num(e.get("filledTs") or e.get("ts"), 0), bool(h.get("correct"))))
    resolved.sort(key=lambda x: x[0])
    streak = 0
    for _, win in reversed(resolved):
        if win:
            break
        streak += 1
    return streak


def block_bootstrap_robustness(ds_filled: pd.DataFrame, item: dict, n_boot: int = 240) -> dict:
    typ, variant, regime = item["geometry"]["type"], item["geometry"]["variant"], item["regime"]
    g = ds_filled[(ds_filled["order_type"] == typ) & (ds_filled["variant"] == variant) & (ds_filled["regime"] == regime)]
    if len(g) < 35:
        g = ds_filled[(ds_filled["order_type"] == typ) & (ds_filled["variant"] == variant)]
    if len(g) < 25:
        return {"samples": int(len(g)), "ready": False}
    rewards = g.sort_values("ts")["reward_r"].to_numpy(dtype=float)
    wins = g.sort_values("ts")["clean_win"].to_numpy(dtype=float)
    L = min(60, len(rewards))
    block = min(6, max(2, len(rewards) // 15))
    evs, wrs = [], []
    rng = np.random.default_rng(SEED + sum(map(ord, typ + variant + regime)))
    for _ in range(n_boot):
        idxs = []
        while len(idxs) < L:
            st = int(rng.integers(0, max(1, len(rewards) - block + 1)))
            idxs.extend(range(st, min(len(rewards), st + block)))
        idx = np.array(idxs[:L], dtype=int)
        evs.append(float(np.mean(rewards[idx])))
        wrs.append(float(np.mean(wins[idx])))
    return {
        "samples": int(len(g)), "ready": True, "method": "BLOCK_BOOTSTRAP_OUTCOME_STRESS",
        "evR": {"p10": round(float(np.percentile(evs, 10)), 3), "p50": round(float(np.percentile(evs, 50)), 3), "p90": round(float(np.percentile(evs, 90)), 3)},
        "cleanWin": {"p10": round(float(np.percentile(wrs, 10)) * 100, 1), "p50": round(float(np.percentile(wrs, 50)) * 100, 1), "p90": round(float(np.percentile(wrs, 90)) * 100, 1)},
    }


def price_path_stress(m1: pd.DataFrame, geom: dict, n_paths: int = 90, horizon: int = 90) -> dict:
    if len(m1) < 600:
        return {"ready": False, "samples": len(m1)}
    x = m1.tail(min(3500, len(m1))).copy()
    prev = x["close"].shift(1)
    ret = (x["close"] / prev - 1).replace([np.inf, -np.inf], np.nan)
    up = ((x["high"] / prev) - 1).replace([np.inf, -np.inf], np.nan)
    dn = ((x["low"] / prev) - 1).replace([np.inf, -np.inf], np.nan)
    mat = np.column_stack([ret, up, dn])
    mat = mat[np.all(np.isfinite(mat), axis=1)]
    if len(mat) < 500:
        return {"ready": False, "samples": len(mat)}
    start_price = float(x.iloc[-1]["close"])
    rng = np.random.default_rng(SEED + sum(map(ord, geom["id"])))
    fill = tp1 = sl = 0
    rewards = []
    block = 6
    for _ in range(n_paths):
        price = start_price
        filled = False
        terminal = None
        for _step in range(horizon):
            j = int(rng.integers(0, max(1, len(mat) - block)))
            rr, uu, dd = mat[j + int(rng.integers(0, block))]
            high = price * (1 + max(uu, rr, 0))
            low = price * (1 + min(dd, rr, 0))
            close = max(1e-9, price * (1 + rr))
            b = {"high": high, "low": low}
            if not filled and is_filled_bar(b, geom):
                filled = True
                fill += 1
            if filled:
                if geom["side_num"] > 0:
                    hsl, htp1, htp2 = low <= geom["sl"], high >= geom["tp1"], high >= geom["tp2"]
                else:
                    hsl, htp1, htp2 = high >= geom["sl"], low <= geom["tp1"], low <= geom["tp2"]
                if hsl:
                    terminal = "SL"
                    sl += 1
                    rewards.append(-1.0 - geom["estimatedCostR"])
                    break
                if htp2:
                    terminal = "TP2"
                    tp1 += 1
                    rewards.append(geom["rr2"] - geom["estimatedCostR"])
                    break
                if htp1:
                    terminal = "TP1"
                    tp1 += 1
                    rewards.append(geom["rr"] - geom["estimatedCostR"])
                    break
            price = close
        if filled and terminal is None:
            rewards.append(-geom["estimatedCostR"])
    denom = max(1, n_paths)
    return {
        "ready": True, "method": "M1_BLOCK_PRICE_PATH_STRESS", "stressOnly": True, "paths": n_paths,
        "pFill": round(100 * fill / denom, 1), "pTp1": round(100 * tp1 / denom, 1), "pSl": round(100 * sl / denom, 1),
        "evR": round(float(np.mean(rewards)) if rewards else 0.0, 3), "weightInScore": 0.05,
    }


def explain_candidate(item: dict, c: dict) -> List[str]:
    f = item["features"]
    out = [f"REGIME {item['regime']}", f"SESSION {item['session']}", f"GEOMETRY {item['geometry']['variant']}"]
    h1 = safe_num(f.get("h1_ema21_50_atr"), 0)
    m15s = safe_num(f.get("m15_slope21_atr"), 0)
    m1wick = safe_num(f.get("micro_rejection_buy" if item["geometry"]["side"] == "BUY" else "micro_rejection_sell"), 0)
    if item["geometry"]["side"] == "BUY" and h1 > 0.10:
        out.append("H1 STRUCTURE SUPPORTS BUY")
    if item["geometry"]["side"] == "SELL" and h1 < -0.10:
        out.append("H1 STRUCTURE SUPPORTS SELL")
    if abs(m15s) > 0.05:
        out.append("M15 MOMENTUM PRESENT")
    if m1wick > 0.12:
        out.append("M1 REJECTION CONFIRMS SIDE")
    if c.get("contextExpert", {}).get("samples", 0) >= 30:
        out.append("CONTEXT EXPERT HAS HISTORY")
    if c.get("ood", {}).get("score", 0) > 35:
        out.append("OOD CAUTION")
    return out[:7]


def source_fingerprint(pack: dict, tfs: Dict[str, pd.DataFrame], label: str) -> str:
    watermark = int(safe_num(pack.get("closedBarWatermark") or (pack.get("feed") or {}).get("closedBarWatermark"), 0))
    digest = hashlib.sha256(f"{label}|{watermark}|".encode("utf-8"))
    for timeframe in ["M1", "M5", "M15", "H1"]:
        digest.update(f"{timeframe}|".encode("utf-8"))
        frame = tfs.get(timeframe)
        if frame is None:
            continue
        for row in frame[["ts", "open", "high", "low", "close"]].itertuples(index=False, name=None):
            digest.update((",".join(format(safe_num(value), ".12g") for value in row) + ";").encode("ascii"))
    return digest.hexdigest()[:24]


def main() -> None:
    live_pack, train_pack, train_source = load_packs()
    train_tfs = pack_frames(train_pack)
    live_tfs = pack_frames(live_pack)
    train_counts = {k: len(v) for k, v in train_tfs.items()}
    live_counts = {k: len(v) for k, v in live_tfs.items()}

    if train_counts["M15"] < MIN_M15 or train_counts["M1"] < MIN_M1:
        wait_data("PRIMARY_HISTORY_TOO_SHORT", {**train_counts, "source": train_source})
    if train_counts["M5"] < 180 or train_counts["H1"] < 80:
        wait_data("PRIMARY_M5_H1_HISTORY_TOO_SHORT", train_counts)
    if live_counts["M15"] < 80 or live_counts["M1"] < 300:
        wait_data("LIVE_ACTIVE_FEED_HISTORY_TOO_SHORT", live_counts)

    # Throttle retraining: score new live state hourly unless manually forced.
    existing = load_json(OUT_PATH)
    latest_live_m15 = int(live_tfs["M15"].iloc[-1]["ts"]) if len(live_tfs["M15"]) else 0
    old_market_ts = int(safe_num((existing.get("current") or {}).get("marketTs"), 0))
    if os.environ.get("ML_FORCE") != "1" and existing.get("version") == VERSION and existing.get("ready") and latest_live_m15 and old_market_ts and latest_live_m15 - old_market_ts < 60 * 60 * 1000:
        print("ML SKIP: V42 fewer than 4 new M15 bars")
        raise SystemExit(0)

    train_anchor, _ = merged_anchor_features(train_tfs)
    live_anchor, _ = merged_anchor_features(live_tfs)
    required = ["atr", "ema21", "swing_high20", "swing_low20"]
    train_anchor = train_anchor.dropna(subset=required).reset_index(drop=True)
    live_anchor = live_anchor.dropna(subset=required).reset_index(drop=True)
    if len(train_anchor) < 350:
        wait_data("PRIMARY_FEATURE_HISTORY_TOO_SHORT", train_counts)
    if live_anchor.empty:
        wait_data("LIVE_FEATURES_NOT_READY", live_counts)

    ds, feature_cols, _ = build_dataset(train_anchor, train_tfs["M1"])
    _, live_feature_cols, current = build_dataset(live_anchor.tail(1), live_tfs["M1"])
    if len(current) != len(ORDER_TYPES) * len(VARIANTS):
        wait_data("CURRENT_CANDIDATE_SCHEMA_INCOMPLETE", {
            "expected": len(ORDER_TYPES) * len(VARIANTS), "actual": len(current), **live_counts,
        })
    if ds.empty or len(ds) < 1600:
        wait_data("NOT_ENOUGH_M1_FIRST_HIT_PENDING_LABELS", {**train_counts, "labeled": len(ds)})
    feature_cols = [c for c in feature_cols if c in live_feature_cols]
    feature_cols, prune_report = prune_features(ds, feature_cols)
    if len(feature_cols) < 20:
        wait_data("TOO_FEW_STABLE_FEATURES", {"features": len(feature_cols), **prune_report})

    Xdf = ds[feature_cols].replace([np.inf, -np.inf], np.nan)
    imputer = SimpleImputer(strategy="median")
    X = imputer.fit_transform(Xdf)
    times = ds["ts"].to_numpy(dtype=float)
    y_fill = ds["filled"].to_numpy(dtype=int)
    filled_mask = y_fill == 1
    if filled_mask.sum() < 360:
        wait_data("NOT_ENOUGH_FILLED_M1_PENDING_PLANS", {"labeled": len(ds), "filled": int(filled_mask.sum())})

    fill_head = fit_head("fill", X, y_fill, times)
    Xf, tf = X[filled_mask], times[filled_mask]
    filled_ds = ds.loc[filled_mask].reset_index(drop=True)
    y_tp1 = filled_ds["tp1"].to_numpy(dtype=int)
    y_tp2 = filled_ds["tp2"].to_numpy(dtype=int)
    y_sl = filled_ds["sl"].to_numpy(dtype=int)
    y_clean = filled_ds["clean_win"].to_numpy(dtype=int)
    if len(np.unique(y_tp1)) < 2 or len(np.unique(y_sl)) < 2 or len(np.unique(y_clean)) < 2:
        wait_data("M1_OUTCOME_CLASSES_NOT_DIVERSE", {"filled": int(filled_mask.sum())})

    tp1_head = fit_head("tp1", Xf, y_tp1, tf)
    sl_head = fit_head("sl", Xf, y_sl, tf)
    # Clean-win is a meta decision score derived from calibrated TP1 + excursion risk.
    # A duplicate classifier target adds little because first-hit TP1 already captures terminal success.
    tp2_head = fit_head("tp2", Xf, y_tp2, tf) if len(np.unique(y_tp2)) == 2 and y_tp2.sum() >= 45 else None

    mfe_h, mfe_e = fit_point_regressors(Xf, filled_ds["mfe_r"].to_numpy(dtype=float), tf)
    mae_h, mae_e = fit_point_regressors(Xf, filled_ds["mae_r"].to_numpy(dtype=float), tf)
    mfe_q = fit_quantile_bundle(Xf, filled_ds["mfe_r"].to_numpy(dtype=float), tf)
    mae_q = fit_quantile_bundle(Xf, filled_ds["mae_r"].to_numpy(dtype=float), tf)

    fp = source_fingerprint(train_pack, train_tfs, train_source)
    _, _, primary_watermark = validate_primary_pack_metadata(train_pack)
    schema_hash = feature_schema_hash(feature_cols)
    provenance = {
        "schemaVersion": ARTIFACT_SCHEMA_VERSION,
        "trainingSource": train_source,
        "trainingFeed": "TWELVE_DATA_PRIMARY",
        "mergeFeeds": False,
        "featureSchemaHash": schema_hash,
        "labelSchema": LABEL_SCHEMA,
        "labelSchemaHash": LABEL_SCHEMA_HASH,
        "sourceFingerprint": fp,
        "dataWatermark": primary_watermark,
        "candidateSchemaCount": len(current),
    }
    pop_drift = population_drift(X, times)
    experts = context_stats(filled_ds)
    news_guard = load_news_guard(int(live_anchor.iloc[-1]["ts"]))
    loss_streak = journal_loss_streak()

    scored = []
    disagreements = []
    current_matrix_rows = []
    for item in current:
        row = pd.DataFrame([{c: item["features"].get(c, np.nan) for c in feature_cols}])
        xc = imputer.transform(row)
        current_matrix_rows.append(xc[0])
        pfill, _, d_fill = fill_head.predict_ensemble(xc)
        ptp1, _, d_tp1 = tp1_head.predict_ensemble(xc)
        psl, _, d_sl = sl_head.predict_ensemble(xc)
        if tp2_head:
            ptp2, _, d_tp2 = tp2_head.predict_ensemble(xc)
            p_tp2, dis_tp2 = float(ptp2[0]), float(d_tp2[0])
        else:
            p_tp2, dis_tp2 = max(0.01, float(ptp1[0]) * 0.55), 12.0

        mfe = max(0.0, float(0.55 * mfe_h.predict(xc)[0] + 0.45 * mfe_e.predict(xc)[0]))
        mae = max(0.0, float(0.55 * mae_h.predict(xc)[0] + 0.45 * mae_e.predict(xc)[0]))
        mfe_int = quantile_predict(mfe_q, xc, mfe)
        mae_int = quantile_predict(mae_q, xc, mae)
        disagreement = float(np.mean([float(d_fill[0]), float(d_tp1[0]), float(d_sl[0]), dis_tp2]))
        disagreements.append(disagreement)

        geom = item["geometry"].copy()
        ctx = lookup_context(experts, item)
        p_tp1 = float(ptp1[0])
        p_sl = float(psl[0])
        # Meta clean-win score: calibrated TP1 probability discounted by predicted adverse excursion
        # and modestly rewarded for favorable excursion. This keeps pClean <= pTP1.
        excursion_clean = float(np.clip(0.92 - 0.34 * min(mae, 1.5) + 0.08 * min(mfe, 2.5), 0.35, 0.98))
        p_clean = float(np.clip(p_tp1 * excursion_clean, 0.005, p_tp1))
        # Context layer is deliberately shrinkage-limited; base calibrated ML remains dominant.
        if ctx.get("samples", 0) >= 20:
            strength = min(0.22, ctx["samples"] / 600.0)
            p_tp1 = (1 - strength) * p_tp1 + strength * safe_num(ctx.get("pTp1"), p_tp1)
            p_sl = (1 - strength) * p_sl + strength * safe_num(ctx.get("pSl"), p_sl)
            p_clean = (1 - strength) * p_clean + strength * safe_num(ctx.get("pClean"), p_clean)

        ev_fill = p_tp1 * geom["rr"] + p_tp2 * max(0.0, geom["rr2"] - geom["rr"]) - p_sl - geom["estimatedCostR"]
        total_ev = float(pfill[0]) * ev_fill
        edge = p_tp1 - p_sl
        excursion_edge = np.clip((mfe - mae) / max(1.8, geom["rr2"]), -0.25, 1.0)

        stress_hist = block_bootstrap_robustness(filled_ds, item)
        stress_path = price_path_stress(live_tfs["M1"], geom)
        stress_bonus = 0.0
        if stress_hist.get("ready"):
            stress_bonus += np.clip(safe_num(stress_hist["evR"]["p10"], 0.0), -0.3, 0.4) * 5.0
        if stress_path.get("ready"):
            stress_bonus += np.clip(safe_num(stress_path.get("evR"), 0.0), -0.4, 0.5) * 3.0

        quality = (
            p_tp1 * 30 + p_clean * 19 + p_tp2 * 8 + float(pfill[0]) * 9 +
            max(0.0, 1.0 - p_sl) * 12 +
            np.clip((total_ev + 0.15) / 0.90, 0, 1) * 13 + excursion_edge * 7
        )
        quality += np.clip(edge, -0.25, 0.45) * 15 + stress_bonus
        quality -= max(0.0, disagreement - 7.0) * 0.40

        c = {
            **{k: geom[k] for k in ["id", "type", "variant", "side", "entry", "entryLow", "entryHigh", "sl", "tp1", "tp2", "rr", "rr2", "cancelLevel"]},
            "regime": item["regime"], "session": item["session"],
            "pFill": round(float(pfill[0]) * 100, 2),
            "pTp1": round(p_tp1 * 100, 2),
            "pTp2": round(p_tp2 * 100, 2),
            "pSl": round(p_sl * 100, 2),
            "pCleanWin": round(p_clean * 100, 2),
            "edgePts": round(edge * 100, 2),
            "expectedMfeR": round(mfe, 3), "expectedMaeR": round(mae, 3),
            "mfeIntervalR": {k: round(v, 3) for k, v in mfe_int.items()},
            "maeIntervalR": {k: round(v, 3) for k, v in mae_int.items()},
            "evR": round(total_ev, 3),
            "estimatedCostR": round(geom["estimatedCostR"], 4),
            "estimatedRoundTripCost": round(geom["estimatedRoundTripCost"], 5),
            "modelDisagreementPts": round(disagreement, 2),
            "contextExpert": {k: (round(v, 4) if isinstance(v, float) else v) for k, v in ctx.items()},
            "robustness": stress_hist,
            "pathStress": stress_path,
            "score": round(float(np.clip(quality, 0, 100)), 1),
        }
        scored.append((item, c))

    if not scored:
        wait_data("NO_LIVE_DYNAMIC_CANDIDATES", live_counts)

    current_matrix = np.asarray(current_matrix_rows, dtype=float)
    current_drift = min(robust_current_drift(X, row) for row in current_matrix)
    ood_score = float(np.clip(max(current_drift, safe_num(pop_drift.get("score"), 0) * 0.85), 0, 100))
    disagreement_pts = float(np.mean(disagreements)) if disagreements else 100.0
    primary_metrics = tp1_head.metrics
    health = health_score(primary_metrics, int(filled_mask.sum()), ood_score, disagreement_pts)
    gov = governance(health, primary_metrics, fp, provenance)
    if ood_score > 55 or safe_num(primary_metrics.get("ece"), 1) > 0.18 or safe_num(primary_metrics.get("brier"), 1) > 0.27:
        gov["trusted"] = False
        gov["action"] = "QUARANTINE_GUARD"
    status = "TRUSTED" if gov.get("trusted") and health >= 53 else "QUARANTINED"

    # Closed-loop journal remains small compared with walk-forward evidence.
    journal = load_json(JOURNAL_PATH)
    by_type = (journal.get("mlPlanSummary") or journal.get("planSummary") or {}).get("byType") or {}
    final_rows = []
    for item, c in scored:
        st = by_type.get(c["type"]) or by_type.get(c["type"].replace("_", " ")) or {}
        samples = int(safe_num(st.get("samples"), 0))
        adj = 0.0
        if samples >= 15:
            hit = safe_num(st.get("hitRate"), 50)
            good = safe_num(st.get("goodEntryRate"), 45)
            strength = min(1.0, samples / 100.0)
            adj = float(np.clip(((hit - 50) * 0.07 + (good - 45) * 0.04) * strength, -5.0, 5.0))
            c["score"] = round(float(np.clip(c["score"] + adj, 0, 100)), 1)
        c["journalSamples"] = samples
        c["journalAdjustment"] = round(adj, 2)
        c["ood"] = {"score": round(ood_score, 1), "currentRobust": round(current_drift, 1), **pop_drift}
        c["explanation"] = explain_candidate(item, c)
        final_rows.append(c)

    tp1_base = safe_num(tp1_head.metrics.get("baseRate"), 0.25) * 100
    sl_base = safe_num(sl_head.metrics.get("baseRate"), 0.25) * 100
    min_plan_score = float(np.clip(62 + max(0, disagreement_pts - 8) * 0.18 + max(0, ood_score - 18) * 0.11, 62, 76))
    min_tp1 = float(np.clip(tp1_base + 5, 24, 62))
    max_sl = float(np.clip(sl_base + 7, 20, 46))
    min_clean = 28.0
    min_ev = 0.16
    min_edge = 6.0
    max_disagreement = 17.0

    # V38 guarded self-play threshold optimizer. Only PRIMARY Twelve shadow outcomes
    # can promote these values, and selfplay-lab.py validates them on an unseen
    # chronological tail before activationReady becomes true.
    threshold_pack = load_json(THRESHOLD_PATH)
    threshold_schema_ok = bool(
        threshold_pack.get("artifactSchema") == ARTIFACT_SCHEMA_VERSION
        and threshold_pack.get("labelSchemaHash") == LABEL_SCHEMA_HASH
        and threshold_pack.get("source") == "PRIMARY_SHADOW_OUTCOMES_ONLY"
    )
    auto_threshold_active = bool(threshold_schema_ok and threshold_pack.get("activationReady") and threshold_pack.get("trusted"))
    if auto_threshold_active:
        rec = threshold_pack.get("recommended") or {}
        min_plan_score = float(np.clip(safe_num(rec.get("minPlanScore"), min_plan_score), 56, 78))
        min_tp1 = float(np.clip(safe_num(rec.get("minTp1Probability"), min_tp1), 22, 65))
        max_sl = float(np.clip(safe_num(rec.get("maxSlProbability"), max_sl), 22, 50))
        min_clean = float(np.clip(safe_num(rec.get("minCleanWinProbability"), min_clean), 18, 55))
        min_ev = float(np.clip(safe_num(rec.get("minExpectedValueR"), min_ev), -0.02, 0.40))
        min_edge = float(np.clip(safe_num(rec.get("minTp1SlEdgePts"), min_edge), 3, 14))
        max_disagreement = float(np.clip(safe_num(rec.get("maxDisagreementPts"), max_disagreement), 10, 22))

    mods = threshold_pack.get("contextModifiers") or {}
    def context_delta(section, key, field):
        try:
            return safe_num(((mods.get(section) or {}).get(str(key)) or {}).get(field), 0.0)
        except Exception:
            return 0.0

    market_open = bool((live_pack.get("feed") or {}).get("marketLikelyOpen", True))
    for c in final_rows:
        score_delta = (
            context_delta("orderType", c.get("type"), "minPlanScoreDelta") +
            context_delta("regime", c.get("regime"), "minPlanScoreDelta") +
            context_delta("session", c.get("session"), "minPlanScoreDelta")
        ) / 3.0
        tp_delta = (
            context_delta("orderType", c.get("type"), "minTp1ProbabilityDelta") +
            context_delta("regime", c.get("regime"), "minTp1ProbabilityDelta") +
            context_delta("session", c.get("session"), "minTp1ProbabilityDelta")
        ) / 3.0
        # Context specialists only make small bounded adjustments and only after
        # the global shadow threshold pack has passed promotion guards.
        if not auto_threshold_active:
            score_delta = tp_delta = 0.0
        cand_min_score = float(np.clip(min_plan_score + np.clip(score_delta, -4, 5), 55, 82))
        cand_min_tp1 = float(np.clip(min_tp1 + np.clip(tp_delta, -3, 4), 20, 68))

        reasons = []
        if status != "TRUSTED": reasons.append("MODEL_NOT_TRUSTED")
        if market_open and news_guard.get("lock"): reasons.append("NEWS_LOCK")
        if ood_score > 55: reasons.append("OOD_REGIME_SHIFT")
        if c["score"] < cand_min_score: reasons.append("LOW_PLAN_SCORE")
        if c["evR"] < min_ev: reasons.append("LOW_EXPECTED_VALUE")
        if c["pTp1"] < cand_min_tp1: reasons.append("LOW_TP1_PROBABILITY")
        if c["pCleanWin"] < min_clean: reasons.append("LOW_CLEAN_WIN_PROBABILITY")
        if c["pSl"] > max_sl: reasons.append("SL_PROBABILITY_HIGH")
        if c["pTp1"] - c["pSl"] < min_edge: reasons.append("WEAK_TP1_SL_EDGE")
        if c["modelDisagreementPts"] > max_disagreement: reasons.append("MODEL_DISAGREEMENT")
        if c.get("robustness", {}).get("ready") and safe_num(c["robustness"]["evR"].get("p10"), 0) < -0.20:
            reasons.append("BOOTSTRAP_DOWNSIDE")
        passed = not reasons
        if passed and c["score"] >= 80 and c["evR"] >= 0.38 and c["pCleanWin"] >= 45:
            grade = "A+"
        elif passed and c["score"] >= 72:
            grade = "A"
        elif passed:
            grade = "B"
        else:
            grade = "REJECT"
        c["qualityGate"] = {
            "passed": passed, "grade": grade, "reasons": reasons,
            "thresholdSource": "SELF_PLAY_AUTO" if auto_threshold_active else "STATIC_GUARDED",
            "contextAdjustment": {"scoreDelta": round(float(score_delta), 2), "tp1Delta": round(float(tp_delta), 2)},
            "thresholds": {
                "minPlanScore": round(cand_min_score, 1), "minTp1Probability": round(cand_min_tp1, 1),
                "minCleanWinProbability": round(min_clean, 1), "maxSlProbability": round(max_sl, 1),
                "minExpectedValueR": round(min_ev, 3), "minTp1SlEdgePts": round(min_edge, 1),
                "maxDisagreementPts": round(max_disagreement, 1), "maxOodScore": 55,
            },
        }

    final_rows.sort(key=lambda x: (bool(x["qualityGate"]["passed"]), x["score"], x["evR"], x["pCleanWin"]), reverse=True)
    for rank, c in enumerate(final_rows, 1):
        c["rank"] = rank
        c["trusted"] = status == "TRUSTED"
        c["planState"] = f"QUALIFIED {c['qualityGate']['grade']}" if c["qualityGate"]["passed"] else "REJECTED"
        c["reason"] = f"P(TP1) {c['pTp1']:.1f}% · Clean {c['pCleanWin']:.1f}% · SL {c['pSl']:.1f}% · EV {c['evR']:+.2f}R"

    qualified = [c for c in final_rows if c["qualityGate"]["passed"]]
    reference = final_rows[0] if final_rows else None
    # Backup should be genuinely different, not merely another depth of the same order.
    backup = next((c for c in qualified[1:] if c["type"] != qualified[0]["type"]), qualified[1] if len(qualified) > 1 else None) if qualified else None

    quality_factor = safe_num((qualified[0] if qualified else reference or {}).get("score"), 0) / 100
    health_factor = np.clip((health - 45) / 45, 0, 1)
    ood_factor = np.clip(1 - ood_score / 85, 0, 1)
    news_factor = 0.0 if news_guard.get("lock") else 0.65 if news_guard.get("caution") else 1.0
    streak_factor = max(0.35, 1.0 - 0.14 * loss_streak)
    risk_scale = float(np.clip(quality_factor * health_factor * ood_factor * news_factor * streak_factor, 0, 1)) if qualified else 0.0

    coverage_days = round((int(train_anchor.iloc[-1]["ts"]) - int(train_anchor.iloc[0]["ts"])) / 86_400_000, 1)
    label_coverage_days = round((int(ds["ts"].max()) - int(ds["ts"].min())) / 86_400_000, 1) if len(ds) > 1 else 0.0
    source_live = str((live_pack.get("feed") or {}).get("active") or live_pack.get("source") or "UNKNOWN")
    latest_ts = int(live_anchor.iloc[-1]["ts"])

    selfplay_pack = load_json(SELFPLAY_PATH)
    counterfactual_pack = load_json(COUNTERFACTUAL_PATH)
    autopsy_pack = load_json(AUTOPSY_PATH)
    shadow_pack = load_json(SHADOW_PATH)

    pack_out = {
        "version": VERSION,
        "generatedAt": utc_now(),
        "ready": bool(status == "TRUSTED" and gov.get("trusted")),
        "status": status,
        "engine": "V42 M1 FIRST-HIT / XGB+HGB+TREES / SHADOW SELF-PLAY / AUTO THRESHOLD / AUTOPSY / COUNTERFACTUAL",
        "sourceFingerprint": fp,
        "artifactSchema": {
            "version": ARTIFACT_SCHEMA_VERSION,
            "featureSchemaHash": schema_hash,
            "labelSchemaHash": LABEL_SCHEMA_HASH,
        },
        "artifactProvenance": provenance,
        "dataIsolation": {
            "trainingSource": train_source,
            "trainingFeed": "TWELVE_DATA_PRIMARY",
            "liveSource": source_live,
            "mergeFeeds": False,
            "rule": "Primary history trains the brain. The currently active feed scores live candidates. No price averaging between feeds.",
        },
        "training": {
            "anchors": int(len(train_anchor)), "candidateSamples": int(len(ds)), "filledSamples": int(filled_mask.sum()),
            "coverageDays": coverage_days, "labelCoverageDays": label_coverage_days, "M1": train_counts["M1"], "M5": train_counts["M5"], "M15": train_counts["M15"], "H1": train_counts["H1"],
            "labels": LABEL_SCHEMA, "fillHorizonMin": FILL_HORIZON_MIN, "outcomeHorizonMin": OUTCOME_HORIZON_MIN,
            "geometryVariants": list(VARIANTS), "candidateSpace": len(ORDER_TYPES) * len(VARIANTS),
        },
        "validation": {
            "folds": int(tp1_head.metrics.get("folds", 0)), "fill": fill_head.metrics, "tp1": tp1_head.metrics,
            "tp2": tp2_head.metrics if tp2_head else None, "sl": sl_head.metrics,
            "cleanWin": {"method": "CALIBRATED_TP1_X_EXCURSION_META", "targetSamples": int(len(y_clean)), "baseRate": round(float(np.mean(y_clean)), 5)},
            "purgeMinutes": int(PURGE_MS / M1_MS), "chronological": True, "randomSplit": False,
            "barAvailabilityShifted": True,
        },
        "modelHealth": {
            "score": round(health, 1), "status": status, "driftPts": round(ood_score, 1),
            "uncertaintyPts": round(disagreement_pts, 1), "governanceAction": gov["action"],
            "populationDrift": pop_drift,
        },
        "governance": gov,
        "features": {"count": len(feature_cols), "pruning": prune_report, "top": feature_importance(tp1_head, feature_cols, 18)},
        "autoML": {
            "xgboostAvailable": HAS_XGBOOST,
            "heads": {
                "fill": {"selection": fill_head.selection, "calibration": fill_head.calibration, "modelMetrics": fill_head.model_metrics},
                "tp1": {"selection": tp1_head.selection, "calibration": tp1_head.calibration, "modelMetrics": tp1_head.model_metrics},
                "tp2": ({"selection": tp2_head.selection, "calibration": tp2_head.calibration, "modelMetrics": tp2_head.model_metrics} if tp2_head else None),
                "sl": {"selection": sl_head.selection, "calibration": sl_head.calibration, "modelMetrics": sl_head.model_metrics},
                "cleanWinMeta": {"method": "CALIBRATED_TP1_X_EXCURSION_META", "inputs": ["pTp1", "expectedMfeR", "expectedMaeR", "contextExpert"]},
            },
            "selectionRule": "Expanding chronological walk-forward with time purge; top OOF models are blended and calibrated on disjoint chronological predictions.",
        },
        "contextExperts": {
            "regimes": list(REGIMES), "sessions": list(SESSIONS), "method": "EMPIRICAL_BAYES_SHRINKAGE",
            "groups": len(experts.get("groups", {})), "global": experts.get("global", {}),
        },
        "uncertainty": {
            "method": "HGB_QUANTILE_10_50_90 + MODEL_DISAGREEMENT",
            "note": "Intervals quantify model/excursion uncertainty; they are not guaranteed market bounds.",
        },
        "newsGuard": news_guard,
        "riskBrain": {
            "scale": round(risk_scale, 3), "lossStreak": loss_streak,
            "components": {"quality": round(float(quality_factor), 3), "health": round(float(health_factor), 3), "ood": round(float(ood_factor), 3), "news": round(float(news_factor), 3), "streak": round(float(streak_factor), 3)},
            "note": "Relative risk throttle only; it does not place trades or guarantee a suitable position size.",
        },
        "current": {
            "marketTs": latest_ts, "regime": regime_name(live_anchor.iloc[-1]), "session": session_name(latest_ts),
            "candidates": final_rows, "primary": qualified[0] if qualified else None, "backup": backup,
            "reference": reference, "qualifiedCount": len(qualified), "candidateCount": len(final_rows),
        },
        "selfPlay": {
            "mode": "SHADOW_FORWARD_LEARNING",
            "ready": bool(selfplay_pack.get("ready")),
            "shadow": shadow_pack.get("summary") or selfplay_pack.get("shadow") or {},
            "primaryResolved": selfplay_pack.get("primaryResolved") or {},
            "forwardReplay": selfplay_pack.get("forwardReplay") or {},
            "thresholdOptimizer": {
                **(selfplay_pack.get("thresholdOptimizer") or {}),
                "active": auto_threshold_active,
                "source": "PRIMARY_TWELVE_SHADOW_ONLY",
            },
            "counterfactual": {
                "ready": bool(counterfactual_pack.get("ready")),
                "ideasReplayed": counterfactual_pack.get("ideasReplayed"),
                "best": counterfactual_pack.get("best"),
                "avgRImprovement": counterfactual_pack.get("avgRImprovement"),
            },
            "autopsy": {
                "ready": bool(autopsy_pack.get("ready")),
                "failures": autopsy_pack.get("failures"),
                "topCauses": (autopsy_pack.get("topCauses") or [])[:5],
            },
            "rule": "AI ideas become learning evidence only after future M1 ground truth resolves them. Rejected plans are shadow-tested but never treated as wins without observed outcomes.",
        },
        "policy": {
            "mlCanOverrideTechnical": bool(status == "TRUSTED" and health >= 60 and ood_score <= 32 and not news_guard.get("lock")),
            "minimumPlanScore": round(min_plan_score, 1), "minimumTp1Probability": round(min_tp1, 1),
            "minimumCleanWinProbability": min_clean, "maximumSlProbability": round(max_sl, 1),
            "minimumExpectedValueR": min_ev, "minimumTp1SlEdgePts": min_edge,
            "maximumDisagreementPts": max_disagreement, "maximumOodScore": 55,
            "hardCandidateGate": True, "noTradeBrain": True, "newsLock": bool(news_guard.get("lock")),
            "executionCostModel": "CONSERVATIVE_ESTIMATE_NOT_BID_ASK",
            "thresholdSource": "SELF_PLAY_AUTO" if auto_threshold_active else "STATIC_GUARDED",
            "selfPlayAutoThresholdActive": auto_threshold_active,
            "note": "A healthy model may reject every plan. Qualified plans still require live feed, gap, broker spread/slippage and risk revalidation.",
        },
    }

    write_json(CANDIDATE_PATH, pack_out)
    existing_active = load_json(OUT_PATH)
    if status == "TRUSTED" and gov.get("trusted"):
        existing_provenance = existing_active.get("artifactProvenance") or {}
        identical_active = bool(
            compatible_artifact(existing_active)
            and existing_active.get("sourceFingerprint") == fp
            and int(safe_num(existing_provenance.get("dataWatermark"), 0)) == int(primary_watermark)
        )
        if gov.get("action") == "KEEP_IDENTICAL_EVIDENCE" and identical_active:
            gov["activeAction"] = "KEEP_IDENTICAL_ACTIVE"
        else:
            write_json(OUT_PATH, pack_out)
            gov["activeAction"] = "PROMOTE_CANDIDATE"
    elif compatible_artifact(existing_active):
        gov["activeAction"] = "KEEP_COMPATIBLE_ACTIVE"
        gov["activeSourceFingerprint"] = existing_active.get("sourceFingerprint")
    else:
        # No compatible champion exists. Publish the quarantined candidate so
        # every consumer fails closed instead of silently retaining a legacy pack.
        write_json(OUT_PATH, pack_out)
        gov["activeAction"] = "PUBLISH_QUARANTINED_NO_COMPATIBLE_ACTIVE"
    write_json(GOV_PATH, gov)
    print("V42 brain ready", {
        "status": status, "health": round(health, 1), "samples": len(ds), "filled": int(filled_mask.sum()),
        "auc": primary_metrics.get("auc"), "brier": primary_metrics.get("brier"), "ece": primary_metrics.get("ece"),
        "ood": round(ood_score, 1), "liveFeed": source_live, "qualified": len(qualified),
        "primary": qualified[0]["id"] if qualified else None,
    })


if __name__ == "__main__":
    main()
