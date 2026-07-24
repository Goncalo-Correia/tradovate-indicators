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

class mmcScalpProMeter {
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
        const frameOrigin = { cs: "frame", h: "left", v: "top" };

        // 10-box strength meter, split green(buy) / red(sell)
        const boxes = this.props.meterBoxes;
        const greenBoxes = Math.max(0, Math.min(boxes, Math.round(s.buyFrac * boxes)));
        const boxW = 12;
        const boxH = 12;
        const gap = 4;
        const startX = 12;
        const topY = 12;

        const rect = (i) => ({
            tag: "Rectangle",
            position: {
                x: px(startX + boxW / 2 + i * (boxW + gap)),
                y: px(topY + boxH / 2)
            },
            size: { width: px(boxW), height: px(boxH) }
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

        // Text labels are indented a bit further right than the meter boxes.
        const labelX = startX + 16;

        // BUY% / SELL% label — green / red / yellow (balanced)
        const balanced = Math.abs(s.buyPct - 50) <= this.props.balanceThreshold;
        const buySellColor = balanced ? YELLOW : (s.buyPct > s.sellPct ? GREEN : RED);
        items.push(this.label(
            "buySell",
            `BUY ${s.buyPct}%   SELL ${s.sellPct}%`,
            labelX, topY + boxH + 12,
            buySellColor, frameOrigin, 13, "bold"
        ));

        // Trend label — only during an active directional move
        if (s.bullishActive) {
            items.push(this.label("trend", "TREND ▲  EMA > VWAP", labelX, topY + boxH + 32, GREEN, frameOrigin, 12));
        }
        else if (s.bearishActive) {
            items.push(this.label("trend", "TREND ▼  EMA < VWAP", labelX, topY + boxH + 32, RED, frameOrigin, 12));
        }

        // Volume label — cyan + ▲ on a spike, otherwise grey
        const volTxt = s.volumeSpike
            ? `VOL ${fmt(s.volume)} ▲ (prev ${fmt(s.prevVolume)})`
            : `VOL ${fmt(s.volume)} (prev ${fmt(s.prevVolume)})`;
        items.push(this.label("vol", volTxt, labelX, topY + boxH + 52, s.volumeSpike ? CYAN : GREY, frameOrigin, 12));

        return items;
    }

    label(key, text, x, y, color, origin, fontSize, fontWeight) {
        return {
            tag: "Text",
            key,
            point: { x: px(x), y: px(y) },
            text,
            style: { fontSize: fontSize || 12, fontWeight: fontWeight || "normal", fill: color },
            textAlignment: "leftMiddle",
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
    name: "mmcScalpProMeter",
    description: "MMC Scalp-Pro Meter (PSR)",
    calculator: mmcScalpProMeter,
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
    tags: [predef.tags.Volumes, "MMC"],
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
