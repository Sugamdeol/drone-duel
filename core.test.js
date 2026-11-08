/* Rules tests for Drone Duel. No dependencies: node --test core.test.js */
const test = require("node:test");
const assert = require("node:assert");
const C = require("./core.js");

test("fresh state starts both drones at full hull, range 60, turn 1", () => {
  const s = C.freshState(7);
  assert.equal(s.drones.a.hp, 100);
  assert.equal(s.drones.b.hp, 100);
  assert.equal(s.distance, 60);
  assert.equal(s.turn, 1);
  assert.equal(s.over, false);
  assert.equal(s.winner, null);
});

test("the seeded generator repeats exactly", () => {
  const a = C.rng(42), b = C.rng(42);
  for (let i = 0; i < 20; i += 1) assert.equal(a(), b());
});

test("different seeds give different dice", () => {
  const a = C.rng(1), b = C.rng(2);
  assert.notEqual(a(), b());
});

test("charge closes the range and costs one energy", () => {
  const s = C.freshState(1);
  const out = C.resolveTurn(s, { a: "charge", b: "feint" }, C.rng(9));
  assert.ok(out.state.distance < 60);
  assert.equal(out.state.drones.a.energy, 5);
});

test("range never goes below zero or above the maximum", () => {
  let s = C.freshState(3);
  for (let i = 0; i < 6; i += 1) {
    s = C.resolveTurn(s, { a: "charge", b: "charge" }, C.rng(i + 1)).state;
    assert.ok(s.distance >= 0 && s.distance <= C.MAX_DISTANCE);
  }
  let t = C.freshState(4);
  for (let i = 0; i < 6; i += 1) {
    t = C.resolveTurn(t, { a: "retreat", b: "retreat" }, C.rng(i + 1)).state;
    assert.ok(t.distance <= C.MAX_DISTANCE);
  }
});

test("retreat regains energy but never past the cap", () => {
  const s = C.freshState(5);
  s.drones.a.energy = C.MAX_ENERGY;
  const out = C.resolveTurn(s, { a: "retreat", b: "retreat" }, C.rng(2));
  assert.equal(out.state.drones.a.energy, C.MAX_ENERGY);
  const low = C.freshState(5);
  low.drones.a.energy = 2;
  const out2 = C.resolveTurn(low, { a: "retreat", b: "feint" }, C.rng(2));
  assert.equal(out2.state.drones.a.energy, 4);
});

test("a shot costs ammo, and no shot is possible without ammo", () => {
  const s = C.freshState(6);
  const out = C.resolveTurn(s, { a: "fire", b: "feint" }, C.rng(11));
  assert.equal(out.state.drones.a.ammo, 2);
  assert.deepEqual(C.legalMoves(out.state, "a").includes("fire"), true);

  const dry = C.freshState(6);
  dry.drones.a.ammo = 0;
  assert.equal(C.legalMoves(dry, "a").includes("fire"), false);
  const forced = C.resolveTurn(dry, { a: "fire", b: "feint" }, C.rng(11));
  assert.equal(forced.state.drones.a.ammo, 0);
});

test("a drone with no energy cannot charge, strafe, feint or fire", () => {
  const s = C.freshState(8);
  s.drones.a.energy = 0;
  const legal = C.legalMoves(s, "a");
  assert.ok(!legal.includes("charge"));
  assert.ok(!legal.includes("fire"));
  assert.ok(!legal.includes("strafe"));
  assert.ok(legal.includes("retreat"));
  assert.ok(!legal.includes("feint"));
});

test("hit chance falls with range and is clamped", () => {
  const near = C.freshState(1); near.distance = 0;
  const far = C.freshState(1); far.distance = 100;
  assert.ok(C.hitChance(near, "a") > C.hitChance(far, "a"));
  assert.ok(C.hitChance(near, "a") <= 0.97);
  assert.ok(C.hitChance(far, "a") >= 0.05);
});

test("a feint makes the enemy's next shot less accurate, once", () => {
  const s = C.freshState(9);
  const base = C.hitChance(s, "b");
  const out = C.resolveTurn(s, { a: "feint", b: "retreat" }, C.rng(3));
  assert.ok(C.hitChance(out.state, "b") < base);
  const after = C.resolveTurn(out.state, { a: "feint", b: "fire" }, C.rng(3));
  assert.equal(after.state.drones.b.shaken, false);
});

