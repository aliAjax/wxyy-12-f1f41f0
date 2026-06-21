const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

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

app.get('/api/config', async (req, res) => {
  const db = await readDb();
  const thresholdRules = getThresholdRules(db);
  res.json({ ...config, thresholdRules });
});

app.patch('/api/config/thresholdRules', async (req, res) => {
  const newRules = req.body;
  if (!newRules || typeof newRules !== 'object') return res.status(400).json({ error: 'invalid rules' });
  const db = await readDb();
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

app.get('/api/db', async (req, res) => {
  const db = await readDb();
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

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  if (collection === 'incidents') {
    const siteId = req.body.siteId;
    if (!siteId) return res.status(400).json({ error: '关联样点必填，无法创建事件' });
    const siteExists = db.sites?.some((s) => s.id === siteId);
    if (!siteExists) return res.status(400).json({ error: '关联样点不存在，无法创建事件' });
  }
  const now = new Date().toISOString();
  const thresholdRules = getThresholdRules(db);
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
  db[collection].push(item);
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  const thresholdRules = getThresholdRules(db);
  const oldStatus = item.status;
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
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  await writeDb(db);
  res.json(item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
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

function runAction(db, action, item) {
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
  const stamped = new WeakSet();
  function stampOnce(target, note) {
    if (!target || stamped.has(target)) return;
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, note || '状态流转'));
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
  return { item };
}

function getLatestSurvey(surveys, siteId) {
  const siteSurveys = surveys.filter((s) => s.siteId === siteId);
  if (!siteSurveys.length) return null;
  return siteSurveys.sort(sortNewest)[0];
}

app.get('/api/zone-overview', async (req, res) => {
  const db = await readDb();
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

app.get('/api/zone-detail/:cave/:zone', async (req, res) => {
  const db = await readDb();
  const { cave, zone } = req.params;
  const sites = (db.sites || []).filter((s) => s.cave === cave && s.zone === zone);
  const siteIds = sites.map((s) => s.id);
  const allSurveys = (db.surveys || []).filter((s) => siteIds.includes(s.siteId));
  const sortedSurveys = allSurveys.sort(sortNewest).slice(0, 10);

  res.json({
    cave,
    zone,
    sites,
    recentSurveys: sortedSurveys
  });
});

app.get('/api/incident-stats', async (req, res) => {
  const db = await readDb();
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

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
