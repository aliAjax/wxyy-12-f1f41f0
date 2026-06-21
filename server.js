const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const audit = require('./utils/audit');
const auth = require('./utils/auth');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

let dbWriteQueue = Promise.resolve();
let dbWriteLock = false;

async function withDbWrite(fn) {
  const result = dbWriteQueue.then(async () => {
    dbWriteLock = true;
    try {
      return await fn();
    } finally {
      dbWriteLock = false;
    }
  });
  dbWriteQueue = result.catch(() => {});
  return result;
}

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function getThresholdRules(db) {
  const dbRules = db?.thresholdRules || {};
  const defaultRules = config.thresholdRules || {};
  const result = {};
  for (const key of ['temperature', 'humidity', 'co2']) {
    result[key] = {
      warning: dbRules[key]?.warning ?? defaultRules[key]?.warning ?? 0,
      critical: dbRules[key]?.critical ?? defaultRules[key]?.critical ?? 0
    };
  }
  return result;
}

async function authMiddleware(req, res, next) {
  const db = await readDb();
  const user = auth.getUserFromRequest(db, req);
  req.user = user;
  req.db = db;
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  next();
}

function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: '请先登录' });
    }
    if (!auth.hasPermission(req.user.role, permission)) {
      return res.status(403).json({ error: `无权限执行此操作` });
    }
    next();
  };
}

app.get('/api/auth/me', authMiddleware, (req, res) => {
  if (req.user) {
    res.json(auth.sanitizeUser(req.user));
  } else {
    res.json(null);
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }
  const db = await readDb();
  const user = auth.findUserByUsername(db, username);
  if (!user || user.password !== password) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const session = auth.createSession(db, user);
  await writeDb(db);
  res.json({
    user: auth.sanitizeUser(user),
    token: session.token
  });
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    const db = await readDb();
    auth.destroySession(db, token);
    await writeDb(db);
  }
  res.json({ success: true });
});

app.get('/api/config', authMiddleware, async (req, res) => {
  const db = req.db;
  const thresholdRules = getThresholdRules(db);
  res.json({ ...config, thresholdRules });
});

app.patch('/api/config/thresholdRules', authMiddleware, requirePermission('config:update'), async (req, res) => {
  const newRules = req.body;
  if (!newRules || typeof newRules !== 'object') return res.status(400).json({ error: 'invalid rules' });
  const db = req.db;
  db.thresholdRules = db.thresholdRules || {};
  for (const key of ['temperature', 'humidity', 'co2']) {
    if (newRules[key]) {
      db.thresholdRules[key] = db.thresholdRules[key] || {};
      if (typeof newRules[key].warning === 'number') db.thresholdRules[key].warning = newRules[key].warning;
      if (typeof newRules[key].critical === 'number') db.thresholdRules[key].critical = newRules[key].critical;
    }
  }
  await writeDb(db);
  config.thresholdRules = getThresholdRules(db);
  res.json(config.thresholdRules);
});

