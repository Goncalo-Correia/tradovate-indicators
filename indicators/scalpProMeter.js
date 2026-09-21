const predef = require("./tools/predef");
const meta = require("./tools/meta");
const EMA = require("./tools/EMA");
const { du, px, op } = require("./tools/graphics");

//
// MMC Scalp-Pro Meter (PSR) — Tradovate port
// ------------------------------------------
// A faithful re-implementation of the "Scalp Pro Meter PSR" ThinkorSwim indicator
// by the Million-Dollar-Margin Club, for the Tradovate custom-indicator API.
//
// Renders in its own pane and shows, for each candle:
//   * a blue volume histogram (total volume of the candle)
//   * a green dot at estimated BUY volume and a red dot at estimated SELL volume
//     (positioned by where the close sits inside the candle's range)
//   * a fixed on-screen HUD (top-left of the pane) built from the *last* candle:
//       - a 10-box strength meter split green(buy)/red(sell)
//       - a BUY%/SELL% label, colored green / red / yellow (balanced)
//       - an EMA-vs-VWAP trend label that only shows during active directional moves
//       - a volume label that turns cyan when the current candle's volume
//         exceeds the previous candle's (a volume spike)
//
// NOTE ON THE BUY/SELL SPLIT: like the original, this is an *estimate* derived from
// where price closed within the candle's range (close near the high => buyers in
// control, near the low => sellers). It is NOT true order-flow / bid-ask delta.
// Tradovate does expose d.offerVolume()/d.bidVolume() if you want real delta —
// see the note in README.md for how to swap it in.
//
// NOTE ON ALERTS: the original plays audio "dings". The Tradovate custom-indicator
// API has no sound primitive, so the audible alerts are reproduced *visually*
// (the volume label turns cyan and shows a ▲ on a spike; the trend label appears
// on a fresh EMA/VWAP cross). Use Tradovate's built-in alerts for sound.
//

// ============================== CONFIG ======================================
// HUD geometry. All values are PIXELS measured inward from the pane corner named
// by HUD_CORNER. Tradovate draws its own indicator title across the top-left of
// the pane, so HUD_TOP must stay large enough for the meter to clear it.
const HUD_CORNER = { cs: "frame", h: "left", v: "top" };

const HUD_X = 12;             // left inset of the whole HUD (meter + labels)
const HUD_TOP = 26;           // top inset; >= ~24 keeps the meter off Tradovate's title

const HUD_BOX_W = 12;         // strength-meter box width
const HUD_BOX_H = 12;         // strength-meter box height
const HUD_BOX_GAP = 4;        // horizontal gap between meter boxes

const HUD_LABEL_INDENT = 16;  // labels' extra indent relative to the meter; 0 = flush
const HUD_LABEL_GAP = 14;     // vertical gap between the meter row and the first label
const HUD_LINE_H = 22;        // vertical distance between consecutive label lines

const HUD_FONT_MAIN = 13;     // BUY%/SELL% label
const HUD_FONT_SUB = 12;      // trend and volume labels
// ============================================================================

class ScalpProMeter {
    init() {
        this.ema = EMA(this.props.emaPeriod);
        this.prevEma = undefined;
        // VWAP accumulators (reset each trading day)
        this.cumulativeValue = 0;
        this.cumulativeVolume = 0;
        this.tradeDate = 0;
    }

    // running session VWAP, mirrors the built-in vwap indicator
    vwap(d) {
        const tradeDate = d.tradeDate();
        if (tradeDate !== this.tradeDate) {
            this.cumulativeVolume = 0;
            this.cumulativeValue = 0;
            this.tradeDate = tradeDate;
        }
        const profile = d.profile();
        if (profile && profile.length) {
            for (let i = 0; i < profile.length; ++i) {
                const level = profile[i];
                this.cumulativeVolume += level.vol;
                this.cumulativeValue += level.vol * level.price;
            }
        }
        else {
            const typical = (d.high() + d.low() + d.close()) / 3;
            this.cumulativeVolume += d.volume();
            this.cumulativeValue += d.volume() * typical;
        }
        return this.cumulativeVolume ? this.cumulativeValue / this.cumulativeVolume : d.close();
    }

