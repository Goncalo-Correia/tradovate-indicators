// ============================================================================
// Session Range Levels — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Draws eight horizontal levels marking the high and low of each major trading
// session, each with a short text label at the right edge so the lines can be
// told apart at a glance:
//
//   ASH / ASL  Asia session high / low          18:00 -> 03:00 ET
//   LOH / LOL  London session high / low        03:00 -> 09:30 ET
//   PMH / PML  Pre-market high / low            04:00 -> 09:30 ET
//   PDH / PDL  PREVIOUS US session high / low   09:30 -> 16:00 ET (prior day)
//
// Pre-market deliberately overlaps London: they are two independently tracked
// ranges, not a partition of the night.
//
// Each level updates live while its window is open and freezes when the window
// closes, so during the US session all eight lines are flat. A line is drawn
// from the bar where its level first existed up to the current bar, so the left
// end of each line marks when that session began.
//
// The "trading day" rolls at 18:00 ET (the futures open), not at midnight, so
// Asia -> London -> pre-market -> US all fall inside one trading day in that
// order. When the day rolls, the US session that just closed becomes PDH/PDL.
//
// LIMITATIONS
//   * The chart must include ELECTRONIC trading hours. On an RTH-only session
//     template the overnight bars do not exist and the Asia / London /
//     pre-market lines will never appear.
//   * On bars longer than MAX_BAR_MINUTES a single bar straddles several
//     session windows and the levels would be meaningless, so the indicator
//     draws nothing. Use 1h bars or faster.
//   * PDH/PDL are undefined until one full US session has been seen; on the
//     first trading day of the loaded history they may reflect a US session
//     truncated by where the chart data begins.
//
// Depends only on ./tools/predef, ./tools/meta and ./tools/graphics — all
// provided by Tradovate. Timezone handled without Intl (see easternParts).
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ============================== CONFIG ======================================
// Session windows, in ET minutes from midnight. A window whose start is later
// than its end (Asia) is understood to span midnight.
const SESSIONS = [
    {
        id: "asia",
        title: "Asia",
        start: 18 * 60,          // 18:00 ET
        end: 3 * 60,             // 03:00 ET (next calendar day)
        hiLabel: "ASH",
        loLabel: "ASL",
        color: "#a855f7",        // purple
        lightColor: "#7e22ce",
        param: "showAsia",
        column: 3
    },
    {
        id: "london",
        title: "London",
        start: 3 * 60,           // 03:00 ET
        end: 9 * 60 + 30,        // 09:30 ET
        hiLabel: "LOH",
        loLabel: "LOL",
        color: "#3b82f6",        // blue
        lightColor: "#1d4ed8",
        param: "showLondon",
        column: 2
    },
    {
        id: "premkt",
        title: "Pre-market",
        start: 4 * 60,           // 04:00 ET
        end: 9 * 60 + 30,        // 09:30 ET
        hiLabel: "PMH",
        loLabel: "PML",
        color: "#f59e0b",        // orange
        lightColor: "#b45309",
        param: "showPremarket",
        column: 1
    },
    {
        id: "us",
        title: "Prev US Session",
        start: 9 * 60 + 30,      // 09:30 ET
        end: 16 * 60,            // 16:00 ET
        hiLabel: "PDH",
        loLabel: "PDL",
        color: "#9ca3af",        // grey
        lightColor: "#4b5563",
        param: "showPrevUs",
        column: 0,
        previous: true           // display the PRIOR day's range, not today's
    }
];

const TRADE_DAY_ROLL_MIN = 18 * 60;   // ET minute at which a new trading day starts
const RTH_OPEN_MIN = 9 * 60 + 30;     // used only by DRAW_ONLY_IN_RTH
const RTH_CLOSE_MIN = 16 * 60;

const DRAW_ONLY_IN_RTH = false;       // true: hide every line outside 09:30-16:00 ET
const MAX_BAR_MINUTES = 60;           // draw nothing on bars longer than this

const SHOW_LABELS = true;
const LABEL_SHOW_PRICE = false;       // "PMH" vs "PMH 5812.25"
const LABEL_FONT_SIZE = 10;
const LABEL_OFFSET_PX = 6;            // gap between the last bar and the first label
const LABEL_COLUMN_PX = 30;           // horizontal stagger between session columns
const LABEL_STAGGER = true;           // see note below

// Labels are staggered into one horizontal column per session rather than being
// nudged vertically: the pre-market window sits inside London's, so PMH and LOH
// are often at the same price, and there is no way to convert a price gap into a
// pixel gap without knowing the chart's zoom. Columns are scale-free and
// deterministic. Set LABEL_STAGGER = false to stack them all at one x.

const LINE_WIDTH = 1;
const DASHED = 3;                     // lineStyle index for a dashed plot
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

