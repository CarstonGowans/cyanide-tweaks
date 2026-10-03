// @param: switch | pc_enabled | Enable playback control | true
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

  var TICK_MS = 250;

  var mc = null;
  var sendSel = null;
  var infoSel = null;

  // Helpers
  function toInt(v) {
    if (v === undefined || v === null) return 0;
    if (typeof v === "number") return v;
    return parseInt(v, 16) || 0;
  }

  function isNil(p) {
    return toInt(p) === 0;
  }

  function responds(obj, name) {
    return toInt(r_responds(obj, name)) !== 0;
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

  // Returns a retained title NSString, or 0
  function currentTitle() {
    if (!infoSel) return 0;
    var info = r_msg2(mc, infoSel);
    if (isNil(info)) return 0;
    var k = r_nsstr(KEY_TITLE);
    var t = r_msg2(info, "objectForKey:", k);
    r_msg2(k, "release");
    if (isNil(t)) return 0;
    return r_msg2(t, "copy");
  }

  function sameTitle(a, b) {
    if (isNil(a) && isNil(b)) return true;
    if (isNil(a) || isNil(b)) return false;
    return toInt(r_msg2(a, "isEqualToString:", b)) !== 0;
  }

  // Feature actions
  function applyRate(rate) {
    send(CMD_RATE, KEY_RATE, rate.toFixed(2));
    log("[pc] rate -> " + rate.toFixed(2));
  }

  function seekTo(sec) {
    send(CMD_SEEK, KEY_POS, sec.toFixed(2));
  }

  function skip(forward, sec) {
    var ok = send(forward ? CMD_SKIP_FWD : CMD_SKIP_BACK, KEY_SKIP, sec.toFixed(0));
    if (!ok) {
      // Fallback to the fixed 15 second commands
      send(forward ? CMD_FF15 : CMD_REW15, null, null);
    }
  }

  function setRepeatOne(on) {
    // MPRepeatType: 0 = off, 1 = one
    send(CMD_REPEAT, KEY_REPEAT, on ? "1" : "0");
  }

  if (!setup()) return;

  // State
  var lastRate = null;
  var lastLoop = r_pref_bool("pc_loop_track");
  var lastAb = false;
  var lastAbStart = -1;
  var lastAbEnd = -1;
  var abClockMs = 0;
  var lastFwd = r_pref_bool("pc_skip_fwd");
  var lastBack = r_pref_bool("pc_skip_back");
  var lastTitle = currentTitle();

  if (lastLoop) setRepeatOne(true);

  setInterval(function () {
    if (!r_pref_bool("pc_enabled")) return;

    var rate = r_pref_num("pc_rate") || 1.0;
    var loopTrack = r_pref_bool("pc_loop_track");
    var ab = r_pref_bool("pc_ab_loop");
    var abStart = r_pref_num("pc_ab_start");
    var abEnd = r_pref_num("pc_ab_end");
    var skipSec = r_pref_num("pc_skip_sec") || 15;
    var fwd = r_pref_bool("pc_skip_fwd");
    var back = r_pref_bool("pc_skip_back");

    // Track change detection
    var title = currentTitle();
    var changed = !sameTitle(title, lastTitle);
    if (changed) {
      if (loopTrack && !isNil(lastTitle)) {
        // App did not repeat the track, so go back to it
        log("[pc] track changed while loop is on, going back");
        send(CMD_PREV, null, null);
      }
      if (!isNil(lastTitle)) r_msg2(lastTitle, "release");
      lastTitle = title;
      // Some apps reset the rate on a new track
      lastRate = null;
    } else if (!isNil(title)) {
      r_msg2(title, "release");
    }

    // Playback speed
    if (lastRate === null || Math.abs(rate - lastRate) > 0.001) {
      applyRate(rate);
      lastRate = rate;
    }

    // Loop current track
    if (loopTrack !== lastLoop) {
      setRepeatOne(loopTrack);
      lastLoop = loopTrack;
    }

    // Skip triggers: each flip of the switch fires one skip
    if (fwd !== lastFwd) { skip(true, skipSec); lastFwd = fwd; }
    if (back !== lastBack) { skip(false, skipSec); lastBack = back; }

    // A-B loop
    if (ab) {
      if (abEnd <= abStart + 1) {
        if (!lastAb) log("[pc] A-B end must be more than start + 1 sec");
        lastAb = true;
        return;
      }
      var reset = !lastAb || abStart !== lastAbStart || abEnd !== lastAbEnd;
      if (reset) {
        seekTo(abStart);
        abClockMs = 0;
        lastAbStart = abStart;
        lastAbEnd = abEnd;
      } else if (isPlaying()) {
        abClockMs += TICK_MS * rate;
        if (abClockMs >= (abEnd - abStart) * 1000) {
          seekTo(abStart);
          abClockMs = 0;
        }
      }
    }
    lastAb = ab;
  }, TICK_MS);

  log("[pc] playback control running");
})();
