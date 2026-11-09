// ============================================================================
// Big Trades + Tape Speed — Tradovate custom indicator
// ----------------------------------------------------------------------------
// 1) BIG TRADE BUBBLES
//    Marks the price where a large aggressive trade went through, in two tiers:
//      * medium = mediumSize <= size < bigSize (default 20 to 49): a dark dot
//      * big    = size >= bigSize (default 50 and up): a light dot with a ring
//                 around it, so it reads as a bigger circle
//      * green = buyers lifting the offer (ask volume)
//      * red   = sellers hitting the bid  (bid volume)
//    Dots are ordinary PLOTS drawn with the built-in dots plotter (the one
//    circle Tradovate is known to render here; graphics Circle / Dots objects
//    did not show up). That plotter draws every dot the same size whatever the
//    line width, hence the shade + ring (a global Text "O", see BIG_MARK).
//    A plot holds one value per bar, so each tier and side gets SLOTS plots:
//    a bar shows at most its SLOTS largest trades per tier and side. On a
//    1-tick chart a bar is one trade, so nothing is lost.
//
//    IMPORTANT — what "an order" means here. A custom indicator never sees the
//    individual time & sales prints; it only sees bars. For each bar we read
//    d.profile() (volume by price, split into bidVol / askVol) and bubble every
//    price level whose ask or bid volume crosses the threshold.
//      * On a 1-TICK chart every bar is a single trade, so a bubble really is
//        one print of >= 20 / >= 50 contracts. This is the intended setup.
//      * On a time / range / larger tick chart a bubble means ">= N contracts
//        traded at that price inside that bar", which on busy markets (NQ/ES
//        at 1-min) is most levels — raise the thresholds or use a 1-tick chart.
//    If a bar has no profile, the whole bar's d.offerVolume()/d.bidVolume() is
//    used at its close. If the feed gives neither, no bubbles are drawn and the
//    HUD says so.
//
// 2) TAPE SPEED
//    speed = contracts per second for a bar (volume / bar duration, from the
//    gap between bar timestamps; the forming bar uses wall-clock time elapsed
//    since it opened). A bar is flagged "FAST" when its speed is at least
//    speedMult x the average speed of the previous speedBars closed bars.
//    On a time chart every bar lasts the same, so this reduces to "volume vs
//    the 10-bar average"; on tick/range charts it is a true rate.
//    Session/weekend gaps are capped (GAP_CAP x the median bar duration) so one
//    huge gap does not drag the average down.
//
// Everything is drawn from the last bar as single-render (global) graphics,
// limited to the most recent LOOKBACK_BARS bars.
//
// Depends only on ./tools/predef, ./tools/meta and ./tools/graphics.
// ============================================================================

const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ============================== CONFIG ======================================
const BUY_COLOR = "#22c55e";   // HUD / "text" style
const SELL_COLOR = "#ef4444";
const FAST_COLOR = "#facc15";
const NEUTRAL_COLOR = "#9ca3af";
// How trades are drawn:
//   "plot" — dots, via plots + the dots plotter (default).
//   "text" — the trade size as a bold number ("24", "120"), every trade.
const MARKER_STYLE = "plot";
// One entry per size tier: dot colours (dark shade for medium, light tint for
// big; also editable per plot in the indicator settings) and font size for
// the "text" style.
const TIERS = {
    med: { buy: "#15803d", sell: "#b91c1c", font: 12 },
    big: { buy: "#86efac", sell: "#fca5a5", font: 18 }
};
// Extra mark on BIG trades in "plot" style (the dots plotter has one size):
//   "ring" — a ring around the dot    "size" — the contract count beside it
//   "none" — shade only
const BIG_MARK = "ring";
const RING_FONT = 22;          // ring diameter is roughly 0.7 x this, in px
const SIZE_FONT = 11;
const SIZE_GAP = 6;            // px between the dot and the count
const SLOTS = 3;               // dots per bar, per tier and side ("plot")
const MAX_MARKERS = 500;       // newest trades given a text item (ring/size/"text")

