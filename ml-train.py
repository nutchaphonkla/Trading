#!/usr/bin/env python3
"""OneMonth OS V36 Autonomous ML Plan Brain.

Reads xauusd.json, builds leakage-safe multi-timeframe features, creates four pending
order candidates (BUY/SELL LIMIT + BUY/SELL STOP), labels their historical outcomes,
trains an ensemble with chronological walk-forward validation and probability
calibration, then writes a compact ai-ml-brain.json for the PWA.

The script intentionally writes WAIT_DATA and exits successfully when history is not
yet sufficient so GitHub Actions does not fail while the rolling pack is growing.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Iterable, List, Optional, Tuple

import numpy as np
import pandas as pd
from sklearn.ensemble import ExtraTreesClassifier, ExtraTreesRegressor, HistGradientBoostingClassifier, HistGradientBoostingRegressor, RandomForestClassifier
from sklearn.impute import SimpleImputer
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, brier_score_loss, roc_auc_score

try:
    from xgboost import XGBClassifier
    HAS_XGBOOST = True
except Exception:
    XGBClassifier = None
    HAS_XGBOOST = False

ROOT = Path(os.environ.get("GITHUB_WORKSPACE", Path.cwd()))
DATA_PATH = ROOT / "xauusd.json"
OUT_PATH = ROOT / "ai-ml-brain.json"
CANDIDATE_PATH = ROOT / "ai-ml-candidate.json"
GOV_PATH = ROOT / "ai-ml-governance.json"
JOURNAL_PATH = ROOT / "ai-outcome-journal.json"
VERSION = "V36.0 AUTONOMOUS ML PLAN BRAIN"
SEED = 3609
MIN_M15 = 420
FILL_HORIZON = 8
OUTCOME_HORIZON = 12
PURGE_BARS = FILL_HORIZON + OUTCOME_HORIZON
N_FOLDS = 3

ORDER_TYPES = ("BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP")
ORDER_ONEHOT = {k: i for i, k in enumerate(ORDER_TYPES)}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def write_json(path: Path, data: dict) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


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
        "engine": "AUTO_ML_TOURNAMENT",
        "training": {"counts": counts or {}},
    }
    write_json(OUT_PATH, pack)
    write_json(CANDIDATE_PATH, pack)
    write_json(GOV_PATH, {"version": VERSION, "updatedAt": utc_now(), "action": "WAIT_DATA", "trusted": False, "reason": reason})
    print("ML WAIT_DATA:", reason, counts or {})
    raise SystemExit(0)


def load_pack() -> dict:
    if not DATA_PATH.exists():
        wait_data("MISSING_XAUUSD_JSON")
    try:
        return json.loads(DATA_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        wait_data(f"INVALID_XAUUSD_JSON:{exc}")


def frame_from_rows(rows: Iterable[dict]) -> pd.DataFrame:
    df = pd.DataFrame(list(rows or []))
    if df.empty:
        return pd.DataFrame(columns=["ts", "open", "high", "low", "close"])
    for c in ["ts", "open", "high", "low", "close"]:
        if c not in df.columns:
            df[c] = np.nan
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df = df.dropna(subset=["ts", "open", "high", "low", "close"])
    df = df[(df[["open", "high", "low", "close"]] > 0).all(axis=1)]
    df = df.sort_values("ts").drop_duplicates("ts", keep="last").reset_index(drop=True)
    return df[["ts", "open", "high", "low", "close"]]


def ema(s: pd.Series, span: int) -> pd.Series:
    return s.ewm(span=span, adjust=False, min_periods=max(3, span // 3)).mean()


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    up = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    down = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = up / down.replace(0, np.nan)
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


def tf_features(df: pd.DataFrame, prefix: str) -> pd.DataFrame:
    if df.empty:
        return df.copy()
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
    ret1 = close.pct_change(1)
    ret4 = close.pct_change(4)
    ret12 = close.pct_change(12)
    logret = np.log(close).diff()

    o = pd.DataFrame({"ts": x["ts"]})
    o[f"{prefix}_ret1"] = ret1
    o[f"{prefix}_ret4"] = ret4
    o[f"{prefix}_ret12"] = ret12
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
    return o.replace([np.inf, -np.inf], np.nan)


def merged_anchor_features(tfs: Dict[str, pd.DataFrame]) -> Tuple[pd.DataFrame, dict]:
    m15 = tfs["M15"]
    base = tf_features(m15, "m15")
    # candidate geometry inputs kept unprefixed for convenience
    a = atr(m15)
    base["close"] = m15["close"].values
    base["high"] = m15["high"].values
    base["low"] = m15["low"].values
    base["atr"] = a.values
    base["ema21"] = ema(m15["close"], 21).values
    base["swing_high20"] = m15["high"].rolling(20, min_periods=8).max().values
    base["swing_low20"] = m15["low"].rolling(20, min_periods=8).min().values
    base["swing_high50"] = m15["high"].rolling(50, min_periods=15).max().values
    base["swing_low50"] = m15["low"].rolling(50, min_periods=15).min().values

    for tf, prefix in [("M5", "m5"), ("H1", "h1")]:
        f = tf_features(tfs.get(tf, pd.DataFrame()), prefix)
        if not f.empty:
            base = pd.merge_asof(
                base.sort_values("ts"), f.sort_values("ts"), on="ts", direction="backward", allow_exact_matches=True
            )

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

    counts = {k: len(v) for k, v in tfs.items()}
    return base, counts


def candidate_geometry(row: pd.Series, order_type: str) -> Optional[dict]:
    close = safe_num(row.get("close"), np.nan)
    a = safe_num(row.get("atr"), np.nan)
    e21 = safe_num(row.get("ema21"), np.nan)
    hi = safe_num(row.get("swing_high20"), np.nan)
    lo = safe_num(row.get("swing_low20"), np.nan)
    if not all(math.isfinite(x) and x > 0 for x in [close, a, e21, hi, lo]):
        return None
    side = 1 if order_type.startswith("BUY") else -1
    is_limit = order_type.endswith("LIMIT")
    # Geometry deliberately uses only information known at anchor time.
    if order_type == "BUY_LIMIT":
        entry = min(close - 0.12 * a, max(lo + 0.10 * a, min(e21, close - 0.08 * a)))
        sl = min(lo - 0.12 * a, entry - 0.82 * a)
    elif order_type == "SELL_LIMIT":
        entry = max(close + 0.12 * a, min(hi - 0.10 * a, max(e21, close + 0.08 * a)))
        sl = max(hi + 0.12 * a, entry + 0.82 * a)
    elif order_type == "BUY_STOP":
        entry = max(hi + 0.06 * a, close + 0.10 * a)
        sl = entry - 0.95 * a
    elif order_type == "SELL_STOP":
        entry = min(lo - 0.06 * a, close - 0.10 * a)
        sl = entry + 0.95 * a
    else:
        return None
    risk = abs(entry - sl)
    if not math.isfinite(risk) or risk < 0.35 * a or risk > 2.8 * a:
        return None
    tp1 = entry + side * risk * 1.40
    tp2 = entry + side * risk * 2.20
    zone_half = max(a * (0.055 if is_limit else 0.035), close * 0.00002)
    cancel = (lo - 0.25 * a) if side > 0 else (hi + 0.25 * a)
    return {
        "type": order_type,
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
        "rr": 1.40,
        "cancelLevel": float(cancel),
    }


def order_feature_values(row: pd.Series, geom: dict) -> dict:
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
        "order_side_entry_dist_atr": side * (geom["entry"] - close) / a,
        "order_side_ema21_atr": side * (close - safe_num(row.get("ema21"), close)) / a,
        "order_side_hi20_atr": side * (safe_num(row.get("swing_high20"), close) - close) / a,
        "order_side_lo20_atr": side * (close - safe_num(row.get("swing_low20"), close)) / a,
    }
    for k, idx in ORDER_ONEHOT.items():
        out[f"order_{k.lower()}"] = 1.0 if geom["type"] == k else 0.0
    return out


def is_filled(bar: pd.Series, geom: dict) -> bool:
    typ = geom["type"]
    if typ == "BUY_LIMIT":
        return safe_num(bar["low"], math.inf) <= geom["entry"]
    if typ == "SELL_LIMIT":
        return safe_num(bar["high"], -math.inf) >= geom["entry"]
    if typ == "BUY_STOP":
        return safe_num(bar["high"], -math.inf) >= geom["entry"]
    return safe_num(bar["low"], math.inf) <= geom["entry"]


def simulate_outcome(m15: pd.DataFrame, anchor_i: int, geom: dict) -> dict:
    max_needed = anchor_i + FILL_HORIZON + OUTCOME_HORIZON
    if max_needed >= len(m15):
        return {"complete": False}
    fill_i = None
    for j in range(anchor_i + 1, min(len(m15), anchor_i + 1 + FILL_HORIZON)):
        if is_filled(m15.iloc[j], geom):
            fill_i = j
            break
    if fill_i is None:
        return {"complete": True, "filled": 0, "tp1": 0, "tp2": 0, "sl": 0, "mfe_r": 0.0, "mae_r": 0.0, "fill_delay": float(FILL_HORIZON + 1)}

    side = geom["side_num"]
    risk = geom["risk"]
    mfe = 0.0
    mae = 0.0
    tp1_hit = 0
    tp2_hit = 0
    sl_hit = 0
    # Conservative intrabar rule: if SL and TP are both touched in the same candle,
    # the SL is assumed first. This avoids optimistic backtest leakage.
    for j in range(fill_i, min(len(m15), fill_i + OUTCOME_HORIZON + 1)):
        b = m15.iloc[j]
        if side > 0:
            favorable = safe_num(b["high"]) - geom["entry"]
            adverse = geom["entry"] - safe_num(b["low"])
            hit_sl = safe_num(b["low"], math.inf) <= geom["sl"]
            hit_tp1 = safe_num(b["high"], -math.inf) >= geom["tp1"]
            hit_tp2 = safe_num(b["high"], -math.inf) >= geom["tp2"]
        else:
            favorable = geom["entry"] - safe_num(b["low"])
            adverse = safe_num(b["high"]) - geom["entry"]
            hit_sl = safe_num(b["high"], -math.inf) >= geom["sl"]
            hit_tp1 = safe_num(b["low"], math.inf) <= geom["tp1"]
            hit_tp2 = safe_num(b["low"], math.inf) <= geom["tp2"]
        mfe = max(mfe, favorable / risk)
        mae = max(mae, adverse / risk)
        if hit_sl:
            sl_hit = 1
            break
        if hit_tp2:
            tp1_hit = 1
            tp2_hit = 1
            break
        if hit_tp1:
            tp1_hit = 1
            # keep observing for TP2 / later stop only for excursion, but TP1 success is locked
    return {
        "complete": True,
        "filled": 1,
        "tp1": int(tp1_hit),
        "tp2": int(tp2_hit),
        "sl": int(sl_hit),
        "mfe_r": float(min(mfe, 8.0)),
        "mae_r": float(min(mae, 5.0)),
        "fill_delay": float(fill_i - anchor_i),
    }


def build_dataset(anchor: pd.DataFrame, m15: pd.DataFrame) -> Tuple[pd.DataFrame, List[str], List[dict]]:
    base_exclude = {"ts", "open", "high", "low", "close", "atr", "ema21", "swing_high20", "swing_low20", "swing_high50", "swing_low50"}
    market_cols = [c for c in anchor.columns if c not in base_exclude]
    rows: List[dict] = []
    current_candidates: List[dict] = []
    ts_to_i = {int(ts): i for i, ts in enumerate(m15["ts"].tolist())}

    for _, r in anchor.iterrows():
        ts = int(r["ts"])
        i = ts_to_i.get(ts)
        if i is None:
            continue
        market_values = {c: safe_num(r.get(c), np.nan) for c in market_cols}
        for typ in ORDER_TYPES:
            geom = candidate_geometry(r, typ)
            if not geom:
                continue
            feats = {**market_values, **order_feature_values(r, geom)}
            outcome = simulate_outcome(m15, i, geom)
            if outcome.get("complete"):
                rows.append({"ts": ts, "order_type": typ, **feats, **outcome})
        # latest anchor gets scored even without future labels
    if not anchor.empty:
        r = anchor.iloc[-1]
        for typ in ORDER_TYPES:
            geom = candidate_geometry(r, typ)
            if not geom:
                continue
            feats = {c: safe_num(r.get(c), np.nan) for c in market_cols}
            feats.update(order_feature_values(r, geom))
            current_candidates.append({"ts": int(r["ts"]), "geometry": geom, "features": feats})

    ds = pd.DataFrame(rows)
    feature_cols = market_cols + list(order_feature_values(anchor.iloc[-1], candidate_geometry(anchor.iloc[-1], "BUY_LIMIT") or {
        "type": "BUY_LIMIT", "side_num": 1, "is_limit": 1.0, "is_stop": 0.0, "entry": 1, "risk": 1
    }).keys()) if not anchor.empty else market_cols
    feature_cols = list(dict.fromkeys(feature_cols))
    return ds, feature_cols, current_candidates


class IdentityCalibrator:
    name = "IDENTITY"
    def fit(self, raw: np.ndarray, y: np.ndarray):
        return self
    def transform(self, raw: np.ndarray) -> np.ndarray:
        return np.clip(np.asarray(raw, dtype=float), 0.005, 0.995)


class PlattCalibrator:
    name = "PLATT"
    def __init__(self):
        self.model: Optional[LogisticRegression] = None

    @staticmethod
    def _logit(p: np.ndarray) -> np.ndarray:
        p = np.clip(np.asarray(p, dtype=float), 1e-5, 1 - 1e-5)
        return np.log(p / (1 - p)).reshape(-1, 1)

    def fit(self, raw: np.ndarray, y: np.ndarray):
        y = np.asarray(y, dtype=int)
        if len(y) >= 60 and len(np.unique(y)) == 2:
            self.model = LogisticRegression(C=0.8, solver="lbfgs", max_iter=500, random_state=SEED)
            self.model.fit(self._logit(raw), y)
        return self

    def transform(self, raw: np.ndarray) -> np.ndarray:
        raw = np.asarray(raw, dtype=float)
        if self.model is None:
            return np.clip(raw, 0.005, 0.995)
        return self.model.predict_proba(self._logit(raw))[:, 1]


class IsotonicCalibrator:
    name = "ISOTONIC"
    def __init__(self):
        self.model: Optional[IsotonicRegression] = None

    def fit(self, raw: np.ndarray, y: np.ndarray):
        raw = np.asarray(raw, dtype=float)
        y = np.asarray(y, dtype=int)
        if len(y) >= 180 and len(np.unique(y)) == 2 and len(np.unique(np.round(raw, 4))) >= 16:
            self.model = IsotonicRegression(out_of_bounds="clip", y_min=0.005, y_max=0.995)
            self.model.fit(raw, y)
        return self

    def transform(self, raw: np.ndarray) -> np.ndarray:
        raw = np.asarray(raw, dtype=float)
        if self.model is None:
            return np.clip(raw, 0.005, 0.995)
        return np.clip(self.model.predict(raw), 0.005, 0.995)


def recency_weights(ts: np.ndarray, half_life_days: float = 45.0) -> np.ndarray:
    latest = np.nanmax(ts)
    age_days = np.maximum(0.0, (latest - ts) / 86400000.0)
    return np.power(0.5, age_days / half_life_days)


def classification_metrics(y: np.ndarray, p: np.ndarray) -> dict:
    y = np.asarray(y, dtype=int)
    p = np.clip(np.asarray(p, dtype=float), 1e-5, 1 - 1e-5)
    if len(y) == 0:
        return {"samples": 0, "brier": None, "auc": None, "accuracy": None, "ece": None, "baseRate": None}
    brier = float(brier_score_loss(y, p))
    acc = float(accuracy_score(y, p >= 0.5))
    auc = None
    if len(np.unique(y)) == 2:
        try:
            auc = float(roc_auc_score(y, p))
        except Exception:
            auc = None
    bins = np.linspace(0, 1, 11)
    ece = 0.0
    for lo, hi in zip(bins[:-1], bins[1:]):
        mask = (p >= lo) & (p < hi if hi < 1 else p <= hi)
        if mask.any():
            ece += float(mask.mean()) * abs(float(p[mask].mean()) - float(y[mask].mean()))
    return {
        "samples": int(len(y)),
        "brier": round(brier, 5),
        "auc": None if auc is None else round(auc, 5),
        "accuracy": round(acc, 5),
        "ece": round(float(ece), 5),
        "baseRate": round(float(y.mean()), 5),
    }


def make_hgb_classifier() -> HistGradientBoostingClassifier:
    return HistGradientBoostingClassifier(
        learning_rate=0.04,
        max_iter=135,
        max_leaf_nodes=21,
        min_samples_leaf=24,
        l2_regularization=1.8,
        random_state=SEED,
    )


def make_extra_classifier() -> ExtraTreesClassifier:
    return ExtraTreesClassifier(
        n_estimators=150,
        max_features=0.72,
        min_samples_leaf=7,
        class_weight="balanced_subsample",
        n_jobs=-1,
        random_state=SEED,
    )


def make_rf_classifier() -> RandomForestClassifier:
    return RandomForestClassifier(
        n_estimators=220,
        max_depth=12,
        max_features="sqrt",
        min_samples_leaf=8,
        class_weight="balanced_subsample",
        n_jobs=-1,
        random_state=SEED,
    )


def make_xgb_classifier():
    if not HAS_XGBOOST:
        return None
    return XGBClassifier(
        n_estimators=170,
        max_depth=4,
        learning_rate=0.035,
        min_child_weight=5,
        subsample=0.84,
        colsample_bytree=0.78,
        reg_alpha=0.08,
        reg_lambda=2.4,
        objective="binary:logistic",
        eval_metric="logloss",
        tree_method="hist",
        n_jobs=2,
        random_state=SEED,
    )


def classifier_factories() -> Dict[str, object]:
    out = {
        "HGB": make_hgb_classifier,
        "EXTRATREES": make_extra_classifier,
    }
    if HAS_XGBOOST:
        out["XGBOOST"] = make_xgb_classifier
    return out


def make_hgb_regressor() -> HistGradientBoostingRegressor:
    return HistGradientBoostingRegressor(
        learning_rate=0.045,
        max_iter=170,
        max_leaf_nodes=17,
        min_samples_leaf=22,
        l2_regularization=1.4,
        loss="absolute_error",
        random_state=SEED,
    )


def make_extra_regressor() -> ExtraTreesRegressor:
    return ExtraTreesRegressor(
        n_estimators=220,
        max_features=0.75,
        min_samples_leaf=6,
        n_jobs=-1,
        random_state=SEED,
    )


def walk_forward_slices(times: np.ndarray, n_folds: int = N_FOLDS) -> List[Tuple[np.ndarray, np.ndarray]]:
    uniq = np.array(sorted(set(int(x) for x in times)))
    if len(uniq) < 180:
        return []
    initial = max(100, int(len(uniq) * 0.50))
    remaining = len(uniq) - initial
    chunk = max(24, remaining // n_folds)
    folds = []
    for k in range(n_folds):
        test_start = initial + k * chunk
        test_end = len(uniq) if k == n_folds - 1 else min(len(uniq), test_start + chunk)
        train_end = max(0, test_start - PURGE_BARS)
        if train_end < 80 or test_end - test_start < 15:
            continue
        train_times = set(uniq[:train_end].tolist())
        test_times = set(uniq[test_start:test_end].tolist())
        tr = np.array([i for i, t in enumerate(times) if int(t) in train_times], dtype=int)
        te = np.array([i for i, t in enumerate(times) if int(t) in test_times], dtype=int)
        if len(tr) >= 200 and len(te) >= 60:
            folds.append((tr, te))
    return folds


def oof_for_factory(factory, X: np.ndarray, y: np.ndarray, times: np.ndarray) -> Tuple[np.ndarray, np.ndarray, int]:
    pred = np.full(len(y), np.nan, dtype=float)
    used = np.zeros(len(y), dtype=bool)
    folds = walk_forward_slices(times)
    for tr, te in folds:
        yt = y[tr]
        if len(np.unique(yt)) < 2:
            continue
        model = factory()
        if model is None:
            continue
        w = recency_weights(times[tr])
        model.fit(X[tr], yt, sample_weight=w)
        pred[te] = model.predict_proba(X[te])[:, 1]
        used[te] = True
    return pred, used, len(folds)


def _quality_from_metrics(m: dict) -> float:
    auc = safe_num(m.get("auc"), 0.5)
    brier = safe_num(m.get("brier"), 0.35)
    ece = safe_num(m.get("ece"), 0.20)
    auc_term = np.clip((auc - 0.50) / 0.25, 0, 1)
    brier_term = np.clip((0.25 - brier) / 0.16, 0, 1)
    ece_term = np.clip((0.14 - ece) / 0.12, 0, 1)
    return float(0.50 * auc_term + 0.34 * brier_term + 0.16 * ece_term)


def _normalize_weights(scores: Dict[str, float]) -> Dict[str, float]:
    if not scores:
        return {}
    best = max(scores.values())
    kept = {k: v for k, v in sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:3] if v >= best - 0.16}
    if not kept:
        kept = {max(scores, key=scores.get): best}
    vals = {k: math.exp((v - best) * 4.5) for k, v in kept.items()}
    total = sum(vals.values()) or 1.0
    return {k: v / total for k, v in vals.items()}


def _calibration_score(metrics: dict) -> float:
    return safe_num(metrics.get("brier"), 1) + 0.55 * safe_num(metrics.get("ece"), 1)


def choose_calibrator(raw: np.ndarray, y: np.ndarray, times: np.ndarray):
    raw = np.asarray(raw, dtype=float)
    y = np.asarray(y, dtype=int)
    order = np.argsort(times)
    raw, y = raw[order], y[order]
    split = max(80, int(len(y) * 0.62))
    split = min(split, max(1, len(y) - 50))
    train_raw, train_y = raw[:split], y[:split]
    eval_raw, eval_y = raw[split:], y[split:]
    candidates = [IdentityCalibrator(), PlattCalibrator(), IsotonicCalibrator()]
    results = []
    for cal in candidates:
        try:
            cal.fit(train_raw, train_y)
            pred = cal.transform(eval_raw)
            m = classification_metrics(eval_y, pred)
            penalty = 0.002 if getattr(cal, "name", "") == "ISOTONIC" and len(train_y) < 350 else 0.0
            results.append((_calibration_score(m) + penalty, cal.name, m))
        except Exception:
            pass
    if not results:
        chosen = IdentityCalibrator()
        selection = {"selected": "IDENTITY", "evaluation": []}
    else:
        results.sort(key=lambda x: x[0])
        name = results[0][1]
        chosen = {"IDENTITY": IdentityCalibrator, "PLATT": PlattCalibrator, "ISOTONIC": IsotonicCalibrator}[name]()
        selection = {
            "selected": name,
            "evaluation": [{"name": n, "score": round(float(sc), 5), "metrics": m} for sc, n, m in results],
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
        preds: Dict[str, np.ndarray] = {}
        for name, model in self.models.items():
            preds[name] = model.predict_proba(X)[:, 1]
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
    oofs: Dict[str, np.ndarray] = {}
    useds: Dict[str, np.ndarray] = {}
    model_metrics: Dict[str, dict] = {}
    quality: Dict[str, float] = {}
    folds = 0
    for model_name, factory in factories.items():
        try:
            pred, used, f = oof_for_factory(factory, X, y, times)
            folds = max(folds, f)
            if used.any():
                m = classification_metrics(y[used], pred[used])
                oofs[model_name] = pred
                useds[model_name] = used
                model_metrics[model_name] = m
                quality[model_name] = _quality_from_metrics(m)
        except Exception as exc:
            model_metrics[model_name] = {"error": str(exc)[:160]}
    if not oofs:
        raise RuntimeError(f"NO_WALK_FORWARD_MODELS:{name}")
    weights = _normalize_weights(quality)
    common = np.ones(len(y), dtype=bool)
    for model_name in weights:
        common &= useds[model_name]
    if common.sum() < 80:
        common = np.zeros(len(y), dtype=bool)
        best_name = max(weights, key=weights.get)
        common |= useds[best_name]
        weights = {best_name: 1.0}
    raw_oof = np.zeros(common.sum(), dtype=float)
    for model_name, w in weights.items():
        raw_oof += float(w) * oofs[model_name][common]
    cal, cal_selection = choose_calibrator(raw_oof, y[common], times[common])
    calibrated = cal.transform(raw_oof)
    metrics = classification_metrics(y[common], calibrated)
    metrics["folds"] = folds
    models: Dict[str, object] = {}
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

def fit_regressor(X: np.ndarray, y: np.ndarray, times: np.ndarray):
    h = make_hgb_regressor()
    e = make_extra_regressor()
    w = recency_weights(times)
    h.fit(X, y, sample_weight=w)
    e.fit(X, y, sample_weight=w)
    return h, e


def feature_importance(head: ClassifierHead, names: List[str], n: int = 14) -> List[dict]:
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
    return [{"feature": names[i], "importance": round(float(vals[i]), 5)} for i in idx]


def drift_score(X_train: np.ndarray, current: np.ndarray) -> float:
    med = np.nanmedian(X_train, axis=0)
    q25 = np.nanpercentile(X_train, 25, axis=0)
    q75 = np.nanpercentile(X_train, 75, axis=0)
    scale = np.maximum(q75 - q25, 1e-6)
    z = np.abs((current - med) / scale)
    z = z[np.isfinite(z)]
    if len(z) == 0:
        return 100.0
    return float(np.clip(np.nanmedian(np.clip(z, 0, 6)) * 18.0, 0, 100))


def health_score(metrics: dict, filled_samples: int, drift_pts: float, disagreement_pts: float) -> float:
    b = safe_num(metrics.get("brier"), 0.35)
    ece = safe_num(metrics.get("ece"), 0.25)
    auc = safe_num(metrics.get("auc"), 0.50)
    sample_bonus = min(18.0, math.log10(max(10, filled_samples)) * 8.0 - 6.0)
    score = 52.0 + sample_bonus + max(0, auc - 0.5) * 65.0
    score -= max(0, b - 0.16) * 105.0
    score -= ece * 70.0
    score -= max(0, drift_pts - 18) * 0.45
    score -= max(0, disagreement_pts - 10) * 0.45
    return float(np.clip(score, 0, 100))


def load_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def governance(candidate_score: float, candidate_metrics: dict, source_fp: str) -> dict:
    old = load_json(GOV_PATH)
    best = safe_num(old.get("bestScore"), -1)
    best_brier = safe_num(old.get("bestBrier"), 9)
    cur_brier = safe_num(candidate_metrics.get("brier"), 9)
    if best < 0:
        action = "BOOTSTRAP"
        trusted = candidate_score >= 48
        best = candidate_score if trusted else -1
        best_brier = cur_brier if trusted else 9
    elif candidate_score >= best + 1.0 and cur_brier <= best_brier + 0.018:
        action = "PROMOTE"
        trusted = True
        best = candidate_score
        best_brier = min(best_brier, cur_brier)
    elif candidate_score >= best - 4.0 and cur_brier <= best_brier + 0.028:
        action = "KEEP_TRUSTED"
        trusted = candidate_score >= 52
    else:
        action = "QUARANTINE"
        trusted = False
    return {
        "version": VERSION,
        "updatedAt": utc_now(),
        "action": action,
        "trusted": bool(trusted),
        "candidateScore": round(candidate_score, 2),
        "bestScore": round(best, 2) if best >= 0 else None,
        "candidateBrier": None if cur_brier >= 8 else round(cur_brier, 5),
        "bestBrier": None if best_brier >= 8 else round(best_brier, 5),
        "sourceFingerprint": source_fp,
    }


def main() -> None:
    pack = load_pack()
    tfraw = pack.get("timeframes") or {}
    tfs = {k: frame_from_rows(tfraw.get(k, [])) for k in ["M1", "M5", "M15", "H1"]}
    counts = {k: len(v) for k, v in tfs.items()}
    # Heavy ML retraining is intentionally throttled. The market pack can update
    # every 10 minutes, but rebuilding the ensemble more often than once per hour
    # adds compute without meaningful new M15 labels. Set ML_FORCE=1 to override.
    existing = load_json(OUT_PATH)
    latest_m15_ts = int(tfs["M15"].iloc[-1]["ts"]) if len(tfs["M15"]) else 0
    old_market_ts = int(safe_num((existing.get("current") or {}).get("marketTs"), 0))
    if os.environ.get("ML_FORCE") != "1" and existing.get("version") == VERSION and existing.get("ready") and latest_m15_ts and old_market_ts and latest_m15_ts - old_market_ts < 60 * 60 * 1000:
        print("ML SKIP: fewer than 4 new M15 bars since last trained brain", {"latest": latest_m15_ts, "trained": old_market_ts})
        raise SystemExit(0)
    if counts["M15"] < MIN_M15:
        wait_data(f"NEED_AT_LEAST_{MIN_M15}_M15_CANDLES", counts)
    if counts["M5"] < 180 or counts["H1"] < 80:
        wait_data("NEED_MORE_M5_H1_HISTORY", counts)

    anchor, counts = merged_anchor_features(tfs)
    anchor = anchor.dropna(subset=["atr", "ema21", "swing_high20", "swing_low20"]).reset_index(drop=True)
    if len(anchor) < 350:
        wait_data("FEATURE_HISTORY_TOO_SHORT", counts)

    ds, feature_cols, current = build_dataset(anchor, tfs["M15"])
    if ds.empty or len(ds) < 800:
        wait_data("NOT_ENOUGH_LABELED_PENDING_PLANS", {**counts, "labeled": len(ds)})
    # Restrict to numeric stable columns and impute once for all heads.
    feature_cols = [c for c in feature_cols if c in ds.columns]
    Xdf = ds[feature_cols].replace([np.inf, -np.inf], np.nan)
    imputer = SimpleImputer(strategy="median")
    X = imputer.fit_transform(Xdf)
    times = ds["ts"].to_numpy(dtype=float)
    y_fill = ds["filled"].to_numpy(dtype=int)

    filled_mask = ds["filled"].to_numpy(dtype=int) == 1
    if filled_mask.sum() < 180:
        wait_data("NOT_ENOUGH_FILLED_PENDING_PLANS", {**counts, "labeled": len(ds), "filled": int(filled_mask.sum())})

    fill_head = fit_head("fill", X, y_fill, times)

    Xf = X[filled_mask]
    tf = times[filled_mask]
    y_tp1 = ds.loc[filled_mask, "tp1"].to_numpy(dtype=int)
    y_tp2 = ds.loc[filled_mask, "tp2"].to_numpy(dtype=int)
    y_sl = ds.loc[filled_mask, "sl"].to_numpy(dtype=int)
    if min(len(np.unique(y_tp1)), len(np.unique(y_sl))) < 2:
        wait_data("OUTCOME_CLASSES_NOT_DIVERSE_YET", {"filled": int(filled_mask.sum()), "tp1Rate": float(y_tp1.mean()), "slRate": float(y_sl.mean())})

    tp1_head = fit_head("tp1", Xf, y_tp1, tf)
    tp2_head = fit_head("tp2", Xf, y_tp2, tf) if len(np.unique(y_tp2)) == 2 and y_tp2.sum() >= 25 else None
    sl_head = fit_head("sl", Xf, y_sl, tf)

    mfe_h, mfe_e = fit_regressor(Xf, ds.loc[filled_mask, "mfe_r"].to_numpy(dtype=float), tf)
    mae_h, mae_e = fit_regressor(Xf, ds.loc[filled_mask, "mae_r"].to_numpy(dtype=float), tf)

    source_payload = {
        "generatedAt": pack.get("generatedAt"),
        "counts": counts,
        "last": {k: int(v.iloc[-1]["ts"]) if len(v) else None for k, v in tfs.items()},
    }
    source_fp = hashlib.sha256(json.dumps(source_payload, sort_keys=True).encode()).hexdigest()[:20]

    scored = []
    disagreements = []
    for item in current:
        row = pd.DataFrame([{c: item["features"].get(c, np.nan) for c in feature_cols}])
        xc = imputer.transform(row)
        pfill, _, d_fill = fill_head.predict_ensemble(xc)
        ptp1, _, d_tp1 = tp1_head.predict_ensemble(xc)
        if tp2_head:
            ptp2, _, d_tp2 = tp2_head.predict_ensemble(xc)
            p_tp2 = float(ptp2[0])
            dis_tp2 = float(d_tp2[0])
        else:
            p_tp2 = max(0.02, float(ptp1[0]) * 0.58)
            dis_tp2 = 12.0
        psl, _, d_sl = sl_head.predict_ensemble(xc)
        mfe = max(0.0, float(0.58 * mfe_h.predict(xc)[0] + 0.42 * mfe_e.predict(xc)[0]))
        mae = max(0.0, float(0.58 * mae_h.predict(xc)[0] + 0.42 * mae_e.predict(xc)[0]))
        disagreement = float(np.mean([float(d_fill[0]), float(d_tp1[0]), dis_tp2, float(d_sl[0])]))
        disagreements.append(disagreement)
        # TP2 is incremental beyond TP1: only its additional 0.8R is added.
        ev_fill = float(ptp1[0]) * 1.40 + p_tp2 * 0.80 - float(psl[0]) * 1.0
        total_ev = float(pfill[0]) * ev_fill
        edge = float(ptp1[0]) - float(psl[0])
        excursion_edge = np.clip((mfe - mae) / 2.2, -0.25, 1.0)
        quality = (
            float(ptp1[0]) * 43
            + p_tp2 * 12
            + float(pfill[0]) * 12
            + max(0.0, 1.0 - float(psl[0])) * 13
            + np.clip((total_ev + 0.15) / 0.75, 0, 1) * 12
            + excursion_edge * 8
        )
        quality += np.clip(edge, -0.25, 0.45) * 18
        quality -= max(0.0, disagreement - 7.0) * 0.45
        geom = item["geometry"].copy()
        scored.append({
            **{k: geom[k] for k in ["type", "side", "entry", "entryLow", "entryHigh", "sl", "tp1", "tp2", "rr", "cancelLevel"]},
            "pFill": round(float(pfill[0]) * 100, 2),
            "pTp1": round(float(ptp1[0]) * 100, 2),
            "pTp2": round(p_tp2 * 100, 2),
            "pSl": round(float(psl[0]) * 100, 2),
            "edgePts": round(edge * 100, 2),
            "expectedMfeR": round(mfe, 3),
            "expectedMaeR": round(mae, 3),
            "evR": round(total_ev, 3),
            "modelDisagreementPts": round(disagreement, 2),
            "score": round(float(np.clip(quality, 0, 100)), 1),
        })

    # Drift evaluated on the best candidate's current feature vector.
    candidate_matrix = imputer.transform(pd.DataFrame([
        {c: item["features"].get(c, np.nan) for c in feature_cols} for item in current
    ]))
    drift = min(drift_score(X, row) for row in candidate_matrix)
    disagreement_pts = float(np.mean(disagreements)) if disagreements else 100.0
    primary_metrics = tp1_head.metrics
    health = health_score(primary_metrics, int(filled_mask.sum()), drift, disagreement_pts)
    gov = governance(health, primary_metrics, source_fp)
    if drift > 45 or safe_num(primary_metrics.get("ece"), 1) > 0.18 or safe_num(primary_metrics.get("brier"), 1) > 0.26:
        gov["trusted"] = False
        gov["action"] = "QUARANTINE_GUARD"
    status = "TRUSTED" if gov["trusted"] and health >= 52 else "QUARANTINED"

    # Closed-loop feedback from real pending-plan journal. This is deliberately a
    # small adjustment; historical ML validation remains the main evidence.
    journal = load_json(JOURNAL_PATH)
    by_type = (journal.get("mlPlanSummary") or journal.get("planSummary") or {}).get("byType") or {}
    for c in scored:
        key_space = c["type"].replace("_", " ")
        st = by_type.get(c["type"]) or by_type.get(key_space) or {}
        samples = int(safe_num(st.get("samples"), 0))
        hit = safe_num(st.get("hitRate"), 50)
        good = safe_num(st.get("goodEntryRate"), 50)
        adj = 0.0
        if samples >= 12:
            strength = min(1.0, samples / 80.0)
            adj = np.clip(((hit - 50.0) * 0.10 + (good - 45.0) * 0.06) * strength, -8.0, 8.0)
            c["score"] = round(float(np.clip(c["score"] + adj, 0, 100)), 1)
        c["journalSamples"] = samples
        c["journalAdjustment"] = round(float(adj), 2)

    # Autonomous execution-quality policy. Model health and candidate quality are separate:
    # a TRUSTED model is allowed to speak, but a weak candidate is still rejected.
    tp1_base = safe_num(tp1_head.metrics.get("baseRate"), 0.25) * 100.0
    sl_base = safe_num(sl_head.metrics.get("baseRate"), 0.25) * 100.0
    min_plan_score = float(np.clip(60.0 + max(0.0, disagreement_pts - 8.0) * 0.20 + max(0.0, drift - 15.0) * 0.10, 60.0, 70.0))
    min_tp1 = float(np.clip(tp1_base + 5.0, 20.0, 58.0))
    max_sl = float(np.clip(sl_base + 9.0, 22.0, 48.0))
    min_ev = 0.18
    min_edge = 6.0
    max_disagreement = 18.0

    for c in scored:
        reasons = []
        if status != "TRUSTED": reasons.append("MODEL_NOT_TRUSTED")
        if c["score"] < min_plan_score: reasons.append("LOW_PLAN_SCORE")
        if c["evR"] < min_ev: reasons.append("LOW_EXPECTED_VALUE")
        if c["pTp1"] < min_tp1: reasons.append("LOW_TP1_PROBABILITY")
        if c["pSl"] > max_sl: reasons.append("SL_PROBABILITY_HIGH")
        if c["pTp1"] - c["pSl"] < min_edge: reasons.append("WEAK_TP1_SL_EDGE")
        if c["modelDisagreementPts"] > max_disagreement: reasons.append("MODEL_DISAGREEMENT")
        passed = len(reasons) == 0
        if passed and c["score"] >= 75 and c["evR"] >= 0.35 and c["pTp1"] - c["pSl"] >= 12:
            grade = "A+"
        elif passed and c["score"] >= 67:
            grade = "A"
        elif passed:
            grade = "B"
        else:
            grade = "REJECT"
        c["qualityGate"] = {
            "passed": passed,
            "grade": grade,
            "reasons": reasons,
            "thresholds": {
                "minPlanScore": round(min_plan_score, 1),
                "minTp1Probability": round(min_tp1, 1),
                "maxSlProbability": round(max_sl, 1),
                "minExpectedValueR": min_ev,
                "minTp1SlEdgePts": min_edge,
                "maxDisagreementPts": max_disagreement,
            },
        }

    scored.sort(key=lambda x: (bool(x["qualityGate"]["passed"]), x["score"], x["evR"], x["pTp1"]), reverse=True)
    for rank, c in enumerate(scored, 1):
        c["rank"] = rank
        c["trusted"] = bool(status == "TRUSTED")
        c["planState"] = ("QUALIFIED " + c["qualityGate"]["grade"]) if c["qualityGate"]["passed"] else "REJECTED"
        c["reason"] = f"P(TP1) {c['pTp1']:.1f}% · P(fill) {c['pFill']:.1f}% · SL {c['pSl']:.1f}% · EV {c['evR']:+.2f}R"

    qualified = [c for c in scored if c["qualityGate"]["passed"]]
    reference = scored[0] if scored else None

    latest_ts = int(anchor.iloc[-1]["ts"])
    coverage_days = round((int(anchor.iloc[-1]["ts"]) - int(anchor.iloc[0]["ts"])) / 86400000, 1)
    training_counts = {
        "anchors": int(anchor.shape[0]),
        "candidateSamples": int(len(ds)),
        "filledSamples": int(filled_mask.sum()),
        "coverageDays": coverage_days,
        "M1": counts["M1"], "M5": counts["M5"], "M15": counts["M15"], "H1": counts["H1"],
    }

    pack_out = {
        "version": VERSION,
        "generatedAt": utc_now(),
        "ready": True,
        "status": status,
        "engine": "AUTO ML TOURNAMENT / XGB+HGB+TREES / AUTO CALIBRATION / WALK_FORWARD",
        "sourceFingerprint": source_fp,
        "sourceGeneratedAt": pack.get("generatedAt"),
        "training": training_counts,
        "validation": {
            "folds": int(tp1_head.metrics.get("folds", 0)),
            "fill": fill_head.metrics,
            "tp1": tp1_head.metrics,
            "tp2": tp2_head.metrics if tp2_head else None,
            "sl": sl_head.metrics,
            "purgeBars": PURGE_BARS,
            "chronological": True,
            "randomSplit": False,
        },
        "modelHealth": {
            "score": round(health, 1),
            "status": status,
            "driftPts": round(drift, 1),
            "uncertaintyPts": round(disagreement_pts, 1),
            "governanceAction": gov["action"],
        },
        "governance": gov,
        "features": {
            "count": len(feature_cols),
            "top": feature_importance(tp1_head, feature_cols, 14),
        },
        "autoML": {
            "xgboostAvailable": HAS_XGBOOST,
            "heads": {
                "fill": {"selection": fill_head.selection, "calibration": fill_head.calibration, "modelMetrics": fill_head.model_metrics},
                "tp1": {"selection": tp1_head.selection, "calibration": tp1_head.calibration, "modelMetrics": tp1_head.model_metrics},
                "tp2": ({"selection": tp2_head.selection, "calibration": tp2_head.calibration, "modelMetrics": tp2_head.model_metrics} if tp2_head else None),
                "sl": {"selection": sl_head.selection, "calibration": sl_head.calibration, "modelMetrics": sl_head.model_metrics},
            },
            "selectionRule": "Leakage-safe chronological OOF tournament; models and calibration are selected by Brier/ECE/AUC quality.",
        },
        "current": {
            "marketTs": latest_ts,
            "candidates": scored,
            "primary": qualified[0] if qualified else None,
            "backup": qualified[1] if len(qualified) > 1 else None,
            "reference": reference,
            "qualifiedCount": len(qualified),
        },
        "policy": {
            "mlCanOverrideTechnical": bool(status == "TRUSTED" and health >= 60 and drift <= 32),
            "minimumPlanScore": round(min_plan_score, 1),
            "minimumTp1Probability": round(min_tp1, 1),
            "maximumSlProbability": round(max_sl, 1),
            "minimumExpectedValueR": min_ev,
            "minimumTp1SlEdgePts": min_edge,
            "maximumDisagreementPts": max_disagreement,
            "hardCandidateGate": True,
            "note": "A trusted model can still reject every candidate. Only qualified pending plans may become actionable; live/news/risk/gap revalidation still applies.",
        },
    }

    write_json(CANDIDATE_PATH, pack_out)
    write_json(OUT_PATH, pack_out)
    write_json(GOV_PATH, gov)
    print("ML brain ready", {
        "status": status,
        "health": round(health, 1),
        "samples": len(ds),
        "filled": int(filled_mask.sum()),
        "brier": primary_metrics.get("brier"),
        "auc": primary_metrics.get("auc"),
        "ece": primary_metrics.get("ece"),
        "drift": round(drift, 1),
        "primary": qualified[0]["type"] if qualified else None,
        "reference": reference["type"] if reference else None,
        "qualified": len(qualified),
    })


if __name__ == "__main__":
    main()
