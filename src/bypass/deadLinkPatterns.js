/**
 * Phrases that indicate a shortener/GDFlix/Google Drive page is showing a
 * confirmed-dead file — not a transient failure (timeout, captcha stuck,
 * slow network) that's worth retrying. Matched against a page's visible text.
 */
const DEAD_LINK_PATTERNS = [
  /file (?:was |has been )?(?:not found|removed|deleted)/i,
  /this file (?:no longer exists|is no longer available)/i,
  /no longer (?:available|exists)/i,
  /link (?:has )?expired/i,
  /removed due to (?:copyright|a copyright|dmca)/i,
  /removed for violating/i,
  /deleted by (?:the )?(?:owner|uploader)/i,
  /file (?:doesn'?t|does not) exist/i,
  /download not available/i,
  /\b404\b.{0,20}not found/i,
];

/** True if `pageText` (a page's visible text) reads as a confirmed-dead file/link. */
export function isDeadLinkPage(pageText) {
  if (!pageText) return false;
  return DEAD_LINK_PATTERNS.some((re) => re.test(pageText));
}

export default isDeadLinkPage;
