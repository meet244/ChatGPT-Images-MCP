// Loaded only by tests. Production configuration and launch code stay unchanged.
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';

const preload = fileURLToPath(import.meta.url);
const spawn = childProcess.spawn;

childProcess.spawn = function (command, args, options) {
  if (!Array.isArray(args)) {
    options ??= args;
    args = [];
  }
  // CLI clients and detached workers must inherit this setup too, including when
  // their transport supplies its own environment rather than inheriting ours.
  if (command === process.execPath && !args.includes(preload)) {
    args = ['--import', preload, ...args];
  }
  // Installed Chrome's CDP and ordinary verification launches bypass Playwright
  // launch options. Keep their actual profiles and handoff behavior, but hide UI.
  if (args.some(arg => /^--user-data-dir(?:=|$)/.test(arg))) {
    args = ['--headless=new', ...args.filter(arg => !/^--headless(?:=|$)/.test(arg))];
  }
  return spawn.call(this, command, args, options);
};
syncBuiltinESMExports();

// Managed Chromium and WebKit must also stay headless, even in tests asserting
// that normal application defaults or interactive login request visible mode.
for (const engine of [chromium, webkit]) {
  const launch = engine.launch;
  engine.launch = function (options = {}) {
    return launch.call(this, { ...options, headless: true });
  };
  const launchPersistentContext = engine.launchPersistentContext;
  engine.launchPersistentContext = function (directory, options = {}) {
    return launchPersistentContext.call(this, directory, { ...options, headless: true });
  };
}
