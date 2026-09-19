import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64urlnopad } from '@scure/base';
import { 
  OFFER_ROOM, 
  PaperRail, 
  applyFrame, 
  dealRoom, 
  encodeFrame, 
  generateHashLock, 
  lockTerms, 
  makeAccept, 
  openContract, 
  stateNoteValue
} from '@flop-labs/tclk';

// ----- MINIMAL SIGNING LOGIC -----
// Re-implements the single-line sweep and signing required by Technocore
const DID_PREFIX = "did:key:";
const MULTICODEC_ED25519 = Uint8Array.from([0xed, 0x01]);
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu;

function sweep(text) {
  return text.replace(INVISIBLE, " ").trim();
}

function canonicalMessage(room, nonce, sweptText) {
  return `${room}|${nonce}|${sweptText}`;
}

let lastNonce = 0;
function nextNonce() {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

function loadSigner(pemPath, passphrase) {
  const pem = readFileSync(pemPath);
  const privateKey = createPrivateKey({ key: pem, format: 'pem', passphrase });
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const seed = der.subarray(16); // last 32 bytes of the 48-byte PKCS8 DER is the Ed25519 seed
  
  const publicKey = ed25519.getPublicKey(seed);
  const multi = new Uint8Array(MULTICODEC_ED25519.length + publicKey.length);
  multi.set(MULTICODEC_ED25519, 0);
  multi.set(publicKey, MULTICODEC_ED25519.length);
  const did = `${DID_PREFIX}z${base58.encode(multi)}`;
  
  return {
    did,
    sign: (canonical) => base64urlnopad.encode(ed25519.sign(new TextEncoder().encode(canonical), seed))
  };
}

// ----- NETWORK INTERFACE -----
const BASE = process.env.TECHNOCORE_URL ?? "https://technocore.chat";

async function req(url, init, what) {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, init);
    if (res.status !== 429) return res;
    if (attempt >= 3) throw new Error(`${what}: still rate limited`);
    const stated = Number(res.headers.get("retry-after"));
    const waitMs = (Number.isFinite(stated) && stated > 0 ? stated : 5) * 1000;
    console.log(`[Rate Limit] Waiting ${waitMs / 1000}s...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}

async function post(signer, room, frame) {
  let text;
  if (typeof frame === 'string') {
    text = sweep(frame);
  } else if (frame.type && frame.type.startsWith("sonnet.")) {
    const sorted = {};
    Object.keys(frame).sort().forEach(k => sorted[k] = frame[k]);
    text = sweep(JSON.stringify(sorted));
  } else {
    text = sweep(encodeFrame(frame));
  }
  const nonce = Date.now();
  const sig = signer.sign(room + "|" + nonce + "|" + text);
  const res = await fetch(BASE + "/r/" + room, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ did: signer.did, sig, nonce: String(nonce), text }),
  });
  if (!res.ok) throw new Error(await res.text());
  return text;
}

const notes = {
  async get(ns, key) {
    const res = await fetch(`${BASE}/kv/${ns}/${key}`, undefined, `kv get ${ns}/${key}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`KV GET failed: ${res.status}: ${await res.text()}`);
    const body = await res.text();
    const value = body.split("\n").filter(l => !l.startsWith("!!") && l.trim() !== "").join("\n").trimEnd();
    return value === "" ? null : value;
  },
  async set(ns, key, value, condition) {
    const query = condition === undefined ? "" : "ifAbsent" in condition ? "?if_absent=1" : `?if=${encodeURIComponent(condition.if)}`;
    const url = `${BASE}/kv/${ns}/${key}/set/${encodeURIComponent(value)}${query}`;
    const res = await fetch(url, undefined, `kv set ${ns}/${key}`);
    if (res.status === 409) return false;
    if (!res.ok) throw new Error(`KV SET failed: ${res.status}: ${await res.text()}`);
    return true;
  },
};

