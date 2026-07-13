import { createLogger } from '../../core/logger.js';

const log = createLogger('captcha:flaresolverr');

/**
 * FlareSolverr/ByParr solver. Since ByParr is a drop-in replacement,
 * this class handles both providers. It sends a request to the
 * configured API endpoint, collects solved cookies, and injects
 * them into the Playwright page context, then reloads the page.
 */
export class FlareSolverrSolver {
  constructor(apiUrl, providerName = 'flaresolverr') {
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.providerName = providerName;
  }

  async solve(page, ctx = {}) {
    const url = page.url();
    ctx.log?.(`Requesting ${this.providerName} to solve challenge at ${url}...`);

    try {
      const payload = {
        cmd: 'request.get',
        url: url,
        maxTimeout: 60000,
      };

      const res = await fetch(`${this.apiUrl}/v1`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} from ${this.providerName}`);
      }

      const data = await res.json();
      if (data.status !== 'ok') {
        throw new Error(`${this.providerName} failed: ${data.message || 'unknown error'}`);
      }

      const solution = data.solution;
      if (solution && solution.cookies) {
        ctx.log?.(`Successfully bypassed challenge. Injecting ${solution.cookies.length} cookies...`);
        const playwrightCookies = solution.cookies.map((c) => ({
          name: c.name,
          value: c.value,
          domain: c.domain.startsWith('.') ? c.domain : `.${c.domain}`,
          path: c.path || '/',
          httpOnly: c.httpOnly ?? false,
          secure: c.secure ?? false,
          sameSite: c.sameSite === 'None' ? 'None' : c.sameSite === 'Lax' ? 'Lax' : c.sameSite === 'Strict' ? 'Strict' : undefined,
        }));

        await page.context().addCookies(playwrightCookies);
        ctx.log?.(`Cookies injected. Reloading page...`);
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        return { solved: true, method: this.providerName };
      } else {
        throw new Error(`No cookies returned from ${this.providerName}`);
      }
    } catch (err) {
      log.error(`${this.providerName} solve failed`, { error: err.message });
      ctx.log?.(`❌ ${this.providerName} failed: ${err.message}`);
      return { solved: false, method: this.providerName, error: err.message };
    }
  }
}

export default FlareSolverrSolver;
