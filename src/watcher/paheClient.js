import { createLogger } from '../core/logger.js';

const log = createLogger('pahe-client');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36';

/**
 * Client for pahe.ink. The site runs WordPress, so we use the WP REST API
 * (/wp-json/wp/v2/posts) rather than scraping HTML — far more stable.
 */
export class PaheClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async _fetchJson(url) {
    const { json } = await this._fetchJsonWithHeaders(url);
    return json;
  }

  async _fetchJsonWithHeaders(url) {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(`GET ${url} -> HTTP ${res.status}`);
    }
    return { json: await res.json(), headers: res.headers };
  }

  /**
   * Fetch the most recent posts.
   * @param {number} perPage
   * @returns {Promise<Array<{id,date,link,title}>>}
   */
  async getLatestPosts(perPage = 10) {
    const url = `${this.baseUrl}/wp-json/wp/v2/posts?per_page=${perPage}&_fields=id,date,link,title,categories`;
    const posts = await this._fetchJson(url);
    return posts.map((p) => ({
      id: p.id,
      date: p.date,
      link: p.link,
      title: decodeEntities(p.title?.rendered || ''),
      categories: p.categories || [],
    }));
  }

  /**
   * Fetch a specific page of posts.
   * @param {number} page
   * @param {number} perPage
   * @returns {Promise<Array<{id,date,link,title}>>}
   */
  async getPostsPage(page = 1, perPage = 10) {
    const url = `${this.baseUrl}/wp-json/wp/v2/posts?page=${page}&per_page=${perPage}&_fields=id,date,link,title,categories`;
    const posts = await this._fetchJson(url);
    return posts.map((p) => ({
      id: p.id,
      date: p.date,
      link: p.link,
      title: decodeEntities(p.title?.rendered || ''),
      categories: p.categories || [],
    }));
  }

  /**
   * Fetch a page of posts along with WP's total post/page counts, read from
   * the `X-WP-Total`/`X-WP-TotalPages` response headers WordPress always
   * sends on collection endpoints. `getPostsPage` never reads these — this
   * is what lets the sync engine know the real end of the catalog instead of
   * inferring it purely from "an empty page came back."
   * @returns {Promise<{posts: Array<{id,date,link,title}>, totalPosts: number|null, totalPages: number|null}>}
   */
  async getPostsPageMeta(page = 1, perPage = 10) {
    const url = `${this.baseUrl}/wp-json/wp/v2/posts?page=${page}&per_page=${perPage}&_fields=id,date,link,title,categories`;
    const { json, headers } = await this._fetchJsonWithHeaders(url);
    const totalPosts = parseIntHeader(headers.get('x-wp-total'));
    const totalPages = parseIntHeader(headers.get('x-wp-totalpages'));
    const posts = json.map((p) => ({
      id: p.id,
      date: p.date,
      link: p.link,
      title: decodeEntities(p.title?.rendered || ''),
      categories: p.categories || [],
    }));
    return { posts, totalPosts, totalPages };
  }

  /**
   * Fetch a single post's rendered HTML content.
   * @returns {Promise<{id,title,link,date,contentHtml}>}
   */
  async getPost(id) {
    const url = `${this.baseUrl}/wp-json/wp/v2/posts/${id}?_fields=id,date,link,title,content`;
    const p = await this._fetchJson(url);
    return {
      id: p.id,
      date: p.date,
      link: p.link,
      title: decodeEntities(p.title?.rendered || ''),
      contentHtml: p.content?.rendered || '',
    };
  }
}

/** Decode a small set of common HTML entities found in WP titles. */
export function decodeEntities(s) {
  return s
    .replace(/&#8217;/g, '’')
    .replace(/&#8216;/g, '‘')
    .replace(/&#8220;/g, '“')
    .replace(/&#8221;/g, '”')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .replace(/&#038;|&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function parseIntHeader(v) {
  if (v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
}

export default PaheClient;
