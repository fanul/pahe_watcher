import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractMetadata as parser01 } from '../src/parser/metadata/parser01.js';
import { extractMetadata as parser02 } from '../src/parser/metadata/parser02.js';
import { parsePostMetadata, isMetadataComplete, mergeMetadata } from '../src/parser/metadata/index.js';

// Real markup captured from a live pahe.ink movie post (imdbwp IMDb-widget layout).
const MOVIE_METADATA_SAMPLE = `
<div class="imdbwp imdbwp--movie dark">
<div class="imdbwp__thumb"><a class="imdbwp__link" href="http://www.imdb.com/title/tt26657236/"><img class="imdbwp__img" src="https://example.com/poster.jpg"></a></div>
<div class="imdbwp__content">
<div class="imdbwp__header"><span class="imdbwp__title">Backrooms</span> (2026)</p>
<div class="imdbwp__meta"><span>110 min</span>|<span>Horror, Sci-Fi, Thriller</span>|<span>29 May 2026</span></div>
</div>
<div class="imdbwp__belt"><span class="imdbwp__star">7.0</span><span class="imdbwp__rating"><strong>Rating:</strong> 7.0 / 10 from 100,148 users</span></div>
<div class="imdbwp__teaser">After a therapist's patient disappears into a dimension beyond reality, she must venture into the unknown to save him.</div>
<div class="imdbwp__footer"><strong>Director:</strong> <span>Kane Parsons</span><br /><strong>Creator:</strong> <span>Will Soodik, Kane Parsons</span><br /><strong>Actors:</strong> <span>Chiwetel Ejiofor, Renate Reinsve, Mark Duplass</span></div>
</div>
</div>
`;

// Real markup from a live in-progress series post: N/A duration, open-ended year, no Director line.
const SERIES_METADATA_SAMPLE = `
<div class="imdbwp imdbwp--series dark">
<div class="imdbwp__content">
<div class="imdbwp__header"><span class="imdbwp__title">House of the Dragon</span> (2022–)</p>
<div class="imdbwp__meta"><span>N/A</span>|<span>Action, Adventure, Drama</span>|<span>21 Aug 2022</span></div>
</div>
<div class="imdbwp__belt"><span class="imdbwp__star">8.3</span></div>
<div class="imdbwp__teaser">An internal succession war within House Targaryen.</div>
<div class="imdbwp__footer"><strong>Creator:</strong> <span>Ryan J. Condal, George R.R. Martin</span><br /><strong>Actors:</strong> <span>Matt Smith, Emma D'Arcy, Olivia Cooke</span></div>
</div>
</div>
`;

test('parser01 extracts year/genre/duration/director/creator/actors from a movie post', () => {
  const meta = parser01(MOVIE_METADATA_SAMPLE);
  assert.equal(meta.year, 2026);
  assert.equal(meta.genre, 'Horror, Sci-Fi, Thriller');
  assert.equal(meta.durationMinutes, 110);
  assert.equal(meta.director, 'Kane Parsons');
  assert.equal(meta.creator, 'Will Soodik, Kane Parsons');
  assert.equal(meta.actors, 'Chiwetel Ejiofor, Renate Reinsve, Mark Duplass');
});

test('parser01 handles series posts: open-ended year, N/A duration, no Director label', () => {
  const meta = parser01(SERIES_METADATA_SAMPLE);
  assert.equal(meta.year, 2022);
  assert.equal(meta.genre, 'Action, Adventure, Drama');
  assert.equal(meta.durationMinutes, null);
  assert.equal(meta.director, '');
  assert.equal(meta.creator, 'Ryan J. Condal, George R.R. Martin');
  assert.equal(meta.actors, "Matt Smith, Emma D'Arcy, Olivia Cooke");
});

test('parser01 defaults fields to empty/null when the imdbwp block is absent', () => {
  const meta = parser01('<p>No IMDb widget here.</p>');
  assert.equal(meta.year, null);
  assert.equal(meta.genre, '');
  assert.equal(meta.durationMinutes, null);
  assert.equal(meta.director, '');
  assert.equal(meta.creator, '');
  assert.equal(meta.actors, '');
});

