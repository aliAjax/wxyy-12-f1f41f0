const PROTECTED_FIELDS = ['id', 'createdAt', 'updatedAt', 'history', 'auditLogId'];

const AUDIT_TYPES = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  ACTION: 'action',
  ROLLBACK: 'rollback',
  RECALC_RISK: 'recalc_risk'
};

const COLLECTION_RELATIONS = {
  surveys: [
    { collection: 'sites', localKey: 'siteId', label: '关联样点' }
  ],
  reviews: [
    { collection: 'surveys', localKey: 'surveyId', label: '关联巡测' },
    { collection: 'sites', localKey: 'siteId', label: '关联样点' },
    { collection: 'incidents', localKey: 'incidentId', label: '关联事件' }
  ],
  incidents: [
    { collection: 'sites', localKey: 'siteId', label: '关联样点' },
    { collection: 'surveys', localKey: 'surveyId', label: '关联巡测' },
    { collection: 'reviews', localKey: 'linkedReviewId', label: '联动复查' }
  ],
  sites: [
    { collection: 'surveys', localKey: 'siteId', isReverse: true, label: '关联巡测记录' }
  ],
  plans: [
    { collection: 'sites', localKey: 'siteIds', isArray: true, label: '关联样点' }
  ]
};

const IMPACT_TYPES = {
  DIRECT: 'direct',
  CASCADE: 'cascade',
  HINT: 'hint',
  REVERSE: 'reverse'
};

function isActualImpact(impact) {
  if (!impact) return false;
  if (impact.isActualImpact === false) return false;
  return impact.impactType !== IMPACT_TYPES.DIRECT;
}

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

function detectRelatedImpacts(db, collection, recordId, action, before, after) {
  const impacts = [];
  const relations = COLLECTION_RELATIONS[collection] || [];
  const record = after || before;
  if (!record) return impacts;

  for (const rel of relations) {
    if (rel.isReverse) {
      continue;
    }
    if (rel.isArray) {
      const ids = record[rel.localKey] || [];
      if (Array.isArray(ids) && ids.length > 0) {
        impacts.push({
          collection: rel.collection,
          recordIds: ids,
          relationLabel: rel.label,
          impactType: IMPACT_TYPES.DIRECT,
          isActualImpact: false,
          description: `${rel.label}：共 ${ids.length} 条（仅关联，未自动修改）`
        });
      }
    } else {
      const relatedId = record[rel.localKey];
      if (relatedId) {
        const relatedItem = db[rel.collection]?.find((item) => item.id === relatedId);
        impacts.push({
          collection: rel.collection,
          recordId: relatedId,
          relationLabel: rel.label,
          impactType: IMPACT_TYPES.DIRECT,
          isActualImpact: false,
          description: `${rel.label}（仅关联，未自动修改）`,
          recordLabel: relatedItem ? _getRecordLabel(rel.collection, relatedItem) : relatedId
        });
      }
    }
  }

  if (action === AUDIT_TYPES.DELETE) {
    for (const rel of relations) {
      if (!rel.isReverse) continue;
      const relatedItems = (db[rel.collection] || []).filter((item) => {
        if (rel.isArray) {
          return item[rel.localKey]?.includes(recordId);
        }
        return item[rel.localKey] === recordId;
      });
      if (relatedItems.length > 0) {
        impacts.push({
          collection: rel.collection,
          recordIds: relatedItems.map((item) => item.id),
          relationLabel: rel.label,
          impactType: IMPACT_TYPES.REVERSE,
          description: `${rel.label}：共 ${relatedItems.length} 条记录受影响`
        });
      }
    }
  }

  return impacts;
}

function _getRecordLabel(collection, item) {
  if (!item) return '';
  switch (collection) {
    case 'sites':
      return [item.cave, item.zone, item.pointCode].filter(Boolean).join(' / ');
    case 'surveys':
      return [item.surveyor, item.date].filter(Boolean).join(' / ');
    case 'reviews':
      return [item.assignee, item.dueDate].filter(Boolean).join(' / ');
    case 'incidents':
      return [item.eventType, item.reporter].filter(Boolean).join(' / ');
    case 'plans':
      return [item.route, item.plannedDate].filter(Boolean).join(' / ');
    default:
      return item.id || '';
  }
}

function createAuditLog({ db, collection, recordId, action, actionLabel, before, after, note, operator, relatedImpacts }) {
  const now = new Date().toISOString();
  const diff = computeDiff(before, after);
  const autoImpacts = detectRelatedImpacts(db, collection, recordId, action, before, after);
  const finalImpacts = relatedImpacts && relatedImpacts.length
    ? [...autoImpacts, ...relatedImpacts]
    : autoImpacts;
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
    relatedImpacts: finalImpacts,
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

function getIncomingImpacts(db, collection, recordId) {
  if (!db.auditLogs) return [];
  return db.auditLogs.filter((log) => {
    if (!log.relatedImpacts || !log.relatedImpacts.length) return false;
    return log.relatedImpacts.some((impact) => {
      if (impact.collection !== collection) return false;
      if (!isActualImpact(impact)) return false;
      if (impact.recordId === recordId) return true;
      if (impact.recordIds && Array.isArray(impact.recordIds) && impact.recordIds.includes(recordId)) return true;
      return false;
    });
  }).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function enrichAuditLogWithImpactDetails(db, log) {
  if (!log.relatedImpacts || !log.relatedImpacts.length) return log;
  const enriched = deepClone(log);
  for (const impact of enriched.relatedImpacts) {
    if (impact.recordId && !impact.recordLabel) {
      const item = db[impact.collection]?.find((item) => item.id === impact.recordId);
      if (item) {
        impact.recordLabel = _getRecordLabel(impact.collection, item);
      }
    }
    if (impact.recordIds && Array.isArray(impact.recordIds) && !impact.recordLabels) {
      impact.recordLabels = impact.recordIds.map((rid) => {
        const item = db[impact.collection]?.find((item) => item.id === rid);
        return { id: rid, label: item ? _getRecordLabel(impact.collection, item) : rid };
      });
    }
  }
  return enriched;
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
  const rollbackTarget = log.after;
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
  const rollbackNote = note || `恢复到「${log.actionLabel}」(${log.createdAt}) 操作完成后的状态`;
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
    note: `${rollbackNote}，源审计记录：${logId}（${log.actionLabel}）`,
    operator
  });
  return { item: currentRecord, auditLog, sourceLog: log };
}

module.exports = {
  PROTECTED_FIELDS,
  AUDIT_TYPES,
  COLLECTION_RELATIONS,
  IMPACT_TYPES,
  isActualImpact,
  computeDiff,
  detectRelatedImpacts,
  _getRecordLabel,
  createAuditLog,
  getAuditLogsForRecord,
  getAuditLogById,
  getIncomingImpacts,
  enrichAuditLogWithImpactDetails,
  rollbackToAuditLog
};
