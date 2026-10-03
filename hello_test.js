(() => {
  log("[hello] script started");
  var cls = r_class("SBMediaController");
  log("[hello] SBMediaController: " + cls);
  var app = r_msg2(r_class("UIApplication"), "sharedApplication");
  log("[hello] sharedApplication: " + app);
  log("[hello] done");
})();
