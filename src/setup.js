// One-time login, per account. Opens real Chrome on the platform's login page in
// that account's own profile directory. Log in by hand, then close the window.
//
//   npm run login -- mybrand-instagram
//
// The profile directory IS the credential — treat browser-profile/<name> as one.
// This never types a credential and never attempts a login.
import { launch } from "./browser.js";
import { loadRegistry } from "./registry.js";

const id = process.argv[2];
const reg = loadRegistry();
const account = reg.accounts.find((a) => a.id === id);
if (!account) {
  console.error(`unknown account "${id ?? ""}". Declared accounts:`);
  for (const a of reg.accounts) console.error(`  ${a.id.padEnd(24)} ${a.platform}  ->  browser-profile/${a.browser_profile}`);
  process.exit(1);
}

const { meta } = await import(`./platforms/${account.platform}.js`);
const ctx = await launch({ headless: false, profile: account.browser_profile });
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(meta.loginUrl);
console.log(`Log in as ${account.handle ?? account.id} in the opened window, then close the browser.`);
console.log(`The session is saved in browser-profile/${account.browser_profile} — treat that folder as a credential.`);
await new Promise((resolve) => ctx.on("close", resolve));
