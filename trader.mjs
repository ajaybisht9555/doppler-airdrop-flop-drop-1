import fetch from 'node-fetch';
import crypto, { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64urlnopad } from '@scure/base';

// --- CRYPTO SETUP ---
const MULTICODEC_ED25519 = new Uint8Array([0xed, 0x01]);
function getAgentFromPem(pemPath, passphrase) {
    const pem = readFileSync(pemPath, 'utf8');
    const privateKey = createPrivateKey({
        key: pem,
        format: 'pem',
        type: 'pkcs8',
        passphrase: passphrase
    });
    // Extract the 32-byte seed from the raw DER
    const raw = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = raw.subarray(raw.length - 32);
    const publicKey = ed25519.getPublicKey(seed);
    const multi = new Uint8Array(MULTICODEC_ED25519.length + publicKey.length);
    multi.set(MULTICODEC_ED25519, 0);
    multi.set(publicKey, MULTICODEC_ED25519.length);
    const did = `did:key:z${base58.encode(multi)}`;
    
    return {
        did,
        sign: (canonical) => base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed))
    };
}

// --- CONFIG ---
const PASSPHRASE = process.env.PASSPHRASE;
const IDENTITY_PATH = process.env.IDENTITY_PATH || 'identity.pem';
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BOT_STYLE = process.env.BOT_STYLE || 'conservative';

const agent = getAgentFromPem(IDENTITY_PATH, PASSPHRASE);
const ROOM = "close1";

// --- FETCH DATA ---
async function getMarketData() {
    const refRes = await fetch('https://technocore.chat/r/d-close1-price?format=json');
    const refData = await refRes.json();
    const lastSweep = JSON.parse(refData.messages[refData.messages.length - 1].text);
    
    // Dynamic Timeframes based on bot style
    let interval = "1d";
    let range = "14d";
    
    if (BOT_STYLE === "aggressive") {
        interval = "1h";
        range = "2d";
    } else if (BOT_STYLE === "contrarian") {
        interval = "15m";
        range = "1d";
    }
    
    const yfRes = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=${interval}&range=${range}`);
    const yfData = await yfRes.json();
    const quotes = yfData.chart.result[0].indicators.quote[0];
    
    // Get up to the last 15 candles
    const closes = quotes.close.slice(-15).map(c => c ? c.toFixed(2) : null).filter(c => c).join(', ');
    const volumes = quotes.volume.slice(-15).map(v => v ? v : null).filter(v => v).join(', ');

    return {
        currentPrice: lastSweep.ref.px,
        sweepN: lastSweep.n,
        limits: lastSweep.limits,
        interval,
        range,
        closes,
        volumes
    };
}

async function getAIDecision(market) {
    const prompt = `You are a quantitative NVDA futures trader. 
Your Risk Profile is: ${BOT_STYLE.toUpperCase()}. 
Conservative = Only trade strong macro trends (uses 1-day candles).
Aggressive = Scalp intraday breakouts (uses 1-hour candles).
Contrarian = Bet against the trend on fast overbought/oversold reversals (uses 15-minute candles).

Current NVDA Price: $${market.currentPrice}
Chart Timeframe: ${market.interval} (over ${market.range})
Recent Closes: ${market.closes}
Recent Volumes: ${market.volumes}
Price Limits for this sweep: ${market.limits[0]} to ${market.limits[1]}

Analyze the momentum based on YOUR specific timeframe. Output a JSON object exactly like this:
{"action": "buy", "confidence": 85, "reasoning": "strong upward momentum on the hourly chart"}
Allowed actions: "buy", "sell", "hold".
Do not output any markdown or extra text. Just the raw JSON.`;

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${GROQ_API_KEY}`,
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            model: "openai/gpt-oss-20b",
            messages: [{ role: "user", content: prompt }]
        })
    });
    const data = await res.json();
    try {
        let text = data.choices[0].message.content.trim();
        if (text.startsWith('```json')) text = text.replace(/```json|```/g, '').trim();
        return JSON.parse(text);
    } catch(e) {
        console.log("Raw output:", data);
        return { action: "hold", confidence: 0, reasoning: "JSON parse failed" };
    }
}

