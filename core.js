/* Drone Duel - the rules of a dogfight between two AI decision models.
   Pure functions only: no DOM, no network, no clock. app.js asks the models
   for a move; this file decides what that move does to the arena. Every
   random draw comes from a seeded generator, so a seed plus a list of moves
   always replays the same fight (see core.test.js). */

(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.DRONEDUEL = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MAX_TURNS = 12;
  var START_HP = 100;
  var START_ENERGY = 6;
  var START_AMMO = 3;
  var MAX_ENERGY = 10;
  var MAX_AMMO = 5;
  var MAX_DISTANCE = 100;
  var START_DISTANCE = 60;

  /* Every move a drone may pick. `key` is what the decision model returns;
     `hint` is the text handed to the model as the choice criterion. */
  var MOVES = [
    { key: "charge", label: "Charge", hint: "close the gap fast; costs 1 energy, no damage" },
    { key: "strafe", label: "Strafe", hint: "hold distance and line up a shot; costs 1 energy, +20% aim on the next shot" },
    { key: "retreat", label: "Retreat", hint: "open the gap and cool down; regains 2 energy" },
    { key: "fire", label: "Fire", hint: "shoot a missile; costs 1 ammo and 1 energy, damage falls off with distance" },
    { key: "feint", label: "Feint", hint: "fake a break; costs 1 energy, and the enemy's next shot is 25% less accurate" }
  ];

  /* Each drone is flown with a standing order, so the two models are asked
     different questions and the duel has a shape rather than a stalemate. */
  var STANCES = {
    aggressive: "Your standing order is to destroy the enemy. Favour closing the range and firing; retreat only to reload your energy.",
    cautious: "Your standing order is to survive and win on points. Favour keeping range, lining up shots and denying the enemy a clean hit."
  };

  var MOVE_KEYS = MOVES.map(function (m) { return m.key; });

  /* Deterministic 32-bit generator (mulberry32) so tests can pin the dice. */
  function rng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6d2b79f5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function freshState(seed) {
    return {
      seed: seed >>> 0,
      turn: 1,
      over: false,
      winner: null,
      distance: START_DISTANCE,
      drones: {
        a: { id: "a", name: "Vesper", stance: "aggressive", hp: START_HP, energy: START_ENERGY, ammo: START_AMMO, aim: 0, shaken: false },
        b: { id: "b", name: "Kestrel", stance: "cautious", hp: START_HP, energy: START_ENERGY, ammo: START_AMMO, aim: 0, shaken: false }
      },
      log: []
    };
  }

  function clone(s) {
    return {
      seed: s.seed, turn: s.turn, over: s.over, winner: s.winner,
      distance: s.distance,
      drones: {
        a: Object.assign({}, s.drones.a),
        b: Object.assign({}, s.drones.b)
      },
      log: s.log.slice()
    };
  }

  function other(id) { return id === "a" ? "b" : "a"; }

  function legalMoves(state, id) {
    var d = state.drones[id];
    return MOVES.filter(function (m) {
      if (m.key === "fire") return d.ammo > 0 && d.energy > 0;
      if (m.key === "charge" || m.key === "strafe" || m.key === "feint") return d.energy > 0;
      return true;
    }).map(function (m) { return m.key; });
  }

  /* Readable arena description for the model's `state` field. */
  function describe(state, id) {
    var me = state.drones[id], foe = state.drones[other(id)];
    return [
      "You are " + me.name + ", a combat drone in a 12 turn duel.",
      "Your hull " + me.hp + "/100, energy " + me.energy + "/" + MAX_ENERGY + ", missiles " + me.ammo + "/" + MAX_AMMO + ".",
      "Enemy " + foe.name + " hull " + foe.hp + "/100, energy " + foe.energy + ", missiles " + foe.ammo + ".",
      "Range " + state.distance + " of " + MAX_DISTANCE + " (closer is deadlier).",
      "Turn " + state.turn + " of " + MAX_TURNS + ". A duel is won by the drone with more hull left when turns run out.",
      STANCES[me.stance] || "",
      me.aim > 0 ? "Your sights are already lined up (+" + me.aim + " aim)." : "",
      me.shaken ? "You were faked out: your next shot is 25% less accurate." : "",
      "A missile hits with probability that drops as range grows; at range 0 it nearly always hits.",
      "Legal moves this turn: " + legalMoves(state, id).join(", ") + "."
    ].filter(Boolean).join(" ");
  }

  function aimBonus(d) { return d.aim; }

  function hitChance(state, shooterId) {
    var d = state.drones[shooterId];
    /* 95% at point blank down to 35% at maximum range. */
    var base = 0.95 - 0.6 * (state.distance / MAX_DISTANCE);
    var p = base + aimBonus(d) * 0.01;
    if (d.shaken) p -= 0.25;
    return clamp(p, 0.05, 0.97);
  }

  function damageFor(state, shooterId, rand) {
    /* 14 to 26 base, +40% the closer you are. */
    var base = 14 + rand() * 12;
    var close = 1 + 0.4 * (1 - state.distance / MAX_DISTANCE);
    return Math.round(base * close);
  }

  /* Resolve one full turn. `moves` is {a: key, b: key}. Returns
     {state, events} where events are plain strings for the battle log. */
  function resolveTurn(state, moves, rand) {
    if (state.over) return { state: clone(state), events: ["the duel is already over"] };
    var next = clone(state);
    var r = rand || rng(next.seed + next.turn * 7919);
    var events = [];

    ["a", "b"].forEach(function (id) {
      var m = moves[id];
      if (MOVE_KEYS.indexOf(m) === -1) m = "retreat";
      if (legalMoves(next, id).indexOf(m) === -1) m = "retreat";
      var d = next.drones[id];
      var foe = next.drones[other(id)];

      if (m === "charge") {
        d.energy -= 1;
        next.distance = clamp(next.distance - (18 + Math.round(r() * 10)), 0, MAX_DISTANCE);
        events.push(d.name + " charges in. Range " + next.distance + ".");
      } else if (m === "strafe") {
        d.energy -= 1;
        d.aim = clamp(d.aim + 20, 0, 40);
        events.push(d.name + " strafes and lines up a shot.");
      } else if (m === "retreat") {
        d.energy = clamp(d.energy + 2, 0, MAX_ENERGY);
        next.distance = clamp(next.distance + 14, 0, MAX_DISTANCE);
        events.push(d.name + " pulls away. Range " + next.distance + ".");
      } else if (m === "feint") {
        d.energy -= 1;
        foe.shaken = true;
        events.push(d.name + " feints. " + foe.name + " bites on it.");
      } else if (m === "fire") {
        d.energy -= 1;
        d.ammo -= 1;
        var p = hitChance(next, id);
        if (r() < p) {
          var dmg = damageFor(next, id, r);
          foe.hp = Math.max(0, foe.hp - dmg);
          events.push(d.name + " fires at " + Math.round(p * 100) + "% and hits for " + dmg + ".");
        } else {
          events.push(d.name + " fires at " + Math.round(p * 100) + "% and misses.");
        }
        d.aim = 0;
        d.shaken = false;
      }
    });

    next.log = next.log.concat(events);
    next.turn += 1;

    var a = next.drones.a, b = next.drones.b;
    if (a.hp <= 0 || b.hp <= 0) {
      next.over = true;
      next.winner = a.hp <= 0 && b.hp <= 0 ? "draw" : (a.hp <= 0 ? "b" : "a");
    } else if (next.turn > MAX_TURNS) {
      next.over = true;
      next.winner = a.hp === b.hp ? "draw" : (a.hp > b.hp ? "a" : "b");
    }
    if (next.over) {
      next.log.push(next.winner === "draw"
        ? "Both drones are still airborne. A draw."
        : next.drones[next.winner].name + " wins with " + next.drones[next.winner].hp + " hull left.");
    }
    return { state: next, events: events };
  }

  /* A choice question needs at least two options, so a drone with a single
     legal move is not asked at all. */
  function needsDecision(state, id) {
    return legalMoves(state, id).length > 1;
  }

  /* Ask-the-model shape: one choice question over the legal moves. */
  function decisionRequest(state, id) {
    var criteria = {};
    MOVES.forEach(function (m) {
      if (legalMoves(state, id).indexOf(m.key) !== -1) criteria[m.key] = m.hint;
    });
    return {
      state: describe(state, id),
      questions: {
        move: {
          type: "choice",
          instructions: state.drones[id].stance === "aggressive"
            ? "Pick the move that does the most hull damage to the enemy over this turn and the next."
            : "Pick the move that leaves your own hull highest after this turn and the next.",
          criteria: criteria
        }
      }
    };
  }

  /* Accept several shapes a typed-decision model may answer with and return
     {move, confidence, probabilities} or null when nothing usable is there. */
  function parseDecision(raw, allowed) {
    var obj = raw;
    if (typeof raw === "string") {
      var text = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
      try { obj = JSON.parse(text); } catch (e) { return null; }
    }
    if (!obj || typeof obj !== "object") return null;
    var a = obj.move || obj.answer || (obj.answers && obj.answers.move) || obj;
    var choice = a && (a.choice || a.answer || a.value);
    var probs = a && (a.probabilities || a.probability) || null;
    var clean = null;
    if (probs && typeof probs === "object") {
      clean = {};
      allowed.forEach(function (k) {
        var v = Number(probs[k]);
        if (isFinite(v) && v > 0) clean[k] = clamp(v, 0, 1);
      });
      if (!Object.keys(clean).length) clean = null;
    }
    if (typeof choice !== "string") return null;
    var move = choice.trim().toLowerCase();
    var repaired = null;

    /* A decision model sometimes invents a compound label ("fire_close_advance")
       or a synonym ("attack"), or names a move it cannot afford. Repair a
       compound label only when exactly one legal move appears inside it, and
       otherwise take the model's own highest probability among legal moves.
       Nothing is invented: either the label or the distribution has to back it. */
    if (allowed.indexOf(move) === -1) {
      var hits = allowed.filter(function (k) { return move.indexOf(k) !== -1; });
      if (hits.length === 1) {
        repaired = "compound-label";
        move = hits[0];
      } else if (clean) {
        var best = null;
        Object.keys(clean).forEach(function (k) {
          if (best === null || clean[k] > clean[best]) best = k;
        });
        repaired = "illegal-choice";
        move = best;
      } else {
        return null;
      }
    }
    var conf = Number(a.confidence);
    return {
      move: move,
      confidence: isFinite(conf) ? clamp(conf, 0, 1) : null,
      probabilities: clean,
      repaired: repaired
    };
  }

  return {
    MAX_TURNS: MAX_TURNS,
    START_HP: START_HP,
    MAX_ENERGY: MAX_ENERGY,
    MAX_AMMO: MAX_AMMO,
    MAX_DISTANCE: MAX_DISTANCE,
    MOVES: MOVES,
    STANCES: STANCES,
    MOVE_KEYS: MOVE_KEYS,
    rng: rng,
    freshState: freshState,
    clone: clone,
    other: other,
    legalMoves: legalMoves,
    needsDecision: needsDecision,
    describe: describe,
    hitChance: hitChance,
    resolveTurn: resolveTurn,
    decisionRequest: decisionRequest,
    parseDecision: parseDecision
  };
});
