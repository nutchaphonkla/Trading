(() => {
  'use strict';

  const VERSION = 'KAGE_SIGNAL_ENGINE_V48';

  // =========================================================
  // HELPERS
  // =========================================================

  function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function clamp(v, min, max) {
    return Math.min(
      max,
      Math.max(min, v)
    );
  }

  function confidenceLevel(v) {
    const n = Number(v) || 0;

    if (n >= 90) return 'VERY HIGH';
    if (n >= 80) return 'HIGH';
    if (n >= 65) return 'MEDIUM';
    if (n >= 50) return 'LOW';

    return 'VERY LOW';
  }

  function stageFromState(state) {
    const s = String(
      state || ''
    )
      .trim()
      .toUpperCase();

    if (s === 'ENTRY READY') {
      return 'ENTRY_READY';
    }

    if (s === 'APPROACHING') {
      return 'APPROACHING';
    }

    if (s === 'EARLY WATCH') {
      return 'EARLY_WATCH';
    }

    if (s === 'IN ZONE') {
      return 'IN_ZONE';
    }

    if (s === 'NEWS HOLD') {
      return 'NEWS_HOLD';
    }

    if (s === 'LATE DETECTED') {
      return 'CHASE_BLOCK';
    }

    if (s === 'REFERENCE ONLY') {
      return 'REFERENCE_ONLY';
    }

    if (s === 'WAIT') {
      return 'WAIT';
    }

    return (
      s.replace(
        /\s+/g,
        '_'
      ) || 'WAIT'
    );
  }

  // =========================================================
  // PLAN ID
  // =========================================================

  function planIdFor(p) {
    const sig = [
      String(
        p?.type ||
        p?.side ||
        'PLAN'
      ),

      Number(
        p?.entry || 0
      ).toFixed(2),

      Number(
        p?.sl || 0
      ).toFixed(2),

      Number(
        p?.tp1 || 0
      ).toFixed(2)
    ].join('|');

    let hash =
      2166136261;

    for (
      const ch
      of sig
    ) {
      hash ^=
        ch.charCodeAt(0);

      hash =
        Math.imul(
          hash,
          16777619
        );
    }

    return (
      `XAUUSD-${(hash >>> 0).toString(16)}`
    );
  }

  // =========================================================
  // READ PLAN GEOMETRY
  // รองรับชื่อ field หลายแบบจาก KAGE
  // =========================================================

  function extractGeometry(p) {

    const entry =
      num(
        p?.entry ??
        p?.pendingPrice ??
        p?.price ??
        p?.entryPrice
      );

    const zoneLow =
      num(
        p?.entryLow ??
        p?.zoneLow ??
        p?.entryZoneLow ??
        p?.idealEntryLow ??
        entry
      );

    const zoneHigh =
      num(
        p?.entryHigh ??
        p?.zoneHigh ??
        p?.entryZoneHigh ??
        p?.idealEntryHigh ??
        entry
      );

    const sl =
      num(
        p?.sl ??
        p?.stopLoss ??
        p?.stop
      );

    const tp1 =
      num(
        p?.tp1 ??
        p?.takeProfit1 ??
        p?.target1
      );

    const tp2 =
      num(
        p?.tp2 ??
        p?.takeProfit2 ??
        p?.target2
      );

    return {
      entry,
      zoneLow,
      zoneHigh,
      sl,
      tp1,
      tp2
    };
  }

  // =========================================================
  // HAS REAL SIGNAL
  //
  // สำคัญ:
  // ไม่บังคับ qualifiedPlan === true แล้ว
  // ถ้าหน้าแอปมี Entry + SL + TP1 จริง
  // ถือว่าเป็น Final Plan ที่สามารถ mirror ได้
  // =========================================================

  function hasUsableSignal(
    p
  ) {
    if (!p) {
      return false;
    }

    const g =
      extractGeometry(p);

    return (
      Number.isFinite(
        g.entry
      ) &&

      Number.isFinite(
        g.sl
      ) &&

      Number.isFinite(
        g.tp1
      )
    );
  }

  // =========================================================
  // FROM APP DECISION
  //
  // นี่คือหัวใจ:
  // เอา object ที่หน้า KAGE ใช้แสดง
  // แปลงเป็น Final Decision กลาง
  // =========================================================

  function fromAppDecision(
    p,
    pp,
    ctx = {}
  ) {

    if (
      !hasUsableSignal(p)
    ) {
      return null;
    }

    const geometry =
      extractGeometry(p);

    const rawState =
      pp?.state ??
      p?.state ??
      p?.status ??
      'WAIT';

    const stage =
      stageFromState(
        rawState
      );

    const type =
      String(
        p?.type ??
        p?.side ??
        p?.orderType ??
        'PLAN'
      )
        .replace(
          /_/g,
          ' '
        )
        .toUpperCase();

    const confidence =
      clamp(
        num(
          ctx?.confidence ??
          p?.confidence ??
          p?.ml?.confidence ??
          p?.ml?.pCleanWin ??
          p?.score ??
          0
        ) ?? 0,
        0,
        100
      );

    const quality =
      clamp(
        num(
          ctx?.quality ??
          p?.quality ??
          p?.score ??
          0
        ) ?? 0,
        0,
        100
      );

    const currentPrice =
      num(
        ctx?.currentPrice ??
        p?.currentPrice ??
        p?.priceNow
      );

    const distance =
      num(
        pp?.lead?.distance ??
        pp?.distance ??
        p?.distance
      );

    const approachDistance =
      num(
        pp?.lead?.approachDistance ??
        pp?.approachDistance ??
        p?.approachDistance
      );

    const reason =
      String(
        pp?.note ??
        pp?.executionNote ??
        p?.reason ??
        p?.note ??
        ''
      );

    return {
      engineVersion:
        VERSION,

      planId:
        planIdFor(p),

      symbol:
        String(
          p?.symbol ||
          'XAUUSD'
        ).toUpperCase(),

      side:
        type,

      type,

      stage,

      entry:
        geometry.entry,

      zoneLow:
        geometry.zoneLow,

      zoneHigh:
        geometry.zoneHigh,

      sl:
        geometry.sl,

      tp1:
        geometry.tp1,

      tp2:
        geometry.tp2,

      confidence,

      confidenceLevel:
        confidenceLevel(
          confidence
        ),

      quality,

      currentPrice,

      distance,

      approachDistance,

      canPlace:
        pp?.canPlace === true ||
        p?.canPlace === true,

      marketOpen:
        ctx?.marketOpen !== false,

      newsLock:
        ctx?.newsLock === true ||
        p?.newsLock === true,

      reason,

      updatedAt:
        Date.now(),

      expiresAt:
        Date.now() +
        3 * 60 * 60 * 1000
    };
  }

  // =========================================================
  // COMPARE DECISION
  //
  // ใช้กัน Telegram เด้งทุก tick
  // =========================================================

  function changed(
    prev,
    next
  ) {

    if (!next) {
      return {
        changed: false,
        kind: 'NO_SIGNAL'
      };
    }

    if (!prev) {
      return {
        changed: true,
        kind: 'NEW'
      };
    }

    if (
      prev.planId !==
      next.planId
    ) {
      return {
        changed: true,
        kind: 'NEW_PLAN'
      };
    }

    if (
      prev.stage !==
      next.stage
    ) {
      return {
        changed: true,
        kind: 'STAGE'
      };
    }

    const geometryFields = [
      'entry',
      'zoneLow',
      'zoneHigh',
      'sl',
      'tp1',
      'tp2'
    ];

    for (
      const field
      of geometryFields
    ) {

      const a =
        Number(
          prev[field]
        );

      const b =
        Number(
          next[field]
        );

      if (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        Math.abs(a - b) >= 0.05
      ) {
        return {
          changed: true,
          kind: 'PLAN_UPDATED',
          field
        };
      }
    }

    const prevConfidence =
      Number(
        prev.confidence
      ) || 0;

    const nextConfidence =
      Number(
        next.confidence
      ) || 0;

    if (
      Math.abs(
        prevConfidence -
        nextConfidence
      ) >= 5
    ) {
      return {
        changed: true,
        kind:
          'CONFIDENCE_UPDATED'
      };
    }

    const prevQuality =
      Number(
        prev.quality
      ) || 0;

    const nextQuality =
      Number(
        next.quality
      ) || 0;

    if (
      Math.abs(
        prevQuality -
        nextQuality
      ) >= 5
    ) {
      return {
        changed: true,
        kind:
          'QUALITY_UPDATED'
      };
    }

    // News lock เปลี่ยน
    if (
      Boolean(
        prev.newsLock
      ) !==
      Boolean(
        next.newsLock
      )
    ) {
      return {
        changed: true,
        kind:
          next.newsLock
            ? 'NEWS_HOLD'
            : 'NEWS_RELEASED'
      };
    }

    // canPlace เปลี่ยน
    if (
      Boolean(
        prev.canPlace
      ) !==
      Boolean(
        next.canPlace
      )
    ) {
      return {
        changed: true,
        kind:
          next.canPlace
            ? 'ENTRY_READY'
            : 'ENTRY_BLOCKED'
      };
    }

    return {
      changed: false,
      kind: 'NOISE'
    };
  }

  // =========================================================
  // DEBUG
  // =========================================================

  function debugDecision(
    p,
    pp,
    ctx
  ) {

    const usable =
      hasUsableSignal(p);

    const decision =
      usable
        ? fromAppDecision(
            p,
            pp,
            ctx
          )
        : null;

    return {
      version:
        VERSION,

      usable,

      rawPlan:
        p || null,

      pendingState:
        pp || null,

      context:
        ctx || null,

      decision
    };
  }

  // =========================================================
  // EXPORT
  // =========================================================

  window.KageSignalEngine = {
    VERSION,

    num,
    clamp,

    confidenceLevel,
    stageFromState,

    extractGeometry,
    hasUsableSignal,

    fromAppDecision,

    changed,

    debugDecision
  };

})();
