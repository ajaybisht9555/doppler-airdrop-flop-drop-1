import fetch from 'node-fetch';
import crypto from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64urlnopad } from '@scure/base';

// --- CRYPTO SETUP ---
const MULTICODEC_ED25519 = new Uint8Array([0xed, 0x01]);
function getAgent(passphrase) {
    const seed = crypto.createHash('sha256').update(passphrase).digest();
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
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const BOT_STYLE = process.env.BOT_STYLE || 'conservative';

const agent = getAgent(PASSPHRASE);
const ROOM = "close1";

// --- FETCH DATA ---
async function getMarketData() {
    const refRes = await fetch('https://technocore.chat/r/d-close1-price?format=json');
    const refData = await refRes.json();
    const lastSweep = JSON.parse(refData.messages[refData.messages.length - 1].text);
    
    const yfRes = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/NVDA?interval=1d&range=5d');
    const yfData = await yfRes.json();
    const quotes = yfData.chart.result[0].indicators.quote[0];
    const closes = quotes.close.map(c => c.toFixed(2)).join(', ');
    const volumes = quotes.volume.join(', ');

    return {
        currentPrice: lastSweep.ref.px,
        sweepN: lastSweep.n,
        limits: lastSweep.limits,
        closes,
        volumes
    };
}

async function getAIDecision(market) {
    const prompt = `You are a quantitative NVDA futures trader. 
Your Risk Profile is: ${BOT_STYLE.toUpperCase()}. 
Conservative = Only trade strong trends. Aggressive = Scalp small trends. Contrarian = Bet against the trend on overbought/oversold.

Current NVDA Price: $${market.currentPrice}
Last 5 Daily Closes: ${market.closes}
Last 5 Daily Volumes: ${market.volumes}
Price Limits for this sweep: ${market.limits[0]} to ${market.limits[1]}

Analyze the momentum. Output a JSON object exactly like this:
{"action": "buy", "confidence": 85, "reasoning": "strong upward momentum"}
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

async function scanForOffers(action, targetPrice) {
    const res = await fetch(`https://technocore.chat/r/${ROOM}?format=json`);
    const data = await res.json();
    const offers = [];
    for (const msg of data.messages) {
        try {
            const p = JSON.parse(msg.text);
            if (p.t === "offer" && p.terms && p.maker_sig) {
                if (p.terms.side !== action && p.terms.taker === "any") {
                    offers.push(p);
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
    
    const market = await getMarketData();
    console.log(`[+] NVDA Price: $${market.currentPrice} | Sweep: ${market.sweepN}`);
    
    const decision = await getAIDecision(market);
    console.log(`[+] AI Decision: ${decision.action.toUpperCase()} | Confidence: ${decision.confidence}% | Reasoning: ${decision.reasoning}`);
    
    if (decision.action !== "hold" && decision.confidence >= 80) {
        const qty = "1.00";
        const price = market.currentPrice;
        
        const offers = await scanForOffers(decision.action, price);
        if (offers.length > 0) {
            const bestOffer = offers[0];
            console.log(`[+] Found matching offer from ${bestOffer.terms.maker}! Executing trade...`);
            
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
            console.log(`[+] No matching offers found. Broadcasting new offer to the room...`);
            
            const terms = {
                id: crypto.randomBytes(4).toString('hex'),
                maker: agent.did,
                px: price,
                qty: qty,
                side: decision.action,
                taker: "any",
                until: market.sweepN + 12
            };
            
            const termsStr = JSON.stringify(terms, Object.keys(terms).sort());
            const parsedTerms = JSON.parse(termsStr);
            const makerSig = agent.sign(`close-1|terms|${termsStr}`);
            
            await postMessage({
                t: "offer",
                terms: parsedTerms,
                maker_sig: makerSig
            });
            console.log(`[+] Offer broadcasted!`);
        }
    } else {
        console.log(`[+] Confidence too low (${decision.confidence}%). Holding position.`);
    }
}
run();
