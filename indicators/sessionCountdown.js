// ============================================================================
// Session Countdown — Tradovate custom indicator
// ----------------------------------------------------------------------------
// Pins a small readout to the BOTTOM-LEFT of the price chart showing, for each
// major session (Asia, London, New York), either:
//   - "OPEN"            (green) while that session is trading, or
//   - the time left until it next opens, e.g. "3h 12m" or "1d 4h 05m".
//
// Each session is defined in its OWN local time and converted with its own
// DST rules (no Intl dependency, same approach as nySessionAtrLevels.js):
//   - Asia   : Tokyo  09:00–18:00 JST  (UTC+9, no DST)
//   - London : London 08:00–16:30      (GMT/BST: last Sun Mar → last Sun Oct)
//   - NY     : New York 09:30–16:00 ET (EST/EDT: 2nd Sun Mar → 1st Sun Nov)
// Sessions only open Monday–Friday in their local time, so on a weekend the
// countdown runs to Monday's open. Exchange holidays are NOT accounted for.
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
// Session hours are in each session's LOCAL time, "HH:MM" 24h. Close must be
// later than open on the same local day.
const SESSIONS = [
    { key: "asia",   label: "ASIA",   tz: "tokyo",  open: "09:00", close: "18:00" },
    { key: "london", label: "LONDON", tz: "london", open: "08:00", close: "16:30" },
    { key: "ny",     label: "NY",     tz: "ny",     open: "09:30", close: "16:00" }
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
    const localDow = local.getUTCDay();
    const isWeekday = localDow >= 1 && localDow <= 5;

    if (isWeekday && localMin >= openMin && localMin < closeMin) {
        return { open: true };
    }

    // Scan forward day by day (local calendar) for the next weekday open.
    for (let k = 0; k <= 7; k++) {
        const localOpen = Date.UTC(
            local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + k,
            Math.floor(openMin / 60), openMin % 60
        );
        const dow = new Date(localOpen).getUTCDay();
        if (dow === 0 || dow === 6) continue;
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