// One plot per tier x side x slot, e.g. buyBig1, sellMed3.
const PLOT_DEFS = [];
for (const tier of ["big", "med"]) {
    for (const side of ["buy", "sell"]) {
        for (let n = 1; n <= SLOTS; ++n) {
            PLOT_DEFS.push({ key: `${side}${tier === "big" ? "Big" : "Med"}${n}`, tier, buy: side === "buy", slot: n - 1 });
        }
    }
}

const LOOKBACK_BARS = 2000;    // only bars this recent get bubbles / FAST labels
const FAST_GAP = 14;           // px between the bar high and the FAST label
const FAST_FONT = 10;

const GAP_CAP = 3;             // durations capped at GAP_CAP x median duration
const MEDIAN_WINDOW = 20;      // bars used for that median
const USE_WALL_CLOCK = true;   // forming bar's duration from Date.now()

const HUD_CORNER = { cs: "frame", h: "right", v: "top" };
const HUD_X = -10;             // px from the right edge (text drawn to the left)
const HUD_TOP = 14;
const HUD_LINE_H = 16;
const HUD_FONT = 12;
// ============================================================================

class BigTrades {
    init() {
        this.bars = [];        // per-bar state keyed by map()'s index
    }

    map(d, index, history) {
        const p = this.props;
        // Tolerate the two thresholds being entered the wrong way round.
        const med = Math.min(p.mediumSize, p.bigSize);
        const big = Math.max(p.mediumSize, p.bigSize);

        // ---- big trades on this bar (recomputed on every tick re-run) -------
        const bubbles = [];
        let src = "none";      // where the bid/ask split came from (HUD diagnostic)
        let maxBuy = 0, maxSell = 0;
        const add = (price, vol, buy) => {
            if (buy) maxBuy = Math.max(maxBuy, vol); else maxSell = Math.max(maxSell, vol);
            if (vol >= med) bubbles.push({ price, vol, buy, tier: vol >= big ? "big" : "med" });
        };
        const profile = d.profile();
        // Use the profile only if its levels actually carry the bid/ask split.
        const split = profile && profile.length &&
            profile.some((lv) => lv.askVol !== undefined || lv.bidVol !== undefined);
        if (split) {
            src = "profile";
            for (let k = 0; k < profile.length; ++k) {
                const lv = profile[k];
                add(lv.price, lv.askVol || 0, true);
                add(lv.price, lv.bidVol || 0, false);
            }
        } else {
            const ask = d.offerVolume ? d.offerVolume() : undefined;
            const bid = d.bidVolume ? d.bidVolume() : undefined;
            if (ask !== undefined || bid !== undefined) {
                src = "bar";
                add(d.close(), ask || 0, true);
                add(d.close(), bid || 0, false);
            }
        }

        // ---- dots: this bar's largest trades per tier and side --------------
        // Chosen trades are flagged `dot` so the ring/count marks match them.
        const plotVals = {};
        if (MARKER_STYLE === "plot") {
            const ranked = bubbles.slice().sort((a, b) => b.vol - a.vol);
            for (const def of PLOT_DEFS) {
                if (def.buy ? !p.showBuys : !p.showSells) continue;
                const t = ranked.filter((b) => b.tier === def.tier && b.buy === def.buy)[def.slot];
                if (t) {
                    t.dot = true;
                    plotVals[def.key] = t.price;
                }
            }
        }

        this.bars[index] = {
            ts: d.timestamp().getTime(),
            vol: d.volume(),
            high: d.high(),
            x: d.index(),
            bubbles,
            maxBuy,
            maxSell,
            ratio: undefined
        };

        // ---- tape speed ------------------------------------------------------
        // The previous bar is now closed: give it its final ratio.
        if (index > 0 && this.bars[index - 1]) {
            this.bars[index - 1].ratio = this.ratioAt(index - 1, index);
        }

        const items = [];
        if (d.isLast()) {
            this.src = src;
            const live = this.ratioAt(index, index);
            this.bars[index].ratio = live;
            items.push(...this.drawHistory(index));
            if (p.showHud) items.push(...this.hud(live));
        }

        // Assign graphics on every bar (false = nothing) so no stale copies linger.
        return Object.assign({ graphics: items.length ? { items } : false }, plotVals);
    }

