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
// A profile is built inside each of three ET windows (see WINDOWS in CONFIG):
//   * Asia   — first 2 hours of the Asia session   18:00-20:00 ET
//   * London — first 2 hours of the London session 03:00-05:00 ET
//   * NY     — the whole NY regular session         09:30-16:00 ET
// Each window starts a FRESH profile, so the three levels update in real time
// as that window's volume distribution evolves. Outside the windows the plots
// return nothing (the lines break). Asia/London need an ETH chart — on an
// RTH-only session template those bars do not exist.
//
// Rendering (all toggleable in CONFIG):
//   * magnet / VAH / VAL as plotted lines (magenta solid, green/red dashed);
//   * a row of green down-arrows on the VAH and red up-arrows on the VAL, one
//     per bar, so the Peak/Trough zones read as arrow rows across the session;
//   * the volume profile itself as full-width, translucent light-blue horizontal
//     bars whose thickness/opacity scale with volume (drawn on the last bar);
//   * MAGNET / VAH / VAL text labels at the last bar.
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
// Profile windows in ET minutes-of-day. Each window gets its own profile,
// reset at the window's start. `end` must be later than `start` (a window may
// not cross midnight). Session starts match sessionRangeLevels.js /
// sessionCountdown.js (Asia 18:00, London 03:00, NY 09:30 ET).
const WINDOWS = [
    { id: "asia",   label: "ASIA",   start: 18 * 60,      end: 20 * 60 }, // Asia, first 2h
    { id: "london", label: "LONDON", start: 3 * 60,       end: 5 * 60 },  // London, first 2h
    { id: "ny",     label: "NY",     start: 9 * 60 + 30,  end: 16 * 60 }  // NY, whole session
];
const SHOW_LABELS = true;             // draw "MAGNET / VAH / VAL" labels at last bar

// Arrow rows: a green down-arrow on the VAH ("Peak Zone") and a red up-arrow on
// the VAL ("Trough Zone") at every Nth in-session bar, tracing the two bands.
const SHOW_ARROWS = true;
const ARROW_EVERY = 1;                // draw an arrow every N bars (1 = every bar)

// Volume-bar fills: the session volume profile drawn as full-width, translucent
// light-blue horizontal bars whose thickness/opacity scale with volume.
const SHOW_PROFILE = true;
const PROFILE_COLOR = "#38bdf8";      // light blue
const PROFILE_MIN_FRAC = 0.2;         // skip levels below this fraction of POC volume
const PROFILE_MAX_WIDTH_PX = 12;      // bar thickness (px) at the POC

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

// The profile window containing ET minute-of-day `minutes`, or undefined.
function windowAt(minutes) {
    for (let i = 0; i < WINDOWS.length; ++i) {
        if (minutes >= WINDOWS[i].start && minutes < WINDOWS[i].end) {
            return WINDOWS[i];
        }
    }
    return undefined;
}

class MarketMagnet {
    init() {
        this.tickSize = (this.contractInfo && this.contractInfo.tickSize) || 0.01;
        this.resetProfile();
        this.windowKey = undefined; // "<window id>:<ET dayKey>" of the active profile
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
        const win = windowAt(et.minutes);

        if (!win) {
            // Clear rather than omit, so an out-of-window bar cannot hold on to
            // graphics it rendered while it was still the last bar.
            return { graphics: false };
        }

        // First bar of a new window (or of the same window on a new day) ->
        // start a fresh profile.
        const windowKey = win.id + ":" + et.dayKey;
        if (windowKey !== this.windowKey) {
            this.windowKey = windowKey;
            this.resetProfile();
        }

        this.accumulate(d);

        const va = this.valueArea(this.props.valueAreaPct / 100);
        if (!va) {
            return { graphics: false };
        }

        const result = {
            magnet: va.magnet,
            vah: va.vah,
            val: va.val
        };

        const items = [];

        // Arrow rows: one green ▼ on the VAH and one red ▲ on the VAL per bar,
        // so the "Peak" and "Trough" zones read as a row of arrows across the day.
        if (SHOW_ARROWS && (index % ARROW_EVERY === 0)) {
            items.push(this.arrow("vahArrow", d.index(), va.vah, "down", GREEN));
            items.push(this.arrow("valArrow", d.index(), va.val, "up", RED));
        }

        // Drawn once, on the most recent bar:
        if (d.isLast()) {
            if (SHOW_PROFILE) {
                this.profileBars().forEach((b) => items.push(b));
            }
            if (SHOW_LABELS) {
                this.labels(d, va, win).forEach((l) => items.push(l));
            }
        }

        // Assign `graphics` on every bar. Omitting the key leaves a bar holding
        // whatever it last rendered, so the isLast()-only labels and profile bars
        // pile up across the chart as new bars form. `false` means "nothing here".
        result.graphics = items.length ? { items } : false;

        return result;
    }

