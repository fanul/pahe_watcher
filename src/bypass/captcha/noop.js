/** No-op solver: assumes the injected userscript handles invisible captchas. */
export class NoopSolver {
  async solve() {
    return { solved: true, method: 'noop' };
  }
}
export default NoopSolver;