    medianDuration(upto) {
        const durs = [];
        for (let j = Math.max(0, upto - MEDIAN_WINDOW); j < upto; ++j) {
            const a = this.bars[j], b = this.bars[j + 1];
            if (a && b && b.ts > a.ts) durs.push(b.ts - a.ts);
        }
        if (!durs.length) return 60000;
        durs.sort((x, y) => x - y);
        return durs[Math.floor(durs.length / 2)];
    }

    // Contracts per second of bar j. `last` is the newest index processed:
    // bar j is closed if j < last, otherwise it is the forming bar.
    speed(j, last, cap) {
        const b = this.bars[j];
        let dur;
        if (j < last) {
            dur = this.bars[j + 1].ts - b.ts;
        } else {
            dur = USE_WALL_CLOCK ? Date.now() - b.ts : cap / GAP_CAP;
        }
        dur = Math.min(Math.max(dur, 1000), cap);
        return b.vol / (dur / 1000);
    }

    // speed of bar j relative to the average of the speedBars closed bars before it
    ratioAt(j, last) {
        const n = this.props.speedBars;
        if (j < n) return undefined;
        const cap = GAP_CAP * this.medianDuration(j);
        let sum = 0;
        for (let k = j - n; k < j; ++k) {
            if (!this.bars[k] || !this.bars[k + 1]) return undefined;
            sum += this.speed(k, last, cap);
        }
        const avg = sum / n;
        return avg > 0 ? this.speed(j, last, cap) / avg : undefined;
    }

    drawHistory(last) {
        const p = this.props;
        const trades = [];
        const labels = [];
        const first = Math.max(0, last - LOOKBACK_BARS);
        this.maxBuy = 0;
        this.maxSell = 0;
        this.scanned = last - first + 1;
        for (let j = first; j <= last; ++j) {
            const b = this.bars[j];
            if (!b) continue;
            this.maxBuy = Math.max(this.maxBuy, b.maxBuy);
            this.maxSell = Math.max(this.maxSell, b.maxSell);
            for (const t of b.bubbles) {
                if (t.buy ? !p.showBuys : !p.showSells) continue;
                trades.push({ x: b.x, t });
            }
            if (p.showSpeed && b.ratio !== undefined && b.ratio >= p.speedMult) {
                labels.push({
                    tag: "Text",
                    key: `fast${j}`,
                    // In grid space, subtracting px moves UP.
                    point: { x: du(b.x), y: op(du(b.high), "-", px(FAST_GAP)) },
                    text: "FAST",
                    style: { fontSize: FAST_FONT, fontWeight: "bold", fill: FAST_COLOR },
                    textAlignment: "centerAbove",
                    global: true
                });
            }
        }

        // HUD counts: every qualifying trade in the scanned bars.
        this.counts = { med: { buy: 0, sell: 0 }, big: { buy: 0, sell: 0 } };
        for (const s of trades) this.counts[s.t.tier][s.t.buy ? "buy" : "sell"]++;
        if (MARKER_STYLE !== "text") return this.bigMarks(trades).concat(labels);

        return trades.slice(-MAX_MARKERS).map(({ x, t }, n) => ({
            tag: "Text",
            key: `bt${n}`,
            point: { x: du(x), y: du(t.price) },
            text: String(Math.round(t.vol)),
            style: {
                fontSize: TIERS[t.tier].font,
                fontWeight: "bold",
                fill: t.buy ? BUY_COLOR : SELL_COLOR
            },
            textAlignment: "centerMiddle",
            global: true
        })).concat(labels);
    }

