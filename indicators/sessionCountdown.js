// ============================================================================
// Session Countdown — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Pins a small readout to the BOTTOM-LEFT of the price chart showing, for each
// major session (Asia, London, New York), either:
//   - "OPEN"            (green) while that session is trading, or
//   - the time left until it next opens, e.g. "3h 12m" or "1d 4h 05m".
//
// Sessions are the futures-trading windows in US Eastern time, matching
// sessionRangeLevels.js (DST handled without Intl):
//   - Asia   : 18:00–03:00 ET  (starts at the Globex open; opens Sun–Thu evenings)
//   - London : 03:00–09:30 ET  (Mon–Fri)
//   - NY     : 09:30–16:00 ET  (Mon–Fri)
// A session whose close is earlier than its open runs past midnight. On a
// weekend the countdown runs to the next open (Asia: Sunday 18:00 ET).
// Exchange holidays and early closes are NOT accounted for.
//
// Each session can instead be set in another market's local time via `tz`
// ("tokyo" = UTC+9, "london" = GMT/BST, "ny" = EST/EDT), e.g. the forex Asia
// session is { tz: "tokyo", open: "09:00", close: "18:00", openDays: MON_FRI }.
//
// Timing: the countdown is computed from the wall clock (Date.now()) when the
// last bar is mapped, so it refreshes whenever Tradovate re-runs map() on the
// live bar (i.e. on incoming ticks). In a quiet market it may lag until the
// next tick. Set USE_WALL_CLOCK = false to base it on the last bar's
// timestamp instead (useful for Replay mode, where the wall clock is wrong).
// ============================================================================

const meta = require("./tools/meta");
const { px } = require("./tools/graphics");

// ============================== CONFIG ======================================
// Hours are "HH:MM" 24h in the session's `tz`. close <= open means the session
// runs past midnight. `openDays` lists the local weekdays (0 = Sun … 6 = Sat)
// on which the session OPENS.
const MON_FRI = [1, 2, 3, 4, 5];
const SUN_THU = [0, 1, 2, 3, 4];
const SESSIONS = [
    { key: "asia",   label: "ASIA",   tz: "ny", open: "18:00", close: "03:00", openDays: SUN_THU },
    { key: "london", label: "LONDON", tz: "ny", open: "03:00", close: "09:30", openDays: MON_FRI },
    { key: "ny",     label: "NY",     tz: "ny", open: "09:30", close: "16:00", openDays: MON_FRI }
];
const USE_WALL_CLOCK = true;   // false: use last bar's timestamp (Replay)
const MARGIN_X = 48;           // px from the left edge of the pane (clears
                               // Tradovate's left-side chart toolbar)
const MARGIN_BOTTOM = 20;      // px from the bottom edge to the last row
const ROW_HEIGHT = 18;         // px between rows
const VALUE_OFFSET_X = 72;     // px from label column to value column
const FONT_SIZE = 12;
const LABEL_COLOR = "#9ca3af"; // session name
const WAIT_COLOR = "#e5e7eb";  // countdown text
const OPEN_COLOR = "#22c55e";  // "OPEN"
// ============================================================================

// -------- Timezone offsets (DST-aware, no Intl dependency) ------------------
function nthSundayOfMonth(year, monthIndex, n) {
    // Day-of-month of the n-th Sunday of the given month (monthIndex is 0-based)
    const firstDow = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
    const firstSunday = 1 + ((7 - firstDow) % 7);
    return firstSunday + (n - 1) * 7;
}

function lastSundayOfMonth(year, monthIndex) {
    const lastDay = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
    const lastDow = new Date(Date.UTC(year, monthIndex, lastDay)).getUTCDay();
    return lastDay - lastDow;
}

function easternOffsetHours(t) {
    const y = new Date(t).getUTCFullYear();
    // DST: 2nd Sunday of March 07:00 UTC → 1st Sunday of November 06:00 UTC
    const dstStart = Date.UTC(y, 2, nthSundayOfMonth(y, 2, 2), 7);
    const dstEnd = Date.UTC(y, 10, nthSundayOfMonth(y, 10, 1), 6);
    return (t >= dstStart && t < dstEnd) ? -4 : -5;
}

function londonOffsetHours(t) {
    const y = new Date(t).getUTCFullYear();
    // BST: last Sunday of March 01:00 UTC → last Sunday of October 01:00 UTC
    const bstStart = Date.UTC(y, 2, lastSundayOfMonth(y, 2), 1);
    const bstEnd = Date.UTC(y, 9, lastSundayOfMonth(y, 9), 1);
    return (t >= bstStart && t < bstEnd) ? 1 : 0;
}