function dateKey(d) {
    return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function easternParts(date) {
    const shifted = new Date(date.getTime() + easternOffsetHours(date) * 3600000);
    // Shift forward so that TRADE_DAY_ROLL_MIN lands on midnight; the resulting
    // calendar date is then the trading-day key.
    const rolled = new Date(shifted.getTime() + (24 * 60 - TRADE_DAY_ROLL_MIN) * 60000);
    return {
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        dayKey: dateKey(shifted),
        tradeDayKey: dateKey(rolled)
    };
}

// A window whose start > end spans midnight.
function inWindow(minutes, startMin, endMin) {
    return startMin <= endMin
        ? (minutes >= startMin && minutes < endMin)
        : (minutes >= startMin || minutes < endMin);
}

function emptyRange() {
    return { hi: undefined, lo: undefined };
}

// -------- Plots, styles and params, all derived from SESSIONS ---------------
const plots = {};
const schemeStyles = { dark: {}, light: {} };
const params = {};

SESSIONS.forEach(function (s) {
    const hi = s.id + "High";
    const lo = s.id + "Low";

    plots[hi] = { title: s.title + " High" };
    plots[lo] = { title: s.title + " Low" };

    // Session identity reads as colour; high vs low reads as solid vs dashed.
    schemeStyles.dark[hi] = predef.styles.plot({ color: s.color, lineWidth: LINE_WIDTH });
    schemeStyles.dark[lo] = predef.styles.plot({ color: s.color, lineWidth: LINE_WIDTH, lineStyle: DASHED });
    schemeStyles.light[hi] = predef.styles.plot({ color: s.lightColor, lineWidth: LINE_WIDTH });
    schemeStyles.light[lo] = predef.styles.plot({ color: s.lightColor, lineWidth: LINE_WIDTH, lineStyle: DASHED });

    params[s.param] = predef.paramSpecs.bool(true);
});

class SessionRangeLevels {
    init() {
        this.ranges = {};
        SESSIONS.forEach((s) => { this.ranges[s.id] = emptyRange(); });
        this.prevUs = undefined;
        this.tradeDayKey = undefined;
        this.prevTs = undefined;
        this.barMinutes = undefined;
    }

    // Smallest gap between consecutive bars = the chart's bar size. Taking the
    // minimum rather than the latest gap keeps weekend/holiday gaps from
    // inflating the estimate.
    trackBarSize(d) {
        const t = d.timestamp().getTime();
        if (this.prevTs !== undefined) {
            const gap = (t - this.prevTs) / 60000;
            if (gap > 0 && (this.barMinutes === undefined || gap < this.barMinutes)) {
                this.barMinutes = gap;
            }
        }
        this.prevTs = t;
    }

    rollTradingDay() {
        const us = this.ranges.us;
        if (us.hi !== undefined) {
            this.prevUs = { hi: us.hi, lo: us.lo };
        }
        SESSIONS.forEach((s) => { this.ranges[s.id] = emptyRange(); });
    }

    accumulate(d, minutes) {
        const high = d.high();
        const low = d.low();
        for (let i = 0; i < SESSIONS.length; ++i) {
            const s = SESSIONS[i];
            if (!inWindow(minutes, s.start, s.end)) {
                continue;
            }
            const r = this.ranges[s.id];
            if (r.hi === undefined || high > r.hi) {
                r.hi = high;
            }
            if (r.lo === undefined || low < r.lo) {
                r.lo = low;
            }
        }
    }

    map(d) {
        this.trackBarSize(d);

        // Too coarse for session windows to mean anything — draw nothing.
        if (this.barMinutes !== undefined && this.barMinutes > MAX_BAR_MINUTES) {
            return {};
        }

        const et = easternParts(d.timestamp());

        if (this.tradeDayKey === undefined) {
            this.tradeDayKey = et.tradeDayKey;
        } else if (et.tradeDayKey !== this.tradeDayKey) {
            this.rollTradingDay();
            this.tradeDayKey = et.tradeDayKey;
        }

        this.accumulate(d, et.minutes);

        if (DRAW_ONLY_IN_RTH && !inWindow(et.minutes, RTH_OPEN_MIN, RTH_CLOSE_MIN)) {
            return {};
        }

        const result = {};
        const entries = [];

        for (let i = 0; i < SESSIONS.length; ++i) {
            const s = SESSIONS[i];
            if (!this.props[s.param]) {
                continue;
            }
            // The US row always shows the PRIOR trading day; today's US range is
            // accumulated only so it can become tomorrow's PDH/PDL.
            const r = s.previous ? this.prevUs : this.ranges[s.id];
            if (!r || r.hi === undefined) {
                continue;
            }
            result[s.id + "High"] = r.hi;
            result[s.id + "Low"] = r.lo;
            entries.push({ key: s.id + "H", price: r.hi, text: s.hiLabel, session: s });
            entries.push({ key: s.id + "L", price: r.lo, text: s.loLabel, session: s });
        }

        if (SHOW_LABELS && d.isLast() && entries.length) {
            result.graphics = { items: this.labels(d, entries) };
        }

        return result;
    }

    labels(d, entries) {
        return entries.map(function (e) {
            const column = LABEL_STAGGER ? e.session.column : 0;
            const text = LABEL_SHOW_PRICE ? e.text + " " + e.price : e.text;
            return {
                tag: "Text",
                key: "lbl" + e.key,
                point: {
                    x: op(du(d.index()), "+", px(LABEL_OFFSET_PX + column * LABEL_COLUMN_PX)),
                    y: du(e.price)
                },
                text,
                style: { fontSize: LABEL_FONT_SIZE, fontWeight: "bold", fill: e.session.color },
                textAlignment: "leftMiddle"
            };
        });
    }
}

module.exports = {
    name: "sessionRangeLevels",
    description: "Session Range Levels (Asia / London / Pre-market / Prev US)",
    calculator: SessionRangeLevels,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    params,
    plots,
    tags: [predef.tags.Levels],
    schemeStyles
};
