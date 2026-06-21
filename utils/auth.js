const config = require('../project.config');

function generateToken() {
  return `sess-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function findUserByUsername(db, username) {
  return db.users?.find((u) => u.username === username) || null;
}

function findSessionByToken(db, token) {
  return db.sessions?.find((s) => s.token === token) || null;
}

function createSession(db, user) {
  if (!db.sessions) db.sessions = [];
  const token = generateToken();
  const session = {
    id: `session-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    token,
    userId: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  };
  db.sessions.unshift(session);
  return session;
}

function destroySession(db, token) {
  if (!db.sessions) return false;
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.token !== token);
  return db.sessions.length < before;
}

function cleanExpiredSessions(db) {
  if (!db.sessions) return;
  const now = new Date();
  db.sessions = db.sessions.filter((s) => new Date(s.expiresAt) > now);
}

function getUserFromRequest(db, req) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  cleanExpiredSessions(db);
  const session = findSessionByToken(db, token);
  if (!session) return null;
  const user = db.users?.find((u) => u.id === session.userId);
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    token: session.token
  };
}

function hasPermission(role, permission) {
  const roleConfig = config.roles?.[role];
  if (!roleConfig) return false;
  return roleConfig.permissions?.includes(permission) || false;
}

function roleLabel(role) {
  return config.roles?.[role]?.label || role;
}

function sanitizeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    name: user.name,
    roleLabel: roleLabel(user.role)
  };
}

module.exports = {
  generateToken,
  findUserByUsername,
  findSessionByToken,
  createSession,
  destroySession,
  cleanExpiredSessions,
  getUserFromRequest,
  hasPermission,
  roleLabel,
  sanitizeUser
};