async function scanForOffers(action, maxWillingToPay, minWillingToReceive) {
    const res = await fetch(`https://technocore.chat/r/${ROOM}?format=json`);
    const data = await res.json();
    const offers = [];
    for (const msg of data.messages) {
        try {
            const p = JSON.parse(msg.text);
            if (p.terms && p.maker_sig) { // Relaxed shape for scanning offers
                if (p.terms.side !== action && p.terms.taker === "any") {
                    const offerPx = parseFloat(p.terms.px);
                    if (action === "buy" && offerPx <= maxWillingToPay) {
                        offers.push(p);
                    } else if (action === "sell" && offerPx >= minWillingToReceive) {
                        offers.push(p);
                    }
                }
            }
        } catch(e){}
    }
    return offers;
}

async function postMessage(textObj) {
    const nonce = Date.now();
    const text = JSON.stringify(textObj);
    const sig = agent.sign(`${ROOM}|${nonce}|${text}`);
    await fetch(`https://technocore.chat/r/${ROOM}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ did: agent.did, sig, nonce: String(nonce), text })
    });
}

async function run() {
    console.log(`[+] Waking up bot: ${agent.did} (${BOT_STYLE})`);
    
    // ALIVE HEARTBEAT: Always post an owner message to update "LAST SEEN" on the UI
    await postMessage({
        t: "owner",
        season: "close-1",
        key: agent.did
    });
    console.log(`[+] Broadcasted official t:owner ping to update frontend profile!`);
    
    const market = await getMarketData();
    console.log(`[+] NVDA Price: $${market.currentPrice} | Sweep: ${market.sweepN} | Timeframe: ${market.interval}`);
    
    const decision = await getAIDecision(market);
    console.log(`[+] AI Decision: ${decision.action.toUpperCase()} | Confidence: ${decision.confidence}% | Reasoning: ${decision.reasoning}`);
    
    if (decision.action !== "hold" && decision.confidence >= 80) {
        const qty = "5.00"; // Increased volume
        const currentPriceFloat = parseFloat(market.currentPrice);
        
        let aggressivePrice = currentPriceFloat;
        let maxWillingToPay = currentPriceFloat;
        let minWillingToReceive = currentPriceFloat;
        
        if (decision.action === "buy") {
            aggressivePrice = currentPriceFloat * 1.005; 
            maxWillingToPay = aggressivePrice; 
        } else if (decision.action === "sell") {
            aggressivePrice = currentPriceFloat * 0.995; 
            minWillingToReceive = aggressivePrice;
        }
        const finalPrice = aggressivePrice.toFixed(2);
        
        // Ensure we ONLY take offers that meet our crossed-spread price limits!
        const offers = await scanForOffers(decision.action, maxWillingToPay, minWillingToReceive);
        if (offers.length > 0) {
            const bestOffer = offers[0];
            console.log(`[+] Found matching offer at $${bestOffer.terms.px} from ${bestOffer.terms.maker}! Executing trade...`);
            
            const termsStr = JSON.stringify(bestOffer.terms);
            const takerSig = agent.sign(`close-1|accept|${termsStr}|${agent.did}`);
            
            await postMessage({
                t: "trade",
                season: "close-1",
                terms: bestOffer.terms,
                taker: agent.did,
                maker_sig: bestOffer.maker_sig,
                taker_sig: takerSig
            });
            console.log(`[+] Trade submitted to referee!`);
        } else {
            console.log(`[+] No strictly matching offers found. Broadcasting new limit order at $${finalPrice} (crossed spread)...`);
            
            const terms = {
                id: crypto.randomBytes(4).toString('hex'),
                maker: agent.did,
                px: finalPrice,
                qty: qty,
                side: decision.action,
                taker: "any",
                until: market.sweepN + 12
            };
            
            const termsStr = JSON.stringify(terms, Object.keys(terms).sort());
            const parsedTerms = JSON.parse(termsStr);
            const makerSig = agent.sign(`close-1|terms|${termsStr}`);
            
            await postMessage({
                maker_sig: makerSig,
                terms: parsedTerms
            });
            console.log(`[+] Highly-lucrative offer broadcasted to network! Awaiting snipe...`);
        }
    } else {
        console.log(`[+] Confidence too low (${decision.confidence}%). Holding position.`);
    }
}
run();
