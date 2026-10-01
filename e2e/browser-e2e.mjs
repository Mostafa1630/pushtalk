// Browser end-to-end test against a RUNNING PushTalk stack.
// Real Chromium users with fake microphones exercise the whole system:
// recording -> upload -> worker/ffmpeg -> Redis -> WebSocket -> playback queue.
//
//   cd e2e && npm install && npx playwright install chromium
//   BASE_URL=http://localhost:8080 node browser-e2e.mjs
//
// Optional: CHROMIUM_PATH=/path/to/chrome to use an existing Chromium binary.
import { chromium } from "playwright";

const BASE = process.env.BASE_URL ?? "http://localhost:8080";
const RUN = Math.random().toString(36).slice(2, 7);
const results = [];
const check = (name, ok, info = "") => {
  results.push([name, ok]);
  console.log(`[${ok ? "PASS" : "FAIL"}] ${name}${!ok && info ? `  (${info})` : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  // Fake microphone (Chromium generates a beep tone) and auto-granted permission.
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
});

const wsControl = { blocked: new Set(), live: new Map() };

async function newUser(name) {
  const ctx = await browser.newContext({ permissions: ["microphone"] });
  const page = await ctx.newPage();
  // Proxy the page's WebSocket so the test can cut the connection like a network drop.
  await page.routeWebSocket(/\/api\/ws\//, (ws) => {
    if (wsControl.blocked.has(name)) {
      ws.close({ code: 1011, reason: "network down (test)" });
      return;
    }
    ws.connectToServer();
    if (!wsControl.live.has(name)) wsControl.live.set(name, []);
    wsControl.live.get(name).push(ws);
  });
  const audioRequests = [];
  page.on("request", (r) => {
    const m = r.url().match(/\/api\/messages\/([0-9a-f-]+)\/audio/);
    if (m) audioRequests.push(m[1]);
  });
  page.on("pageerror", (e) => console.log(`  [${name} pageerror]`, e.message));
  await page.goto(`${BASE}/login`);
  await page.click("text=No account? Sign up");
  await page.fill("input[name=username]", name);
  await page.fill("input[name=password]", "password123");
  await page.click("button[type=submit]");
  await page.waitForURL("**/channels");
  return { ctx, page, audioRequests, name };
}

async function hold(page, ms) {
  const btn = page.getByTestId("ptt");
  const box = await btn.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await sleep(ms);
  await page.mouse.up();
}

const statuses = (page) => page.locator("[data-testid=message].message--own [data-testid=message-status]").allInnerTexts();

try {
  const alice = await newUser(`alice${RUN}`);
  const bob = await newUser(`bob${RUN}`);

  // Alice creates a channel, Bob joins it.
  await alice.page.fill("input[aria-label='Channel name']", `e2e-${RUN}`);
  await alice.page.click("button[type=submit]:has-text(\"Create\")");
  await alice.page.waitForURL(/\/channels\/\d+$/);
  const channelUrl = alice.page.url();
  await bob.page.reload();
  await bob.page.click(`li:has-text("#e2e-${RUN}") >> text=Join`);
  await bob.page.waitForURL(channelUrl);
  await bob.page.waitForSelector("[data-testid=connection][data-state=open]");
  await alice.page.waitForSelector("[data-testid=connection][data-state=open]");

  // Presence: both online.
  await alice.page.waitForFunction(() => document.querySelectorAll("[data-testid=member][data-online=true]").length === 2, null, { timeout: 5000 }).catch(() => {});
  check("presence: both members shown online", (await alice.page.locator("[data-testid=member][data-online=true]").count()) === 2);

  // 1) Record & send. Bob receives it and it auto-plays; Alice's own does not.
  await hold(alice.page, 1500);
  await alice.page.waitForSelector("[data-testid=message][data-status=ready]", { timeout: 15000 });
  check("sender sees own message processed (ready)", true);
  await bob.page.waitForSelector("[data-testid=message][data-status=ready]", { timeout: 15000 });
  check("recipient receives the message in realtime", true);
  await alice.page.waitForFunction(
    () => [...document.querySelectorAll("[data-testid=message-status]")].some((e) => e.textContent.startsWith("Played")),
    null,
    { timeout: 15000 },
  ).then(() => check("sender sees status progress to Played (auto-played by recipient)", true))
   .catch(async () => check("sender sees status progress to Played", false, await statuses(alice.page)));
  check("recipient fetched audio exactly once (auto-play)", bob.audioRequests.length === 1, bob.audioRequests);
  check("sender's own message was NOT auto-played", alice.audioRequests.length === 0, alice.audioRequests);

  // 2) Ordering: three messages in quick succession of different lengths.
  bob.audioRequests.length = 0;
  for (const ms of [2200, 700, 1200]) {
    await hold(alice.page, ms);
    await sleep(150);
  }
  await bob.page.waitForFunction(() => document.querySelectorAll("[data-testid=message][data-status=ready]").length === 4, null, { timeout: 20000 });
  const seqs = await bob.page.locator("[data-testid=message]").evaluateAll((els) => els.map((e) => Number(e.dataset.seq)));
  check("recipient list ordered by seq", JSON.stringify(seqs) === JSON.stringify([...seqs].sort((a, b) => a - b)), seqs);
  const aliceIds = await alice.page.evaluate(async () => {
    const s = JSON.parse(localStorage.getItem("pushtalk.session"));
    const ch = location.pathname.split("/").pop();
    const r = await fetch(`/api/channels/${ch}/messages`, { headers: { Authorization: `Bearer ${s.token}` } });
    return (await r.json()).messages.map((m) => m.id);
  });
  // Wait for sequential playback of the 3 messages (~4.1 s of audio).
  await sleep(7000);
  check("recipient played the 3 messages sequentially in seq order", JSON.stringify(bob.audioRequests) === JSON.stringify(aliceIds.slice(1)), `${bob.audioRequests} vs ${aliceIds.slice(1)}`);

  // 3) Minimum duration: a 200 ms tap is rejected client side.
  await hold(alice.page, 200);
  await sleep(300);
  check("too-short recording shows a hint and is not sent",
    (await alice.page.locator("text=Hold the button a little longer").count()) === 1 &&
    (await alice.page.locator("[data-testid=message]").count()) === 4);

  // 4) Message arrives while the recipient is recording: held, then played after release.
  bob.audioRequests.length = 0;
  const bobBtn = await bob.page.getByTestId("ptt").boundingBox();
  await bob.page.mouse.move(bobBtn.x + 20, bobBtn.y + 20);
  await bob.page.mouse.down();
  await hold(alice.page, 1000);
  await sleep(2500); // processed and delivered meanwhile
  const duringRecording = bob.audioRequests.length;
  const queuedHint = await bob.page.locator("text=waiting until you release").count();
  await bob.page.mouse.up();
  await sleep(2500);
  check("incoming message is held while recording", duringRecording === 0 && queuedHint === 1, `requests=${duringRecording} hint=${queuedHint}`);
  check("held message plays after releasing the button", bob.audioRequests.length === 1, bob.audioRequests);

  // 5) Reconnect & catch-up: Bob goes offline, Alice sends 2 messages, Bob comes back.
  const bobCountBefore = await bob.page.locator("[data-testid=message][data-status=ready]").count();
  bob.audioRequests.length = 0;
  wsControl.blocked.add(bob.name);
  for (const ws of wsControl.live.get(bob.name) ?? []) await ws.close({ code: 1011, reason: "network drop (test)" }).catch(() => {});
  await bob.page.waitForSelector("[data-testid=connection][data-state=reconnecting]", { timeout: 10000 })
    .then(() => check("recipient detects the dropped connection (reconnecting)", true))
    .catch(() => check("recipient detects the dropped connection (reconnecting)", false));
  await hold(alice.page, 900);
  await sleep(300);
  await hold(alice.page, 900);
  await sleep(2500);
  wsControl.blocked.delete(bob.name);
  await bob.page.waitForSelector("[data-testid=connection][data-state=open]", { timeout: 30000 });
  await bob.page.waitForFunction((n) => document.querySelectorAll("[data-testid=message][data-status=ready]").length >= n + 2, bobCountBefore, { timeout: 15000 })
    .then(() => check("after reconnect, missed messages are recovered", true))
    .catch(() => check("after reconnect, missed messages are recovered", false));
  await sleep(4000);
  check("recovered messages auto-play in order after reconnect", bob.audioRequests.length === 2, bob.audioRequests);

  // 6) Autoplay policy. Headless Chromium under Playwright always reports a user
  // activation, so the browser policy is EMULATED in the page: play() rejects
  // with NotAllowedError until a real pointerdown, and userActivation reports
  // hasBeenActive=false (variant A) or is absent like Safari/Firefox (variant B).
  // A dedicated member (carol) so no other tab of the same user plays the message first.
  const carol = await newUser(`carol${RUN}`);
  await carol.page.goto(channelUrl.replace(/\/channels\/\d+$/, "/channels"));
  await carol.page.click(`li:has-text("#e2e-${RUN}") >> text=Join`);
  await carol.page.waitForURL(channelUrl);
  const carolSession = await carol.page.evaluate(() => localStorage.getItem("pushtalk.session"));
  await carol.ctx.close();
  for (const variant of ["A: userActivation API", "B: play() rejection only"]) {
    const ctx = await browser.newContext();
    await ctx.addInitScript(([s, hasApi]) => {
      localStorage.setItem("pushtalk.session", s);
      let activated = false;
      document.addEventListener("pointerdown", () => { activated = true; }, true);
      Object.defineProperty(navigator, "userActivation", {
        get: () => (hasApi ? { hasBeenActive: activated, isActive: activated } : undefined),
      });
      const realPlay = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        if (!activated) return Promise.reject(new DOMException("play() requires a user gesture", "NotAllowedError"));
        return realPlay.call(this);
      };
    }, [carolSession, variant.startsWith("A")]);
    const fresh = await ctx.newPage();
    const freshAudio = [];
    fresh.on("request", (r) => r.url().includes("/audio") && freshAudio.push(r.url()));
    await fresh.goto(channelUrl);
    await fresh.waitForSelector("[data-testid=connection][data-state=open]");
    await hold(alice.page, 900);
    await sleep(3000);
    const banner = await fresh.getByTestId("unlock-audio").count();
    check(`autoplay ${variant}: banner shown, message kept waiting`, banner === 1, `banner=${banner} audioReqs=${freshAudio.length}`);
    const before = await fresh.evaluate(() => document.querySelector(".message--playing") !== null);
    await fresh.getByTestId("unlock-audio").click();
    await fresh.waitForSelector(".message--playing", { timeout: 5000 }).then(
      () => check(`autoplay ${variant}: click unlocks and the waiting message plays`, !before),
      () => check(`autoplay ${variant}: click unlocks and the waiting message plays`, false),
    );
    await ctx.close();
  }

  // 7) Multi-tab: Bob opens a second tab on the same channel; only one tab auto-plays.
  const bobTab2 = await bob.ctx.newPage();
  const tab2Audio = [];
  bobTab2.on("request", (r) => r.url().includes("/audio") && tab2Audio.push(r.url()));
  await bobTab2.goto(channelUrl);
  await bobTab2.waitForSelector("[data-testid=connection][data-state=open]");
  bob.audioRequests.length = 0;
  await hold(alice.page, 900);
  await sleep(3000);
  check("same user, two tabs: message auto-plays in exactly one tab", bob.audioRequests.length + tab2Audio.length === 1, `tab1=${bob.audioRequests.length} tab2=${tab2Audio.length}`);
  check("second tab explains it is not the playback tab", (await bobTab2.locator("text=open in another tab").count()) === 1);
  await bobTab2.close();

  // 8) Unauthorized media access from a non-member browser session.
  const mallory = await newUser(`mallory${RUN}`);
  const status = await mallory.page.evaluate(async (id) => {
    const s = JSON.parse(localStorage.getItem("pushtalk.session"));
    return (await fetch(`/api/messages/${id}/audio`, { headers: { Authorization: `Bearer ${s.token}` } })).status;
  }, aliceIds[0]);
  check("non-member cannot fetch channel audio (403)", status === 403, status);

  if (process.env.SCREENSHOT_DIR) {
    await alice.page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/alice.png` });
    await bob.page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/bob.png` });
  }
} catch (err) {
  console.error("E2E crashed:", err);
  results.push(["crash", false]);
} finally {
  await browser.close();
}
const failed = results.filter(([, ok]) => !ok).length;
console.log(failed ? `\n${failed} FAILED` : "\nALL E2E CHECKS PASSED");
process.exit(failed ? 1 : 0);
