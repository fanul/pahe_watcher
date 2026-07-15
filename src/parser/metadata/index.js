import { extractMetadata as parser01 } from './parser01.js';
import { extractMetadata as parser02 } from './parser02.js';

// Tried in order; each fills whatever the previous ones left empty. Add a
// new strategy by dropping a parserNN.js in this folder (exporting the same
// `extractMetadata(html)` shape) and listing it here.
const STRATEGIES = [parser01, parser02];

// Required for a post to count as "complete" — durationMinutes is
// deliberately excluded: confirmed from live data that even some movies and
// most series legitimately have no runtime shown, so requiring it would
// flag otherwise well-populated posts as incomplete.
const REQUIRED_FIELDS = ['poster', 'rating', 'synopsis', 'year', 'genre', 'actors'];

function emptyMetadata() {
  return {
    poster: '', rating: '', synopsis: '', year: null, genre: '',
    durationMinutes: null, director: '', creator: '', actors: '',
  };
}

/** Fills only `base`'s empty/null/falsy fields from `incoming` — never overwrites a field a prior strategy already found. */
export function mergeMetadata(base, incoming) {
  const merged = { ...base };
  for (const key of Object.keys(incoming)) {
    const current = merged[key];
    const isEmpty = current === null || current === undefined || current === '';
    if (isEmpty && incoming[key] !== null && incoming[key] !== undefined && incoming[key] !== '') {
      merged[key] = incoming[key];
    }
  }
  return merged;
}

/** True if every required field is present. `director` OR `creator` counts — series legitimately have only Creator. */
export function isMetadataComplete(meta) {
  const hasRequired = REQUIRED_FIELDS.every((key) => {
    const v = meta[key];
    return v !== null && v !== undefined && v !== '';
  });
  return hasRequired && Boolean(meta.director || meta.creator);
}

/**
 * Runs each metadata strategy in order, merging results and stopping as
 * soon as the merged result is complete. If no strategy reaches
 * completeness, returns the best-effort merge of everything found with
 * `metadataComplete: false` — callers use that flag to surface an
 * incomplete-metadata signal rather than silently accepting partial data.
 *
 * @param {string} html
 * @returns {ReturnType<typeof emptyMetadata> & {metadataComplete: boolean}}
 */
export function parsePostMetadata(html) {
  let merged = emptyMetadata();
  for (const strategy of STRATEGIES) {
    merged = mergeMetadata(merged, strategy(html));
    if (isMetadataComplete(merged)) return { ...merged, metadataComplete: true };
  }
  return { ...merged, metadataComplete: false };
}

export default parsePostMetadata;
