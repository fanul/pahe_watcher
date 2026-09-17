/**
 * Phrases shown by ad-gate anti-bot walls (confirmed live on intercelestial.com
 * — the "LL" ad-gate template also used by teknoasian.com) when they judge a
 * visit as automated/ad-blocked. This is a probabilistic check on their end,
 * not a hard block: retrying the whole chain from scratch (fresh token, fresh
 * session) has a real chance of passing next time. So unlike a confirmed-dead
 * link, this should fail FAST rather than sit out the full job timeout —
 * letting the job queue's existing retry loop get another attempt sooner.
 */
const ANTI_AUTOMATION_WALL_PATTERNS = [
  /ad blocker or auto-?click script detected/i,
  /turn off the auto-?click script/i,
  /(?:a script|a userscript|a browser extension) is (?:pressing|clicking|controlling)/i,
  /press(?:es|ing) the buttons? (?:on this page )?for you/i,
  /disable your ad blocker and any userscript/i,
  /skips? the countdown and hides? the ads/i,
  /switch (?:it|the (?:bypass )?script) off for this (?:site|page)/i,
  // NOT included here (tried and reverted): the generic Cloudflare-style
  // "Performing security verification... This page is displayed while the
  // website verifies you are not a bot" interstitial. Unlike every pattern
  // above (a genuine, persistent wall that never clears on its own),
  // confirmed live this is a TRANSIENT loading state — a real, unscripted
  // browser sat on it for a few seconds and it cleared itself automatically
  // into the real ad-gate page, no click or interaction needed. Treating it
  // as an instant-throw wall (as this briefly did) killed the job WHILE
  // Cloudflare was still mid-check, before it ever got the chance to clear
  // and reveal the real .myButton — reported live as "after it passes,
  // still doesn't detect the button", which was actually this resolver
  // never waiting long enough to let it pass at all. Left unhandled here on
  // purpose: the normal button-detection poll loop already waits and
  // rechecks every cycle, which is exactly the right behavior for a state
  // that's expected to clear on its own.
];

/** True if `pageText` (a page's visible text) reads as an anti-bot/anti-adblock wall. */
export function isAntiAutomationWallPage(pageText) {
  if (!pageText) return false;
  return ANTI_AUTOMATION_WALL_PATTERNS.some((re) => re.test(pageText));
}

export default isAntiAutomationWallPage;
