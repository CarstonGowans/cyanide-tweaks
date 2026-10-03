// @param: switch | pc_enabled | Enable playback control | true
// @param: switch | pc_player_bar | Show controls in player | true
// @param: switch | pc_bar_top | Put player controls at top | false
// @param: slider | pc_rate | Playback speed | 1.0 | 0.5-2.0
// @param: switch | pc_loop_track | Loop current track | false
// @param: switch | pc_ab_loop | A-B loop | false
// @param: slider | pc_ab_start | A-B start (sec) | 0.0 | 0.0-600.0
// @param: slider | pc_ab_end | A-B end (sec) | 30.0 | 0.0-600.0
// @param: slider | pc_skip_sec | Skip interval (sec) | 15.0 | 5.0-60.0
// @param: switch | pc_skip_fwd | Skip forward (flip to fire) | false
// @param: switch | pc_skip_back | Skip back (flip to fire) | false

(() => {
  // MediaRemote command IDs
  var CMD_PREV = 5;
  var CMD_REW15 = 12;
  var CMD_FF15 = 13;
  var CMD_SKIP_FWD = 17;
  var CMD_SKIP_BACK = 18;
  var CMD_RATE = 19;
  var CMD_SEEK = 24;
  var CMD_REPEAT = 25;

  // MediaRemote option and info keys
  var KEY_RATE = "kMRMediaRemoteOptionPlaybackRate";
  var KEY_POS = "kMRMediaRemoteOptionPlaybackPosition";
  var KEY_SKIP = "kMRMediaRemoteOptionSkipInterval";
  var KEY_REPEAT = "kMRMediaRemoteOptionRepeatMode";
  var KEY_TITLE = "kMRMediaRemoteNowPlayingInfoTitle";
  var KEY_ELAPSED = "kMRMediaRemoteNowPlayingInfoElapsedTime";

  // Timing
  var TICK_MS = 250;
  var SCAN_MS = 1500;
  var SCAN_NODE_CAP = 800;

  // Player bar setup
  var SPEEDS = [0.5, 0.75, 1.0, 1.25, 1.5, 2.0];
  var SPEED_TITLES = ["0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x"];
  var AB_ACTIONS = ["a", "b", "off"];
  var NO_SEGMENT = -1;
  var WINDOW_CLASS_NAMES = ["SBCoverSheetWindow", "SBControlCenterWindow"];
  var HOST_CLASS_NAMES = ["MRUNowPlayingView"];

  var mc = null;
  var sendSel = null;
  var infoSel = null;
  var windowClasses = [];
  var hostClasses = [];

  // Pointer and integer helpers. Pointers are hex strings.
  function hex(v) {
    if (v === undefined || v === null || v === false) return "0";
    if (v === true) return "1";
    if (typeof v === "number") return v.toString(16);
    var s = String(v).toLowerCase().replace(/^0x/, "").replace(/^0+/, "");
    return s === "" ? "0" : s;
  }

  function toInt(v) {
    if (typeof v === "number") return v;
    var h = hex(v);
    if (!/^[0-9a-f]+$/.test(h)) return 0;
    try {
      return Number(BigInt.asIntN(64, BigInt("0x" + h)));
    } catch (e) {
      return parseInt(h, 16) || 0;
    }
  }

  function isNil(p) {
    return hex(p) === "0";
  }

  function ptrEq(a, b) {
    return hex(a) === hex(b);
  }

  // Encode a signed integer argument (for -1)
  function arg(n) {
    if (n >= 0) return n;
    return "0x" + BigInt.asUintN(64, BigInt(n)).toString(16);
  }

  function responds(obj, name) {
    return toInt(r_responds(obj, name)) !== 0;
  }

  function isKindAny(obj, classes) {
    for (var i = 0; i < classes.length; i++) {
      if (toInt(r_msg2(obj, "isKindOfClass:", classes[i])) !== 0) return true;
    }
    return false;
  }

  function resolveClasses(names, out, label) {
    for (var i = 0; i < names.length; i++) {
      var c = r_class(names[i]);
      if (!isNil(c)) out.push(c);
      log("[pc] " + label + " " + names[i] + ": " + (isNil(c) ? "NONE" : "yes"));
    }
  }

  // Find SBMediaController and the methods this iOS version has
  function setup() {
    var cls = r_class("SBMediaController");
    if (isNil(cls)) {
      log("[pc] SBMediaController not found. Run this tweak in SpringBoard.");
      return false;
    }
    mc = r_msg2(cls, "sharedInstance");
    if (isNil(mc)) {
      log("[pc] SBMediaController sharedInstance is nil.");
      return false;
    }

    var sendCands = ["_sendMediaCommand:options:", "sendMediaCommand:options:"];
    for (var i = 0; i < sendCands.length; i++) {
      if (responds(mc, sendCands[i])) { sendSel = sendCands[i]; break; }
    }

    var infoCands = ["_nowPlayingInfo", "nowPlayingInfo"];
    for (var j = 0; j < infoCands.length; j++) {
      if (responds(mc, infoCands[j])) { infoSel = infoCands[j]; break; }
    }

    log("[pc] send selector: " + (sendSel || "NONE"));
    log("[pc] info selector: " + (infoSel || "NONE"));
    log("[pc] isPlaying: " + (responds(mc, "isPlaying") ? "yes" : "NONE"));
    resolveClasses(WINDOW_CLASS_NAMES, windowClasses, "window class");
    resolveClasses(HOST_CLASS_NAMES, hostClasses, "player class");

    if (!sendSel) {
      log("[pc] No media command method found. Tweak stops.");
      return false;
    }
    return true;
  }

  // Build a one-key options dictionary. Value is a number as a string.
  function makeOptions(key, valueStr) {
    if (!key) return 0;
    var k = r_nsstr(key);
    var vs = r_nsstr(valueStr);
    var num = r_msg2(r_class("NSDecimalNumber"), "decimalNumberWithString:", vs);
    var dict = r_msg2(r_class("NSDictionary"), "dictionaryWithObject:forKey:", num, k);
    r_msg2(dict, "retain");
    r_msg2(k, "release");
    r_msg2(vs, "release");
    return dict;
  }

  function send(cmd, key, valueStr) {
    var opts = makeOptions(key, valueStr);
    var ok = toInt(r_msg2(mc, sendSel, cmd, opts)) !== 0;
    if (!isNil(opts)) r_msg2(opts, "release");
    if (!ok) log("[pc] command " + cmd + " was not accepted");
    return ok;
  }

  function isPlaying() {
    if (!responds(mc, "isPlaying")) return true;
    return toInt(r_msg2(mc, "isPlaying")) !== 0;
  }

  function infoValue(keyName) {
    if (!infoSel) return 0;
    var info = r_msg2(mc, infoSel);
    if (isNil(info)) return 0;
    var k = r_nsstr(keyName);
    var v = r_msg2(info, "objectForKey:", k);
    r_msg2(k, "release");
    return v;
  }

  // Returns a retained title NSString, or 0
  function currentTitle() {
    var t = infoValue(KEY_TITLE);
    if (isNil(t)) return 0;
    return r_msg2(t, "copy");
  }

  // Returns elapsed whole seconds from now playing info, or null
  function readElapsed() {
    var n = infoValue(KEY_ELAPSED);
    if (isNil(n)) return null;
    return toInt(r_msg2(n, "integerValue"));
  }

  function sameTitle(a, b) {
    if (isNil(a) && isNil(b)) return true;
    if (isNil(a) || isNil(b)) return false;
    return toInt(r_msg2(a, "isEqualToString:", b)) !== 0;
  }

  // Position estimate: last value from the app plus our own play clock
  var pos = { base: 0, ms: Date.now(), raw: null, playing: false, rate: 1.0 };

  function position() {
    var run = pos.playing ? (Date.now() - pos.ms) / 1000 * pos.rate : 0;
    return pos.base + run;
  }

  function rebase(newBase) {
    pos.base = newBase === undefined ? position() : newBase;
    pos.ms = Date.now();
  }

  function updatePosition(playing) {
    if (playing !== pos.playing) {
      rebase();
      pos.playing = playing;
    }
    var e = readElapsed();
    if (e !== null && e !== pos.raw) {
      pos.raw = e;
      rebase(e);
    }
  }

  // Feature actions
  function applyRate(rate) {
    rebase();
    pos.rate = rate;
    send(CMD_RATE, KEY_RATE, rate.toFixed(2));
    log("[pc] rate -> " + rate.toFixed(2));
  }

  function seekTo(sec) {
    send(CMD_SEEK, KEY_POS, sec.toFixed(2));
    rebase(sec);
  }

  function skip(forward, sec) {
    var ok = send(forward ? CMD_SKIP_FWD : CMD_SKIP_BACK, KEY_SKIP, sec.toFixed(0));
    if (!ok) {
      // Fallback to the fixed 15 second commands
      send(forward ? CMD_FF15 : CMD_REW15, null, null);
    }
    rebase(Math.max(0, position() + (forward ? sec : -sec)));
  }

  function setRepeatOne(on) {
    // MPRepeatType: 0 = off, 1 = one
    send(CMD_REPEAT, KEY_REPEAT, on ? "1" : "0");
  }

  function speedIndex(rate) {
    for (var i = 0; i < SPEEDS.length; i++) {
      if (Math.abs(SPEEDS[i] - rate) < 0.01) return i;
    }
    return NO_SEGMENT;
  }

  function skipTitles(sec) {
    var s = Math.round(sec);
    return ["-" + s, "+" + s];
  }

  // Player bar UI. UIKit changes go to the main thread.
  var bars = [];

  function newView(clsName) {
    return r_msg2_main(r_msg2(r_class(clsName), "alloc"), "init");
  }

  function makeSegmented(titles) {
    var seg = newView("UISegmentedControl");
    for (var i = 0; i < titles.length; i++) {
      var s = r_nsstr(titles[i]);
      r_msg2_main(seg, "insertSegmentWithTitle:atIndex:animated:", s, i, 0);
      r_msg2(s, "release");
    }
    return seg;
  }

  function setSegmentTitles(seg, titles) {
    for (var i = 0; i < titles.length; i++) {
      var s = r_nsstr(titles[i]);
      r_msg2_main(seg, "setTitle:forSegmentAtIndex:", s, i);
      r_msg2(s, "release");
    }
  }

  function makeLabel(text) {
    var lbl = newView("UILabel");
    var s = r_nsstr(text);
    r_msg2_main(lbl, "setText:", s);
    r_msg2(s, "release");
    var style = r_nsstr("UICTFontTextStyleFootnote");
    var font = r_msg2(r_class("UIFont"), "preferredFontForTextStyle:", style);
    r_msg2(style, "release");
    if (!isNil(font)) r_msg2_main(lbl, "setFont:", font);
    return lbl;
  }

  // axis: 0 = horizontal, 1 = vertical
  function makeStack(axis, distribution, alignment) {
    var st = newView("UIStackView");
    r_msg2_main(st, "setAxis:", axis);
    r_msg2_main(st, "setDistribution:", distribution);
    r_msg2_main(st, "setAlignment:", alignment);
    return st;
  }

  function pin(a, b) {
    var c = r_msg2_main(a, "constraintEqualToAnchor:", b);
    if (!isNil(c)) r_msg2_main(c, "setActive:", 1);
  }

  function pushToBar(b) {
    var idx = speedIndex(state.rate);
    r_msg2_main(b.speedSeg, "setSelectedSegmentIndex:", arg(idx));
    b.lastSpeedIdx = idx;
    r_msg2_main(b.loopSw, "setOn:animated:", state.loop ? 1 : 0, 0);
    b.lastLoop = state.loop;
  }

  function buildBar(host, skipSec, atTop) {
    // Vertical stack: speed row, then loop / skip / A-B row
    var bar = makeStack(1, 0, 0);
    r_msg2_main(bar, "setOverrideUserInterfaceStyle:", 2);
    r_msg2_main(bar, "setTranslatesAutoresizingMaskIntoConstraints:", 0);

    var speedSeg = makeSegmented(SPEED_TITLES);
    // Horizontal row, equal spacing, centered
    var row = makeStack(0, 3, 3);
    var loopLbl = makeLabel("Loop");
    var loopSw = newView("UISwitch");
    var skipSeg = makeSegmented(skipTitles(skipSec));
    var abSeg = makeSegmented(["A", "B", "Off"]);

    r_msg2_main(row, "addArrangedSubview:", loopLbl);
    r_msg2_main(row, "addArrangedSubview:", loopSw);
    r_msg2_main(row, "addArrangedSubview:", skipSeg);
    r_msg2_main(row, "addArrangedSubview:", abSeg);
    r_msg2_main(bar, "addArrangedSubview:", speedSeg);
    r_msg2_main(bar, "addArrangedSubview:", row);
    r_msg2_main(host, "addSubview:", bar);

    var guide = r_msg2(host, "layoutMarginsGuide");
    pin(r_msg2(bar, "leadingAnchor"), r_msg2(guide, "leadingAnchor"));
    pin(r_msg2(bar, "trailingAnchor"), r_msg2(guide, "trailingAnchor"));
    if (atTop) {
      pin(r_msg2(bar, "topAnchor"), r_msg2(guide, "topAnchor"));
    } else {
      pin(r_msg2(bar, "bottomAnchor"), r_msg2(guide, "bottomAnchor"));
    }

    var b = {
      host: host, bar: bar, row: row, speedSeg: speedSeg, loopLbl: loopLbl,
      loopSw: loopSw, skipSeg: skipSeg, abSeg: abSeg,
      lastSpeedIdx: NO_SEGMENT, lastLoop: false, skipSec: Math.round(skipSec)
    };
    pushToBar(b);
    return b;
  }

  function destroyBar(b) {
    r_msg2_main(b.bar, "removeFromSuperview");
    var objs = [b.speedSeg, b.loopLbl, b.loopSw, b.skipSeg, b.abSeg, b.row, b.bar];
    for (var i = 0; i < objs.length; i++) r_msg2_main(objs[i], "release");
  }

  function destroyAllBars() {
    for (var i = 0; i < bars.length; i++) destroyBar(bars[i]);
    bars = [];
  }

  function barAlive(b) {
    return !isNil(r_msg2(b.bar, "window"));
  }

  function isOurBar(v) {
    for (var i = 0; i < bars.length; i++) {
      if (ptrEq(bars[i].bar, v)) return true;
    }
    return false;
  }

  function windowHasBar(w) {
    for (var i = 0; i < bars.length; i++) {
      if (ptrEq(r_msg2(bars[i].bar, "window"), w)) return true;
    }
    return false;
  }

  function visibleWindows() {
    var cls = r_class("UIWindow");
    if (responds(cls, "allWindowsIncludingInternalWindows:onlyVisibleWindows:")) {
      return r_msg2(cls, "allWindowsIncludingInternalWindows:onlyVisibleWindows:", 1, 1);
    }
    return r_msg2(r_msg2(r_class("UIApplication"), "sharedApplication"), "windows");
  }

  // Walk one window and return the player views in it
  function findHosts(w) {
    var stack = [w];
    var found = [];
    var nodes = 0;
    while (stack.length > 0 && nodes < SCAN_NODE_CAP) {
      var v = stack.pop();
      nodes++;
      if (isOurBar(v)) continue;
      if (toInt(r_msg2(v, "isHidden")) !== 0) continue;
      if (isKindAny(v, hostClasses)) { found.push(v); continue; }
      var subs = r_msg2(v, "subviews");
      var c = toInt(r_msg2(subs, "count"));
      for (var j = c - 1; j >= 0; j--) stack.push(r_msg2(subs, "objectAtIndex:", j));
    }
    return { hosts: found, nodes: nodes };
  }

  var missLogged = false;

  function scan(skipSec, atTop) {
    // Drop bars that left the screen
    var keep = [];
    for (var i = 0; i < bars.length; i++) {
      if (barAlive(bars[i])) keep.push(bars[i]); else destroyBar(bars[i]);
    }
    bars = keep;

    if (windowClasses.length === 0 || hostClasses.length === 0) return;

    var wins = visibleWindows();
    if (isNil(wins)) return;
    var n = toInt(r_msg2(wins, "count"));
    for (var k = 0; k < n; k++) {
      var w = r_msg2(wins, "objectAtIndex:", k);
      if (!isKindAny(w, windowClasses)) continue;
      if (windowHasBar(w)) continue;
      var res = findHosts(w);
      if (res.hosts.length === 0) {
        if (!missLogged) log("[pc] no player view found in window (" + res.nodes + " views checked)");
        missLogged = true;
        continue;
      }
      // First player view only. Others in the same window are skipped.
      bars.push(buildBar(res.hosts[0], skipSec, atTop));
      missLogged = false;
      log("[pc] player bar added (" + res.nodes + " views checked, " + res.hosts.length + " player views)");
    }
  }

  // Read taps and changes from the player bars
  function readBars(actions) {
    var changed = false;
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i];

      var si = toInt(r_msg2(b.speedSeg, "selectedSegmentIndex"));
      if (si !== b.lastSpeedIdx && si >= 0 && si < SPEEDS.length) {
        state.rate = SPEEDS[si];
        changed = true;
      }

      var lo = toInt(r_msg2(b.loopSw, "isOn")) !== 0;
      if (lo !== b.lastLoop) {
        state.loop = lo;
        changed = true;
      }

      // Skip and A-B are one-shot: read the tap, then clear the selection
      var sk = toInt(r_msg2(b.skipSeg, "selectedSegmentIndex"));
      if (sk === 0 || sk === 1) {
        actions.push(sk === 0 ? "back" : "fwd");
        r_msg2_main(b.skipSeg, "setSelectedSegmentIndex:", arg(NO_SEGMENT));
      }

      var ab = toInt(r_msg2(b.abSeg, "selectedSegmentIndex"));
      if (ab >= 0 && ab < AB_ACTIONS.length) {
        actions.push(AB_ACTIONS[ab]);
        r_msg2_main(b.abSeg, "setSelectedSegmentIndex:", arg(NO_SEGMENT));
      }
    }
    return changed;
  }

  log("[pc] v1.1.1 start");
  var setupOk = false;
  try {
    setupOk = setup();
  } catch (e) {
    log("[pc] setup error: " + e);
  }
  if (!setupOk) return;

  // Shared state for app settings and player bar
  function readPrefs() {
    return {
      rate: r_pref_num("pc_rate") || 1.0,
      loop: r_pref_bool("pc_loop_track"),
      ab: r_pref_bool("pc_ab_loop"),
      abStart: r_pref_num("pc_ab_start"),
      abEnd: r_pref_num("pc_ab_end"),
      skipSec: r_pref_num("pc_skip_sec") || 15,
      fwd: r_pref_bool("pc_skip_fwd"),
      back: r_pref_bool("pc_skip_back"),
      bar: r_pref_bool("pc_player_bar"),
      barTop: r_pref_bool("pc_bar_top")
    };
  }

  var lastPref = readPrefs();
  var state = {
    rate: lastPref.rate,
    loop: lastPref.loop,
    abOn: lastPref.ab,
    abA: lastPref.abStart,
    abB: lastPref.abEnd
  };
  var appliedRate = null;
  var appliedLoop = false;
  var lastAbOn = false;
  var lastTitle = currentTitle();
  var lastScanMs = 0;
  var abWarned = false;

  var tickCount = 0;
  var lastError = "";

  setInterval(function () {
    try {
      tick();
    } catch (e) {
      // Log each new error once
      var msg = String(e);
      if (msg !== lastError) log("[pc] tick error: " + msg);
      lastError = msg;
    }
  }, TICK_MS);

  function tick() {
    tickCount++;
    if (tickCount === 1) log("[pc] first tick ok");
    if (!r_pref_bool("pc_enabled")) {
      if (bars.length > 0) destroyAllBars();
      return;
    }

    var p = readPrefs();
    var actions = [];
    var stateChanged = false;

    // Track change detection
    var title = currentTitle();
    if (!sameTitle(title, lastTitle)) {
      if (state.loop && !isNil(lastTitle)) {
        // App did not repeat the track, so go back to it
        log("[pc] track changed while loop is on, going back");
        send(CMD_PREV, null, null);
      }
      if (!isNil(lastTitle)) r_msg2(lastTitle, "release");
      lastTitle = title;
      pos.raw = null;
      rebase(0);
      // Some apps reset the rate on a new track
      appliedRate = null;
    } else if (!isNil(title)) {
      r_msg2(title, "release");
    }

    updatePosition(isPlaying());

    // App settings changes
    if (Math.abs(p.rate - lastPref.rate) > 0.001) { state.rate = p.rate; stateChanged = true; }
    if (p.loop !== lastPref.loop) { state.loop = p.loop; stateChanged = true; }
    if (p.ab !== lastPref.ab || p.abStart !== lastPref.abStart || p.abEnd !== lastPref.abEnd) {
      state.abOn = p.ab;
      state.abA = p.abStart;
      state.abB = p.abEnd;
    }
    if (p.fwd !== lastPref.fwd) actions.push("fwd");
    if (p.back !== lastPref.back) actions.push("back");

    // Player bar add, remove, and read
    if (!p.bar || p.barTop !== lastPref.barTop) {
      if (bars.length > 0) destroyAllBars();
    }
    if (p.bar) {
      if (readBars(actions)) stateChanged = true;
      var now = Date.now();
      if (now - lastScanMs >= SCAN_MS) {
        lastScanMs = now;
        scan(p.skipSec, p.barTop);
      }
      if (Math.round(p.skipSec) !== Math.round(lastPref.skipSec)) {
        for (var i = 0; i < bars.length; i++) {
          setSegmentTitles(bars[i].skipSeg, skipTitles(p.skipSec));
          bars[i].skipSec = Math.round(p.skipSec);
        }
      }
    }
    lastPref = p;

    // Playback speed
    if (appliedRate === null || Math.abs(state.rate - appliedRate) > 0.001) {
      applyRate(state.rate);
      appliedRate = state.rate;
    }

    // Loop current track
    if (state.loop !== appliedLoop) {
      setRepeatOne(state.loop);
      appliedLoop = state.loop;
    }

    // One-shot actions
    for (var a = 0; a < actions.length; a++) {
      var act = actions[a];
      if (act === "fwd") skip(true, p.skipSec);
      else if (act === "back") skip(false, p.skipSec);
      else if (act === "a") {
        state.abA = Math.floor(position());
        state.abOn = false;
        log("[pc] A set to " + state.abA + " sec");
      } else if (act === "b") {
        state.abB = Math.floor(position());
        state.abOn = true;
        log("[pc] B set to " + state.abB + " sec");
      } else if (act === "off") {
        state.abOn = false;
        log("[pc] A-B loop off");
      }
    }

    // Keep all player bars the same as the state
    if (stateChanged) {
      for (var j = 0; j < bars.length; j++) pushToBar(bars[j]);
    }

    // A-B loop
    if (state.abOn) {
      if (state.abB <= state.abA + 1) {
        if (!abWarned) log("[pc] A-B end must be more than start + 1 sec");
        abWarned = true;
      } else {
        abWarned = false;
        var at = position();
        if (!lastAbOn || at >= state.abB || at < state.abA - 2) seekTo(state.abA);
      }
    }
    lastAbOn = state.abOn;
  }

  log("[pc] playback control running");
})();
