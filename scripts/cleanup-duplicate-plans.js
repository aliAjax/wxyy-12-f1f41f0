const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'db.json');
const backupPath = path.join(__dirname, '..', 'data', 'db.backup-before-cleanup.json');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

if (!db.plans || !db.plans.length) {
  console.log('没有计划数据，无需清理');
  process.exit(0);
}

fs.copyFileSync(dbPath, backupPath);
console.log(`已备份原数据到: ${backupPath}`);

const autoPlans = db.plans.filter((p) => p.autoCreatedFromZone === true);
console.log(`\n自动生成的计划总数: ${autoPlans.length}`);

const planGroups = {};
autoPlans.forEach((plan) => {
  const key = `${plan.sourceCave}||${plan.sourceZone}`;
  if (!planGroups[key]) planGroups[key] = [];
  planGroups[key].push(plan);
});

console.log('\n各分区自动生成计划数量:');
Object.keys(planGroups).forEach((key) => {
  const [cave, zone] = key.split('||');
  const plans = planGroups[key];
  const pendingCount = plans.filter((p) => p.status === '待执行').length;
  console.log(`  ${cave} / ${zone}: 共 ${plans.length} 个，其中待执行 ${pendingCount} 个`);
});

const planIdsToRemove = new Set();
Object.keys(planGroups).forEach((key) => {
  const plans = planGroups[key];
  const pendingPlans = plans
    .filter((p) => p.status === '待执行')
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  if (pendingPlans.length > 1) {
    const toRemove = pendingPlans.slice(1);
    toRemove.forEach((p) => planIdsToRemove.add(p.id));
  }
});

console.log(`\n需要删除的重复待执行计划数: ${planIdsToRemove.size}`);

if (planIdsToRemove.size > 0) {
  db.plans = db.plans.filter((p) => !planIdsToRemove.has(p.id));

  if (db.auditLogs && db.auditLogs.length) {
    const originalAuditCount = db.auditLogs.length;
    db.auditLogs = db.auditLogs.filter(
      (log) => !(log.collection === 'plans' && planIdsToRemove.has(log.recordId))
    );
    const removedAuditCount = originalAuditCount - db.auditLogs.length;
    console.log(`同时删除相关审计日志: ${removedAuditCount} 条`);
  }

  fs.writeFileSync(dbPath, JSON.stringify(db, null, 2), 'utf8');
  console.log('\n清理完成！');
  console.log(`剩余计划总数: ${db.plans.length}`);
  console.log(`剩余自动生成计划数: ${db.plans.filter((p) => p.autoCreatedFromZone).length}`);
} else {
  console.log('\n没有需要清理的重复计划');
}