    map(d, index, history) {
        const high = d.high();
        const low = d.low();
        const close = d.close();
        const volume = d.volume();

        // --- estimated buyer / seller split from close position in range ---
        const range = high - low;
        const buyFrac = range > 0 ? (close - low) / range : 0.5;
        const sellFrac = 1 - buyFrac;
        const buyVolume = volume * buyFrac;
        const sellVolume = volume * sellFrac;
        const buyPct = Math.round(buyFrac * 100);
        const sellPct = 100 - buyPct;

        // --- trend: 14 EMA vs session VWAP, with slope-based "active move" gate ---
        const emaValue = this.ema(close);
        const vwapValue = this.vwap(d);
        const slope = this.prevEma === undefined ? 0 : emaValue - this.prevEma;
        this.prevEma = emaValue;
        const bullishActive = emaValue > vwapValue && slope > 0;
        const bearishActive = emaValue < vwapValue && slope < 0;

        // --- volume spike vs previous candle ---
        const prevVolume = index > 0 ? history.prior().volume() : volume;
        const volumeSpike = volume > prevVolume;

        const result = {
            volume,
            buyVolume,
            sellVolume,
            ema: emaValue,
            vwap: vwapValue
        };

        // The HUD is a single, fixed overlay drawn from the most recent candle.
        if (d.isLast()) {
            result.graphics = {
                items: this.hud({
                    buyFrac, buyPct, sellPct,
                    bullishActive, bearishActive,
                    volume, prevVolume, volumeSpike
                })
            };
        }

        return result;
    }

    // Builds the fixed top-left HUD (meter + labels), pinned to the pane frame.
    hud(s) {
        const GREEN = "#22c55e";
        const RED = "#ef4444";
        const YELLOW = "#eab308";
        const CYAN = "#22d3ee";
        const GREY = "#9ca3af";

        const items = [];
        const frameOrigin = HUD_CORNER;

        // 10-box strength meter, split green(buy) / red(sell)
        const boxes = this.props.meterBoxes;
        const greenBoxes = Math.max(0, Math.min(boxes, Math.round(s.buyFrac * boxes)));

        const rect = (i) => ({
            tag: "Rectangle",
            position: {
                x: px(HUD_X + HUD_BOX_W / 2 + i * (HUD_BOX_W + HUD_BOX_GAP)),
                y: px(HUD_TOP + HUD_BOX_H / 2)
            },
            size: { width: px(HUD_BOX_W), height: px(HUD_BOX_H) }
        });

        const greenPrimitives = [];
        const redPrimitives = [];
        for (let i = 0; i < boxes; ++i) {
            (i < greenBoxes ? greenPrimitives : redPrimitives).push(rect(i));
        }
        if (greenPrimitives.length) {
            items.push({
                tag: "Shapes", key: "meterBuy",
                primitives: greenPrimitives,
                fillStyle: { color: GREEN },
                global: true, origin: frameOrigin
            });
        }
        if (redPrimitives.length) {
            items.push({
                tag: "Shapes", key: "meterSell",
                primitives: redPrimitives,
                fillStyle: { color: RED },
                global: true, origin: frameOrigin
            });
        }

        const labelX = HUD_X + HUD_LABEL_INDENT;
        // y-centre of label row `n` (0-based), stacked below the meter.
        const rowY = (n) => HUD_TOP + HUD_BOX_H + HUD_LABEL_GAP + n * HUD_LINE_H;

        // The trend row is conditional, but it keeps its own slot so the volume
        // row does not jump up and down as the trend appears and disappears.
        let row = 0;

        // BUY% / SELL% label — green / red / yellow (balanced)
        const balanced = Math.abs(s.buyPct - 50) <= this.props.balanceThreshold;
        const buySellColor = balanced ? YELLOW : (s.buyPct > s.sellPct ? GREEN : RED);
        items.push(this.label(
            "buySell",
            `BUY ${s.buyPct}%   SELL ${s.sellPct}%`,
            labelX, rowY(row++),
            buySellColor, frameOrigin, HUD_FONT_MAIN, "bold"
        ));

        // Trend label — only during an active directional move
        if (s.bullishActive) {
            items.push(this.label("trend", "TREND ▲  EMA > VWAP", labelX, rowY(row), GREEN, frameOrigin, HUD_FONT_SUB));
        }
        else if (s.bearishActive) {
            items.push(this.label("trend", "TREND ▼  EMA < VWAP", labelX, rowY(row), RED, frameOrigin, HUD_FONT_SUB));
        }
        row++;

        // Volume label — cyan + ▲ on a spike, otherwise grey
        const volTxt = s.volumeSpike
            ? `VOL ${fmt(s.volume)} ▲ (prev ${fmt(s.prevVolume)})`
            : `VOL ${fmt(s.volume)} (prev ${fmt(s.prevVolume)})`;
        items.push(this.label("vol", volTxt, labelX, rowY(row), s.volumeSpike ? CYAN : GREY, frameOrigin, HUD_FONT_SUB));

        // NOTE: do not wrap these in a Container to apply a ZIndex transform.
        // Frame-anchored items (global: true + origin) stop rendering entirely
        // once nested in a Container — the HUD disappears. The volume columns
        // painting over the labels has to be solved some other way.
        return items;
    }