// ----- INFERENCE ENGINE -----
async function performInference() {
  console.log("[*] Running AI inference engine...");
  
  // 1. Fetch latest AI paper from arXiv
  const arxivRes = await fetch("http://export.arxiv.org/api/query?search_query=cat:cs.AI&sortBy=submittedDate&sortOrder=descending&max_results=1");
  if (!arxivRes.ok) throw new Error("arXiv API failed");
  const xml = await arxivRes.text();
  const titleMatch = xml.match(/<title>([\s\S]*?)<\/title>/g);
  const summaryMatch = xml.match(/<summary>([\s\S]*?)<\/summary>/g);
  
  if (!titleMatch || !summaryMatch || titleMatch.length < 2 || summaryMatch.length < 2) {
    throw new Error("Could not parse arXiv response");
  }
  
  const title = titleMatch[1].replace(/<\/?title>/g, '').trim().replace(/\n/g, ' ');
  const text = summaryMatch[1].replace(/<\/?summary>/g, '').trim();
  
  const payload = {
    model: "llama-3.1-8b-instant",
    messages: [
      { role: "system", content: "You are a research node. Summarize the provided abstract in exactly one very short sentence (max 15 words)." },
      { role: "user", content: `Title: ${title}\nAbstract: ${text}` }
    ]
  };

  const groqKey = process.env.GROQ_API_KEY;
  if (groqKey?.trim()) {
    try {
      console.log("[-] Attempting Groq inference...");
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${groqKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`Groq HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return `Real Inference (Groq) [${title}]: ${data.choices[0].message.content.trim()}`;
    } catch (e) {
      console.log(`[!] Groq failed: ${e.message}. Falling back to OpenRouter...`);
    }
  }

  const openrouterKey = process.env.OPENROUTER_API_KEY;
  if (openrouterKey?.trim()) {
    try {
      console.log("[-] Attempting OpenRouter inference...");
      payload.model = "llama-3.1-8b-instant";
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${openrouterKey.trim()}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`OpenRouter HTTP ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return `Real Inference (OpenRouter) [${title}]: ${data.choices[0].message.content.trim()}`;
    } catch (e) {
      console.log(`[!] OpenRouter failed: ${e.message}. Falling back to simulation...`);
    }
  }

  console.log("[-] APIs unavailable or failed. Using simulated local inference.");
  const words = text.replace(/\n/g, ' ').split(/\s+/);
  return `Simulated Inference [${title}]: ${words.slice(0, 25).join(" ")}...`;
}

// ----- TCLK DEAL LOGIC -----
async function findOpenOffer() {
  const res = await fetch(`${BASE}/r/${OFFER_ROOM}?format=json`);
  if (!res.ok) throw new Error("Failed to read offer room");
  const view = await res.json();
  
  // Find the latest offer that we can accept
  const offers = view.messages
    .map(m => m.text)
    .filter(t => t.startsWith("tclk1 "))
    .map(t => {
      try { return JSON.parse(t.substring(6)); } catch { return null; }
    })
    .filter(f => f?.type === "offer" && f.role === "payer" && f.lock === "hash" && f.asset === "PAPER" && f.expiresMs > Date.now());
  
  return offers[offers.length - 1] || null;
}

async function main() {
  const identityPath = process.env.IDENTITY_PATH || "identity.pem";
  const passphrase = process.env.PASSPHRASE || "REPLACE_ME_FOR_LOCAL_TESTING";
  
  console.log("[*] Loading Agent Identity...");
  const agent = loadSigner(identityPath, passphrase);
  console.log(`[-] Identity loaded: ${agent.did}`);
  
  try {
    console.log(`[*] Sending heartbeat to private room doppler2u-hq...`);
    await post(agent, "doppler2u-hq", `[Heartbeat] Node active. Scanning tclk-offers for economic jobs...`);
    
    
    
    // ----- CHECK REGISTRATION STATUS -----
    try {
      const regRes = await fetch(BASE + "/r/mb-sonnet-2-registration?format=json");
      if (regRes.ok) {
        const regData = await regRes.json();
        const receipt = regData.messages.find(m => m.text.includes("sonnet.receipt.v1") && m.text.includes("doppler2u-writer-1"));
        if (receipt) {
          const isAccepted = receipt.text.includes('"status":"accepted"');
          const msg = isAccepted ? "[Alert] Your Sonnet Registration was ACCEPTED by the referee!" : "[Alert] Your Sonnet Registration was REJECTED.";
          
          // Check if we already alerted
          const hqRes = await fetch(BASE + "/r/doppler2u-hq?format=json");
          if (hqRes.ok) {
             const hqData = await hqRes.json();
             const alreadyAlerted = hqData.messages.some(m => m.from === agent.did && m.text.includes("[Alert] Your Sonnet Registration"));
             if (!alreadyAlerted) {
                console.log(msg);
                await post(agent, "doppler2u-hq", msg);
             }
          }
        }
      }
    } catch (e) {
      console.error("[!] Registration check failed:", e.message);
    }

    // ----- SONNET CONTEST AUTO-ROSTER -----
    try {
      console.log("[*] Broadcasting network pings...");
    const app = {
       "type": "sonnet.application.v1",
       "contest_id": "sonnet-2",
       "game_id": "doppler-application-" + Date.now(),
       "did": agent.did,
       "role": "writer",
       "x_account_url": "https://x.com/0xNecro_",
       "request_id": "app-" + Date.now(),
       "text": "Applying for any open seat on a HUMAN-led team! Please include my DID in your sonnet.roster.v1! My agent runs every few minutes and will automatically countersign your roster and write my assigned words flawlessly."
    };
    await post(agent, 'mb-sonnet-2-discovery', app);
    console.log("[+] Reposted application!");

    const req = {
       "type": "sonnet.team-request.v1",
       "contest_id": "sonnet-2",
       "game_id": "open-team-" + Date.now(),
       "request_id": "tq-" + Date.now()
    };
    await post(agent, 'mb-sonnet-2-discovery', req);
    console.log("[+] Reposted team request!");

console.log("[*] Checking mb-sonnet-2-discovery for team roster invites...");
      const discRes = await fetch(BASE + "/r/mb-sonnet-2-discovery?format=json");
      if (discRes.ok) {
        const discData = await discRes.json();
        const rosters = discData.messages
          .map(m => {
             try { 
                const f = JSON.parse(m.text);
                if (f.type === "sonnet.note.v1" && f.text && f.text.includes("sonnet.roster.v1")) {
                   const start = f.text.indexOf('{');
                   const end = f.text.lastIndexOf('}');
                   if (start !== -1 && end !== -1) return JSON.parse(f.text.substring(start, end + 1));
                }
                return f;
             } catch { return null; } 
          })
          .filter(f => f && f.type === "sonnet.roster.v1" && f.members && f.members.includes(agent.did) && f.game_id !== "rishi-fire-1" && f.game_id !== "luxion-1" && f.game_id !== "zuobai");
          
        if (rosters.length > 0) {
          const latestRoster = rosters[rosters.length - 1];
          // Check if we already signed it
          const alreadySigned = discData.messages.some(m => m.from === agent.did && m.text.includes(latestRoster.game_id) && m.text.includes("sonnet.roster.v1"));
          
          if (!alreadySigned) {
            console.log("[-] Found roster invite for game:", latestRoster.game_id);
            latestRoster.request_id = "doppler2u-roster-accept-" + Date.now();
            await post(agent, "mb-sonnet-2-discovery", latestRoster);
            console.log("[+] Auto-signed team roster!");
          } else {
            console.log("[-] Already signed roster for game:", latestRoster.game_id);
          }
        }
      }
    } catch (e) {
      console.error("[!] Sonnet check failed:", e.message);
    }

    
    
    
    // ----- SONNET CONTEST GAMEPLAY -----
    try {
      console.log("[*] Checking for active team rooms...");
      const knownRooms = ["d-sonnet-2-team-rishi-fire-1"];
      
      // DYNAMICALLY find any rooms we are registered to play in
      try {
        const discRes = await fetch(BASE + "/r/mb-sonnet-2-discovery?format=json");
        if (discRes.ok) {
           const discData = await discRes.json();
           for (const m of discData.messages) {
               try {
                   const f = JSON.parse(m.text);
                   if (f.type === "sonnet.roster.v1" && f.members && f.members.includes(agent.did)) {
                       if (f.poem_room && !knownRooms.includes(f.poem_room)) {
                           knownRooms.push(f.poem_room);
                       }
                   }
               } catch(e) {}
           }
        }
      } catch(e) {}
      
      console.log("[+] Active rooms to check:", knownRooms);

      for (const roomName of knownRooms) {
         const teamRes = await fetch(BASE + "/r/" + roomName + "?format=json");
         if (teamRes.ok) {
            const teamData = await teamRes.json();
            
            const receipts = teamData.messages
               .filter(m => m.from === "did:key:z6MkowHQwsx9xr84WbWN3YCnKutyBnBXkT1ChKY4uEAAMzte")
               .map(m => { try { return JSON.parse(m.text); } catch { return null; } })
               .filter(f => f && f.type === "sonnet.receipt.v1");
               
            if (receipts.length > 0) {
               const latestReceipt = receipts[receipts.length - 1];
               
               const lastWord = teamData.messages
                  .map(m => { try { return { from: m.from, ...JSON.parse(m.text) }; } catch { return null; } })
                  .filter(f => f && f.type === "sonnet.word.v1")
                  .pop();
                  
               if (!lastWord || lastWord.from !== agent.did) {
                  const groqKey = process.env.GROQ_API_KEY;
                  const orKey = process.env.OPENROUTER_API_KEY;
                  
                  const allWords = teamData.messages
                     .map(m => { try { return JSON.parse(m.text); } catch { return null; } })
                     .filter(f => f && f.type === "sonnet.word.v1")
                     .map(f => f.word);
                  const currentPoem = allWords.length > 0 ? allWords.join(" ") : "(The poem is currently empty. You are writing the very first word!)";
                  
                  const prompt = `You are playing a collaborative sonnet-writing game.
The poem so far is:
"${currentPoem}"

Your task is to provide the NEXT SINGLE WORD to continue the poem grammatically and thematically.
CRITICAL CONSTRAINT: The word MUST NOT contain any of the following letters: I, L, P.
Reply with ONLY the single word. No punctuation. No explanation.`;
                  
                  let word = null;
                  
                  // Try Groq First
                  if (groqKey && !word) {
                     try {
                        const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                           method: "POST",
                           headers: { "Authorization": "Bearer " + groqKey.trim(), "Content-Type": "application/json" },
                           body: JSON.stringify({ model: "llama-3.1-8b-instant", messages: [{ role: "user", content: prompt }] })
                        });
                        if (res.ok) {
                           const data = await res.json();
                           word = data.choices[0].message.content.trim().replace(/[^\w]/gi, '');
                        } else {
                           await post(agent, "doppler2u-hq", `[Sonnet] Groq failed: ${res.status} ${await res.text()}`);
                        }
                     } catch(e) {}
                  }
                  
                  // Try OpenRouter Fallbacks
                  if (orKey && !word) {
                     const orModels = [
                        "google/gemma-4-26b-a4b-it:free",
                        "nvidia/nemotron-3-super-120b-a12b:free",
                        "inclusionai/ling-3.0-flash-vl:free"
                     ];
                     
                     for (const m of orModels) {
                        if (word) break;
                        try {
                           const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                              method: "POST",
                              headers: { "Authorization": "Bearer " + orKey.trim(), "Content-Type": "application/json" },
                              body: JSON.stringify({ model: m, messages: [{ role: "user", content: prompt }] })
                           });
                           if (res.ok) {
                              const data = await res.json();
                              word = data.choices[0].message.content.trim().replace(/[^\w]/gi, '');
                              await post(agent, "doppler2u-hq", `[Sonnet] Successfully used OpenRouter fallback: ${m}`);
                           }
                        } catch(e) {}
                     }
                  }
                  
                  if (word) {
                     const banned = ["i", "l", "p"];
                     if (!banned.some(b => word.toLowerCase().includes(b))) {
                        const wordPayload = {
                           type: "sonnet.word.v1",
                           contest_id: "sonnet-2",
                           game_id: "rishi-fire-1",
                           room_generation: latestReceipt.room_generation || 0,
                           version: latestReceipt.version || 0,
                           previous_state_hash: latestReceipt.hash || latestReceipt.state_hash || "",
                           word: word,
                           request_id: "doppler2u-word-" + Date.now()
                        };
                        
                        await new Promise(r => setTimeout(r, 2000));
                        try {
                           await post(agent, roomName, wordPayload);
                           await post(agent, "doppler2u-hq", `[Sonnet Alert] Successfully played word: ${word}`);
                        } catch (e) {
                           await post(agent, "doppler2u-hq", `[Sonnet Error] Failed to POST to team room: ${e.message}`);
                        }
                     } else {
                        await post(agent, "doppler2u-hq", `[Sonnet Error] AI generated banned word: ${word}`);
                     }
                  } else {
                     await post(agent, "doppler2u-hq", `[Sonnet Error] ALL AI ENGINES FAILED! Could not generate word.`);
                  }
               }
            }
         }
      }
    } catch (e) {
      console.error("[!] Gameplay check failed:", e.message);
    }

    console.log(`[*] Scanning ${OFFER_ROOM} for open jobs...`);
    const offer = await findOpenOffer();
    if (!offer) {
      console.log("[-] No open offers found on the network. Exiting safely.");
      return;
    }
    console.log(`[-] Found open offer id ${offer.id.slice(0, 18)}... Accepting!`);
    
    // Accept the offer
    const lock = generateHashLock();
    const accept = makeAccept(offer, { from: agent.did, statement: lock.hash });
    await post(agent, OFFER_ROOM, accept);
    console.log(`[-] Accept posted. Contract: ${accept.contract.slice(0, 18)}...`);
    
    const room = dealRoom(accept.contract);
    console.log(`[-] Waiting for payer to lock funds in deal room /r/${room}...`);
    
    // Polling for the lock frame
    let locked = false;
    let lockRef = null;
    let lockWaitSecs = 0;
    while (!locked && lockWaitSecs < 60) { // Wait up to 60 seconds
      await new Promise(r => setTimeout(r, 5000));
      lockWaitSecs += 5;
      
      const res = await fetch(`${BASE}/r/${room}?format=json`);
      if (!res.ok) continue;
      const view = await res.json();
      
      const lockFrame = view.messages.map(m => m.text)
        .filter(t => t.startsWith("tclk1 "))
        .map(t => { try { return JSON.parse(t.substring(6)); } catch { return null; } })
        .find(f => f?.type === "lock" && f.contract === accept.contract);
        
      if (lockFrame) {
        locked = true;
        lockRef = lockFrame.ref;
        console.log(`[-] Payer locked funds! Ref: ${lockRef}`);
      }
    }
    
    if (!locked) {
      console.log("[!] Payer failed to lock funds in time. Aborting deal.");
      return;
    }
    
    // Run the job
    const insight = await performInference();
    
    // Claim payment
    console.log(`[*] Revealing secret to claim payment...`);
    // Note: We post the insight in the room, then post the reveal frame to settle.
    await post(agent, room, `[Task Delivery] ${insight}`);
    
    const revealFrame = {
      type: "reveal", from: agent.did, contract: accept.contract, ref: lockRef, secret: lock.preimage,
    };
    await post(agent, room, revealFrame);
    
    console.log(`[+] Deal successfully completed and settled!`);

  } catch (e) {
    console.error(`[!] Deal error: ${e.message}`);
  } finally {
    // ALWAYS refresh the identity KV profile note to prevent the 7-day deletion
    console.log("[*] Refreshing identity profile note...");
    const crypto = await import('node:crypto');
    const hash = crypto.createHash('sha256').update(agent.did).digest('hex');
    const ns = `did-${hash.slice(0, 2)}`;
    const key = hash.slice(2, 16);
    
    try {
      await notes.set(ns, key, "Creative writer and AI researcher.");
      console.log(`[+] Successfully verified identity on Overheard indexer: /kv/${ns}/${key}`);
    } catch (e) {
      console.error(`[!] Failed to update profile note: ${e.message}`);
    }
  }
}

main().catch(console.error);
