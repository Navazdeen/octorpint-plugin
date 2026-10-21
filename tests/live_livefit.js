// The Live view card fits above the console, open or closed, and refits when the console opens, closes or is resized.
const { chromium } = require("playwright"); const fs = require("fs"); const R = [];
function ok(n, p, d) { R.push((p ? "PASS " : "FAIL ") + n + (d !== undefined ? " - " + JSON.stringify(d) : "")); }
(async () => { const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 2000, height: 1040 } });
  await ctx.addCookies(JSON.parse(fs.readFileSync(__dirname + "/.session.json", "utf8")).cookies);
  await ctx.addInitScript(() => { try { localStorage.setItem("kobra_ui.viewMode", "webcam"); } catch (e) {} });
  const p = await ctx.newPage(); await p.goto("http://octoprint-kobra:5000/?kui=printer", { waitUntil: "domcontentloaded" });
  await p.waitForSelector("html.kui-on #kui .app", { timeout: 120000 }); await p.waitForTimeout(5000);
  const vm = "ko.dataFor(document.getElementById('kui'))";
  const m = () => p.evaluate(() => { const c = document.getElementById("kui-live").getBoundingClientRect(), d = document.querySelector("#kui .dock").getBoundingClientRect(); return { cardBottom: Math.round(c.bottom), dockTop: Math.round(d.top) }; });
  for (const [name, setup] of [["closed", `${vm}.dockOpen(false)`], ["open", `${vm}.dockOpen(true)`], ["open, taller", `${vm}.conH(420)`]]) {
    await p.evaluate(setup); await p.waitForTimeout(700);
    const r = await m(); ok("console " + name + ": Live view ends above the console", r.cardBottom <= r.dockTop, r);
  }
  await p.screenshot({ path: "/home/navaz/kobra-printer/shots/livefit.png" });
  await p.evaluate(`${vm}.dockOpen(false)`);
  console.log(R.join("\n")); await b.close(); })();
