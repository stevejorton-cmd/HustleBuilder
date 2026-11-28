// "auto" follows the calendar. "fall", "winter", "snow", or "summer"
// forces that season. It is not a Vercel env var. The page reads this
// file when it loads. A device can also remember hb-season-mode.
const SEASON = "auto";

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

// Prices match the builder's beginner level. Minutes match other timed jobs.
const FALL_WINTER_IDEAS = [
  { type: "snow", emoji: "❄️", name: "Snow shoveling", service: "Snow shoveling, about 45 minutes", blurb: "Driveways, sidewalks, and steps.", price: "12", minutes: 45 },
  { type: "prep", emoji: "🍂", name: "Leaf raking", service: "Leaf raking", blurb: "Rake and bag a yard.", price: "12", minutes: 45 },
  { type: "prep", emoji: "🧹", name: "Yard and gutter cleanup", service: "Yard and gutter cleanup", blurb: "Yard cleanup and gutters you can reach from the ground.", price: "15", minutes: 60 },
  { type: "snow", emoji: "🧂", name: "De-ice and salt the walks", service: "De-ice and salt the walks", blurb: "Salt and de-ice sidewalks and steps.", price: "4", minutes: 20 },
  { type: "help", emoji: "💡", name: "Holiday light help", service: "Holiday light help, 1 hour", blurb: "About 1 hour. A parent approves the tools.", price: "10", minutes: 60 },
  { type: "help", emoji: "🎁", name: "Gift wrapping", service: "Gift wrapping, 30 minutes", blurb: "About 30 minutes indoors.", price: "8", minutes: 30 },
  { type: "pet", emoji: "🐶", name: "Pet sitting over the holidays", service: "Pet sitting over the holidays", blurb: "A visit while neighbors are away.", price: "10", minutes: 30 },
  { type: "snow", emoji: "🪵", name: "Stack firewood", service: "Stack firewood", blurb: "Stack a small pile.", price: "8", minutes: 45 },
  { type: "snow", emoji: "🚗", name: "Brush snow off the car", service: "Brush snow off the car", blurb: "Clear snow off a parked car.", price: "4", minutes: 15 },
  { type: "tutor", emoji: "📚", name: "Indoor tutoring", service: "Indoor tutoring, 30 minutes", blurb: "About 30 minutes. A parent stays nearby.", price: "12", minutes: 30 },
  { type: "help", emoji: "🤝", name: "Babysitting help", service: "Babysitting help, 1 hour", blurb: "About 1 hour. A parent is home.", price: "10", minutes: 60 }
];

const SUMMER_IDEAS = [
  { type: "lawn", emoji: "🌿", name: "Lawn mowing", service: "Mow a small yard", blurb: "Mow, trim, and edge.", price: "10", minutes: 45 },
  { type: "lawn", emoji: "🍂", name: "Leaf raking", service: "Leaf raking", blurb: "Rake and bag a yard.", price: "12", minutes: 45 },
  { type: "pet", emoji: "🐶", name: "Dog walking", service: "Dog walk, 30 minutes", blurb: "A 30-minute walk.", price: "8", minutes: 30 },
  { type: "wash", emoji: "🚗", name: "Car washing", service: "Wash the outside", blurb: "Soap, rinse, and a dry towel.", price: "10", minutes: 45 },
  { type: "snow", emoji: "❄️", name: "Snow shoveling", service: "Snow shoveling, about 45 minutes", blurb: "Driveways, sidewalks, and steps. Still on the list.", price: "12", minutes: 45 }
];

const SEASON_PRICE = {
  priceLead: "$9.99 for the season, never auto-renews.",
  priceMeta: "A parent puts a kid's neighborhood business online. $9.99 for the season, or $19.99 for a year. It never auto-renews.",
  priceShare: "$9.99 for the season. Never auto-renews.",
  priceFaq: "$9.99 for the season, or $19.99 for a year. The first 14 days after publish are free.",
  priceOffer: "Season, one-time, never auto-renews"
};

