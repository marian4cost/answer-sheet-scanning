// Identidade apenas nos callbacks de testes isolados; o middleware HTTP continua obrigatório.
const nodeTest = require('node:test');
const {withAccount} = require('../dist/account-context');
const FIXTURE_ACCOUNT = {id:'11111111-1111-4111-8111-111111111111',email:'professor-ficticio@example.test'};
function scoped(register) {
  return (...args) => {
    const index = args.findLastIndex(arg => typeof arg === 'function');
    if (index >= 0) {
      const work = args[index];
      args[index] = (...parameters) => withAccount(FIXTURE_ACCOUNT, () => work(...parameters));
    }
    return register(...args);
  };
}
module.exports = Object.assign(scoped(nodeTest), {
  test:scoped(nodeTest.test),before:scoped(nodeTest.before),after:scoped(nodeTest.after),
  beforeEach:scoped(nodeTest.beforeEach),afterEach:scoped(nodeTest.afterEach),FIXTURE_ACCOUNT,
});