const OFFSET_FNS = {
    tokyo: function () { return 9; },
    london: londonOffsetHours,
    ny: easternOffsetHours
};

function hhmm(s) {
    const parts = s.split(":");
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

// -------- Session state at instant `now` (ms since epoch) -------------------
// Returns { open: true } or { open: false, msUntil }.
function sessionState(session, now) {
    const offsetFn = OFFSET_FNS[session.tz];
    const openMin = hhmm(session.open);
    const closeMin = hhmm(session.close);

    // Local wall-clock "now" expressed as a UTC Date
    const local = new Date(now + offsetFn(now) * 3600000);
    const localMin = local.getUTCHours() * 60 + local.getUTCMinutes();
    const today = local.getUTCDay();
    const yesterday = (today + 6) % 7;
    const opensOn = function (dow) { return session.openDays.indexOf(dow) !== -1; };

    const isOpen = closeMin > openMin
        ? opensOn(today) && localMin >= openMin && localMin < closeMin
        // Overnight: opened this evening, or opened yesterday and not yet closed
        : (opensOn(today) && localMin >= openMin) ||
          (opensOn(yesterday) && localMin < closeMin);
    if (isOpen) {
        return { open: true };
    }

    // Scan forward day by day (local calendar) for the next open.
    for (let k = 0; k <= 7; k++) {
        const localOpen = Date.UTC(
            local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k,
            Math.floor(openMin / 60), openMin % 60
        );
        if (!opensOn(new Date(localOpen).getUTCDay())) continue;
        // Convert local open → UTC; refine offset at the candidate instant
        // so a DST switch between now and the open is handled.
        let utcOpen = localOpen - offsetFn(now) * 3600000;
        utcOpen = localOpen - offsetFn(utcOpen) * 3600000;
        if (utcOpen > now) {
            return { open: false, msUntil: utcOpen - now };
        }
    }
    return { open: false, msUntil: NaN }; // unreachable with sane config
}

function pad2(n) {
    return n < 10 ? "0" + n : "" + n;
}

function formatCountdown(ms) {
    if (!isFinite(ms)) return "--";
    const totalMin = Math.ceil(ms / 60000); // round up: never show "0m" early
    const days = Math.floor(totalMin / 1440);
    const hours = Math.floor((totalMin % 1440) / 60);
    const mins = totalMin % 60;
    if (days > 0) return days + "d " + hours + "h " + pad2(mins) + "m";
    if (hours > 0) return hours + "h " + pad2(mins) + "m";
    return mins + "m";
}

class SessionCountdown {
    init() {}

    map(d) {
        // Assign graphics on every bar (false = nothing) so no stale copies linger.
        if (!d.isLast()) return { graphics: false };

        const now = USE_WALL_CLOCK ? Date.now() : d.timestamp().getTime();
        const origin = { cs: "frame", h: "left", v: "bottom" };
        const items = [];

        // Rows are stacked upward from the bottom edge: last session lowest.
        const n = SESSIONS.length;
        SESSIONS.forEach(function (s, i) {
            const state = sessionState(s, now);
            const y = -(MARGIN_BOTTOM + (n - 1 - i) * ROW_HEIGHT);
            items.push(label(s.key + "Label", s.label, MARGIN_X, y, LABEL_COLOR, origin, "normal"));
            items.push(label(
                s.key + "Value",
                state.open ? "OPEN" : formatCountdown(state.msUntil),
                MARGIN_X + VALUE_OFFSET_X, y,
                state.open ? OPEN_COLOR : WAIT_COLOR,
                origin, "bold"
            ));
        });

        return { graphics: { items } };
    }
}

function label(key, text, x, y, color, origin, fontWeight) {
    return {
        tag: "Text",
        key,
        point: { x: px(x), y: px(y) },
        text,
        style: { fontSize: FONT_SIZE, fontWeight: fontWeight || "normal", fill: color },
        textAlignment: "rightMiddle", // text sits to the RIGHT of `point`
        global: true,
        origin
    };
}

module.exports = {
    name: "sessionCountdown",
    description: "Session Countdown (Asia / London / NY)",
    calculator: SessionCountdown,
    params: {},
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    plots: {},
    tags: ["Custom Indicators"],
    schemeStyles: { dark: {}, light: {} }
};
