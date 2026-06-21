const PROTECTED_FIELDS = ['id', 'createdAt', 'updatedAt', 'history', 'auditLogId'];

const AUDIT_TYPES = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  ACTION: 'action',
  ROLLBACK: 'rollback'
};

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function computeDiff(before, after) {
  const changes = {};
  const allKeys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  for (const key of allKeys) {
    if (PROTECTED_FIELDS.includes(key)) continue;
    const beforeVal = before?.[key];
    const afterVal = after?.[key];
    const beforeStr = JSON.stringify(beforeVal);
    const afterStr = JSON.stringify(afterVal);
    if (beforeStr !== afterStr) {
      changes[key] = {
        before: beforeVal,
        after: afterVal
      };
    }
  }
  return changes;
}

function createAuditLog({ db, collection, recordId, action, actionLabel, before, after, note, operator }) {
  const now = new Date().toISOString();
  const diff = computeDiff(before, after);
  const log = {
    id: `audit-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    collection,
    recordId,
    action,
    actionLabel: actionLabel || action,
    before: before ? deepClone(before) : null,
    after: after ? deepClone(after) : null,
    diff,
    note: note || '',
    operator: operator || 'system',
    createdAt: now
  };
  if (!db.auditLogs) db.auditLogs = [];
  db.auditLogs.unshift(log);
  return log;
}

function getAuditLogsForRecord(db, collection, recordId) {
  if (!db.auditLogs) return [];
  return db.auditLogs.filter(
    (log) => log.collection === collection && log.recordId === recordId
  ).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function getAuditLogById(db, logId) {
  return db.auditLogs?.find((log) => log.id === logId) || null;
}

function rollbackToAuditLog(db, logId, note, operator) {
  const log = getAuditLogById(db, logId);
  if (!log) {
    return { error: '审计记录不存在' };
  }
  if (log.action === AUDIT_TYPES.DELETE) {
    return { error: '删除操作无法回滚' };
  }
  const { collection, recordId } = log;
  const currentRecord = db[collection]?.find((item) => item.id === recordId);
  if (!currentRecord) {
    return { error: '当前记录不存在，无法回滚' };
  }
  const rollbackTarget = log.action === AUDIT_TYPES.CREATE ? log.after : log.before;
  if (!rollbackTarget) {
    return { error: '目标版本数据不存在' };
  }
  const beforeRollback = deepClone(currentRecord);
  for (const key of Object.keys(currentRecord)) {
    if (!PROTECTED_FIELDS.includes(key)) {
      delete currentRecord[key];
    }
  }
  for (const key of Object.keys(rollbackTarget)) {
    if (!PROTECTED_FIELDS.includes(key)) {
      currentRecord[key] = deepClone(rollbackTarget[key]);
    }
  }
  currentRecord.updatedAt = new Date().toISOString();
  const rollbackNote = note || `回滚至 ${log.actionLabel} (${log.createdAt})`;
  if (!currentRecord.history) currentRecord.history = [];
  currentRecord.history.unshift({
    at: currentRecord.updatedAt,
    action: '回滚',
    note: rollbackNote
  });
  const auditLog = createAuditLog({
    db,
    collection,
    recordId,
    action: AUDIT_TYPES.ROLLBACK,
    actionLabel: '回滚',
    before: beforeRollback,
    after: deepClone(currentRecord),
    note: `${rollbackNote}，源审计记录：${logId}`,
    operator
  });
  return { item: currentRecord, auditLog, sourceLog: log };
}

module.exports = {
  PROTECTED_FIELDS,
  AUDIT_TYPES,
  computeDiff,
  createAuditLog,
  getAuditLogsForRecord,
  getAuditLogById,
  rollbackToAuditLog
};