    label(key, text, x, y, color, origin, fontSize, fontWeight) {
        return {
            tag: "Text",
            key,
            point: { x: px(x), y: px(y) },
            text,
            style: { fontSize: fontSize || 12, fontWeight: fontWeight || "normal", fill: color },
            // "rightMiddle" puts the text to the RIGHT of `point`. "leftMiddle"
            // draws it to the left, which ran these labels off the left edge of
            // the pane so only their tails were visible.
            textAlignment: "rightMiddle",
            global: true,
            origin
        };
    }
}

function fmt(n) {
    // compact thousands separator without locale dependence
    const r = Math.round(n);
    return r.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

module.exports = {
    name: "scalpProMeter",
    description: "Scalp-Pro Meter (PSR)",
    calculator: ScalpProMeter,
    params: {
        emaPeriod: predef.paramSpecs.period(14),
        meterBoxes: predef.paramSpecs.number(10, 1, 2),
        balanceThreshold: predef.paramSpecs.number(6, 1, 0)
    },
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.NEW,
    plots: {
        volume: {},
        buyVolume: {},
        sellVolume: {},
        ema: { displayOnly: true },
        vwap: { displayOnly: true }
    },
    plotter: [
        predef.plotters.columns("volume"),
        predef.plotters.dots("buyVolume"),
        predef.plotters.dots("sellVolume")
    ],
    // Autoscale on the VOLUME fields only. `ema` and `vwap` are price-valued
    // (~22,000 on NQ) and are carried purely so the HUD can compare them; if
    // they are left in the autoscale set the pane stretches to fit the price,
    // and the volume histogram collapses into a sliver along the bottom.
    scaler: {
        type: "multiPath",
        fields: ["volume", "buyVolume", "sellVolume"]
    },
    tags: ["Custom Indicators"],
    schemeStyles: {
        dark: {
            volume: predef.styles.plot({ color: "#3b82f6", lineWidth: 1 }),
            buyVolume: predef.styles.plot({ color: "#22c55e", lineWidth: 3 }),
            sellVolume: predef.styles.plot({ color: "#ef4444", lineWidth: 3 })
        },
        light: {
            volume: predef.styles.plot({ color: "#2563eb", lineWidth: 1 }),
            buyVolume: predef.styles.plot({ color: "#16a34a", lineWidth: 3 }),
            sellVolume: predef.styles.plot({ color: "#dc2626", lineWidth: 3 })
        }
    }
};