test("strafe aim bonus is spent by the next shot", () => {
  const s = C.freshState(10);
  const out = C.resolveTurn(s, { a: "strafe", b: "feint" }, C.rng(4));
  assert.ok(out.state.drones.a.aim > 0);
  const shot = C.resolveTurn(out.state, { a: "fire", b: "feint" }, C.rng(4));
  assert.equal(shot.state.drones.a.aim, 0);
});

test("a hull never goes negative and the duel ends on a kill", () => {
  const s = C.freshState(12);
  s.drones.b.hp = 5;
  s.distance = 0;
  let out;
  for (let i = 0; i < 6 && !out; i += 1) {
    const r = C.resolveTurn(s, { a: "fire", b: "feint" }, C.rng(i + 1));
    if (r.state.over) out = r;
  }
  assert.ok(out, "a point blank shot at 5 hull should end the duel");
  assert.equal(out.state.drones.b.hp, 0);
  assert.equal(out.state.winner, "a");
});

test("the duel always ends by turn 12 at the latest", () => {
  let s = C.freshState(13);
  let guard = 0;
  while (!s.over && guard < 40) {
    s = C.resolveTurn(s, { a: "feint", b: "feint" }, C.rng(guard + 1)).state;
    guard += 1;
  }
  assert.equal(s.over, true);
  assert.equal(s.turn, C.MAX_TURNS + 1);
});

test("when turns run out the higher hull wins, equal hull is a draw", () => {
  let s = C.freshState(14);
  s.turn = C.MAX_TURNS;
  s.drones.a.hp = 70;
  s.drones.b.hp = 40;
  const out = C.resolveTurn(s, { a: "feint", b: "feint" }, C.rng(1));
  assert.equal(out.state.over, true);
  assert.equal(out.state.winner, "a");

  let t = C.freshState(14);
  t.turn = C.MAX_TURNS;
  t.drones.a.hp = 55;
  t.drones.b.hp = 55;
  const out2 = C.resolveTurn(t, { a: "feint", b: "feint" }, C.rng(1));
  assert.equal(out2.state.winner, "draw");
});

test("an unknown or illegal move falls back to retreat, not a crash", () => {
  const s = C.freshState(15);
  const out = C.resolveTurn(s, { a: "nonsense", b: "fire" }, C.rng(5));
  assert.equal(out.state.drones.a.energy, 8); /* 6 to start, retreat gives 2 */
  assert.equal(out.state.turn, 2);
});

test("a turn on a finished duel changes nothing", () => {
  const s = C.freshState(16);
  s.over = true;
  s.winner = "a";
  const out = C.resolveTurn(s, { a: "charge", b: "charge" }, C.rng(1));
  assert.equal(out.state.turn, s.turn);
  assert.deepEqual(out.events, ["the duel is already over"]);
});

test("resolveTurn does not mutate the state it is given", () => {
  const s = C.freshState(17);
  const before = JSON.stringify(s);
  C.resolveTurn(s, { a: "fire", b: "charge" }, C.rng(6));
  assert.equal(JSON.stringify(s), before);
});

test("the decision request is a single choice question over legal moves only", () => {
  const s = C.freshState(18);
  s.drones.a.ammo = 0;
  const req = C.decisionRequest(s, "a");
  assert.equal(req.questions.move.type, "choice");
  assert.ok(req.questions.move.criteria.charge);
  assert.equal(req.questions.move.criteria.fire, undefined);
  assert.ok(req.state.includes("Vesper"));
  assert.ok(req.state.includes("Range 60"));
});

test("parseDecision accepts a bare object with a choice", () => {
  const got = C.parseDecision({ move: { choice: "charge", confidence: 0.8 } }, C.MOVE_KEYS);
  assert.equal(got.move, "charge");
  assert.equal(got.confidence, 0.8);
});

test("parseDecision accepts the native answers wrapper", () => {
  const got = C.parseDecision({ answers: { move: { type: "choice", choice: "fire", probabilities: { fire: 0.7, retreat: 0.3 } } } }, C.MOVE_KEYS);
  assert.equal(got.move, "fire");
  assert.equal(got.probabilities.fire, 0.7);
});

