/* Drone Duel - the arena drawing, the OAuth flow, and the loop that asks two
   decision models for a move each turn. All the rules live in core.js; this
   file only paints the arena, calls the models and keeps the transcript. No
   build step, no dependencies, no server. Visitors pay with their own Pollen. */

(function () {
  "use strict";

  var C = window.DRONEDUEL;

  var CFG = {
    clientId: "pk_WwUSknOmoKoRzIGX",
    authEndpoint: "https://enter.pollinations.ai/authorize",
    tokenEndpoint: "https://enter.pollinations.ai/api/oauth/token",
    userinfoEndpoint: "https://enter.pollinations.ai/api/oauth/userinfo",
    chatEndpoint: "https://gen.pollinations.ai/v1/chat/completions",
    scope: "profile usage",
    budget: 5,
    expiryDays: 7
  };

  /* The typed decision model the quest is about, with a plain text model as a
     fallback so a duel never stalls when the decision model is unavailable. */
  var DECISION_MODEL = "microsoft/microsoft-decision-1";
  var FALLBACK_MODEL = "openai/gpt-5.4-nano";

  var $ = function (s) { return document.querySelector(s); };

  var S = {
    token: sessionStorage.getItem("drone.token") || null,
    state: null,
    busy: false,
    running: false,
    stop: false,
    calls: 0,
    moves: { a: [], b: [] },
    lastMove: { a: null, b: null }
  };

  /* ------------------------------------------------------------------ auth */

  function pageUrl() {
    return window.location.origin + window.location.pathname.replace(/index\.html$/, "");
  }
  function b64url(buf) {
    var bytes = new Uint8Array(buf), s = "";
    for (var i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function rnd(n) {
    var alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
    var b = new Uint8Array(n), out = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < n; i += 1) out += alphabet[b[i] % alphabet.length];
    return out;
  }
  function signIn() {
    var verifier = rnd(64), state = rnd(24);
    sessionStorage.setItem("drone.verifier", verifier);
    sessionStorage.setItem("drone.state", state);
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)).then(b64url).then(function (ch) {
      var p = new URLSearchParams({
        response_type: "code",
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        scope: CFG.scope,
        budget: String(CFG.budget),
        models: "text",
        expiry: String(CFG.expiryDays),
        state: state,
        code_challenge: ch,
        code_challenge_method: "S256"
      });
      window.location.assign(CFG.authEndpoint + "?" + p.toString());
    });
  }
  function finishSignIn() {
    var params = new URLSearchParams(window.location.search);
    var code = params.get("code"), err = params.get("error");
    if (!code && !err) return Promise.resolve(false);
    if (window.history && window.history.replaceState) window.history.replaceState(null, "", pageUrl());
    if (err) {
      setStatus("Sign in failed: " + err + " " + (params.get("error_description") || ""), "err");
      return Promise.resolve(true);
    }
    var verifier = sessionStorage.getItem("drone.verifier");
    var wantState = sessionStorage.getItem("drone.state");
    var gotState = params.get("state");
    if (!verifier) {
      setStatus("Sign in could not finish because this tab lost its verifier. Sign in again.", "err");
      return Promise.resolve(true);
    }
    if (wantState && gotState && wantState !== gotState) {
      setStatus("Sign in failed: the state did not match. Sign in again.", "err");
      return Promise.resolve(true);
    }
    setStatus("Finishing sign in...", "");
    return fetch(CFG.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        client_id: CFG.clientId,
        redirect_uri: pageUrl(),
        code_verifier: verifier
      })
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || !d.access_token) throw new Error((d && (d.error_description || d.error)) || ("HTTP " + r.status));
        S.token = d.access_token;
        sessionStorage.setItem("drone.token", S.token);
        sessionStorage.removeItem("drone.verifier");
        sessionStorage.removeItem("drone.state");
      });
    }).then(function () {
      setStatus("Signed in. Your own Pollen pays for every move.", "ok");
      return loadUser().then(function () { return true; });
    }).catch(function (e) {
      setStatus("Sign in failed: " + (e && e.message ? e.message : "unknown error"), "err");
      return true;
    });
  }
  function loadUser() {
    if (!S.token) {
      $("#who").textContent = "Not signed in";
      $("#signBtn").textContent = "Sign in with Pollen";
      return Promise.resolve();
    }
    if (S.token.indexOf("sk_") === 0) {
      $("#who").textContent = "Your key";
      $("#signBtn").textContent = "Sign out";
      return Promise.resolve();
    }
    return fetch(CFG.userinfoEndpoint, { headers: { Authorization: "Bearer " + S.token } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (u) {
        var name = (u && (u.name || u.githubUsername || u.username || u.email)) || "Pollen account";
        $("#who").textContent = name;
        $("#signBtn").textContent = "Sign out";
      });
  }
  function toggleSign() {
    if (S.token) {
      S.token = null;
      sessionStorage.removeItem("drone.token");
      loadUser();
      setStatus("Signed out.", "");
      syncButtons();
    } else signIn();
  }
  function toggleKeyRow() {
    var row = $("#keyRow");
    row.hidden = !row.hidden;
    if (!row.hidden) $("#keyInput").focus();
  }
  function saveKey() {
    var k = $("#keyInput").value.trim();
    if (!k) return;
    if (k.indexOf("pk_") === 0) {
      setStatus("That is an app key. A secret key starts with sk_.", "err");
      return;
    }
    if (k.indexOf("sk_") !== 0) {
      setStatus("That does not look like a Pollinations secret key (sk_...).", "err");
      return;
    }
    S.token = k;
    sessionStorage.setItem("drone.token", k);
    $("#keyInput").value = "";
    $("#keyRow").hidden = true;
    $("#who").textContent = "Your key";
    setStatus("Using your key. Your own Pollen pays for every move.", "ok");
    syncButtons();
  }

  /* ----------------------------------------------------------------- model */

  function setStatus(msg, kind) {
    var el = $("#status");
    el.textContent = msg || "";
    el.className = "status" + (kind ? " " + kind : "");
  }

  function chat(model, user, maxTokens, jsonMode, attempt) {
    attempt = attempt || 0;
    var body = {
      model: model,
      messages: [{ role: "user", content: user }],
      max_tokens: maxTokens || 300
    };
    if (jsonMode) body.response_format = { type: "json_object" };
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, 60000);
    return fetch(CFG.chatEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + S.token },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }).then(function (r) {
      return r.text().then(function (text) {
        clearTimeout(timer);
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!r.ok) {
          if (r.status >= 500 && attempt < 1) {
            return new Promise(function (res) { setTimeout(res, 2000); })
              .then(function () { return chat(model, user, maxTokens, jsonMode, attempt + 1); });
          }
          var m = (data && data.error && (data.error.message || data.error)) || text || ("HTTP " + r.status);
          var e2 = new Error(String(typeof m === "string" ? m : JSON.stringify(m)).slice(0, 220));
          e2.status = r.status;
          throw e2;
        }
        S.calls += 1;
        $("#cost").textContent = S.calls;
        var ch = data && data.choices && data.choices[0];
        var content = ch && ch.message ? (ch.message.content || "") : "";
        if (Array.isArray(content)) {
          content = content.map(function (p) { return typeof p === "string" ? p : (p && p.text) || ""; }).join(" ");
        }
        return String(content || "");
      });
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === "AbortError") { e = new Error("the model took longer than 60 seconds"); }
      throw e;
    });
  }

  /* Ask one drone for a move. The decision model gets the native
     state/questions JSON as a string message; anything unusable falls back to
     the plain text model, and a second failure falls back to a legal random
     move so the duel still ends. */
  function askDecision(req, allowed, attempt) {
    /* One retry with the legal list spelled out: the model sometimes answers a
       synonym ("attack") or a label it made up, and saying so fixes most of them. */
    var ask = attempt
      ? JSON.stringify(req) + "\n\nYour previous answer was not one of these moves. Answer again with exactly one of: " + allowed.join(", ") + "."
      : JSON.stringify(req);
    return chat(DECISION_MODEL, ask, 300, true).then(function (raw) {
      var got = C.parseDecision(raw, allowed);
      if (!got) {
        if (attempt < 1) return askDecision(req, allowed, attempt + 1);
        throw new Error("decision model returned no usable choice");
      }
      got.via = "decision";
      return got;
    });
  }

  function askMove(id) {
    var st = S.state;
    var allowed = C.legalMoves(st, id);
    if (!C.needsDecision(st, id)) {
      /* One legal move: no question to ask, so no call to pay for. */
      return Promise.resolve({ move: allowed[0], confidence: null, probabilities: null, via: "forced" });
    }
    var req = C.decisionRequest(st, id);
    return askDecision(req, allowed, 0).catch(function (first) {
      var fallbackPrompt = req.state + "\n\nAnswer with one JSON object only, no prose: {\"move\":{\"choice\":\"<one of " +
        allowed.join(", ") + ">\",\"confidence\":0.0}}";
      return chat(FALLBACK_MODEL, fallbackPrompt, 200, true).then(function (raw) {
        var got = C.parseDecision(raw, allowed);
        if (!got) throw new Error("fallback model returned no usable choice");
        got.via = "text-fallback";
        return got;
      }).catch(function (second) {
        var pick = allowed[Math.floor(Math.random() * allowed.length)];
        return { move: pick, confidence: null, probabilities: null, via: "random", error: second.message };
      });
    });
  }

  /* ---------------------------------------------------------------- drawing */

  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function bar(value, max, cls) {
    var wrap = el("div", "bar " + (cls || ""));
    var fill = el("div", "fill");
    fill.style.width = Math.max(0, Math.min(100, (value / max) * 100)) + "%";
    wrap.appendChild(fill);
    return wrap;
  }

  function paintDrones() {
    var st = S.state;
    ["a", "b"].forEach(function (id) {
      var d = st.drones[id];
      var card = $("#drone-" + id);
      card.querySelector(".hull .num").textContent = d.hp + " / 100";
      card.querySelector(".hull .bar .fill").style.width = d.hp + "%";
      card.querySelector(".energy .num").textContent = d.energy + " / " + C.MAX_ENERGY;
      card.querySelector(".ammo .num").textContent = d.ammo + " / " + C.MAX_AMMO;
      card.querySelector(".aim .num").textContent = d.aim > 0 ? "+" + d.aim : "0";
      card.classList.toggle("shaken", !!d.shaken);
      card.classList.toggle("dead", d.hp <= 0);
      var last = S.lastMove[id];
      card.querySelector(".last").textContent = last ? last : "waiting";
    });
    $("#rangeNum").textContent = st.distance;
    $("#rangeBar .fill").style.width = (st.distance / C.MAX_DISTANCE) * 100 + "%";
    $("#turnNum").textContent = Math.min(st.turn, C.MAX_TURNS) + " / " + C.MAX_TURNS;
  }

  function paintLog() {
    var box = $("#log");
    box.innerHTML = "";
    S.state.log.forEach(function (line) {
      box.appendChild(el("li", null, line));
    });
    box.scrollTop = box.scrollHeight;
  }

  function paintMoves() {
    ["a", "b"].forEach(function (id) {
      var box = $("#moves-" + id);
      box.innerHTML = "";
      S.moves[id].slice(-6).forEach(function (m) {
        var chip = el("span", "chip" + (m.via === "random" ? " bad" : ""), m.move);
        chip.title = (m.via || "") + (m.confidence != null ? " confidence " + Math.round(m.confidence * 100) + "%" : "");
        box.appendChild(chip);
      });
    });
  }

  function syncButtons() {
    var signedIn = !!S.token;
    var over = S.state && S.state.over;
    $("#stepBtn").disabled = !signedIn || S.busy || S.running || over;
    $("#autoBtn").disabled = !signedIn || S.busy || over;
    $("#resetBtn").disabled = S.running;
    $("#signBtn").textContent = signedIn ? "Sign out" : "Sign in with Pollen";
    if (!signedIn) setStatus("Sign in with Pollen, or paste your own sk_ key, so your own Pollen pays for the moves.", "");
  }

  /* --------------------------------------------------------------- the duel */

  function reset(seed) {
    S.state = C.freshState(seed || (Date.now() % 100000));
    S.moves = { a: [], b: [] };
    S.lastMove = { a: null, b: null };
    S.calls = 0;
    $("#cost").textContent = "0";
    $("#verdict").textContent = "";
    $("#verdict").className = "verdict";
    paintDrones();
    paintLog();
    paintMoves();
    syncButtons();
  }

  function oneTurn() {
    if (!S.state || S.state.over) return Promise.resolve();
    S.busy = true;
    syncButtons();
    setStatus("Both drones are deciding...", "");
    return Promise.all([askMove("a"), askMove("b")]).then(function (res) {
      var moves = { a: res[0].move, b: res[1].move };
      S.moves.a.push(res[0]);
      S.moves.b.push(res[1]);
      S.lastMove = moves;
      var out = C.resolveTurn(S.state, moves, C.rng(S.state.seed + S.state.turn * 7919));
      S.state = out.state;
      paintDrones();
      paintLog();
      paintMoves();
      S.busy = false;
      if (S.state.over) {
        var w = S.state.winner;
        $("#verdict").textContent = w === "draw"
          ? "Draw. Both drones still flying."
          : S.state.drones[w].name + " wins the duel.";
        $("#verdict").className = "verdict done";
        setStatus("Duel over.", "ok");
      } else {
        setStatus("Turn " + S.state.turn + ". Both drones chose.", "ok");
      }
      syncButtons();
      return S.state;
    }).catch(function (e) {
      S.busy = false;
      setStatus("Turn failed: " + (e && e.message ? e.message : "unknown error"), "err");
      syncButtons();
    });
  }

  function autoRun() {
    if (S.running) { S.stop = true; return; }
    S.running = true;
    S.stop = false;
    $("#autoBtn").textContent = "Stop";
    syncButtons();
    var loop = function () {
      if (S.stop || !S.state || S.state.over) {
        S.running = false;
        S.stop = false;
        $("#autoBtn").textContent = "Run the duel";
        syncButtons();
        return;
      }
      oneTurn().then(function () {
        if (S.stop || (S.state && S.state.over)) return loop();
        setTimeout(loop, 900);
      });
    };
    loop();
  }

  /* ------------------------------------------------------------------ boot */

  function boot() {
    $("#signBtn").addEventListener("click", toggleSign);
    $("#keyBtn").addEventListener("click", toggleKeyRow);
    $("#keySave").addEventListener("click", saveKey);
    $("#stepBtn").addEventListener("click", oneTurn);
    $("#autoBtn").addEventListener("click", autoRun);
    $("#resetBtn").addEventListener("click", function () { if (!S.running) reset(); });
    reset();
    finishSignIn().then(function () { return loadUser(); }).then(syncButtons);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  /* Exposed for the headless harness and for anyone poking at the console. */
  window.DD = {
    S: S, CFG: CFG, askMove: askMove, oneTurn: oneTurn, reset: reset,
    setToken: function (t) { S.token = t; },
    /* Paint an arbitrary state. Used by the screenshot and by anyone who wants
       to look at the arena without spending Pollen. */
    render: function (state, moves) {
      S.state = state;
      if (moves) { S.moves = moves; S.lastMove = { a: moves.a[moves.a.length - 1] && moves.a[moves.a.length - 1].move, b: moves.b[moves.b.length - 1] && moves.b[moves.b.length - 1].move }; }
      paintDrones(); paintLog(); paintMoves(); syncButtons();
    }
  };
})();
