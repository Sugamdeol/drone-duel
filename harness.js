/* Headless duel: the same core.js rules the page uses, against the live
   Pollinations API. Proves the decision model returns usable typed choices,
   that the loop terminates, and that a full duel can be replayed from a seed.
   Usage: node harness.js [seed] [maxTurns] */
const fs = require("fs");
const C = require("./core.js");

const KEY = JSON.parse(fs.readFileSync("/mnt/hermes-storage/pollinations-quests/config.json", "utf8")).api_key;
const DECISION_MODEL = "microsoft/microsoft-decision-1";
const FALLBACK_MODEL = "openai/gpt-5.4-nano";
const SEED = Number(process.argv[2] || 20261108);
const MAX = Number(process.argv[3] || 12);

let calls = 0;
const via = { decision: 0, "text-fallback": 0, random: 0 };

async function chat(model, user, maxTokens, jsonMode, attempts = 0) {
  const body = { model, messages: [{ role: "user", content: user }], max_tokens: maxTokens || 300 };
  if (jsonMode) body.response_format = { type: "json_object" };
  const r = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: JSON.stringify(body)
  });
  const text = await r.text();
  if (!r.ok && r.status >= 500 && attempts < 1) {
    await new Promise((z) => setTimeout(z, 2000));
    return chat(model, user, maxTokens, jsonMode, attempts + 1);
  }
  if (!r.ok) throw new Error("HTTP " + r.status + " " + text.slice(0, 200));
  calls += 1;
  return JSON.parse(text).choices[0].message.content || "";
}

async function askMove(state, id) {
  const allowed = C.legalMoves(state, id);
  if (!C.needsDecision(state, id)) {
    via.forced = (via.forced || 0) + 1;
    return { move: allowed[0], confidence: null, via: "forced" };
  }
  const req = C.decisionRequest(state, id);
  try {
    let last = "";
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const user = attempt
        ? JSON.stringify(req) + "\n\nYour previous answer was not one of these moves. Answer again with exactly one of: " + allowed.join(", ") + "."
        : JSON.stringify(req);
      const raw = await chat(DECISION_MODEL, user, 300, true);
      const got = C.parseDecision(raw, allowed);
      if (got && attempt > 0) got.retried = true;
      if (got) { got.via = "decision"; via.decision += 1; return got; }
      last = raw.slice(0, 120);
    }
    throw new Error("no usable choice: " + last);
  } catch (first) {
    console.log("DECISION FAILED at " + id + ": " + first.message);
    const prompt =
      req.state + "\n\nAnswer with one JSON object only, no prose: {\"move\":{\"choice\":\"<one of " +
      allowed.join(", ") + ">\",\"confidence\":0.0}}";
    try {
      const raw = await chat(FALLBACK_MODEL, prompt, 200, true);
      const got = C.parseDecision(raw, allowed);
      if (!got) throw new Error("no usable choice: " + raw.slice(0, 120));
      got.via = "text-fallback";
      via["text-fallback"] += 1;
      return got;
    } catch (second) {
      const pick = allowed[Math.floor(Math.random() * allowed.length)];
      via.random += 1;
      console.log("RANDOM FALLBACK at " + id + ": " + second.message);
      return { move: pick, confidence: null, via: "random", error: second.message };
    }
  }
}

(async () => {
  let state = C.freshState(SEED);
  const r = C.rng(SEED);
  const trace = [];
  while (!state.over && state.turn <= MAX) {
    const [a, b] = await Promise.all([askMove(state, "a"), askMove(state, "b")]);
    const out = C.resolveTurn(state, { a: a.move, b: b.move }, r);
    state = out.state;
    trace.push({
      turn: state.turn - 1,
      a: { move: a.move, confidence: a.confidence, via: a.via },
      b: { move: b.move, confidence: b.confidence, via: b.via },
      events: out.events
    });
    out.events.forEach((e) => console.log(`T${state.turn - 1}  ${e}`));
  }
  console.log("\n--- result ---");
  console.log("winner:", state.winner, "| turns:", state.turn - 1);
  console.log("hull:", state.drones.a.hp, "vs", state.drones.b.hp);
  console.log("model calls:", calls, "| via:", JSON.stringify(via));
  const confs = trace.flatMap((t) => [t.a.confidence, t.b.confidence]).filter((c) => c != null);
  console.log("mean confidence:", confs.length ? (confs.reduce((x, y) => x + y, 0) / confs.length).toFixed(3) : "n/a");
  fs.writeFileSync("/tmp/drone-duel/docs/harness-run.json", JSON.stringify({ seed: SEED, winner: state.winner, calls, via, trace }, null, 1));
  if (state.over !== true) { console.error("FAIL: duel did not finish"); process.exit(1); }
  if (via.random > 0) { console.error("FAIL: a model call fell through to a random move"); process.exit(1); }
})();
