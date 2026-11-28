import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const seasonSrc = await readFile(new URL("../config/season.js", import.meta.url), "utf8");
const html = await readFile(new URL("../index.html", import.meta.url), "utf8");

function loadSeason() {
  const sandbox = {};
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seasonSrc, sandbox);
  return sandbox.HB_SEASON_FILE;
}

const { SEASON, LAWN_SNAPSHOT, seasonView } = loadSeason();

test("the season file follows the calendar and is not an env var", () => {
  assert.equal(SEASON, "auto");
  assert.equal(seasonSrc.match(/const SEASON = /g).length, 1);
  assert.match(seasonSrc, /const SEASON = "auto"/);
  assert.equal(html.includes("process.env"), false);
  assert.match(html, /src="\/config\/season\.js"/);
  assert.match(html, /function seasonDefaultType\(/);
  assert.match(html, /function hbSeason\(/);
  assert.match(html, /hb-season-mode/);
  assert.match(html, /const LS="hustle-builder-v3"/);
  assert.match(html, /seasonPicker\(\)/);
  assert.match(html, /if\(blankLawnDefault\(savedRaw\)\)S\.type=seasonDefaultType\(\)/);
  assert.match(html, /applySeasonCopy\(\);\nfunction shouldOpenIntro/);
  assert.match(html, /Object\.assign\(defaults\(\),savedRaw/);
  assert.match(html, /\$9\.99 for the season, never auto-renews/);
  assert.equal(html.includes("tonight"), false);
  assert.match(html, /\$19\.99 covers a full year/);
  assert.equal(html.includes("student-owned"), false);
  assert.equal(html.includes("student owned"), false);
});

test("fall leads with snow shoveling and still keeps yard cleanup", () => {
  const fall = seasonView("fall");
  assert.equal(fall.defaultType, "prep");
  assert.equal(fall.picker[0], "snow");
  assert.equal(fall.picker.join(","), "snow,prep,lawn,pet,both");
  assert.equal(fall.picker.includes("lawn"), true);
  assert.equal(fall.prepCard.name, "Yard cleanup");
  assert.equal(fall.prepCard.blurb, "Leaf raking. Dead plant cleanup.");
  assert.equal(fall.prepCard.blurb.toLowerCase().includes("snow"), false);
  assert.match(fall.prepCard.img, /prep\.webp/);
  assert.equal(fall.parentsBiz, "Taylor's Yard Cleanup");
  assert.equal(fall.parentsTown, "Elkhorn");
  assert.equal(fall.rates[0].n, "Yard cleanup, small");
  assert.equal(fall.rates[0].p, "15");
  assert.match(fall.rates[1].n, /Leaf/);
  assert.equal(fall.rates[1].p, "15");
  assert.match(fall.kicker, /YARD CLEANUP/);
  assert.match(fall.biz, /Taylor’s Yard Cleanup/);
  assert.match(fall.tagline, /Leaves raked\. Dead plants cleared\./);
  assert.equal(fall.tagline.toLowerCase().includes("winter"), false);
  assert.match(fall.payNote, /yard cleanup/);
  assert.equal(fall.payAmount, "+$15.00");
  assert.equal(JSON.stringify(fall.rates).includes("student"), false);
});

test("snow leads with shoveling and keeps every other job", () => {
  const snow = seasonView("snow");
  assert.equal(snow.defaultType, "snow");
  assert.equal(snow.picker[0], "snow");
  assert.equal(snow.prepCard.name, "Winter prep");
  assert.equal(snow.prepCard.blurb, "Yard cleanup and snow");
  assert.equal(snow.picker.slice().sort().join(","), "both,lawn,pet,prep,snow");
  assert.equal(snow.parentsBiz, "Sam's Snow Removal");
  assert.equal(snow.rates[0].n, "Shovel the driveway");
  assert.equal(snow.rates[0].p, "10");
  assert.equal(snow.rates[1].p, "12");
  assert.match(snow.kicker, /SNOW/);
  assert.match(snow.biz, /Taylor’s Snow Removal/);
  assert.match(snow.payNote, /shoveling/);
  assert.match(snow.tagline, /Kid-owned/);
  assert.equal(JSON.stringify(snow).includes("student"), false);
});

test("the lawn-first wording from before the switch is saved in the season file", () => {
  assert.equal(LAWN_SNAPSHOT.defaultType, "lawn");
  assert.equal(LAWN_SNAPSHOT.picker.join(","), "lawn,snow,both,pet,prep");
  assert.equal(LAWN_SNAPSHOT.parentsBiz, "Sam's Lawn Co.");
  assert.equal(LAWN_SNAPSHOT.parentsTown, "Elkhorn");
  assert.equal(JSON.stringify(LAWN_SNAPSHOT.rates), JSON.stringify([{ n: "Mow a small yard", p: "20" }, { n: "Leaf cleanup", p: "15" }]));
  assert.equal(LAWN_SNAPSHOT.kicker, "NEIGHBORHOOD LAWN CARE");
  assert.equal(LAWN_SNAPSHOT.biz, "Taylor’s Yard Crew");
  assert.equal(LAWN_SNAPSHOT.bizHtml, "Taylor’s<br>Yard Crew");
  assert.equal(LAWN_SNAPSHOT.tagline, "Fresh cuts. Happy neighbors.");
  assert.equal(LAWN_SNAPSHOT.payAmount, "+$20.00");
  assert.equal(LAWN_SNAPSHOT.payNote, "“Thanks for mowing!”");
  assert.equal(LAWN_SNAPSHOT.flyerLabel, "Example flyer for Taylor’s Yard Crew: mowing $20, leaf cleanup $15, with a sample QR code");
});

test("a blank saved lawn draft follows the season, and a named draft stays", () => {
  const start = html.indexOf("function blankLawnDefault(");
  const end = html.indexOf("function defaults(", start);
  assert.ok(start > 0 && end > start);
  const sandbox = { PRESETS: { lawn: 1, snow: 1, prep: 1 }, HB_SEASON_FILE: { SEASON: "fall", seasonView } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(html.indexOf("function seasonDefaultType("), end), sandbox);
  assert.equal(sandbox.blankLawnDefault({ type: "lawn", first: "", svcEdited: false, services: [{ n: "Mow a small yard", p: "10" }] }), true);
  assert.equal(sandbox.blankLawnDefault({ type: "lawn", first: "Will", svcEdited: false }), false);
  assert.equal(sandbox.blankLawnDefault({ type: "snow", first: "", svcEdited: false }), false);
  assert.equal(sandbox.blankLawnDefault({ type: "lawn", first: "", svcEdited: true }), false);
  const kept = { type: "lawn" };
  if (sandbox.blankLawnDefault({ type: "lawn", first: "" })) kept.type = sandbox.seasonDefaultType();
  assert.equal(kept.type, "prep");
});

test("a new draft follows the season and a saved draft keeps its own type", () => {
  const start = html.indexOf("function seasonDefaultType(");
  const end = html.indexOf("function defaults(", start);
  assert.ok(start > 0 && end > start);
  const sandbox = { PRESETS: { lawn: 1, snow: 1, prep: 1 }, HB_SEASON_FILE: { SEASON: "fall", seasonView } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start, end), sandbox);
  assert.equal(sandbox.seasonDefaultType(), "prep");
  sandbox.HB_SEASON_FILE = { SEASON: "snow", seasonView };
  assert.equal(sandbox.seasonDefaultType(), "snow");
  const saved = { type: "lawn", services: [{ n: "Mow a small yard", p: "10" }] };
  const kept = Object.assign({ type: sandbox.seasonDefaultType(), services: [{ n: "prep", p: "15" }] }, saved);
  assert.equal(kept.type, "lawn");
  assert.equal(kept.services[0].p, "10");
  assert.match(html, /Object\.assign\(defaults\(\),savedRaw/);
});

test("fall wording keeps snow strings for snow mode and hides the shovel starter", () => {
  const fall = seasonView("fall");
  const snow = seasonView("snow");
  assert.equal(fall.priceLead, "$9.99 for the season, never auto-renews.");
  assert.equal(fall.priceLead.includes("winter"), false);
  assert.equal(fall.priceShare, "$9.99 for the season. Never auto-renews.");
  assert.match(fall.priceFaq, /\$9\.99 for the season, or \$19\.99/);
  assert.equal(fall.priceOffer, "Season, one-time, never auto-renews");
  assert.match(snow.priceLead, /\$9\.99 for the whole winter/);
  assert.equal(snow.priceOffer, "Winter season, one-time, never auto-renews");
  assert.match(html, /Starter prices for yard cleanup\. Agree on the yard size and tasks/);
  assert.match(html, /Starter prices for yard cleanup and winter prep\. Agree on the yard size and tasks/);
  assert.match(html, /Leaf cleanup, weeding, and seasonal yard work/);
  assert.match(html, /data-prep-snow/);
  const start = html.indexOf("function starterServices(");
  const end = html.indexOf("// Repair the old numeric-ceiling", start);
  const run = (season) => {
    const sandbox = { PRESETS: null, HB_SEASON_FILE: { SEASON: season } };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(html.slice(html.indexOf("const PRESETS="), start) + html.slice(start, end) + "\nthis.starterServices=starterServices;", sandbox);
    return sandbox.starterServices("prep", 1);
  };
  const fallJobs = run("fall");
  const snowJobs = run("snow");
  assert.equal(fallJobs.map((job) => job.n).join(" | "), "Leaf raking | Dead flower/plant removal");
  assert.equal(fallJobs[0].p, "12");
  assert.equal(fallJobs[1].p, "12");
  assert.equal(fallJobs.some((job) => /hedge|faucet|hose|gutter|ladder|shovel/i.test(job.n)), false);
  const shovel = snowJobs.find((job) => job.n === "Shovel walks and driveway");
  assert.equal(shovel.p, "15");
  assert.equal(snowJobs.find((job) => job.n === "Yard cleanup, large").p, "40");
  assert.equal(snowJobs.some((job) => job.n === "Trim small hedges" || job.n === "Cover outdoor faucets" || job.n === "Put away hoses and furniture"), false);
  const names = html.slice(html.indexOf("const PREP_FALL_NAMES="), html.indexOf("function prepIdea("));
  assert.match(names, /\{F\}’s Winter Prep/);
  assert.match(names, /\{F\}’s Yard Cleanup/);
  assert.match(names, /\{T\} Leaf Crew/);
  assert.match(names, /Curb Ready Yard Care/);
  assert.match(html, /const NAME_IDEAS=/);
  assert.match(html, /\{F\}’s Winter Prep/);
});

test("the season doc tells Steve the calendar is automatic and a forced season still merges", async () => {
  const doc = await readFile(new URL("../docs/season-switch.md", import.meta.url), "utf8");
  assert.match(doc, /const SEASON = "auto"/);
  assert.match(doc, /"snow"/);
  assert.match(doc, /September, October, and November/);
  assert.match(doc, /December, January, and February/);
  assert.match(doc, /March through August/);
  assert.match(doc, /merge to main/i);
  assert.match(doc, /env var/i);
  assert.match(doc, /LAWN_SNAPSHOT/);
  assert.match(doc, /hb-season-mode/);
});

test("the calendar maps fall, winter, and spring/summer without dropping summer jobs", () => {
  const nov = new Date(2026, 10, 28);
  const sep = new Date(2026, 8, 1);
  const dec = new Date(2026, 11, 1);
  const feb = new Date(2027, 1, 28);
  const mar = new Date(2027, 2, 1);
  const aug = new Date(2026, 7, 31);
  const { seasonForDate, resolveSeason, activeSeason } = loadSeason();
  assert.equal(seasonForDate(sep), "fall");
  assert.equal(seasonForDate(nov), "fall");
  assert.equal(seasonForDate(dec), "winter");
  assert.equal(seasonForDate(feb), "winter");
  assert.equal(seasonForDate(mar), "summer");
  assert.equal(seasonForDate(aug), "summer");
  assert.equal(resolveSeason("auto", nov), "fall");
  assert.equal(resolveSeason("snow", aug), "winter");
  assert.equal(resolveSeason("winter", aug), "winter");
  assert.equal(resolveSeason("summer", dec), "summer");
  assert.equal(resolveSeason("fall", dec), "fall");
  assert.equal(activeSeason(nov), "fall");
  assert.equal(activeSeason(dec), "winter");
  assert.equal(activeSeason(mar), "summer");
  const summer = seasonView("summer");
  assert.equal(summer.defaultType, "lawn");
  assert.equal(summer.picker[0], "lawn");
  assert.equal(summer.picker.includes("snow"), true);
  assert.equal(summer.picker.includes("prep"), true);
  assert.equal(summer.parentsBiz, "Sam's Lawn Co.");
  assert.match(summer.kicker, /LAWN CARE/);
  const winter = seasonView("winter");
  assert.equal(winter.defaultType, "snow");
  assert.equal(winter.picker[0], "snow");
  assert.equal(winter.biz, seasonView("snow").biz);
});

test("snow shoveling is a first-class fall idea with a price and a duration", () => {
  const fall = seasonView("fall");
  const snow = fall.ideas.find((idea) => idea.name === "Snow shoveling");
  assert.equal(snow.type, "snow");
  assert.equal(snow.emoji, "❄️");
  assert.match(snow.blurb, /Driveways, sidewalks, and steps/);
  assert.equal(snow.price, "12");
  assert.equal(snow.minutes, 45);
  assert.equal(snow.service, "Snow shoveling, about 45 minutes");
  const names = fall.ideas.map((idea) => idea.name);
  for (const name of ["Leaf raking", "Yard and gutter cleanup", "De-ice and salt the walks", "Holiday light help", "Gift wrapping", "Pet sitting over the holidays", "Stack firewood", "Brush snow off the car", "Indoor tutoring", "Babysitting help"]) {
    assert.equal(names.includes(name), true, name);
  }
  assert.match(fall.safety, /on the ground/);
  assert.match(fall.ideas.find((idea) => idea.name === "Yard and gutter cleanup").blurb, /from the ground/);
  assert.equal(/ladder/i.test(fall.safety), false);
  assert.match(html, /name:"Snow shoveling"/);
  assert.match(html, /\["Snow shoveling, about 45 minutes",\[12,13,15,16,18\]\]/);
  assert.match(html, /Yard and gutter cleanup/);
  assert.equal(/ladder/i.test(html), false);
  const summerNames = seasonView("summer").ideas.map((idea) => idea.name);
  assert.equal(summerNames.includes("Lawn mowing"), true);
  assert.equal(summerNames.includes("Snow shoveling"), true);
});

test("a saved season override changes the picker and leaves the draft key alone", () => {
  const start = html.indexOf("function hbSeason(");
  const end = html.indexOf("function blankLawnDefault(", start);
  assert.ok(start > 0 && end > start);
  const store = new Map();
  const sandbox = {
    PRESETS: { lawn: 1, snow: 1, prep: 1 },
    HB_SEASON_FILE: loadSeason(),
    localStorage: {
      getItem: (key) => store.get(key) || "",
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(html.slice(start, end) + "\nthis.hbSeason=hbSeason;this.seasonDefaultType=seasonDefaultType;", sandbox);
  assert.equal(sandbox.hbSeason(), sandbox.HB_SEASON_FILE.activeSeason());
  store.set("hb-season-mode", "winter");
  assert.equal(sandbox.hbSeason(), "winter");
  assert.equal(sandbox.seasonDefaultType(), "snow");
  store.set("hb-season-mode", "summer");
  assert.equal(sandbox.seasonDefaultType(), "lawn");
  store.set("hb-season-mode", "snow");
  assert.equal(sandbox.hbSeason(), "winter");
  assert.equal(store.has("hustle-builder-v3"), false);
});