    // "plot" style: ring or contract count on every BIG trade that got a dot.
    bigMarks(trades) {
        if (BIG_MARK !== "ring" && BIG_MARK !== "size") return [];
        const ring = BIG_MARK === "ring";
        return trades.filter((s) => s.t.dot && s.t.tier === "big").slice(-MAX_MARKERS).map(({ x, t }, n) => ({
            tag: "Text",
            key: `bm${n}`,
            point: { x: ring ? du(x) : op(du(x), "+", px(SIZE_GAP)), y: du(t.price) },
            // A plain ASCII capital O: the chart font drops fancier glyphs.
            text: ring ? "O" : String(Math.round(t.vol)),
            style: {
                fontSize: ring ? RING_FONT : SIZE_FONT,
                fontWeight: "bold",
                fill: TIERS.big[t.buy ? "buy" : "sell"]
            },
            // "rightMiddle" = text to the RIGHT of the point.
            textAlignment: ring ? "centerMiddle" : "rightMiddle",
            global: true
        }));
    }

    hud(live) {
        const p = this.props;
        const rows = [];
        if (live === undefined) {
            rows.push([`TAPE  warming up (${p.speedBars} bars)`, NEUTRAL_COLOR]);
        } else {
            const fast = live >= p.speedMult;
            rows.push([`TAPE  ${live.toFixed(1)}x avg${fast ? "  FAST" : ""}`, fast ? FAST_COLOR : NEUTRAL_COLOR]);
        }
        // How many trades of each tier were found in the scanned bars — tells
        // "nothing to draw" apart from "drawn but not rendering".
        const c = this.counts;
        rows.push([`MED  buy ${c.med.buy} / sell ${c.med.sell}`, NEUTRAL_COLOR]);
        rows.push([`BIG  buy ${c.big.buy} / sell ${c.big.sell}`, NEUTRAL_COLOR]);
        // Diagnostics: where the bid/ask split comes from on the newest bar
        // ("profile" = per-price, "bar" = whole-bar offer/bid volume, "none"),
        // and the biggest buy / sell seen in the scanned bars. If MAX stays
        // under mediumSize there is simply no trade that big on screen.
        rows.push([`SRC  ${this.src}`, this.src === "none" ? SELL_COLOR : NEUTRAL_COLOR]);
        rows.push([`MAX  buy ${Math.round(this.maxBuy)} / sell ${Math.round(this.maxSell)} in ${this.scanned} bars`, NEUTRAL_COLOR]);

        return rows.map(([text, color], n) => ({
            tag: "Text",
            key: `bthud${n}`,
            point: { x: px(HUD_X), y: px(HUD_TOP + n * HUD_LINE_H) },
            text,
            style: { fontSize: HUD_FONT, fontWeight: "bold", fill: color },
            // anchored at the right edge: "leftMiddle" = text to the LEFT of point
            textAlignment: "leftMiddle",
            global: true,
            origin: HUD_CORNER
        }));
    }
}

module.exports = {
    name: "bigTrades",
    description: "Big Trades (bubbles) + Tape Speed",
    calculator: BigTrades,
    params: {
        mediumSize: predef.paramSpecs.number(20, 1, 1),   // small circle from this size...
        bigSize: predef.paramSpecs.number(50, 1, 1),      // ...bigger circle from this size up
        speedBars: predef.paramSpecs.period(10),          // bars in the speed average
        speedMult: predef.paramSpecs.number(2, 0.1, 1),   // FAST when speed >= this x average
        // Literal boolean shape — predef.paramSpecs.bool() is not known to exist
        // and a missing helper makes the indicator silently vanish from the list.
        showBuys: { type: "boolean", def: true },
        showSells: { type: "boolean", def: true },
        showSpeed: { type: "boolean", def: true },
        showHud: { type: "boolean", def: true }
    },
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    plots: PLOT_DEFS.reduce((o, def) => { o[def.key] = {}; return o; }, {}),
    plotter: PLOT_DEFS.map((def) => predef.plotters.dots(def.key)),
    tags: ["Custom Indicators"],
    schemeStyles: { dark: plotStyles(), light: plotStyles() }
};

function plotStyles() {
    const o = {};
    for (const def of PLOT_DEFS) {
        o[def.key] = predef.styles.plot({ color: TIERS[def.tier][def.buy ? "buy" : "sell"], lineWidth: 3 });
    }
    return o;
}
