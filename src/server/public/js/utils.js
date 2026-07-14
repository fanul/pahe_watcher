/** Update the matching item in place, or prepend if not found. Returns true if it was a fresh insert (not an update). */
export function upsert(arr, item, keyFn) {
  const k = keyFn(item);
  const i = arr.findIndex((x) => keyFn(x) === k);
  if (i >= 0) { arr[i] = item; return false; }
  arr.unshift(item);
  return true;
}

export function splitList(s) {
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

export function timeago(iso) {
  const d = (Date.now() - new Date(iso)) / 1000;
  if (d < 60) return `${Math.floor(d)}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  return `${Math.floor(d / 3600)}h ago`;
}
