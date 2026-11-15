// One switch for the whole app. Change this line, then merge to main.
// It is not a Vercel env var.
const SEASON = "fall";

// Exact home, /parents, and welcome sample on 2026-11-14, before this switch.
// The live app was lawn-first, not snow-first. Kept here so that copy is not lost.
const LAWN_SNAPSHOT = {
  defaultType: "lawn",
  picker: ["lawn", "snow", "both", "pet", "prep"],
  parentsBiz: "Sam's Lawn Co.",
  parentsTown: "Elkhorn",
  rates: [{ n: "Mow a small yard", p: "20" }, { n: "Leaf cleanup", p: "15" }],
  kicker: "NEIGHBORHOOD LAWN CARE",
  biz: "Taylor’s Yard Crew",
  bizHtml: "Taylor’s<br>Yard Crew",
  tagline: "Fresh cuts. Happy neighbors.",
  flyerLabel: "Example flyer for Taylor’s Yard Crew: mowing $20, leaf cleanup $15, with a sample QR code",
  payAmount: "+$20.00",
  payNote: "“Thanks for mowing!”",
  sampleType: "lawn"
};

const SEASON_PACKS = {
  fall: {
    defaultType: "prep",
    picker: ["prep", "lawn", "pet", "snow", "both"],
    prepCard: { name: "Yard cleanup", blurb: "Leaves. Gutters. Garden cleanup.", img: "assets/jobs/prep.webp" },
    parentsBiz: "Sam's Yard Cleanup",
    parentsTown: "Elkhorn",
    rates: [{ n: "Yard cleanup, small", p: "15" }, { n: "Leaf raking", p: "15" }],
    kicker: "NEIGHBORHOOD YARD CLEANUP",
    biz: "Taylor’s Yard Cleanup",
    bizHtml: "Taylor’s<br>Yard Cleanup",
    tagline: "Leaves raked. Yard ready for winter.",
    flyerLabel: "Example flyer for Taylor’s Yard Cleanup: yard cleanup $15, leaf raking $15, with a sample QR code",
    payAmount: "+$15.00",
    payNote: "“Thanks for the yard cleanup!”",
    sampleType: "prep"
  },
  snow: {
    defaultType: "snow",
    picker: ["snow", "lawn", "both", "pet", "prep"],
    prepCard: { name: "Winter prep", blurb: "Yard cleanup and snow" },
    parentsBiz: "Sam's Snow Removal",
    parentsTown: "Elkhorn",
    rates: [{ n: "Shovel the driveway", p: "10" }, { n: "Shovel driveway and walk", p: "12" }],
    kicker: "NEIGHBORHOOD SNOW REMOVAL",
    biz: "Taylor’s Snow Removal",
    bizHtml: "Taylor’s<br>Snow Removal",
    tagline: "Driveway clear. Kid-owned.",
    flyerLabel: "Example flyer for Taylor’s Snow Removal: driveway $10, walk $12, with a sample QR code",
    payAmount: "+$10.00",
    payNote: "“Thanks for shoveling!”",
    sampleType: "snow"
  }
};

function seasonView(season) {
  const id = season === undefined ? SEASON : season;
  return SEASON_PACKS[id] || SEASON_PACKS.fall;
}

globalThis.HB_SEASON_FILE = { SEASON, LAWN_SNAPSHOT, seasonView };