app.get('/api/db', authMiddleware, async (req, res) => {
  const db = req.db;
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

function computeAutoRisk(survey, site, rules) {
  if (!site) return { autoRiskLevel: '', autoRiskReasons: [], deviationTemp: 0, deviationHumidity: 0, deviationCo2: 0 };
  const deviationTemp = Math.abs(Number(survey.temperature || 0) - Number(site.baselineTemp || 0));
  const deviationHumidity = Math.abs(Number(survey.humidity || 0) - Number(site.baselineHumidity || 0));
  const deviationCo2 = Math.abs(Number(survey.co2 || 0) - Number(site.baselineCo2 || 0));
  const reasons = [];
  let level = '';
  const tr = rules || {};
  const tempRule = tr.temperature || {};
  const humRule = tr.humidity || {};
  const co2Rule = tr.co2 || {};
  if (deviationTemp >= (tempRule.critical || 4)) {
    reasons.push(`温度偏差${deviationTemp.toFixed(1)}℃≥${tempRule.critical}℃(高风险阈值)`);
    level = '高风险';
  } else if (deviationTemp >= (tempRule.warning || 2)) {
    reasons.push(`温度偏差${deviationTemp.toFixed(1)}℃≥${tempRule.warning}℃(预警阈值)`);
    if (level !== '高风险') level = '预警';
  }
  if (deviationHumidity >= (humRule.critical || 20)) {
    reasons.push(`湿度偏差${deviationHumidity.toFixed(1)}%≥${humRule.critical}%(高风险阈值)`);
    level = '高风险';
  } else if (deviationHumidity >= (humRule.warning || 10)) {
    reasons.push(`湿度偏差${deviationHumidity.toFixed(1)}%≥${humRule.warning}%(预警阈值)`);
    if (level !== '高风险') level = '预警';
  }
  if (deviationCo2 >= (co2Rule.critical || 400)) {
    reasons.push(`CO2偏差${deviationCo2.toFixed(0)}ppm≥${co2Rule.critical}ppm(高风险阈值)`);
    level = '高风险';
  } else if (deviationCo2 >= (co2Rule.warning || 200)) {
    reasons.push(`CO2偏差${deviationCo2.toFixed(0)}ppm≥${co2Rule.warning}ppm(预警阈值)`);
    if (level !== '高风险') level = '预警';
  }
  return { autoRiskLevel: level || '正常', autoRiskReasons: reasons, deviationTemp, deviationHumidity, deviationCo2 };
}

app.post('/api/:collection', authMiddleware, async (req, res) => {
  const { collection } = req.params;
  const permissionMap = {
    sites: 'sites:create',
    surveys: 'surveys:create',
    plans: 'plans:create',
    reviews: 'reviews:create',
    incidents: 'incidents:create'
  };
  const requiredPermission = permissionMap[collection];
  if (requiredPermission && !req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (requiredPermission && req.user && !auth.hasPermission(req.user.role, requiredPermission)) {
    return res.status(403).json({ error: '无权限创建此类型记录' });
  }
  const db = req.db;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (collection === 'incidents') {
    const siteId = req.body.siteId;
    if (!siteId) return res.status(400).json({ error: '关联样点必填，无法创建事件' });
    const siteExists = db.sites?.some((s) => s.id === siteId);
    if (!siteExists) return res.status(400).json({ error: '关联样点不存在，无法创建事件' });
  }
  const operator = req.user ? req.user.name : (req.body.operator || req.headers['x-operator'] || 'system');
  const now = new Date().toISOString();
  const thresholdRules = getThresholdRules(db);
  const autoCreateReview = collection === 'incidents' && req.body.autoCreateReview === true;
  delete req.body.autoCreateReview;
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  if (collection === 'surveys' && item.siteId) {
    const site = db.sites?.find((s) => s.id === item.siteId);
    const risk = computeAutoRisk(item, site, thresholdRules);
    item.autoRiskLevel = risk.autoRiskLevel;
    item.autoRiskReasons = risk.autoRiskReasons;
    item.deviationTemp = risk.deviationTemp;
    item.deviationHumidity = risk.deviationHumidity;
    item.deviationCo2 = risk.deviationCo2;
    item.manuallyReviewed = false;
    if (risk.autoRiskLevel === '高风险' && (!item.status || item.status === '正常')) {
      item.status = '异常待复查';
    }
    const riskNote = risk.autoRiskLevel !== '正常' ? `自动判定：${risk.autoRiskLevel}（${risk.autoRiskReasons.join('；')}）` : '自动判定：正常';
    item.history[0] = stamp('创建', `${req.body.note || req.body.memo || ''}${req.body.note || req.body.memo ? '；' : ''}${riskNote}`);
  }

  let linkedReview = null;
  if (collection === 'incidents' && autoCreateReview && ['严重', '紧急'].includes(item.severity)) {
    if (!db.reviews) db.reviews = [];
    let targetSurveyId = item.surveyId || '';
    if (!targetSurveyId) {
      const siteSurveys = (db.surveys || [])
        .filter((survey) => survey.siteId === item.siteId)
        .sort(sortNewest);
      targetSurveyId = siteSurveys[0]?.id || '';
    }
    const dueDate = new Date();
    dueDate.setDate(dueDate.getDate() + 3);
    linkedReview = {
      id: `reviews-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      surveyId: targetSurveyId,
      siteId: item.siteId,
      incidentId: item.id,
      assignee: operator,
      dueDate: dueDate.toISOString().slice(0, 10),
      status: '待处理',
      suggestion: `因${item.severity}干扰事件「${item.eventType}」自动创建的联动复查任务，请核实事件影响并完成复查。`,
      autoCreatedFromIncident: true,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', `由干扰事件 ${item.id} 自动联动创建`)]
    };
    item.linkedReviewId = linkedReview.id;
    item.history.unshift(stamp('联动复查', `已自动创建复查任务 ${linkedReview.id}`));
    audit.createAuditLog({
      db,
      collection: 'reviews',
      recordId: linkedReview.id,
      action: audit.AUDIT_TYPES.CREATE,
      actionLabel: '创建（联动）',
      before: null,
      after: linkedReview,
      note: `由干扰事件 ${item.id} 自动创建`,
      operator
    });
    db.reviews.push(linkedReview);
  }
  audit.createAuditLog({
    db,
    collection,
    recordId: item.id,
    action: audit.AUDIT_TYPES.CREATE,
    actionLabel: '创建',
    before: null,
    after: item,
    note: req.body.note || req.body.memo || (linkedReview ? `自动创建联动复查任务 ${linkedReview.id}` : ''),
    operator
  });
  db[collection].push(item);
  await writeDb(db);
  const response = { ...item };
  if (linkedReview) response.linkedReview = linkedReview;
  res.status(201).json(response);
});

app.patch('/api/:collection/:id', authMiddleware, async (req, res) => {
  const { collection, id } = req.params;
  const permissionMap = {
    sites: 'sites:update',
    surveys: 'surveys:update',
    plans: 'plans:update',
    reviews: 'reviews:update',
    incidents: 'incidents:update'
  };
  const requiredPermission = permissionMap[collection];
  if (requiredPermission && !req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (requiredPermission && req.user && !auth.hasPermission(req.user.role, requiredPermission)) {
    return res.status(403).json({ error: '无权限更新此类型记录' });
  }
  const db = req.db;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const beforeUpdate = JSON.parse(JSON.stringify(item));
  const historyAction = req.body.historyAction;
  const operator = req.user ? req.user.name : (req.body.operator || req.headers['x-operator'] || 'system');
  delete req.body.historyAction;
  delete req.body.operator;
  const thresholdRules = getThresholdRules(db);
  const oldStatus = item.status;

  const baselineFields = ['baselineTemp', 'baselineHumidity', 'baselineCo2'];
  let baselineChanged = false;
  let baselineChanges = {};
  if (collection === 'sites') {
    for (const field of baselineFields) {
      if (req.body[field] !== undefined && Number(req.body[field]) !== Number(item[field])) {
        baselineChanged = true;
        baselineChanges[field] = {
          before: Number(item[field]),
          after: Number(req.body[field])
        };
      }
    }
  }

  if (collection === 'surveys' && req.body.status !== undefined && req.body.status !== oldStatus) {
    const newStatus = req.body.status;
    if (newStatus === '已复查') {
      if (!req.user || !auth.hasPermission(req.user.role, 'surveys:review')) {
        return res.status(403).json({ error: '无权限完成复查' });
      }
    }
    if (newStatus === '异常待复查') {
      if (!req.user || !auth.hasPermission(req.user.role, 'surveys:markAbnormal')) {
        return res.status(403).json({ error: '无权限标记异常' });
      }
    }
  }

  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  if (collection === 'surveys') {
    if (req.body.status && req.body.status !== oldStatus) {
      item.manuallyReviewed = true;
    }
    const hasMeasurementChanges = req.body.temperature !== undefined || req.body.humidity !== undefined || req.body.co2 !== undefined;
    if (hasMeasurementChanges && item.siteId) {
      const site = db.sites?.find((s) => s.id === item.siteId);
      const risk = computeAutoRisk(item, site, thresholdRules);
      item.autoRiskLevel = risk.autoRiskLevel;
      item.autoRiskReasons = risk.autoRiskReasons;
      item.deviationTemp = risk.deviationTemp;
      item.deviationHumidity = risk.deviationHumidity;
      item.deviationCo2 = risk.deviationCo2;
      if (!item.manuallyReviewed && risk.autoRiskLevel === '高风险' && item.status === '正常') {
        item.status = '异常待复查';
      }
    }
  }
  item.history = item.history || [];
  const historyNote = req.body.note || req.body.memo || '';
  if (historyAction || historyNote || req.body.status || baselineChanged) {
    const finalNote = baselineChanged
      ? `${historyNote ? historyNote + '；' : ''}基准值变更（${Object.keys(baselineChanges).join('、')}）`
      : historyNote;
    item.history.unshift(stamp(historyAction || req.body.status || '更新', finalNote));
  }
  audit.createAuditLog({
    db,
    collection,
    recordId: id,
    action: audit.AUDIT_TYPES.UPDATE,
    actionLabel: historyAction || '更新',
    before: beforeUpdate,
    after: item,
    note: historyNote,
    operator
  });
  await writeDb(db);

  if (collection === 'sites' && baselineChanged) {
    const siteSurveys = (db.surveys || [])
      .filter((s) => s.siteId === id)
      .sort(sortNewest)
      .slice(0, 10);
    const responseItem = JSON.parse(JSON.stringify(item));
    responseItem.baselineChanged = true;
    responseItem.baselineChanges = baselineChanges;
    responseItem.affectedSurveyCount = siteSurveys.length;
    responseItem.recentSurveys = siteSurveys.map((s) => ({
      id: s.id,
      date: s.date,
      surveyor: s.surveyor,
      temperature: s.temperature,
      humidity: s.humidity,
      co2: s.co2,
      autoRiskLevel: s.autoRiskLevel,
      status: s.status
    }));
    res.json(responseItem);
  } else {
    res.json(item);
  }
});

app.delete('/api/:collection/:id', authMiddleware, async (req, res) => {
  const { collection, id } = req.params;
  const permissionMap = {
    sites: 'sites:delete',
    surveys: 'surveys:delete',
    plans: 'plans:delete',
    reviews: 'reviews:delete',
    incidents: 'incidents:delete'
  };
  const requiredPermission = permissionMap[collection];
  if (requiredPermission && !req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (requiredPermission && req.user && !auth.hasPermission(req.user.role, requiredPermission)) {
    return res.status(403).json({ error: '无权限删除此类型记录' });
  }
  const db = req.db;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const beforeDelete = JSON.parse(JSON.stringify(item));
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  const operator = req.user ? req.user.name : (req.body?.operator || req.headers['x-operator'] || 'system');
  audit.createAuditLog({
    db,
    collection,
    recordId: id,
    action: audit.AUDIT_TYPES.DELETE,
    actionLabel: '删除',
    before: beforeDelete,
    after: null,
    note: req.body?.note || '',
    operator
  });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', authMiddleware, async (req, res) => {
  const { actionId } = req.params;
  const actionPermissionMap = {
    'site-normal': 'sites:update',
    'site-focus': 'sites:update',
    'site-close': 'sites:suspend',
    'survey-alert': 'surveys:markAbnormal',
    'survey-review': 'surveys:review',
    'plan-complete': 'plans:complete',
    'plan-reopen': 'plans:update',
    'plan-generate-drafts': 'plans:generateDrafts',
    'review-complete': 'reviews:complete',
    'incident-processing': 'incidents:process',
    'incident-resolve': 'incidents:process',
    'incident-close': 'incidents:process',
    'incident-reopen': 'incidents:process',
    'incident-suspend-site': 'incidents:suspendSite'
  };
  const requiredPermission = actionPermissionMap[actionId];
  if (requiredPermission && !req.user) {
    return res.status(401).json({ error: '请先登录' });
  }
  if (requiredPermission && req.user && !auth.hasPermission(req.user.role, requiredPermission)) {
    return res.status(403).json({ error: '无权限执行此操作' });
  }
  const db = req.db;
  const action = config.actions.find((entry) => entry.id === actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const operator = req.user ? req.user.name : (req.body?.operator || req.headers['x-operator'] || 'system');
  const note = req.body?.note || '';
  const result = runAction(db, action, item, operator, note);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item, operator, note) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3, '一般': 1, '严重': 2, '紧急': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  const beforeItem = item ? JSON.parse(JSON.stringify(item)) : null;
  const beforeRelated = related ? JSON.parse(JSON.stringify(related)) : null;
  const stamped = new WeakSet();
  function stampOnce(target, actionNote) {
    if (!target || stamped.has(target)) return;
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, actionNote || '状态流转'));
    stamped.add(target);
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    if (action.collection === 'surveys' && patch.target !== 'related' && patch.field === 'status') {
      target.manuallyReviewed = true;
    }
    stampOnce(target, action.note);
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    stampOnce(target, action.note || '数量调整');
  }

  const isIncidentComplete = action.collection === 'incidents' &&
    (action.id === 'incident-resolve' || action.id === 'incident-close');
  const linkHints = { review: null, site: null };
  if (isIncidentComplete) {
    const completedLabel = action.id === 'incident-resolve' ? '处理完成' : '关闭';
    if (item.linkedReviewId) {
      const linkedReview = (db.reviews || []).find((review) => review.id === item.linkedReviewId);
      if (linkedReview) {
        const beforeReview = JSON.parse(JSON.stringify(linkedReview));
        const alreadyComplete = linkedReview.status === '已完成';
        linkedReview.incidentResolvedHint = alreadyComplete
          ? `关联干扰事件已${completedLabel}，该复查任务已人工完成，原复查结果保持不变`
          : `关联干扰事件已${completedLabel}，请核实是否还需继续复查`;
        linkedReview.updatedAt = new Date().toISOString();
        linkedReview.history = linkedReview.history || [];
        linkedReview.history.unshift(stamp('事件联动提示', `关联事件 ${item.id} 已${completedLabel}${alreadyComplete ? '，人工复查结果保持不变' : '，请评估复查必要性'}`));
        linkHints.review = linkedReview.id;
        audit.createAuditLog({
          db,
          collection: 'reviews',
          recordId: linkedReview.id,
          action: audit.AUDIT_TYPES.ACTION,
          actionLabel: '事件联动提示',
          before: beforeReview,
          after: linkedReview,
          note: `关联干扰事件 ${item.id} 已${completedLabel}，已生成复查提示（未覆盖人工结果）`,
          operator,
          relatedImpacts: [
            {
              collection: 'incidents',
              recordId: item.id,
              relationLabel: '触发事件',
              impactType: audit.IMPACT_TYPES.CASCADE,
              description: `由干扰事件「${item.eventType}」${completedLabel}触发`,
              recordLabel: [item.eventType, item.reporter].filter(Boolean).join(' / ')
            }
          ]
        });
      }
    }
    if (item.siteId) {
      const site = (db.sites || []).find((entry) => entry.id === item.siteId);
      if (site) {
        const beforeSite = JSON.parse(JSON.stringify(site));
        const previousStatus = site.protectedStatus;
        const hintMsg = `关联${item.severity}干扰事件「${item.eventType}」已${completedLabel}，请评估是否调整保护状态（当前：${previousStatus}）`;
        site.protectionHints = site.protectionHints || [];
        site.protectionHints.unshift({
          incidentId: item.id,
          hint: hintMsg,
          severity: item.severity,
          at: new Date().toISOString(),
          actionId: action.id
        });
        site.updatedAt = new Date().toISOString();
        site.history = site.history || [];
        site.history.unshift(stamp('事件联动提示', hintMsg));
        linkHints.site = site.id;
        audit.createAuditLog({
          db,
          collection: 'sites',
          recordId: site.id,
          action: audit.AUDIT_TYPES.ACTION,
          actionLabel: '事件联动提示',
          before: beforeSite,
          after: site,
          note: `${hintMsg}（仅作提示，未自动修改保护状态）`,
          operator,
          relatedImpacts: [
            {
              collection: 'incidents',
              recordId: item.id,
              relationLabel: '触发事件',
              impactType: audit.IMPACT_TYPES.CASCADE,
              description: `由${item.severity}干扰事件「${item.eventType}」${completedLabel}触发提示`,
              recordLabel: [item.eventType, item.reporter].filter(Boolean).join(' / ')
            }
          ]
        });
      }
    }
    if (linkHints.review || linkHints.site) {
      item.linkHints = linkHints;
    }
  }

  if (stamped.has(item) && beforeItem) {
    const extraImpacts = [];
    if (stamped.has(related) && action.relation) {
      extraImpacts.push({
        collection: action.relation.collection,
        recordId: related.id,
        relationLabel: action.relation.label || '关联记录',
        impactType: audit.IMPACT_TYPES.CASCADE,
        description: `同步修改了关联记录`,
        recordLabel: audit._getRecordLabel(action.relation.collection, related)
      });
    }
    if (isIncidentComplete && (linkHints.review || linkHints.site)) {
      if (linkHints.review) {
        extraImpacts.push({
          collection: 'reviews',
          recordId: linkHints.review,
          relationLabel: '联动复查',
          impactType: audit.IMPACT_TYPES.HINT,
          description: '已发送事件联动提示',
          recordLabel: audit._getRecordLabel('reviews', db.reviews?.find((r) => r.id === linkHints.review))
        });
      }
      if (linkHints.site) {
        extraImpacts.push({
          collection: 'sites',
          recordId: linkHints.site,
          relationLabel: '关联样点',
          impactType: audit.IMPACT_TYPES.HINT,
          description: '已发送事件联动提示',
          recordLabel: audit._getRecordLabel('sites', db.sites?.find((s) => s.id === linkHints.site))
        });
      }
    }
    audit.createAuditLog({
      db,
      collection: action.collection,
      recordId: item.id,
      action: audit.AUDIT_TYPES.ACTION,
      actionLabel: action.label,
      before: beforeItem,
      after: item,
      note: note || action.note || '状态流转',
      operator,
      relatedImpacts: extraImpacts.length ? extraImpacts : undefined
    });
  }
  if (stamped.has(related) && beforeRelated && action.relation) {
    audit.createAuditLog({
      db,
      collection: action.relation.collection,
      recordId: related.id,
      action: audit.AUDIT_TYPES.ACTION,
      actionLabel: action.label,
      before: beforeRelated,
      after: related,
      note: `${note || action.note || '状态流转'}（关联操作）`,
      operator,
      relatedImpacts: [
        {
          collection: action.collection,
          recordId: item.id,
          relationLabel: '触发操作',
          impactType: audit.IMPACT_TYPES.CASCADE,
          description: `由${action.label}操作联动修改`,
          recordLabel: audit._getRecordLabel(action.collection, item)
        }
      ]
    });
  }
  return { item };
}

function getLatestSurvey(surveys, siteId) {
  const siteSurveys = surveys.filter((s) => s.siteId === siteId);
  if (!siteSurveys.length) return null;
  return siteSurveys.sort(sortNewest)[0];
}

app.get('/api/zone-overview', authMiddleware, async (req, res) => {
  const db = req.db;
  const sites = db.sites || [];
  const surveys = db.surveys || [];
  const layout = config.zoneLayout || {};

  const caveMap = {};
  for (const site of sites) {
    const cave = site.cave || '未分类洞穴';
    const zone = site.zone || '未分区';
    if (!caveMap[cave]) caveMap[cave] = {};
    if (!caveMap[cave][zone]) {
      caveMap[cave][zone] = {
        name: zone,
        siteCount: 0,
        normal: 0,
        keyProtection: 0,
        suspended: 0,
        abnormal: 0,
        route: '',
        sites: [],
        lastSurveyAt: null
      };
    }
    const zoneData = caveMap[cave][zone];
    zoneData.siteCount += 1;
    zoneData.sites.push(site.id);

    const latest = getLatestSurvey(surveys, site.id);
    if (latest) {
      if (!zoneData.lastSurveyAt || new Date(latest.createdAt || latest.date) > new Date(zoneData.lastSurveyAt)) {
        zoneData.lastSurveyAt = latest.createdAt || latest.date;
      }
    }

    if (latest && latest.status === '异常待复查') {
      zoneData.abnormal += 1;
    } else if (site.protectedStatus === '暂停开放') {
      zoneData.suspended += 1;
    } else if (site.protectedStatus === '重点保护') {
      zoneData.keyProtection += 1;
    } else {
      zoneData.normal += 1;
    }
  }

  const caveList = Object.keys(caveMap).map((caveName) => {
    const caveLayout = layout[caveName];
    const zones = Object.keys(caveMap[caveName]).map((zoneName) => {
      const zoneLayout = caveLayout?.zones?.find((z) => z.name === zoneName);
      return {
        ...caveMap[caveName][zoneName],
        order: zoneLayout?.order ?? 99,
        route: zoneLayout?.route || caveMap[caveName][zoneName].route
      };
    }).sort((a, b) => a.order - b.order);
    return {
      name: caveName,
      order: caveLayout?.order ?? 99,
      zones
    };
  }).sort((a, b) => a.order - b.order);

  res.json({ caves: caveList });
});

app.get('/api/zone-detail/:cave/:zone', authMiddleware, async (req, res) => {
  const db = req.db;
  const { cave, zone } = req.params;
  const sites = (db.sites || []).filter((s) => s.cave === cave && s.zone === zone);
  const siteIds = sites.map((s) => s.id);
  const allSurveys = (db.surveys || []).filter((s) => siteIds.includes(s.siteId));
  const sortedSurveys = allSurveys.sort(sortNewest).slice(0, 10);

  const patrolCycle = config.patrolCycle || { '高': 3, '中': 7, '低': 14 };
  const now = new Date();

  const sitesWithSchedule = sites.map((site) => {
    const siteSurveys = allSurveys
      .filter((s) => s.siteId === site.id)
      .sort(sortNewest);
    const latestSurvey = siteSurveys[0] || null;
    const cycleDays = patrolCycle[site.sensitivity] || patrolCycle['低'] || 14;
    let lastSurveyAt = null;
    let overdueDays = 0;
    let isOverdue = false;
    if (latestSurvey) {
      lastSurveyAt = latestSurvey.createdAt || latestSurvey.date;
      const lastDate = new Date(lastSurveyAt);
      const diffMs = now.getTime() - lastDate.getTime();
      const diffDays = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      overdueDays = diffDays - cycleDays;
      isOverdue = overdueDays > 0;
    } else {
      isOverdue = true;
      overdueDays = 999;
    }
    return {
      ...site,
      schedule: {
        lastSurveyAt,
        latestRiskLevel: latestSurvey?.autoRiskLevel || '正常',
        latestSurveyStatus: latestSurvey?.status || '',
        cycleDays,
        overdueDays: isOverdue ? overdueDays : 0,
        isOverdue
      }
    };
  });

  const overdueCount = sitesWithSchedule.filter((s) => s.schedule.isOverdue).length;

  res.json({
    cave,
    zone,
    sites: sitesWithSchedule,
    recentSurveys: sortedSurveys,
    scheduleSummary: {
      totalSites: sites.length,
      overdueCount,
      onScheduleCount: sites.length - overdueCount
    }
  });
});

app.post('/api/zone-create-plan/:cave/:zone', authMiddleware, requirePermission('plans:createFromZone'), async (req, res) => {
  const { cave, zone } = req.params;
  const preCheckDb = req.db;
  const sites = (preCheckDb.sites || []).filter((s) => s.cave === cave && s.zone === zone);
  if (!sites.length) return res.status(404).json({ error: '未找到该分区样点' });

  const patrolCycle = config.patrolCycle || { '高': 3, '中': 7, '低': 14 };
  const preNow = new Date();
  const preAllSurveys = preCheckDb.surveys || [];

  const hasOverdue = sites.some((site) => {
    const siteSurveys = preAllSurveys
      .filter((s) => s.siteId === site.id)
      .sort(sortNewest);
    const latestSurvey = siteSurveys[0] || null;
    const cycleDays = patrolCycle[site.sensitivity] || patrolCycle['低'] || 14;
    if (!latestSurvey) return true;
    const lastDate = new Date(latestSurvey.createdAt || latestSurvey.date);
    const diffDays = Math.floor((preNow.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));
    return diffDays > cycleDays;
  });

  if (!hasOverdue) return res.status(400).json({ error: '该分区无逾期样点，无需创建计划' });

  try {
    const result = await withDbWrite(async () => {
      const db = await readDb();
      const allSurveys = db.surveys || [];
      const now = new Date();

      const overdueSites = sites.filter((site) => {
        const siteSurveys = allSurveys
          .filter((s) => s.siteId === site.id)
          .sort(sortNewest);
        const latestSurvey = siteSurveys[0] || null;
        const cycleDays = patrolCycle[site.sensitivity] || patrolCycle['低'] || 14;
        if (!latestSurvey) return true;
        const lastDate = new Date(latestSurvey.createdAt || latestSurvey.date);
        const diffDays = Math.floor((now.getTime() - lastDate.getTime()) / (24 * 60 * 60 * 1000));
        return diffDays > cycleDays;
      });

      if (!overdueSites.length) {
        return { status: 400, data: { error: '该分区无逾期样点，无需创建计划' } };
      }

      const existingPlan = (db.plans || []).find(
        (p) =>
          p.autoCreatedFromZone &&
          p.sourceCave === cave &&
          p.sourceZone === zone &&
          p.status === '待执行'
      );
      if (existingPlan) {
        return {
          status: 409,
          data: {
            error: '该分区已有待执行的自动生成巡测计划，请先完成或关闭后再创建',
            existingPlanId: existingPlan.id
          }
        };
      }

      const zoneLayout = (config.zoneLayout || {})[cave]?.zones?.find((z) => z.name === zone);
      const route = zoneLayout?.route || overdueSites[0]?.route || '';
      const operator = req.user ? req.user.name : (req.body?.operator || 'system');
      const nowISO = new Date().toISOString();
      const plannedDate = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

      const plan = {
        id: `plans-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        route,
        siteIds: overdueSites.map((s) => s.id),
        siteCount: overdueSites.length,
        manager: operator,
        plannedDate,
        status: '待执行',
        note: `自动生成：${cave} / ${zone} 逾期样点巡测计划（共 ${overdueSites.length} 个样点）`,
        autoCreatedFromZone: true,
        sourceCave: cave,
        sourceZone: zone,
        createdAt: nowISO,
        updatedAt: nowISO,
        history: [stamp('创建', `由分区巡测排程自动生成，包含 ${overdueSites.length} 个逾期样点`)]
      };

      if (!db.plans) db.plans = [];
      db.plans.push(plan);

      audit.createAuditLog({
        db,
        collection: 'plans',
        recordId: plan.id,
        action: audit.AUDIT_TYPES.CREATE,
        actionLabel: '创建（自动生成）',
        before: null,
        after: plan,
        note: `分区 ${cave} / ${zone} 一键生成逾期样点巡测计划`,
        operator
      });

      await writeDb(db);
      return { status: 201, data: plan };
    });

    res.status(result.status).json(result.data);
  } catch (err) {
    console.error('创建分区巡测计划失败', err);
    res.status(500).json({ error: '创建计划失败，请稍后重试' });
  }
});

app.get('/api/incident-stats', authMiddleware, async (req, res) => {
  const db = req.db;
  const incidents = db.incidents || [];
  const sites = db.sites || [];

  const byType = {};
  const bySeverity = {};
  const byStatus = {};
  const byCave = {};

  for (const inc of incidents) {
    byType[inc.eventType] = (byType[inc.eventType] || 0) + 1;
    bySeverity[inc.severity] = (bySeverity[inc.severity] || 0) + 1;
    byStatus[inc.status] = (byStatus[inc.status] || 0) + 1;

    const site = sites.find((s) => s.id === inc.siteId);
    if (site) {
      const cave = site.cave || '未分类';
      byCave[cave] = (byCave[cave] || 0) + 1;
    }
  }

  const recent = incidents.sort(sortNewest).slice(0, 10);

  res.json({
    total: incidents.length,
    byType,
    bySeverity,
    byStatus,
    byCave,
    recent
  });
});

function getTrendDirection(values, minSamples = 2) {
  if (!values || values.length < minSamples) return 'insufficient';
  const valid = values.filter((v) => typeof v === 'number' && !isNaN(v));
  if (valid.length < minSamples) return 'insufficient';
  const first = valid[0];
  const last = valid[valid.length - 1];
  const diff = last - first;
  if (Math.abs(diff) < 0.001) return 'stable';
  return diff > 0 ? 'up' : 'down';
}

function average(values) {
  const valid = values.filter((v) => typeof v === 'number' && !isNaN(v));
  if (!valid.length) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function aggregateZoneTrends(zoneSurveys, rules) {
  if (!zoneSurveys.length) {
    return {
      sampleCount: 0,
      latest: null,
      temperature: { avg: null, trend: 'insufficient', values: [] },
      humidity: { avg: null, trend: 'insufficient', values: [] },
      co2: { avg: null, trend: 'insufficient', values: [] },
      riskTrend: 'insufficient',
      highRiskCount: 0,
      warningCount: 0,
      normalCount: 0,
      latestAbnormal: null
    };
  }

  const ordered = [...zoneSurveys].sort((a, b) => {
    const ta = new Date(a.createdAt || a.date || 0).getTime();
    const tb = new Date(b.createdAt || b.date || 0).getTime();
    return ta - tb;
  });
  const latest = ordered[ordered.length - 1] || null;

  const tempValues = ordered.map((s) => Number(s.temperature)).filter((v) => !isNaN(v));
  const humValues = ordered.map((s) => Number(s.humidity)).filter((v) => !isNaN(v));
  const co2Values = ordered.map((s) => Number(s.co2)).filter((v) => !isNaN(v));

  const highRiskCount = ordered.filter((s) => s.autoRiskLevel === '高风险').length;
  const warningCount = ordered.filter((s) => s.autoRiskLevel === '预警').length;
  const normalCount = ordered.filter((s) => !s.autoRiskLevel || s.autoRiskLevel === '正常').length;

  let riskTrend = 'stable';
  if (ordered.length >= 2) {
    const mid = Math.floor(ordered.length / 2);
    const firstHalf = ordered.slice(0, mid);
    const secondHalf = ordered.slice(mid);
    const firstRisk = firstHalf.filter((s) => s.autoRiskLevel === '高风险' || s.autoRiskLevel === '预警').length;
    const secondRisk = secondHalf.filter((s) => s.autoRiskLevel === '高风险' || s.autoRiskLevel === '预警').length;
    if (secondRisk > firstRisk) riskTrend = 'up';
    else if (secondRisk < firstRisk) riskTrend = 'down';
  }

  const latestAbnormalSurvey = [...ordered].reverse().find((s) => s.status === '异常待复查')
    || [...ordered].reverse().find((s) => s.autoRiskLevel === '高风险')
    || [...ordered].reverse().find((s) => s.autoRiskLevel === '预警')
    || null;

  return {
    sampleCount: ordered.length,
    latest,
    temperature: {
      avg: average(tempValues),
      trend: getTrendDirection(tempValues),
      values: tempValues
    },
    humidity: {
      avg: average(humValues),
      trend: getTrendDirection(humValues),
      values: humValues
    },
    co2: {
      avg: average(co2Values),
      trend: getTrendDirection(co2Values),
      values: co2Values
    },
    riskTrend,
    highRiskCount,
    warningCount,
    normalCount,
    latestAbnormal: latestAbnormalSurvey
  };
}

app.get('/api/microclimate-trends', authMiddleware, async (req, res) => {
  const db = req.db;
  const sites = db.sites || [];
  const surveys = db.surveys || [];
  const layout = config.zoneLayout || {};
  const rules = getThresholdRules(db);

  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const caveMap = {};
  for (const site of sites) {
    const cave = site.cave || '未分类洞穴';
    const zone = site.zone || '未分区';
    if (!caveMap[cave]) caveMap[cave] = { zones: {}, siteIds: [] };
    if (!caveMap[cave].zones[zone]) caveMap[cave].zones[zone] = { siteIds: [] };
    caveMap[cave].zones[zone].siteIds.push(site.id);
    caveMap[cave].siteIds.push(site.id);
  }

  const surveyBySite = {};
  for (const s of surveys) {
    if (!s.siteId) continue;
    if (!surveyBySite[s.siteId]) surveyBySite[s.siteId] = [];
    surveyBySite[s.siteId].push(s);
  }

  for (const siteId of Object.keys(surveyBySite)) {
    surveyBySite[siteId].sort(sortNewest);
  }

  const caves = [];
  for (const caveName of Object.keys(caveMap)) {
    const caveData = caveMap[caveName];
    const caveLayout = layout[caveName];

    const caveSiteIds = caveData.siteIds;
    let caveAllSurveys = [];
    for (const sid of caveSiteIds) {
      if (surveyBySite[sid]) {
        const siteSurveys = surveyBySite[sid];
        const recent10 = siteSurveys.slice(0, 10);
        const recent7Days = siteSurveys.filter((s) => {
          const d = new Date(s.createdAt || s.date || 0);
          return d >= sevenDaysAgo;
        });
        const used = recent7Days.length > 0 ? recent7Days : recent10;
        caveAllSurveys = caveAllSurveys.concat(used);
      }
    }
    caveAllSurveys.sort(sortNewest);
    caveAllSurveys = caveAllSurveys.slice(0, 50);

    const zones = [];
    for (const zoneName of Object.keys(caveData.zones)) {
      const zoneLayout = caveLayout?.zones?.find((z) => z.name === zoneName);
      const zoneSiteIds = caveData.zones[zoneName].siteIds;

      let zoneSurveys = [];
      for (const sid of zoneSiteIds) {
        if (surveyBySite[sid]) {
          const siteSurveys = surveyBySite[sid];
          const recent10 = siteSurveys.slice(0, 10);
          const recent7Days = siteSurveys.filter((s) => {
            const d = new Date(s.createdAt || s.date || 0);
            return d >= sevenDaysAgo;
          });
          const used = recent7Days.length > 0 ? recent7Days : recent10;
          zoneSurveys = zoneSurveys.concat(used);
        }
      }
      zoneSurveys.sort(sortNewest);
      zoneSurveys = zoneSurveys.slice(0, 30);

      const trends = aggregateZoneTrends(zoneSurveys, rules);

      let latestAbnormalSite = null;
      if (trends.latestAbnormal) {
        latestAbnormalSite = sites.find((s) => s.id === trends.latestAbnormal.siteId) || null;
      }

      zones.push({
        name: zoneName,
        order: zoneLayout?.order ?? 99,
        route: zoneLayout?.route || '',
        siteCount: zoneSiteIds.length,
        ...trends,
        latestAbnormalSite
      });
    }

    zones.sort((a, b) => a.order - b.order);

    const caveTrends = aggregateZoneTrends(caveAllSurveys, rules);
    let caveLatestAbnormalSite = null;
    if (caveTrends.latestAbnormal) {
      caveLatestAbnormalSite = sites.find((s) => s.id === caveTrends.latestAbnormal.siteId) || null;
    }

    caves.push({
      name: caveName,
      order: caveLayout?.order ?? 99,
      siteCount: caveSiteIds.length,
      zoneCount: zones.length,
      zones,
      ...caveTrends,
      latestAbnormalSite: caveLatestAbnormalSite
    });
  }

  caves.sort((a, b) => a.order - b.order);

  const totalSurveys = surveys.length;
  const withSurveys = Object.keys(surveyBySite).length;
  const noSurveySites = sites.length - withSurveys;

  res.json({
    generatedAt: now.toISOString(),
    summary: {
      totalCaves: caves.length,
      totalZones: caves.reduce((s, c) => s + c.zoneCount, 0),
      totalSites: sites.length,
      totalSurveys,
      sitesWithSurveys: withSurveys,
      sitesWithoutSurveys: noSurveySites
    },
    caves
  });
});

function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
  const rows = lines.slice(1).map((line, index) => {
    const values = line.split(',').map((v) => v.trim());
    const row = {};
    headers.forEach((header, i) => {
      row[header] = values[i] || '';
    });
    return { lineNumber: index + 2, raw: line, values: row };
  });
  return { headers, rows };
}

function normalizeHeaders(headers) {
  const map = {};
  const aliases = {
    '样点编号': 'pointCode', '点位编号': 'pointCode', 'pointcode': 'pointCode', 'point_code': 'pointCode', 'point code': 'pointCode',
    '温度': 'temperature', 'temp': 'temperature', 'temperature': 'temperature',
    '湿度': 'humidity', 'humidity': 'humidity', 'hum': 'humidity',
    'co2': 'co2', 'CO2': 'co2', '二氧化碳': 'co2',
    '滴水频率': 'dripRate', '滴水速率': 'dripRate', 'driprate': 'dripRate', 'drip_rate': 'dripRate', 'drip rate': 'dripRate',
    '巡测人员': 'surveyor', '测量员': 'surveyor', 'surveyor': 'surveyor',
    '日期': 'date', '测量日期': 'date', 'date': 'date',
    '干扰痕迹': 'disturbance', '干扰': 'disturbance', 'disturbance': 'disturbance'
  };
  headers.forEach((header) => {
    const normalized = aliases[header] || header;
    map[header] = normalized;
  });
  return map;
}

app.post('/api/surveys/import/preview', authMiddleware, requirePermission('import:surveys'), async (req, res) => {
  const { csvText } = req.body;
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ error: 'CSV文本不能为空' });
  }

  const db = req.db;
  const sites = db.sites || [];
  const siteMap = new Map(sites.map((s) => [s.pointCode, s]));

  const { headers, rows } = parseCsv(csvText);
  if (!rows.length) {
    return res.json({ total: 0, valid: 0, invalid: 0, preview: [], errors: [] });
  }

  const headerMap = normalizeHeaders(headers);
  const requiredFields = ['pointCode', 'temperature', 'humidity', 'co2', 'dripRate'];
  const missingRequired = requiredFields.filter((f) => !Object.values(headerMap).includes(f));

  const preview = [];
  const errors = [];

  for (const row of rows) {
    const normalized = {};
    Object.keys(row.values).forEach((key) => {
      const normKey = headerMap[key];
      if (normKey) normalized[normKey] = row.values[key];
    });

    const rowErrors = [];

    if (!normalized.pointCode) {
      rowErrors.push('缺少样点编号');
    } else if (!siteMap.has(normalized.pointCode)) {
      rowErrors.push(`未知样点编号: ${normalized.pointCode}`);
    }

    const numFields = [
      { key: 'temperature', label: '温度' },
      { key: 'humidity', label: '湿度' },
      { key: 'co2', label: 'CO2' },
      { key: 'dripRate', label: '滴水频率' }
    ];

    for (const field of numFields) {
      const val = normalized[field.key];
      if (val === '' || val === undefined || val === null) {
        rowErrors.push(`缺少${field.label}`);
      } else if (isNaN(Number(val))) {
        rowErrors.push(`${field.label}数字格式错误: ${val}`);
      } else if (Number(val) < 0) {
        rowErrors.push(`${field.label}不能为负数: ${val}`);
      }
    }

    if (normalized.date && isNaN(Date.parse(normalized.date))) {
      rowErrors.push(`日期格式错误: ${normalized.date}`);
    }

    const site = siteMap.get(normalized.pointCode) || null;
    preview.push({
      lineNumber: row.lineNumber,
      pointCode: normalized.pointCode || '',
      siteLabel: site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '',
      temperature: normalized.temperature || '',
      humidity: normalized.humidity || '',
      co2: normalized.co2 || '',
      dripRate: normalized.dripRate || '',
      surveyor: normalized.surveyor || '',
      date: normalized.date || '',
      disturbance: normalized.disturbance || '',
      isValid: rowErrors.length === 0,
      errors: rowErrors
    });

    if (rowErrors.length) {
      errors.push({ line: row.lineNumber, errors: rowErrors });
    }
  }

  const validCount = preview.filter((p) => p.isValid).length;

  res.json({
    total: rows.length,
    valid: validCount,
    invalid: rows.length - validCount,
    missingRequired,
    preview
  });
});

