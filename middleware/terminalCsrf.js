// Double-submit CSRF check for terminal routes. Cookies are httpOnly (or, for
// cm_csrf, at least same-origin), so a cross-site page can trigger a request
// that carries them automatically -- but it can't read cm_csrf's value to
// echo it back in a header, which is what this checks.
//
// Applies to every state-changing terminal route (POST/PATCH/DELETE) once a
// session exists. Not applied to /api/terminal/login -- there's no CSRF
// cookie yet at that point, and rate limiting already bounds that endpoint.
function requireCsrf(req, res, next) {
  const cookieVal = req.cookies && req.cookies.cm_csrf;
  const headerVal = req.headers['x-csrf-token'];
  if (!cookieVal || !headerVal || cookieVal !== headerVal) {
    return res.status(403).json({ message: 'CSRF check failed.' });
  }

  const origin = req.headers.origin || req.headers.referer;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) {
        return res.status(403).json({ message: 'Origin mismatch.' });
      }
    } catch {
      return res.status(403).json({ message: 'Invalid origin.' });
    }
  }

  next();
}

module.exports = { requireCsrf };