    // A small filled triangle centred on `price` at bar `index`.
    // dir "down" = green ▼ sitting on the VAH; "up" = red ▲ on the VAL.
    arrow(key, index, price, dir, color) {
        const half = 3;   // half-width of the arrow (px)
        const base = 7;   // distance of the flat side from the line (px)
        const tip = 1;    // distance of the tip from the line (px)
        // In grid space, subtracting px moves UP, adding px moves DOWN.
        const y = (d) => op(du(price), d < 0 ? "-" : "+", px(Math.abs(d)));
        const points = dir === "down"
            ? [
                { x: op(du(index), "-", px(half)), y: y(-base) },
                { x: op(du(index), "+", px(half)), y: y(-base) },
                { x: du(index), y: y(-tip) }
            ]
            : [
                { x: op(du(index), "-", px(half)), y: y(base) },
                { x: op(du(index), "+", px(half)), y: y(base) },
                { x: du(index), y: y(tip) }
            ];
        return {
            tag: "Shapes",
            key,
            primitives: [{ tag: "Polygon", points }],
            fillStyle: { color, opacity: 0.9 }
        };
    }

    // The session volume profile as full-width, translucent light-blue bars.
    // Thickness and opacity scale with each level's volume relative to the POC.
    profileBars() {
        const bars = [];
        const vals = Array.from(this.levels.values());
        if (!vals.length) {
            return bars;
        }
        let maxVol = 0;
        for (let i = 0; i < vals.length; ++i) {
            if (vals[i].vol > maxVol) {
                maxVol = vals[i].vol;
            }
        }
        if (maxVol <= 0) {
            return bars;
        }
        let k = 0;
        for (let i = 0; i < vals.length; ++i) {
            const frac = vals[i].vol / maxVol;
            if (frac < PROFILE_MIN_FRAC) {
                continue;
            }
            const width = Math.max(1, Math.round(frac * PROFILE_MAX_WIDTH_PX));
            const opacity = Math.min(0.6, 0.12 + frac * 0.5);
            bars.push({
                tag: "LineSegments",
                key: "vp" + (k++),
                lines: [{
                    tag: "Line",
                    a: { x: du(0), y: du(vals[i].price) },
                    b: { x: du(1), y: du(vals[i].price) },
                    infiniteStart: true,
                    infiniteEnd: true
                }],
                lineStyle: { lineWidth: width, color: PROFILE_COLOR, opacity }
            });
        }
        return bars;
    }

    // Labels are prefixed with the active window ("NY MAGNET (POC)", ...).
    labels(d, va, win) {
        const mk = (key, price, text, color) => ({
            tag: "Text",
            key,
            point: { x: op(du(d.index()), "+", px(6)), y: du(price) },
            text,
            style: { fontSize: 11, fontWeight: "bold", fill: color },
            textAlignment: "rightMiddle",
            // Single-render: drawn once for the series, not once per bar.
            global: true
        });
        return [
            mk("mag", va.magnet, `${win.label} MAGNET (POC)`, MAGENTA),
            mk("vah", va.vah, `${win.label} VAH ${this.props.valueAreaPct}%`, GREEN)
        ];
    }
}

module.exports = {
    name: "marketMagnet",
    description: "MMC Market Magnet (PSR)",
    calculator: MarketMagnet,
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
    tags: ["Custom Indicators"],
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
