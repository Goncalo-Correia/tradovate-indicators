// ============================================================================
// MMC Market Magnet (PSR) — Tradovate custom indicator
// ----------------------------------------------------------------------------
// A port of the Million-Dollar-Margin Club "Market Magnet / Market Magnet PSR"
// ThinkorSwim indicator. Despite the "magnetic force" marketing, it is a
// SESSION VOLUME PROFILE. Their own formulas confirm the mapping:
//
//   * Magnet (solid magenta line) = Point of Control (POC), the price level
//     with the most traded volume in the session:            argmax(Vi)
//   * 50% Volume Zone = a value area holding 50% of the session's volume:
//                                                             V50% = 0.50 * Vtotal
//   * High Band (green dashed) = Value Area High (VAH) = top of the 50% zone.
//   * Low  Band (red   dashed) = Value Area Low  (VAL) = bottom of the 50% zone.
//   * "Peak Zone"  (top half, green)  = magnet .. VAH.
//   * "Trough Zone"(bottom half, red) = VAL .. magnet.
//
// The profile is accumulated across the NY regular session (09:30-16:00 ET)
// and re-anchored each session, so the three levels update in real time as the
// day's volume distribution evolves. Outside the session the plots return
// nothing (the lines break), matching nySessionAtrLevels.js.
//
// Data source: d.profile() gives per-bar volume-by-price levels
// ({price, vol, bidVol, askVol}); available when the chart is requested with a
// volume profile (withHistogram). If the profile is absent on a bar, we fall
// back to a single level at the bar's typical price with d.volume() — coarser,
// but the indicator still works.
//
// Depends only on ./tools/predef, ./tools/meta and ./tools/graphics — all
// provided by Tradovate. Timezone handled without Intl (see easternParts).
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ============================== CONFIG ======================================
const SESSION_OPEN_MIN = 9 * 60 + 30; // 09:30 ET (NY regular session open)
const SESSION_CLOSE_MIN = 16 * 60;    // 16:00 ET (NY regular session close)
const SHOW_LABELS = true;             // draw "MAGNET / VAH / VAL" labels at last bar

const MAGENTA = "#e83fd8";
const GREEN = "#22c55e";
const RED = "#ef4444";
// ============================================================================

// -------- US Eastern time (DST-aware, no Intl dependency) -------------------
function nthSundayOfMonth(year, monthIndex, n) {
    const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDow) % 7);
    return firstSunday + (n - 1) * 7;
}

function easternOffsetHours(date) {
    const y = date.getUTCFullYear();
    const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);  // 2nd Sun Mar 02:00 EST
    const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);  // 1st Sun Nov 02:00 EDT
    const t = date.getTime();
    return (t >= dstStart && t < dstEnd) ? -4 : -5; // EDT vs EST
}

function easternParts(date) {
    const shifted = new Date(date.getTime() + easternOffsetHours(date) * 3600000);
    return {
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        dayKey: shifted.getUTCFullYear() * 10000 +
                (shifted.getUTCMonth() + 1) * 100 +
                shifted.getUTCDate()
    };
}

class MmcMarketMagnet {
    init() {
        this.tickSize = (this.contractInfo && this.contractInfo.tickSize) || 0.01;
        this.resetProfile();
        this.sessionDayKey = undefined;
    }

    resetProfile() {
        // priceKey (integer number of ticks) -> { price, vol }
        this.levels = new Map();
    }

    addLevel(price, vol) {
        if (!(vol > 0)) {
            return;
        }
        const key = Math.round(price / this.tickSize);
        const existing = this.levels.get(key);
        if (existing) {
            existing.vol += vol;
        } else {
            this.levels.set(key, { price, vol });
        }
    }

    accumulate(d) {
        const profile = d.profile();
        if (profile && profile.length) {
            for (let i = 0; i < profile.length; ++i) {
                this.addLevel(profile[i].price, profile[i].vol);
            }
        } else {
            // Fallback: no volume profile on this bar — approximate with typical price.
            const typical = (d.high() + d.low() + d.close()) / 3;
            this.addLevel(typical, d.volume());
        }
    }

