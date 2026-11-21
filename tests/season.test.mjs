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

test("the season file is the one switch and ships fall", () => {
  assert.equal(SEASON, "fall");
  assert.equal(seasonSrc.match(/const SEASON = /g).length, 1);
  assert.match(seasonSrc, /const SEASON = "fall"/);
  assert.equal(html.includes("process.env"), false);
  assert.match(html, /src="\/config\/season\.js"/);
  assert.match(html, /function seasonDefaultType\(/);
  assert.match(html, /const TYPES=seasonPicker\(\)/);
  assert.match(html, /if\(blankLawnDefault\(savedRaw\)\)S\.type=seasonDefaultType\(\)/);
  assert.match(html, /applySeasonCopy\(\);\nfunction shouldOpenIntro/);
  assert.match(html, /Object\.assign\(defaults\(\),savedRaw/);
  assert.match(html, /\$9\.99 for the season, never auto-renews/);
  assert.equal(html.includes("tonight"), false);
  assert.match(html, /\$19\.99 covers a full year/);
  assert.equal(html.includes("student-owned"), false);
  assert.equal(html.includes("student owned"), false);
});

test("fall leads with yard cleanup and snow is second", () => {
  const fall = seasonView("fall");
  assert.equal(fall.defaultType, "prep");
  assert.equal(fall.picker.join(","), "prep,lawn,pet,snow,both");
  assert.equal(fall.picker[0], "prep");
  assert.equal(fall.prepCard.name, "Yard cleanup");
  assert.equal(fall.prepCard.blurb, "Leaf raking. Dead plant cleanup.");
  assert.equal(fall.prepCard.blurb.toLowerCase().includes("snow"), false);
  assert.match(fall.prepCard.img, /prep\.webp/);
  assert.equal(fall.parentsBiz, "Sam's Yard Cleanup");
  assert.equal(fall.parentsTown, "Elkhorn");
  assert.equal(fall.rates[0].n, "Yard cleanup, small");
  assert.equal(fall.rates[0].p, "15");
  assert.match(fall.rates[1].n, /Leaf/);
  assert.equal(fall.rates[1].p, "15");
  assert.match(fall.kicker, /YARD CLEANUP/);
  assert.match(fall.biz, /Taylor’s Yard Cleanup/);
  assert.match(fall.tagline, /Leaves/);
  assert.match(fall.payNote, /yard cleanup/);
  assert.equal(fall.payAmount, "+$15.00");
  assert.equal(JSON.stringify(fall).includes("student"), false);
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
  assert.equal(fallJobs.some((job) => job.n === "Shovel walks and driveway"), false);
  const shovel = snowJobs.find((job) => job.n === "Shovel walks and driveway");
  assert.equal(shovel.p, "15");
  assert.equal(fallJobs.find((job) => job.n === "Yard cleanup, small").p, "15");
  assert.equal(snowJobs.find((job) => job.n === "Yard cleanup, large").p, "40");
  const names = html.slice(html.indexOf("const PREP_FALL_NAMES="), html.indexOf("function prepIdea("));
  assert.match(names, /\{F\}’s Winter Prep/);
  assert.match(names, /\{F\}’s Yard Cleanup/);
  assert.match(names, /\{T\} Leaf Crew/);
  assert.match(names, /Curb Ready Yard Care/);
  assert.match(html, /const NAME_IDEAS=/);
  assert.match(html, /\{F\}’s Winter Prep/);
});

test("the season doc tells Steve to change one line and merge", async () => {
  const doc = await readFile(new URL("../docs/season-switch.md", import.meta.url), "utf8");
  assert.match(doc, /const SEASON = "fall"/);
  assert.match(doc, /"snow"/);
  assert.match(doc, /merge to main/i);
  assert.match(doc, /env var/i);
  assert.match(doc, /LAWN_SNAPSHOT/);
});