app.post('/api/surveys/import', authMiddleware, requirePermission('import:surveys'), async (req, res) => {
  const { csvText } = req.body;
  if (!csvText || typeof csvText !== 'string') {
    return res.status(400).json({ error: 'CSV文本不能为空' });
  }

  const db = req.db;
  const sites = db.sites || [];
  const siteMap = new Map(sites.map((s) => [s.pointCode, s]));
  const thresholdRules = getThresholdRules(db);
  const operator = req.user ? req.user.name : (req.body?.operator || '批量导入');

  const { headers, rows } = parseCsv(csvText);
  const headerMap = normalizeHeaders(headers);

  const successItems = [];
  const failedItems = [];
  const now = new Date().toISOString();

  for (const row of rows) {
    const normalized = {};
    Object.keys(row.values).forEach((key) => {
      const normKey = headerMap[key];
      if (normKey) normalized[normKey] = row.values[key];
    });

    const rowErrors = [];

    if (!normalized.pointCode) {
      rowErrors.push('缺少样点编号');
    } else if (!siteMap.has(normalized.pointCode)) {
      rowErrors.push(`未知样点编号: ${normalized.pointCode}`);
    }

    const numFields = [
      { key: 'temperature', label: '温度' },
      { key: 'humidity', label: '湿度' },
      { key: 'co2', label: 'CO2' },
      { key: 'dripRate', label: '滴水频率' }
    ];

    for (const field of numFields) {
      const val = normalized[field.key];
      if (val === '' || val === undefined || val === null) {
        rowErrors.push(`缺少${field.label}`);
      } else if (isNaN(Number(val))) {
        rowErrors.push(`${field.label}数字格式错误: ${val}`);
      } else if (Number(val) < 0) {
        rowErrors.push(`${field.label}不能为负数: ${val}`);
      }
    }

    if (normalized.date && isNaN(Date.parse(normalized.date))) {
      rowErrors.push(`日期格式错误: ${normalized.date}`);
    }

    if (rowErrors.length) {
      failedItems.push({
        lineNumber: row.lineNumber,
        pointCode: normalized.pointCode || '',
        errors: rowErrors
      });
      continue;
    }

    const site = siteMap.get(normalized.pointCode);
    const surveyData = {
      siteId: site.id,
      surveyor: normalized.surveyor || '批量导入',
      date: normalized.date || new Date().toISOString().slice(0, 10),
      temperature: Number(normalized.temperature),
      humidity: Number(normalized.humidity),
      co2: Number(normalized.co2),
      dripRate: Number(normalized.dripRate),
      disturbance: normalized.disturbance || '',
      photos: [],
      status: '正常',
      reviewNote: '',
      manuallyReviewed: false
    };

    const risk = computeAutoRisk(surveyData, site, thresholdRules);
    surveyData.autoRiskLevel = risk.autoRiskLevel;
    surveyData.autoRiskReasons = risk.autoRiskReasons;
    surveyData.deviationTemp = risk.deviationTemp;
    surveyData.deviationHumidity = risk.deviationHumidity;
    surveyData.deviationCo2 = risk.deviationCo2;

    if (risk.autoRiskLevel === '高风险') {
      surveyData.status = '异常待复查';
    }

    const riskNote = risk.autoRiskLevel !== '正常'
      ? `自动判定：${risk.autoRiskLevel}（${risk.autoRiskReasons.join('；')}）`
      : '自动判定：正常';

    const item = {
      id: `surveys-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      ...surveyData,
      createdAt: now,
      updatedAt: now,
      history: [stamp('创建', `批量导入 · ${riskNote}`)]
    };

    db.surveys.push(item);
    audit.createAuditLog({
      db,
      collection: 'surveys',
      recordId: item.id,
      action: audit.AUDIT_TYPES.CREATE,
      actionLabel: '批量导入',
      before: null,
      after: item,
      note: `批量导入 · ${riskNote}`,
      operator
    });
    successItems.push({
      lineNumber: row.lineNumber,
      id: item.id,
      pointCode: normalized.pointCode,
      autoRiskLevel: item.autoRiskLevel,
      status: item.status
    });
  }

  await writeDb(db);

  const normalItems = successItems.filter((item) => item.autoRiskLevel === '正常' || !item.autoRiskLevel);
  const warningItems = successItems.filter((item) => item.autoRiskLevel === '预警');
  const highRiskItems = successItems.filter((item) => item.autoRiskLevel === '高风险');

  const riskGroups = {
    normal: {
      label: '正常',
      count: normalItems.length,
      items: normalItems
    },
    warning: {
      label: '预警',
      count: warningItems.length,
      items: warningItems
    },
    highRisk: {
      label: '高风险',
      count: highRiskItems.length,
      items: highRiskItems
    }
  };

  res.json({
    total: rows.length,
    success: successItems.length,
    failed: failedItems.length,
    successItems,
    failedItems,
    riskSummary: {
      normal: normalItems.length,
      warning: warningItems.length,
      highRisk: highRiskItems.length
    },
    riskGroups,
    importedIds: successItems.map((item) => item.id)
  });
});

app.get('/api/audit-logs/:collection/:id', authMiddleware, requirePermission('audit:view'), async (req, res) => {
  const db = req.db;
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const logs = audit.getAuditLogsForRecord(db, collection, id);
  const enrichedLogs = logs.map((log) => audit.enrichAuditLogWithImpactDetails(db, log));
  const incomingImpacts = audit.getIncomingImpacts(db, collection, id);
  const enrichedIncoming = incomingImpacts.map((log) => audit.enrichAuditLogWithImpactDetails(db, log));
  res.json({
    logs: enrichedLogs,
    incomingImpacts: enrichedIncoming
  });
});

app.get('/api/audit-logs/:logId', authMiddleware, requirePermission('audit:view'), async (req, res) => {
  const db = req.db;
  const log = audit.getAuditLogById(db, req.params.logId);
  if (!log) return res.status(404).json({ error: 'audit log not found' });
  const enriched = audit.enrichAuditLogWithImpactDetails(db, log);
  res.json(enriched);
});

app.get('/api/audit-logs/:collection/:id/incoming-impacts', authMiddleware, requirePermission('audit:view'), async (req, res) => {
  const db = req.db;
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const incomingImpacts = audit.getIncomingImpacts(db, collection, id);
  const enriched = incomingImpacts.map((log) => audit.enrichAuditLogWithImpactDetails(db, log));
  res.json(enriched);
});

app.post('/api/audit-logs/:logId/rollback', authMiddleware, requirePermission('audit:rollback'), async (req, res) => {
  const db = req.db;
  const { logId } = req.params;
  const { note } = req.body || {};
  const operator = req.user ? req.user.name : (req.body?.operator || req.headers['x-operator'] || 'system');
  const result = audit.rollbackToAuditLog(db, logId, note, operator);
  if (result.error) return res.status(400).json({ error: result.error });
  await writeDb(db);
  res.json({
    item: result.item,
    auditLog: result.auditLog,
    sourceLog: result.sourceLog
  });
});

app.post('/api/sites/:siteId/recalculate-risks', authMiddleware, requirePermission('sites:update'), async (req, res) => {
  const { siteId } = req.params;
  const db = req.db;
  const site = db.sites?.find((s) => s.id === siteId);
  if (!site) return res.status(404).json({ error: '样点不存在' });

  const operator = req.user ? req.user.name : (req.body?.operator || req.headers['x-operator'] || 'system');
  const thresholdRules = getThresholdRules(db);

  const siteSurveys = (db.surveys || [])
    .filter((s) => s.siteId === siteId)
    .sort(sortNewest)
    .slice(0, 10);

  const recalculated = [];
  for (const survey of siteSurveys) {
    const beforeUpdate = JSON.parse(JSON.stringify(survey));
    const oldRiskLevel = survey.autoRiskLevel;
    const risk = computeAutoRisk(survey, site, thresholdRules);
    survey.autoRiskLevel = risk.autoRiskLevel;
    survey.autoRiskReasons = risk.autoRiskReasons;
    survey.deviationTemp = risk.deviationTemp;
    survey.deviationHumidity = risk.deviationHumidity;
    survey.deviationCo2 = risk.deviationCo2;
    survey.updatedAt = new Date().toISOString();

    if (!survey.manuallyReviewed) {
      if (risk.autoRiskLevel === '高风险' && survey.status === '正常') {
        survey.status = '异常待复查';
      } else if (risk.autoRiskLevel === '正常' && survey.status === '异常待复查' && oldRiskLevel && oldRiskLevel !== '正常') {
        survey.status = '正常';
      }
    }

    survey.history = survey.history || [];
    const riskNote = oldRiskLevel !== risk.autoRiskLevel
      ? `基准值变更导致风险重算：${oldRiskLevel || '正常'} → ${risk.autoRiskLevel}`
      : `基准值变更导致风险重算：风险等级未变（${risk.autoRiskLevel || '正常'}）`;
    survey.history.unshift(stamp('重新计算风险', riskNote));

    audit.createAuditLog({
      db,
      collection: 'surveys',
      recordId: survey.id,
      action: audit.AUDIT_TYPES.RECALC_RISK,
      actionLabel: '重新计算风险',
      before: beforeUpdate,
      after: survey,
      note: riskNote,
      operator
    });

    recalculated.push({
      id: survey.id,
      oldRiskLevel,
      newRiskLevel: risk.autoRiskLevel,
      status: survey.status,
      reasons: risk.autoRiskReasons,
      deviationTemp: risk.deviationTemp,
      deviationHumidity: risk.deviationHumidity,
      deviationCo2: risk.deviationCo2
    });
  }

  audit.createAuditLog({
    db,
    collection: 'sites',
    recordId: siteId,
    action: audit.AUDIT_TYPES.RECALC_RISK,
    actionLabel: '批量重算风险',
    before: null,
    after: { recalculatedCount: recalculated.length },
    note: `对该样点最近 ${recalculated.length} 条巡测记录重新计算风险`,
    operator
  });

  await writeDb(db);
  res.json({
    siteId,
    recalculatedCount: recalculated.length,
    results: recalculated
  });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