const SEASON_PACKS = {
  fall: Object.assign({
    defaultType: "prep",
    picker: ["snow", "prep", "lawn", "pet", "both"],
    prepCard: { name: "Yard cleanup", blurb: "Leaf raking. Dead plant cleanup.", img: "assets/jobs/prep.webp" },
    parentsBiz: "Taylor's Yard Cleanup",
    parentsTown: "Elkhorn",
    rates: [{ n: "Yard cleanup, small", p: "15" }, { n: "Leaf raking", p: "15" }],
    kicker: "NEIGHBORHOOD YARD CLEANUP",
    biz: "Taylor’s Yard Cleanup",
    bizHtml: "Taylor’s<br>Yard Cleanup",
    tagline: "Leaves raked. Dead plants cleared.",
    flyerLabel: "Example flyer for Taylor’s Yard Cleanup: yard cleanup $15, leaf raking $15, with a sample QR code",
    payAmount: "+$15.00",
    payNote: "“Thanks for the yard cleanup!”",
    sampleType: "prep",
    ideaLead: "Fall and winter ideas. Snow shoveling is for driveways, sidewalks, and steps.",
    safety: "For gutter cleanup, stay on the ground. A parent approves the tools. Babysitting help means a parent is home.",
    ideas: FALL_WINTER_IDEAS
  }, SEASON_PRICE),
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
    sampleType: "snow",
    ideaLead: "Winter ideas. Snow shoveling comes first.",
    safety: "For gutter cleanup, stay on the ground. A parent approves the tools. Babysitting help means a parent is home.",
    ideas: FALL_WINTER_IDEAS,
    priceLead: "$9.99 for the whole winter, never auto-renews.",
    priceMeta: "A parent puts a kid's neighborhood business online. $9.99 for the whole winter, or $19.99 for a year. It never auto-renews.",
    priceShare: "$9.99 for the whole winter. Never auto-renews.",
    priceFaq: "$9.99 for the whole winter, or $19.99 for a year. The first 14 days after publish are free.",
    priceOffer: "Winter season, one-time, never auto-renews"
  },
  summer: Object.assign({
    defaultType: "lawn",
    picker: ["lawn", "snow", "both", "pet", "prep"],
    prepCard: { name: "Yard cleanup", blurb: "Leaf raking. Dead plant cleanup.", img: "assets/jobs/prep.webp" },
    parentsBiz: LAWN_SNAPSHOT.parentsBiz,
    parentsTown: LAWN_SNAPSHOT.parentsTown,
    rates: LAWN_SNAPSHOT.rates,
    kicker: LAWN_SNAPSHOT.kicker,
    biz: LAWN_SNAPSHOT.biz,
    bizHtml: LAWN_SNAPSHOT.bizHtml,
    tagline: LAWN_SNAPSHOT.tagline,
    flyerLabel: LAWN_SNAPSHOT.flyerLabel,
    payAmount: LAWN_SNAPSHOT.payAmount,
    payNote: LAWN_SNAPSHOT.payNote,
    sampleType: "lawn",
    ideaLead: "Spring and summer ideas. Lawn care leads, and snow shoveling stays on the list.",
    safety: "",
    ideas: SUMMER_IDEAS
  }, SEASON_PRICE)
};

function seasonForDate(date) {
  // getMonth is checked instead of instanceof Date so a date from another
  // realm, including the test runner, still counts.
  const stamp = date && typeof date.getMonth === "function" ? date.getTime() : NaN;
  const d = Number.isFinite(stamp) ? date : new Date();
  const month = d.getMonth();
  if (month === 11 || month === 0 || month === 1) return "winter";
  if (month >= 8 && month <= 10) return "fall";
  return "summer";
}

function canonicalSeason(id) {
  if (id === "snow" || id === "winter") return "winter";
  if (id === "summer" || id === "spring" || id === "lawn") return "summer";
  if (id === "fall") return "fall";
  return "";
}

function resolveSeason(season, date) {
  const raw = season === undefined ? SEASON : season;
  const named = canonicalSeason(raw);
  if (named) return named;
  return seasonForDate(date);
}

function seasonView(season, date) {
  const id = resolveSeason(season, date);
  if (id === "winter") return SEASON_PACKS.snow;
  return SEASON_PACKS[id] || SEASON_PACKS.fall;
}

function activeSeason(date) {
  return resolveSeason(SEASON, date);
}

globalThis.HB_SEASON_FILE = { SEASON, LAWN_SNAPSHOT, SEASON_PACKS, seasonForDate, canonicalSeason, resolveSeason, seasonView, activeSeason };
