// A limiter belongs to one app, never to the imported module/process.
export function createLoginLimiter(clock = Date.now) {
  const loginAttempts = new Map();
  function pruneLoginAttempts(now) {
    for (const [ip, values] of loginAttempts) {
      const recent = values.filter((time) => now - time < 15 * 60_000);
      if (recent.length) loginAttempts.set(ip, recent);
      else loginAttempts.delete(ip);
    }
  }

  function loginAllowed(ip) {
    const now = clock();
    if (loginAttempts.size > 2_000) pruneLoginAttempts(now);
    const attempts = (loginAttempts.get(ip) || []).filter((time) => now - time < 15 * 60_000);
    loginAttempts.set(ip, attempts);
    return attempts.length < 8;
  }

  function recordLoginFailure(ip) {
    const attempts = loginAttempts.get(ip) || [];
    attempts.push(clock());
    loginAttempts.set(ip, attempts);
  }

  function clearLoginFailures(ip) {
    loginAttempts.delete(ip);
  }

  return { loginAllowed, recordLoginFailure, clearLoginFailures };
}
