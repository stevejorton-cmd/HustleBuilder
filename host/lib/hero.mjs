// Phone hero width after the 22px side padding on a 390px screen.
export const HERO_BOX_PX = 346;

// Largest size, from 15 to 84, whose longest word fits the box.
// 0.75em covers a wide fallback such as Impact. The live page still
// measures the real font and only hyphenates if 15px is not enough.
export function heroFitPx(name, boxPx) {
  const words = String(name || "").toUpperCase().split(/[^A-Z0-9&']+/).filter(Boolean);
  const longest = words.reduce((n, w) => Math.max(n, w.length), 1);
  const box = Math.max(120, Number(boxPx) || HERO_BOX_PX);
  const size = Math.floor(box / (longest * 0.75));
  return Math.max(15, Math.min(84, size));
}

export function heroFitBoot() {
  return `<script id="hb-hero-fit">(function(){function fitHero(){var h1=document.querySelector(".hero h1");if(!h1)return;var box=h1.parentElement;var boxCss=box?getComputedStyle(box):null;var width=box?box.clientWidth-parseFloat(boxCss.paddingLeft||0)-parseFloat(boxCss.paddingRight||0):0;if(!width)return;var words=String(h1.textContent||"").toUpperCase().split(/[^A-Z0-9&']+/).filter(Boolean);var longest=words.reduce(function(a,b){return a.length>=b.length?a:b;},"")||"X";var probe=document.getElementById("hb-hero-probe");if(!probe){probe=document.createElement("span");probe.id="hb-hero-probe";probe.setAttribute("aria-hidden","true");probe.style.cssText="position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;pointer-events:none;";document.body.appendChild(probe);}var cs=getComputedStyle(h1);probe.style.fontFamily=cs.fontFamily;probe.style.fontStyle=cs.fontStyle;probe.style.fontWeight=cs.fontWeight;probe.style.letterSpacing=cs.letterSpacing;probe.style.textTransform="uppercase";probe.textContent=longest;var min=15,max=84,lo=min,hi=max,best=min,mid;while(lo<=hi){mid=(lo+hi)>>1;probe.style.fontSize=mid+"px";if(probe.getBoundingClientRect().width<=width){best=mid;lo=mid+1;}else hi=mid-1;}h1.style.setProperty("font-size",best+"px","important");h1.style.setProperty("overflow-wrap","normal","important");h1.style.setProperty("word-break","normal","important");h1.style.setProperty("hyphens","manual","important");probe.style.fontSize=best+"px";if(probe.getBoundingClientRect().width>width+0.5){if(!h1.getAttribute("lang"))h1.setAttribute("lang","en");h1.style.setProperty("hyphens","auto","important");h1.style.setProperty("overflow-wrap","break-word","important");}}fitHero();window.addEventListener("resize",fitHero);if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitHero);})();</script>`;
}