// A page with no imdbwp block at all, but labeled metadata in plain prose —
// exercises parser02's generic label-scan fallback in isolation.
const GENERIC_LABELED_SAMPLE = `
  <div class="movie-info">
    <p>Released: 2020</p>
    <p>Genre: Action, Thriller</p>
    <p>Director: Jane Doe</p>
    <p>Cast: Alice Actor, Bob Star</p>
    <p>Runtime: 118 min</p>
    <p>Rating: 7.2 / 10</p>
  </div>
  <p>A long enough synopsis paragraph that should be picked up by the fallback synopsis scan since it has no links and is just about the plot and characters involved.</p>
`;

test('parser02 extracts labeled metadata from generic prose (no imdbwp block)', () => {
  const meta = parser02(GENERIC_LABELED_SAMPLE);
  assert.equal(meta.genre, 'Action, Thriller');
  assert.equal(meta.director, 'Jane Doe');
  assert.equal(meta.actors, 'Alice Actor, Bob Star');
  assert.equal(meta.durationMinutes, 118);
  assert.equal(meta.rating, '7.2');
  assert.ok(meta.synopsis.length > 50);
});

test('parser02 returns empty/null fields when nothing matches', () => {
  const meta = parser02('<p>Nothing useful here.</p>');
  assert.equal(meta.genre, '');
  assert.equal(meta.director, '');
  assert.equal(meta.actors, '');
  assert.equal(meta.durationMinutes, null);
});

test('mergeMetadata fills only empty fields, never overwrites an already-found value', () => {
  const base = { poster: 'p1', rating: '', synopsis: 's1', year: null, genre: '', durationMinutes: null, director: '', creator: '', actors: '' };
  const incoming = { poster: 'p2', rating: 'r2', synopsis: 's2', year: 2020, genre: 'g2', durationMinutes: 90, director: 'd2', creator: 'c2', actors: 'a2' };
  const merged = mergeMetadata(base, incoming);
  assert.equal(merged.poster, 'p1'); // already set, kept
  assert.equal(merged.synopsis, 's1'); // already set, kept
  assert.equal(merged.rating, 'r2'); // was empty, filled
  assert.equal(merged.year, 2020); // was null, filled
  assert.equal(merged.director, 'd2'); // was empty, filled
});

test('isMetadataComplete requires poster/rating/synopsis/year/genre/actors plus (director OR creator); duration is not required', () => {
  const complete = { poster: 'p', rating: 'r', synopsis: 's', year: 2020, genre: 'g', durationMinutes: null, director: '', creator: 'c', actors: 'a' };
  assert.equal(isMetadataComplete(complete), true); // no duration, but creator covers director

  const missingActors = { ...complete, actors: '' };
  assert.equal(isMetadataComplete(missingActors), false);

  const missingBothDirectorAndCreator = { ...complete, creator: '' };
  assert.equal(isMetadataComplete(missingBothDirectorAndCreator), false);

  const directorInsteadOfCreator = { ...complete, creator: '', director: 'd' };
  assert.equal(isMetadataComplete(directorInsteadOfCreator), true);
});

test('parsePostMetadata stops at parser01 when it alone is complete, and flags metadataComplete: true', () => {
  const meta = parsePostMetadata(MOVIE_METADATA_SAMPLE);
  assert.equal(meta.metadataComplete, true);
  assert.equal(meta.director, 'Kane Parsons');
});

test('parsePostMetadata falls through to parser02 when parser01 alone is incomplete, merging in whatever it finds', () => {
  // No imdbwp block, but the same fields available via generic labeled prose.
  const html = GENERIC_LABELED_SAMPLE + '<div class="imdbwp"><div class="imdbwp__thumb"><img class="imdbwp__img" src="https://example.com/p.jpg"></div></div>';
  const meta = parsePostMetadata(html);
  assert.equal(meta.poster, 'https://example.com/p.jpg'); // from parser01 (imdbwp__img)
  assert.equal(meta.genre, 'Action, Thriller'); // from parser02 (generic scan)
  assert.equal(meta.director, 'Jane Doe'); // from parser02
  assert.equal(meta.metadataComplete, true);
});

test('parsePostMetadata flags metadataComplete: false when neither strategy finds everything', () => {
  const meta = parsePostMetadata('<p>Totally unrelated page with no metadata at all.</p>');
  assert.equal(meta.metadataComplete, false);
});
