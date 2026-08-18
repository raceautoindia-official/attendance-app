// requireAuth, minus the JWT. The timeline route's access rule is tested by
// tests/timeline.js against a live server; this stub exists so the SQL the
// route builds can be tested without one.
async function requireAuth() {
  return { id: 1, emp_id: 'ADMIN001', role: 'super_admin', tv: 0 };
}

module.exports = { requireAuth };