    // Standard volume-profile value area: expand out from the POC, adding the
    // larger neighbour each step, until `pct` of total volume is covered.
    valueArea(pct) {
        const sorted = Array.from(this.levels.values()).sort((a, b) => a.price - b.price);
        const n = sorted.length;
        if (n === 0) {
            return undefined;
        }

        let total = 0;
        let pocIndex = 0;
        for (let i = 0; i < n; ++i) {
            total += sorted[i].vol;
            if (sorted[i].vol > sorted[pocIndex].vol) {
                pocIndex = i;
            }
        }

        const target = total * pct;
        let accum = sorted[pocIndex].vol;
        let lo = pocIndex;
        let hi = pocIndex;
        while (accum < target && (lo > 0 || hi < n - 1)) {
            const volAbove = hi < n - 1 ? sorted[hi + 1].vol : -1;
            const volBelow = lo > 0 ? sorted[lo - 1].vol : -1;
            if (volAbove >= volBelow) {
                accum += volAbove;
                hi++;
            } else {
                accum += volBelow;
                lo--;
            }
        }

        return {
            magnet: sorted[pocIndex].price, // POC
            vah: sorted[hi].price,          // High Band
            val: sorted[lo].price           // Low Band
        };
    }

    map(d, index) {
        const et = easternParts(d.timestamp());
        const inSession =
            et.minutes >= SESSION_OPEN_MIN && et.minutes < SESSION_CLOSE_MIN;

        // New NY session -> start a fresh profile.
        if (inSession && et.dayKey !== this.sessionDayKey) {
            this.sessionDayKey = et.dayKey;
            this.resetProfile();
        }

        if (!inSession) {
            return {};
        }

        this.accumulate(d);

        const va = this.valueArea(this.props.valueAreaPct / 100);
        if (!va) {
            return {};
        }

        const result = {
            magnet: va.magnet,
            vah: va.vah,
            val: va.val
        };

        if (SHOW_LABELS && d.isLast()) {
            result.graphics = { items: this.labels(d, va) };
        }

        return result;
    }

    labels(d, va) {
        const mk = (key, price, text, color) => ({
            tag: "Text",
            key,
            point: { x: op(du(d.index()), "+", px(6)), y: du(price) },
            text,
            style: { fontSize: 11, fontWeight: "bold", fill: color },
            textAlignment: "leftMiddle"
        });
        return [
            mk("mag", va.magnet, "MAGNET (POC)", MAGENTA),
            mk("vah", va.vah, `VAH ${this.props.valueAreaPct}%`, GREEN),
            mk("val", va.val, `VAL ${this.props.valueAreaPct}%`, RED)
        ];
    }
}

module.exports = {
    name: "mmcMarketMagnet",
    description: "MMC Market Magnet (PSR)",
    calculator: MmcMarketMagnet,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    params: {
        valueAreaPct: predef.paramSpecs.percent(50, 1, 1, 100)
    },
    plots: {
        magnet: { title: "Magnet (POC)" },
        vah: { title: "High Band (VAH)" },
        val: { title: "Low Band (VAL)" }
    },
    tags: [predef.tags.Volumes, "MMC"],
    schemeStyles: {
        dark: {
            magnet: predef.styles.plot({ color: MAGENTA, lineWidth: 2 }),
            vah: predef.styles.plot({ color: GREEN, lineWidth: 1, lineStyle: 3 }),
            val: predef.styles.plot({ color: RED, lineWidth: 1, lineStyle: 3 })
        },
        light: {
            magnet: predef.styles.plot({ color: "#c026d3", lineWidth: 2 }),
            vah: predef.styles.plot({ color: "#16a34a", lineWidth: 1, lineStyle: 3 }),
            val: predef.styles.plot({ color: "#dc2626", lineWidth: 1, lineStyle: 3 })
        }
    }
};