test("parseDecision reads JSON wrapped in a fenced block", () => {
  const got = C.parseDecision('```json\n{"move":{"choice":"strafe"}}\n```', C.MOVE_KEYS);
  assert.equal(got.move, "strafe");
});

test("parseDecision rejects a move that is not legal", () => {
  assert.equal(C.parseDecision({ move: { choice: "nuke" } }, C.MOVE_KEYS), null);
  assert.equal(C.parseDecision({ move: { choice: "fire" } }, ["charge", "retreat"]), null);
});

test("parseDecision rejects junk instead of guessing", () => {
  assert.equal(C.parseDecision("not json at all", C.MOVE_KEYS), null);
  assert.equal(C.parseDecision({}, C.MOVE_KEYS), null);
  assert.equal(C.parseDecision(null, C.MOVE_KEYS), null);
});

test("parseDecision repairs a compound label when one legal move is inside it", () => {
  assert.equal(C.parseDecision({ move: { choice: "fire_close_advance" } }, C.MOVE_KEYS).move, "fire");
  assert.equal(C.parseDecision({ move: { choice: "Charge In" } }, C.MOVE_KEYS).move, "charge");
});

test("parseDecision refuses to repair an ambiguous label", () => {
  /* both "fire" and "retreat" are inside the label, so there is no safe pick */
  assert.equal(C.parseDecision({ move: { choice: "fire_then_retreat" } }, C.MOVE_KEYS), null);
  assert.equal(C.parseDecision({ move: { choice: "attack" } }, C.MOVE_KEYS), null);
});

test("parseDecision drops probabilities for moves that are not offered", () => {
  const got = C.parseDecision({ move: { choice: "charge", probabilities: { charge: 0.6, nuke: 0.4 } } }, C.MOVE_KEYS);
  assert.deepEqual(Object.keys(got.probabilities), ["charge"]);
});

test("parseDecision takes the highest legal probability when the choice is illegal", () => {
  const got = C.parseDecision({
    move: { choice: "nuke", confidence: 0.5, probabilities: { nuke: 0.5, retreat: 0.3, strafe: 0.2 } }
  }, C.MOVE_KEYS);
  assert.equal(got.move, "retreat");
  assert.equal(got.repaired, "illegal-choice");
});

test("an illegal choice with no usable distribution is still rejected", () => {
  assert.equal(C.parseDecision({ move: { choice: "nuke" } }, C.MOVE_KEYS), null);
  /* a offered but fired dry: distributions over moves that are not allowed are ignored */
  assert.equal(C.parseDecision({ move: { choice: "fire", probabilities: { fire: 0.9 } } }, ["charge", "retreat"]), null);
});

test("a legal choice is never marked as repaired", () => {
  assert.equal(C.parseDecision({ move: { choice: "charge" } }, C.MOVE_KEYS).repaired, null);
});

test("confidence outside 0 to 1 is clamped", () => {
  assert.equal(C.parseDecision({ move: { choice: "charge", confidence: 7 } }, C.MOVE_KEYS).confidence, 1);
  assert.equal(C.parseDecision({ move: { choice: "charge", confidence: -3 } }, C.MOVE_KEYS).confidence, 0);
});

test("a drone with one legal move is not asked a one-option question", () => {
  const s = C.freshState(21);
  s.drones.a.energy = 0;
  s.drones.a.ammo = 0;
  assert.deepEqual(C.legalMoves(s, "a"), ["retreat"]);
  assert.equal(C.needsDecision(s, "a"), false);
  assert.equal(C.needsDecision(s, "b"), true);
});

test("every move in the table is reachable and described", () => {
  const s = C.freshState(20);
  C.MOVES.forEach((m) => {
    assert.ok(C.legalMoves(s, "a").includes(m.key), m.key + " should be legal at full strength");
    assert.ok(m.hint.length > 10);
  });
});

test("the same seed and the same moves replay the same duel", () => {
  const play = () => {
    let s = C.freshState(99);
    const r = C.rng(99);
    while (!s.over) s = C.resolveTurn(s, { a: "charge", b: "fire" }, r).state;
    return JSON.stringify(s);
  };
  assert.equal(play(), play());
});
