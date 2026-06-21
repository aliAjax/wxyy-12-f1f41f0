const state = {
  config: null,
  db: {},
  activeTab: '',
  selectedDraftIds: new Set(),
  editingDraftId: null,
  zoneOverview: null,
  activeZoneDetail: null,
  zoneDetailCache: null,
  microclimateTrends: null,
  importCsvText: '',
  importPreviewData: null,
  importResultData: null,
  auditLogs: [],
  activeAuditRecord: null,
  activeDiffLog: null,
  currentUser: null,
  authToken: null,
  listFilters: {}
};

const TOKEN_STORAGE_KEY = 'wxyy_auth_token_v1';

const DRAFT_STORAGE_KEY = 'wxyy_survey_drafts_v1';

const DraftStore = {
  all() {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      console.error('草稿读取失败', e);
      return [];
    }
  },
  save(list) {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(list));
  },
  add(data, extra = {}) {
    const list = this.all();
    const now = new Date().toISOString();
    const draft = {
      id: `draft-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      collection: 'surveys',
      data,
      createdAt: now,
      updatedAt: now,
      submitError: null,
      ...extra
    };
    list.unshift(draft);
    this.save(list);
    return draft;
  },
  addMany(items) {
    if (!items || !items.length) return [];
    const list = this.all();
    const now = new Date().toISOString();
    const created = [];
    for (const item of items) {
      const draft = {
        id: `draft-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
        collection: 'surveys',
        data: item.data,
        createdAt: now,
        updatedAt: now,
        submitError: null,
        ...(item.extra || {})
      };
      list.unshift(draft);
      created.push(draft);
    }
    this.save(list);
    return created;
  },
  findByPlanId(planId) {
    if (!planId) return [];
    return this.all().filter((d) => d.data?.planId === planId);
  },
  update(id, data) {
    const list = this.all();
    const idx = list.findIndex((d) => d.id === id);
    if (idx < 0) return null;
    list[idx].data = { ...list[idx].data, ...data };
    list[idx].updatedAt = new Date().toISOString();
    list[idx].submitError = null;
    this.save(list);
    return list[idx];
  },
  remove(id) {
    const list = this.all().filter((d) => d.id !== id);
    this.save(list);
  },
  removeMany(ids) {
    const set = new Set(ids);
    const list = this.all().filter((d) => !set.has(d.id));
    this.save(list);
  },
  setError(id, error) {
    const list = this.all();
    const idx = list.findIndex((d) => d.id === id);
    if (idx >= 0) {
      list[idx].submitError = error;
      list[idx].updatedAt = new Date().toISOString();
      this.save(list);
    }
  },
  clearErrors() {
    const list = this.all().map((d) => ({ ...d, submitError: null }));
    this.save(list);
  },
  get(id) {
    return this.all().find((d) => d.id === id) || null;
  }
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
}

async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (state.authToken) {
    headers['Authorization'] = `Bearer ${state.authToken}`;
  }
  const res = await fetch(path, {
    ...options,
    headers
  });
  if (res.status === 401) {
    state.currentUser = null;
    state.authToken = null;
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    renderHeaderUser();
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
}

function hasPermission(permission) {
  if (!state.currentUser || !state.config?.roles) return false;
  const roleConfig = state.config.roles[state.currentUser.role];
  if (!roleConfig) return false;
  return roleConfig.permissions?.includes(permission) || false;
}

function actionPermissionMap(actionId) {
  const map = {
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
  return map[actionId] || null;
}

function canCreateCollection(collection) {
  const permissionMap = {
    sites: 'sites:create',
    surveys: 'surveys:create',
    plans: 'plans:create',
    reviews: 'reviews:create',
    incidents: 'incidents:create'
  };
  const perm = permissionMap[collection];
  return perm ? hasPermission(perm) : false;
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValueByPath(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function searchValueByPath(source, pathName) {
  const keys = pathName.split('.');
  const walk = (value, index) => {
    if (value === undefined || value === null) return [];
    if (Array.isArray(value)) return value.flatMap((entry) => walk(entry, index));
    if (index >= keys.length) return [value];
    return walk(value[keys[index]], index + 1);
  };
  return walk(source, 0).map((value) => String(value)).join(' ');
}

function displayField(item, field) {
  const value = item[field.name] ?? '';
  if (field.type === 'select' && field.options) return value || field.options[0];
  return value;
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  let label = relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
  if (relation.withSite && relation.collection === 'surveys' && item.siteId) {
    const site = state.db.sites?.find((s) => s.id === item.siteId);
    if (site) {
      const siteLabel = [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
      label = `${siteLabel} · ${label}`;
    }
  }
  return label;
}

function optionList(items, labelFields, options = {}) {
  return items.map((item) => {
    let label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    if (options.withSite && options.collection === 'surveys' && item.siteId) {
      const site = state.db.sites?.find((s) => s.id === item.siteId);
      if (site) {
        const siteLabel = [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
        label = `${siteLabel} · ${label}`;
      }
    }
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    let items = state.db[field.collection] || [];
    if (field.filter) items = items.filter((item) => item[field.filter.field] === field.filter.value);
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields, { withSite: field.withSite, collection: field.collection })}</select></label>`;
  }
  if (field.type === 'multirelation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" multiple size="6" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  if (field.type === 'photos') {
    return `<div class="photos-field ${field.wide ? 'wide' : ''}">
      <div class="photos-field-header">
        <label>${field.label}</label>
        <button type="button" class="secondary add-photo-btn" data-field="${field.name}">+ 添加照片</button>
      </div>
      <div class="photo-entries" data-field="${field.name}"></div>
    </div>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 5).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function photoEntryHtml(fieldName, photo = {}) {
  return `<div class="photo-entry" data-field="${fieldName}">
    <div class="photo-entry-header">
      <span class="photo-entry-index">照片 ${fieldName}</span>
      <button type="button" class="danger remove-photo-btn">删除</button>
    </div>
    <div class="photo-entry-grid">
      <label>标题<input type="text" data-photo-field="title" value="${escapeHtml(photo.title || '')}" placeholder="例如：栏杆触碰痕迹"></label>
      <label>图片URL<input type="text" data-photo-field="url" value="${escapeHtml(photo.url || '')}" placeholder="https://..."></label>
      <label class="wide">拍摄点位<input type="text" data-photo-field="location" value="${escapeHtml(photo.location || '')}" placeholder="例如：北麓三号洞 / 滴水帘区 / D-07"></label>
      <label class="wide">说明<textarea data-photo-field="description" placeholder="照片描述和现场说明">${escapeHtml(photo.description || '')}</textarea></label>
    </div>
  </div>`;
}

function photosBadgeHtml(item, collection) {
  const photos = item.photos || [];
  if (!photos.length) return '';
  return `<button class="photos-badge" data-view-photos="${collection}:${item.id}">
    <span class="photos-icon">📷</span>
    <span>${photos.length} 张照片</span>
  </button>`;
}

function renderPhotoModal(photoKey) {
  const [collection, id] = photoKey.split(':');
  const item = state.db[collection]?.find((entry) => entry.id === id);
  if (!item || !item.photos?.length) return;
  const site = state.db.sites?.find((s) => s.id === item.siteId);
  const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '';
  const titleLabel = item.surveyor ? `${item.surveyor} / ${item.date}` : (item.eventType ? `${item.eventType} / ${item.reporter}` : item.id);
  $('#photoModalTitle').textContent = `照片证据 - ${titleLabel}`;
  $('#photoModalBody').innerHTML = item.photos.map((photo, index) => `
    <div class="photo-detail">
      <div class="photo-detail-head">
        <span class="photo-detail-index">照片 ${index + 1}</span>
        ${photo.title ? `<h3>${escapeHtml(photo.title)}</h3>` : ''}
      </div>
      <div class="photo-detail-image">
        <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.title || '现场照片')}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex';">
        <div class="photo-error">
          <span>📷</span>
          <p>图片加载失败</p>
          <a href="${escapeHtml(photo.url)}" target="_blank">在新窗口打开</a>
        </div>
      </div>
      <div class="photo-detail-meta">
        ${photo.location || siteLabel ? `<div class="photo-meta-item"><span class="meta-label">拍摄点位</span><span>${escapeHtml(photo.location || siteLabel)}</span></div>` : ''}
        ${photo.description ? `<div class="photo-meta-item"><span class="meta-label">说明</span><span>${escapeHtml(photo.description)}</span></div>` : ''}
        <div class="photo-meta-item"><span class="meta-label">图片链接</span><a href="${escapeHtml(photo.url)}" target="_blank">${escapeHtml(photo.url)}</a></div>
      </div>
    </div>
  `).join('');
  $('#photoModal').classList.add('show');
}

function closePhotoModal() {
  $('#photoModal').classList.remove('show');
}

const AUDIT_ACTION_ICONS = {
  create: '➕',
  update: '✏️',
  delete: '🗑️',
  action: '🔄',
  rollback: '↩️',
  recalc_risk: '🔁'
};

const AUDIT_ACTION_LABELS = {
  create: '创建',
  update: '更新',
  delete: '删除',
  action: '动作',
  rollback: '回滚',
  recalc_risk: '重新计算风险'
};

function formatValue(val) {
  if (val === null || val === undefined) return '-';
  if (typeof val === 'object') return JSON.stringify(val, null, 2);
  return String(val);
}

function diffClass(log) {
  if (!log || !log.diff) return '';
  const keys = Object.keys(log.diff);
  return keys.length > 0 ? 'has-diff' : 'no-diff';
}

async function loadAuditLogs(collection, id) {
  try {
    const logs = await api(`/api/audit-logs/${collection}/${id}`);
    state.auditLogs = logs;
    return logs;
  } catch (err) {
    toast(`加载审计日志失败：${err.message}`);
    return [];
  }
}

async function openAuditModal(collection, id, title) {
  state.activeAuditRecord = { collection, id, title };
  const logs = await loadAuditLogs(collection, id);
  const item = state.db[collection]?.find((entry) => entry.id === id);
  const site = item?.siteId ? state.db.sites?.find((s) => s.id === item.siteId) : null;
  const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '';
  const fullTitle = `${title}${siteLabel ? ' · ' + siteLabel : ''}`;
  $('#auditModalTitle').textContent = `审计时间线 - ${fullTitle}`;
  $('#auditModalBody').innerHTML = renderAuditTimeline(logs, collection, id);
  $('#auditModal').classList.add('show');
}

function closeAuditModal() {
  $('#auditModal').classList.remove('show');
  state.activeAuditRecord = null;
  state.auditLogs = [];
}

function openDiffModal(logId) {
  const log = state.auditLogs.find((l) => l.id === logId);
  if (!log) return;
  state.activeDiffLog = log;
  $('#diffModalTitle').textContent = `变更详情 - ${log.actionLabel} (${fmtDate(log.createdAt)})`;
  $('#diffModalBody').innerHTML = renderDiffView(log);
  $('#diffModal').classList.add('show');
}

function closeDiffModal() {
  $('#diffModal').classList.remove('show');
  state.activeDiffLog = null;
}

function renderAuditTimeline(logs, collection, id) {
  if (!logs.length) {
    return `<div class="empty" style="padding:40px;text-align:center;">暂无审计记录</div>`;
  }
  const currentItem = state.db[collection]?.find((entry) => entry.id === id);
  const rollbackNote = currentItem ? `确认将记录恢复到本次操作完成后的状态？此操作将生成新的审计记录。` : '';
  return `
    <div class="audit-timeline">
      ${logs.map((log, index) => {
        const isLatest = index === 0;
        const canRollback = log.action !== 'delete' && !isLatest && currentItem;
        const changeCount = Object.keys(log.diff || {}).length;
        return `
          <div class="audit-timeline-item ${diffClass(log)}" data-audit-log-id="${log.id}">
            <div class="audit-timeline-marker">
              <span class="audit-icon">${AUDIT_ACTION_ICONS[log.action] || '📝'}</span>
            </div>
            <div class="audit-timeline-content">
              <div class="audit-timeline-head">
                <div class="audit-timeline-title">
                  <strong>${escapeHtml(log.actionLabel || AUDIT_ACTION_LABELS[log.action] || log.action)}</strong>
                  ${isLatest ? '<span class="pill ok">当前版本</span>' : ''}
                  ${changeCount > 0 ? `<span class="pill warn">${changeCount} 项变更</span>` : ''}
                </div>
                <div class="audit-timeline-meta">
                  <span>${fmtDate(log.createdAt)}</span>
                  <span>操作人：${escapeHtml(log.operator || 'system')}</span>
                </div>
              </div>
              ${log.note ? `<div class="audit-timeline-note">${escapeHtml(log.note)}</div>` : ''}
              ${changeCount > 0 ? `
                <div class="audit-timeline-changes">
                  ${Object.entries(log.diff).slice(0, 5).map(([key, val]) => `
                    <div class="audit-change-mini">
                      <span class="audit-change-field">${escapeHtml(key)}</span>
                      <span class="audit-change-before" title="变更前">${escapeHtml(formatValue(val.before).slice(0, 30))}</span>
                      <span class="audit-change-arrow">→</span>
                      <span class="audit-change-after" title="变更后">${escapeHtml(formatValue(val.after).slice(0, 30))}</span>
                    </div>
                  `).join('')}
                  ${changeCount > 5 ? `<div class="audit-more-changes">还有 ${changeCount - 5} 项变更…</div>` : ''}
                </div>
              ` : ''}
              <div class="audit-timeline-actions">
                <button class="secondary" data-view-diff="${log.id}">查看详细差异</button>
                ${canRollback ? `<button class="danger" data-rollback="${log.id}" data-rollback-note="${escapeHtml(rollbackNote)}">恢复到此状态</button>` : ''}
              </div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderDiffView(log) {
  const diff = log.diff || {};
  const keys = Object.keys(diff);
  if (!keys.length) {
    return `<div class="empty" style="padding:40px;text-align:center;">此操作无业务字段变更</div>`;
  }
  return `
    <div class="diff-view">
      <div class="diff-summary">
        <div class="diff-summary-item">
          <span class="diff-label">操作类型</span>
          <span class="pill">${AUDIT_ACTION_ICONS[log.action] || ''} ${escapeHtml(log.actionLabel || AUDIT_ACTION_LABELS[log.action] || log.action)}</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-label">操作时间</span>
          <span>${fmtDate(log.createdAt)}</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-label">操作人</span>
          <span>${escapeHtml(log.operator || 'system')}</span>
        </div>
        <div class="diff-summary-item">
          <span class="diff-label">变更字段</span>
          <span class="pill warn">${keys.length} 项</span>
        </div>
        ${log.note ? `
          <div class="diff-summary-item wide">
            <span class="diff-label">备注</span>
            <span>${escapeHtml(log.note)}</span>
          </div>
        ` : ''}
      </div>
      <div class="diff-table">
        <div class="diff-table-head">
          <div class="diff-col">字段</div>
          <div class="diff-col diff-col-before">变更前</div>
          <div class="diff-col diff-col-after">变更后</div>
        </div>
        ${keys.map((key) => {
          const val = diff[key];
          const beforeStr = formatValue(val.before);
          const afterStr = formatValue(val.after);
          return `
            <div class="diff-table-row">
              <div class="diff-col diff-field-name"><strong>${escapeHtml(key)}</strong></div>
              <div class="diff-col diff-col-before"><pre>${escapeHtml(beforeStr)}</pre></div>
              <div class="diff-col diff-col-after"><pre>${escapeHtml(afterStr)}</pre></div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
}

async function rollbackToLog(logId) {
  const log = state.auditLogs.find((l) => l.id === logId);
  if (!log) return;
  const note = prompt(`回滚备注（可选）：\n\n将记录恢复到「${log.actionLabel}」(${fmtDate(log.createdAt)}) 操作完成后的状态\n确认后将生成新的审计记录。`, '');
  if (note === null) return;
  try {
    const result = await api(`/api/audit-logs/${logId}/rollback`, {
      method: 'POST',
      body: JSON.stringify({ note: note || '' })
    });
    await load();
    closeDiffModal();
    if (state.activeAuditRecord) {
      await openAuditModal(state.activeAuditRecord.collection, state.activeAuditRecord.id, state.activeAuditRecord.title);
    }
    toast('回滚成功，已生成新的审计记录');
  } catch (err) {
    toast(`回滚失败：${err.message}`);
  }
}

function updatePhotoIndices(container) {
  const entries = container.querySelectorAll('.photo-entry');
  entries.forEach((entry, idx) => {
    const indexEl = entry.querySelector('.photo-entry-index');
    if (indexEl) {
      const fieldName = entry.dataset.field;
      indexEl.textContent = `照片 ${idx + 1}`;
    }
  });
}

function addPhotoEntry(btn) {
  const fieldName = btn.dataset.field;
  const container = btn.closest('.photos-field').querySelector('.photo-entries');
  const entryCount = container.querySelectorAll('.photo-entry').length;
  const div = document.createElement('div');
  div.innerHTML = photoEntryHtml(fieldName).replace('照片 ' + fieldName, `照片 ${entryCount + 1}`);
  container.appendChild(div.firstElementChild);
}

function values(form, view) {
  const payload = {};
  const formData = new FormData(form);
  for (const [key, value] of formData.entries()) {
    if (payload[key] === undefined) {
      payload[key] = value;
    } else if (Array.isArray(payload[key])) {
      payload[key].push(value);
    } else {
      payload[key] = [payload[key], value];
    }
  }
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
    if (field.type === 'multirelation') {
      if (!Array.isArray(payload[field.name])) {
        payload[field.name] = payload[field.name] ? [payload[field.name]] : [];
      }
    }
    if (field.type === 'photos') {
      const entries = form.querySelectorAll(`.photo-entry[data-field="${field.name}"]`);
      payload[field.name] = Array.from(entries).map((entry, idx) => ({
        id: `photo-${Date.now()}-${idx}`,
        title: entry.querySelector(`[data-photo-field="title"]`).value.trim(),
        url: entry.querySelector(`[data-photo-field="url"]`).value.trim(),
        location: entry.querySelector(`[data-photo-field="location"]`).value.trim(),
        description: entry.querySelector(`[data-photo-field="description"]`).value.trim()
      })).filter((photo) => photo.url);
    }
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  const draftCount = DraftStore.all().length;
  const draftBadge = draftCount > 0 ? `<span class="tab-badge" data-tab-badge="drafts">${draftCount}</span>` : '';
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('') + `<button class="tab tab-drafts" data-tab="drafts">草稿箱${draftBadge}</button>`;
  state.activeTab = state.config.views[0].id;
}

function updateDraftBadge() {
  const count = DraftStore.all().length;
  const badge = $('[data-tab-badge="drafts"]');
  if (badge) {
    badge.textContent = count;
    badge.style.display = count > 0 ? '' : 'none';
  }
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function autoRiskHtml(item) {
  if (!item.autoRiskLevel || item.autoRiskLevel === '正常') return '';
  const tone = item.autoRiskLevel === '高风险' ? 'bad' : 'warn';
  const reasons = (item.autoRiskReasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('');
  const reviewedBadge = item.manuallyReviewed ? '<span class="auto-risk-reviewed" title="已人工复查，自动判定结果仅供参考">已人工复核</span>' : '';
  return `<div class="auto-risk ${tone}">
    <div class="auto-risk-head">
      <span class="auto-risk-label">自动判定</span>
      ${pill(item.autoRiskLevel, tone)}
      ${reviewedBadge}
    </div>
    ${reasons ? `<ul class="auto-risk-reasons">${reasons}</ul>` : ''}
    <div class="auto-risk-deviations">
      <span>温度偏差 <strong>${Number(item.deviationTemp || 0).toFixed(1)}℃</strong></span>
      <span>湿度偏差 <strong>${Number(item.deviationHumidity || 0).toFixed(1)}%</strong></span>
      <span>CO2偏差 <strong>${Number(item.deviationCo2 || 0).toFixed(0)}ppm</strong></span>
    </div>
  </div>`;
}

function baselineImpactHint(site) {
  const rules = state.config.thresholdRules || {};
  const tr = rules.temperature || {};
  const hr = rules.humidity || {};
  const cr = rules.co2 || {};
  const surveyCount = ((state.db.surveys || []).filter((s) => s.siteId === site.id)).length;
  return `<div class="baseline-impact-hint">
    <div class="baseline-impact-icon">⚠️</div>
    <div class="baseline-impact-content">
      <h4>基准值影响提示</h4>
      <p>基准温度、湿度和 CO₂ 是自动风险判定的计算依据，修改后会影响该样点所有巡测记录的自动风险判定结果。</p>
      <div class="baseline-impact-rules">
        <span>温度偏差阈值：预警 ≥ ${tr.warning || 2}℃ / 高风险 ≥ ${tr.critical || 4}℃</span>
        <span>湿度偏差阈值：预警 ≥ ${hr.warning || 10}% / 高风险 ≥ ${hr.critical || 20}%</span>
        <span>CO₂ 偏差阈值：预警 ≥ ${cr.warning || 200}ppm / 高风险 ≥ ${cr.critical || 400}ppm</span>
      </div>
      ${surveyCount > 0 ? `<p class="baseline-impact-surveys">该样点已有 <strong>${surveyCount}</strong> 条巡测记录，保存后可对最近 10 条记录重新计算风险。</p>` : ''}
    </div>
  </div>`;
}

function openSiteEditModal(siteId) {
  const site = state.db.sites?.find((s) => s.id === siteId);
  if (!site) { toast('样点不存在'); return; }
  const sitesView = state.config.views.find((v) => v.id === 'sites');
  if (!sitesView) return;
  const title = `${site.cave} / ${site.zone} / ${site.pointCode}`;
  $('#siteEditModalTitle').textContent = `编辑样点 - ${title}`;

  const fieldsHtml = sitesView.fields.map((field) => {
    const value = site[field.name] ?? (field.default ?? '');
    const required = field.required ? 'required' : '';
    const baselineClass = ['baselineTemp', 'baselineHumidity', 'baselineCo2'].includes(field.name) ? 'baseline-field' : '';
    if (field.type === 'textarea') {
      return `<label class="${field.wide ? 'wide' : ''} ${baselineClass}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(value)}</textarea></label>`;
    }
    if (field.type === 'select') {
      return `<label class="${field.wide ? 'wide' : ''} ${baselineClass}">${field.label}<select name="${field.name}" ${required}>${field.options.map((opt) => `<option ${opt === value ? 'selected' : ''}>${escapeHtml(opt)}</option>`).join('')}</select></label>`;
    }
    return `<label class="${field.wide ? 'wide' : ''} ${baselineClass}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" value="${escapeHtml(value)}" ${required}></label>`;
  }).join('');

  $('#siteEditModalBody').innerHTML = `
    ${baselineImpactHint(site)}
    <form id="siteEditForm" data-site-id="${site.id}">
      <div class="form-grid">${fieldsHtml}</div>
      <div class="actions">
        <button type="submit">保存修改</button>
        <button type="button" class="ghost" data-close-site-edit>取消</button>
      </div>
    </form>
  `;
  $('#siteEditModal').classList.add('show');
}

function closeSiteEditModal() {
  $('#siteEditModal').classList.remove('show');
}

function openRiskRecalcModal(siteData) {
  const site = state.db.sites?.find((s) => s.id === siteData.id) || siteData;
  const changes = siteData.baselineChanges || {};
  const changeLabels = {
    baselineTemp: '基准温度',
    baselineHumidity: '基准湿度',
    baselineCo2: '基准CO₂'
  };
  const unitLabels = {
    baselineTemp: '℃',
    baselineHumidity: '%',
    baselineCo2: 'ppm'
  };
  const changesHtml = Object.keys(changes).map((key) => {
    const c = changes[key];
    const unit = unitLabels[key] || '';
    return `<div class="risk-recalc-change">
      <span class="risk-recalc-field">${changeLabels[key] || key}</span>
      <span class="risk-recalc-before">${Number(c.before).toFixed(key === 'baselineCo2' ? 0 : 1)}${unit}</span>
      <span class="risk-recalc-arrow">→</span>
      <span class="risk-recalc-after">${Number(c.after).toFixed(key === 'baselineCo2' ? 0 : 1)}${unit}</span>
    </div>`;
  }).join('');

  const surveys = siteData.recentSurveys || [];
  const surveysHtml = surveys.length ? `
    <h4>受影响的最近 ${surveys.length} 条巡测记录</h4>
    <div class="risk-recalc-surveys">
      ${surveys.map((s) => `
        <div class="risk-recalc-survey-item">
          <div class="risk-recalc-survey-head">
            <strong>${escapeHtml(s.surveyor || '-')} / ${escapeHtml(s.date || '-')}</strong>
            ${s.autoRiskLevel && s.autoRiskLevel !== '正常' ? pill(s.autoRiskLevel, s.autoRiskLevel === '高风险' ? 'bad' : 'warn') : pill('正常', 'ok')}
            ${s.status ? pill(s.status, toneFor(s.status)) : ''}
          </div>
          <div class="risk-recalc-survey-data">
            <span>温度: <strong>${Number(s.temperature || 0).toFixed(1)}℃</strong></span>
            <span>湿度: <strong>${Number(s.humidity || 0).toFixed(0)}%</strong></span>
            <span>CO₂: <strong>${Number(s.co2 || 0).toFixed(0)}ppm</strong></span>
          </div>
        </div>
      `).join('')}
    </div>
  ` : '<p class="muted-text">该样点暂无巡测记录。</p>';

  $('#riskRecalcModalTitle').textContent = `基准值已变更 - 重新计算风险`;
  $('#riskRecalcModalBody').innerHTML = `
    <div class="risk-recalc-panel">
      <h3>变更内容</h3>
      <div class="risk-recalc-changes">${changesHtml}</div>
      ${surveys.length ? `
        <div class="risk-recalc-actions">
          <p>系统将使用新的基准值对上述 <strong>${surveys.length}</strong> 条巡测记录重新计算自动风险等级。已人工复核的记录其状态不会被自动覆盖。</p>
          <button id="doRecalcRisksBtn" data-site-id="${siteData.id}">🔁 重新计算最近 ${surveys.length} 条记录风险</button>
          <button class="ghost" data-close-risk-recalc>暂不处理</button>
        </div>
      ` : ''}
      ${surveysHtml}
      <div id="riskRecalcResult"></div>
    </div>
  `;
  $('#riskRecalcModal').classList.add('show');
}

function closeRiskRecalcModal() {
  $('#riskRecalcModal').classList.remove('show');
}

async function doRecalculateRisks(siteId) {
  const btn = $('#doRecalcRisksBtn');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = '计算中...';
  try {
    const result = await api(`/api/sites/${siteId}/recalculate-risks`, { method: 'POST' });
    await load();
    const resultEl = $('#riskRecalcResult');
    if (resultEl) {
      const changed = result.results.filter((r) => r.oldRiskLevel !== r.newRiskLevel);
      resultEl.innerHTML = `
        <div class="risk-recalc-success">
          <h4>✅ 重新计算完成</h4>
          <p>共处理 <strong>${result.recalculatedCount}</strong> 条记录，其中 <strong>${changed.length}</strong> 条风险等级发生变化：</p>
          ${changed.length ? `
            <div class="risk-recalc-result-list">
              ${changed.map((r) => `
                <div class="risk-recalc-result-item">
                  <span>${escapeHtml(r.id)}</span>
                  <span>${pill(r.oldRiskLevel || '正常', r.oldRiskLevel === '高风险' ? 'bad' : (r.oldRiskLevel === '预警' ? 'warn' : 'ok'))}</span>
                  <span>→</span>
                  <span>${pill(r.newRiskLevel || '正常', r.newRiskLevel === '高风险' ? 'bad' : (r.newRiskLevel === '预警' ? 'warn' : 'ok'))}</span>
                  <span class="muted-text">${pill(r.status, toneFor(r.status))}</span>
                </div>
              `).join('')}
            </div>
          ` : '<p class="muted-text">所有记录风险等级均未变化。</p>'}
        </div>
      `;
    }
    btn.remove();
  } catch (err) {
    toast(`重新计算失败：${err.message}`);
    btn.disabled = false;
    btn.textContent = '🔁 重新计算风险';
  }
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    let raw = item[field.name];
    if (field.name === 'siteCount' && Array.isArray(item.siteIds)) {
      raw = item.siteIds.length + ' 个';
    }
    let value;
    if (field.type === 'relation') {
      value = relationLabel(field, raw);
    } else if (field.type === 'multirelation' && Array.isArray(raw)) {
      const items = state.db[field.collection] || [];
      value = raw.map((id) => {
        const relItem = items.find((entry) => entry.id === id);
        return relItem ? field.labelFields.map((f) => relItem[f]).filter(Boolean).join(' / ') : id;
      }).join('、');
    } else {
      value = raw;
    }
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const siteListHtml = (Array.isArray(item.siteIds) && item.siteIds.length) ? `<div class="meta">样点：${escapeHtml(item.siteIds.map((id) => {
    const site = state.db.sites?.find((s) => s.id === id);
    return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : id;
  }).join('、'))}</div>` : '';
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');

  let planDraftsBadge = '';
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => {
      const perm = actionPermissionMap(action.id);
      const permDisabled = perm ? !hasPermission(perm) : false;

      if (action.id === 'plan-generate-drafts' && collection === 'plans') {
        const existingDrafts = DraftStore.findByPlanId(item.id);
        const hasExistingDrafts = existingDrafts.length > 0;
        const hasGeneratedDrafts = Boolean(item.draftsGenerated) || hasExistingDrafts;
        const siteIds = item.siteIds || [];
        const hasSites = siteIds.length > 0;
        const disabled = permDisabled || !hasSites || hasGeneratedDrafts;
        let buttonLabel = action.label;
        let buttonClass = 'ghost plan-generate-drafts-btn';
        let extraAttrs = '';

        if (hasGeneratedDrafts) {
          buttonLabel = hasExistingDrafts ? `草稿已生成 (${existingDrafts.length}条)` : '草稿已生成';
          buttonClass += ' plan-drafts-exist';
          extraAttrs = 'title="草稿已生成，禁止重复生成"';
          planDraftsBadge = `<span class="pill plan-drafts-status-pill" title="草稿已生成，禁止重复生成">📝 ${hasExistingDrafts ? `已生成 ${existingDrafts.length} 条草稿` : '已生成草稿'}</span>`;
        } else if (!hasSites) {
          extraAttrs = 'title="该计划暂未关联样点，无法生成草稿"';
        }

        return `<button class="${buttonClass}" data-plan-generate-drafts="${item.id}" ${disabled ? 'disabled' : ''} ${permDisabled ? 'title="无权限执行此操作"' : extraAttrs}>${escapeHtml(buttonLabel)}</button>`;
      }

      const title = permDisabled ? '无权限执行此操作' : '';
      return `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}" ${permDisabled ? 'disabled title="无权限执行此操作"' : ''}>${escapeHtml(action.label)}</button>`;
    })
    .join('');

  let editBtn = '';
  if (collection === 'sites' && hasPermission('sites:update')) {
    editBtn = `<button class="ghost" data-edit-site="${item.id}">✏️ 编辑样点</button>`;
  }

  const canViewAudit = hasPermission('audit:view');
  const auditBtn = canViewAudit
    ? `<button class="ghost" data-audit-history="${collection}:${item.id}" data-audit-title="${escapeHtml(title)}">📋 审计历史</button>`
    : '';
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3><div class="card-head-right">${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}${planDraftsBadge}${photosBadgeHtml(item, collection)}</div></div>
    ${relation}
    ${siteListHtml}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${autoRiskHtml(item)}
    ${details ? `<div class="detail">${details}</div>` : ''}
    <div class="actions">${editBtn}${actions}${auditBtn}</div>
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const isSurveyView = collection === 'surveys';
  const viewFilters = state.listFilters[view.id] || {};
  const query = viewFilters.search || '';
  const status = viewFilters.status || '';
  const filterValue = view.filterField ? (viewFilters[view.filterField] || '') : '';
  const typeFilterValue = view.typeFilterField ? (viewFilters[view.typeFilterField] || '') : '';
  const autoRiskValue = isSurveyView ? (viewFilters.autoRiskLevel || '') : '';
  const importedIdsStr = isSurveyView ? (viewFilters.importedIds || '') : '';
  const importedIds = importedIdsStr ? importedIdsStr.split(',').filter(Boolean) : [];

  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => searchValueByPath(item, field).includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  if (filterValue && view.filterField) {
    items = items.filter((item) => item[view.filterField] === filterValue);
  }
  if (typeFilterValue && view.typeFilterField) {
    items = items.filter((item) => item[view.typeFilterField] === typeFilterValue);
  }
  if (autoRiskValue && isSurveyView) {
    items = items.filter((item) => {
      const level = item.autoRiskLevel || '正常';
      if (autoRiskValue === '正常') return level === '正常' || level === '';
      return level === autoRiskValue;
    });
  }
  if (importedIds.length && isSurveyView) {
    const idSet = new Set(importedIds);
    items = items.filter((item) => idSet.has(item.id));
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

function renderHighRiskSummary() {
  const surveys = state.db.surveys || [];
  const highRiskItems = surveys.filter((s) => s.autoRiskLevel === '高风险');
  const warningItems = surveys.filter((s) => s.autoRiskLevel === '预警');
  if (!highRiskItems.length && !warningItems.length) return '';
  const summaryRows = [];
  for (const item of highRiskItems) {
    const site = state.db.sites?.find((s) => s.id === item.siteId);
    const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : item.siteId;
    const reasons = (item.autoRiskReasons || []).join('；');
    summaryRows.push(`<div class="risk-summary-row bad">
      <div class="risk-summary-level">${pill('高风险', 'bad')}</div>
      <div class="risk-summary-info">
        <div class="risk-summary-title">${escapeHtml(siteLabel)} · ${escapeHtml(item.surveyor)} / ${escapeHtml(item.date)}</div>
        <div class="risk-summary-reasons">${escapeHtml(reasons)}</div>
      </div>
      <div class="risk-summary-status">${pill(item.status || '', toneFor(item.status))}</div>
    </div>`);
  }
  for (const item of warningItems) {
    const site = state.db.sites?.find((s) => s.id === item.siteId);
    const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : item.siteId;
    const reasons = (item.autoRiskReasons || []).join('；');
    summaryRows.push(`<div class="risk-summary-row warn">
      <div class="risk-summary-level">${pill('预警', 'warn')}</div>
      <div class="risk-summary-info">
        <div class="risk-summary-title">${escapeHtml(siteLabel)} · ${escapeHtml(item.surveyor)} / ${escapeHtml(item.date)}</div>
        <div class="risk-summary-reasons">${escapeHtml(reasons)}</div>
      </div>
      <div class="risk-summary-status">${pill(item.status || '', toneFor(item.status))}</div>
    </div>`);
  }
  return `<div class="panel high-risk-panel">
    <h2>高风险与预警摘要</h2>
    <div class="risk-summary-list">${summaryRows.join('')}</div>
  </div>`;
}

function trendDirectionLabel(trend) {
  const map = { up: '上升', down: '下降', stable: '稳定', insufficient: '样本不足' };
  return map[trend] || '—';
}

function trendIcon(trend) {
  const map = { up: '▲', down: '▼', stable: '—', insufficient: '○' };
  return map[trend] || '○';
}

function trendTone(trend) {
  if (trend === 'up') return 'bad';
  if (trend === 'down') return 'ok';
  if (trend === 'stable') return 'ok';
  return '';
}

function riskTrendTone(trend) {
  if (trend === 'up') return 'bad';
  if (trend === 'down') return 'ok';
  if (trend === 'stable') return 'warn';
  return '';
}

function renderTrendIndicator(trend, isRisk = false) {
  const label = trendDirectionLabel(trend);
  const icon = trendIcon(trend);
  const tone = isRisk ? riskTrendTone(trend) : trendTone(trend);
  if (trend === 'insufficient') {
    return `<span class="trend-indicator insufficient" title="样本不足，无法判断趋势">${icon} 样本不足</span>`;
  }
  return `<span class="trend-indicator ${tone}" title="${label}">${icon} ${label}</span>`;
}

function renderMetricTrend(metric, label, unit, decimals = 1) {
  const avg = metric.avg;
  const avgStr = avg !== null && avg !== undefined ? Number(avg).toFixed(decimals) : '—';
  return `<div class="metric-trend">
    <div class="metric-trend-label">${escapeHtml(label)}</div>
    <div class="metric-trend-value">${avgStr}<span class="metric-unit">${escapeHtml(unit)}</span></div>
    ${renderTrendIndicator(metric.trend)}
  </div>`;
}

function renderAbnormalInfo(latestAbnormal, latestAbnormalSite) {
  if (!latestAbnormal) {
    return `<div class="trend-abnormal-empty muted-text">暂无异常样点</div>`;
  }
  const site = latestAbnormalSite || (latestAbnormal.siteId ? state.db.sites?.find((s) => s.id === latestAbnormal.siteId) : null);
  const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : (latestAbnormal.siteId || '未知样点');
  const riskLevel = latestAbnormal.autoRiskLevel || '预警';
  const tone = riskLevel === '高风险' ? 'bad' : 'warn';
  const reasons = (latestAbnormal.autoRiskReasons || []).slice(0, 2).join('；');
  return `<div class="trend-abnormal">
    <div class="trend-abnormal-head">
      ${pill(riskLevel, tone)}
      <span class="trend-abnormal-site">${escapeHtml(siteLabel)}</span>
    </div>
    ${reasons ? `<div class="trend-abnormal-reasons muted-text">${escapeHtml(reasons)}</div>` : ''}
    <div class="trend-abnormal-meta muted-text">
      ${escapeHtml(latestAbnormal.surveyor || '-')} · ${escapeHtml(latestAbnormal.date || '-')}
    </div>
  </div>`;
}

function renderZoneTrendCard(zone, caveName) {
  return `<div class="zone-trend-card">
    <div class="zone-trend-card-head">
      <h4>${escapeHtml(zone.name)}</h4>
      <div class="zone-trend-card-meta">
        <span class="muted-text">${zone.siteCount} 样点 · ${zone.sampleCount} 条记录</span>
        ${zone.riskTrend !== 'insufficient' ? renderTrendIndicator(zone.riskTrend, true) : ''}
      </div>
    </div>
    ${zone.sampleCount === 0 ? `
      <div class="trend-no-data">
        <span class="trend-no-data-icon">📋</span>
        <span>该分区暂无巡测记录</span>
      </div>
    ` : `
      <div class="metrics-grid">
        ${renderMetricTrend(zone.temperature, '温度', '℃', 1)}
        ${renderMetricTrend(zone.humidity, '湿度', '%', 0)}
        ${renderMetricTrend(zone.co2, 'CO₂', 'ppm', 0)}
      </div>
      <div class="zone-trend-stats">
        <span class="pill ok">正常 ${zone.normalCount}</span>
        <span class="pill warn">预警 ${zone.warningCount}</span>
        <span class="pill bad">高风险 ${zone.highRiskCount}</span>
      </div>
      ${renderAbnormalInfo(zone.latestAbnormal, zone.latestAbnormalSite)}
    `}
  </div>`;
}

function renderCaveTrendBlock(cave) {
  return `<div class="cave-trend-block">
    <div class="cave-trend-block-head">
      <div class="cave-trend-title">
        <h3>${escapeHtml(cave.name)}</h3>
        <span class="muted-text">${cave.zoneCount} 分区 · ${cave.siteCount} 样点 · ${cave.sampleCount || 0} 条记录</span>
      </div>
      ${cave.sampleCount > 0 ? `
        <div class="cave-trend-summary">
          ${cave.riskTrend !== 'insufficient' ? `<div class="cave-risk-trend"><span class="muted-text">风险趋势：</span>${renderTrendIndicator(cave.riskTrend, true)}</div>` : ''}
          <div class="cave-risk-counts">
            <span class="pill ok">正常 ${cave.normalCount}</span>
            <span class="pill warn">预警 ${cave.warningCount}</span>
            <span class="pill bad">高风险 ${cave.highRiskCount}</span>
          </div>
        </div>
      ` : ''}
    </div>
    ${cave.sampleCount > 0 ? `
      <div class="cave-metrics-overview">
        ${renderMetricTrend(cave.temperature, '平均温度', '℃', 1)}
        ${renderMetricTrend(cave.humidity, '平均湿度', '%', 0)}
        ${renderMetricTrend(cave.co2, '平均 CO₂', 'ppm', 0)}
      </div>
      ${cave.latestAbnormal ? `
        <div class="cave-latest-abnormal">
          <span class="cave-latest-abnormal-label">最新异常：</span>
          ${renderAbnormalInfo(cave.latestAbnormal, cave.latestAbnormalSite)}
        </div>
      ` : ''}
    ` : `
      <div class="trend-no-data cave-no-data">
        <span class="trend-no-data-icon">📋</span>
        <span>该洞穴暂无巡测记录，建议尽快安排巡测</span>
      </div>
    `}
    <div class="zone-trends-grid">
      ${cave.zones.map((zone) => renderZoneTrendCard(zone, cave.name)).join('')}
    </div>
  </div>`;
}

function renderMicroclimateTrends() {
  const data = state.microclimateTrends;
  if (!data) {
    return `<div class="panel microclimate-trend-panel">
      <h2>微环境趋势
        <span class="muted-text" style="font-weight:normal;font-size:13px;">（按洞穴和分区聚合最近 7 天或最近 10 条记录）</span>
      </h2>
      <div class="trend-loading">
        <div class="loading-spinner"></div>
        <span>正在加载趋势数据…</span>
      </div>
    </div>`;
  }

  const summary = data.summary || {};
  const caves = data.caves || [];

  if (!caves.length) {
    return `<div class="panel microclimate-trend-panel">
      <h2>微环境趋势
        <span class="muted-text" style="font-weight:normal;font-size:13px;">（按洞穴和分区聚合最近 7 天或最近 10 条记录）</span>
      </h2>
      <div class="empty">暂无洞穴数据</div>
    </div>`;
  }

  const cavesWithData = caves.filter((c) => c.sampleCount > 0).length;
  const cavesWithoutData = caves.length - cavesWithData;

  return `<div class="panel microclimate-trend-panel">
    <h2>微环境趋势
      <span class="muted-text" style="font-weight:normal;font-size:13px;">（按洞穴和分区聚合最近 7 天或最近 10 条记录）</span>
    </h2>
    <div class="trend-summary-bar">
      <div class="trend-summary-item">
        <span class="trend-summary-label">洞穴总数</span>
        <span class="trend-summary-value">${summary.totalCaves || 0}</span>
      </div>
      <div class="trend-summary-item">
        <span class="trend-summary-label">分区总数</span>
        <span class="trend-summary-value">${summary.totalZones || 0}</span>
      </div>
      <div class="trend-summary-item">
        <span class="trend-summary-label">样点总数</span>
        <span class="trend-summary-value">${summary.totalSites || 0}</span>
      </div>
      <div class="trend-summary-item">
        <span class="trend-summary-label">巡测记录</span>
        <span class="trend-summary-value">${summary.totalSurveys || 0}</span>
      </div>
      <div class="trend-summary-item ok">
        <span class="trend-summary-label">有数据样点</span>
        <span class="trend-summary-value">${summary.sitesWithSurveys || 0}</span>
      </div>
      ${cavesWithoutData > 0 ? `
        <div class="trend-summary-item warn">
          <span class="trend-summary-label">无数据样点</span>
          <span class="trend-summary-value">${summary.sitesWithoutSurveys || 0}</span>
        </div>
      ` : ''}
    </div>
    <div class="cave-trends-container">
      ${caves.map(renderCaveTrendBlock).join('')}
    </div>
  </div>`;
}

function draftSiteLabel(siteId) {
  const site = state.db.sites?.find((s) => s.id === siteId);
  return site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : (siteId || '未关联样点');
}

function draftTitle(draft) {
  const d = draft.data;
  const parts = [d.surveyor, d.date].filter(Boolean);
  return parts.join(' / ') || draft.id;
}

function renderDraftCard(draft) {
  const d = draft.data;
  const selected = state.selectedDraftIds.has(draft.id);
  const errorBox = draft.submitError
    ? `<div class="draft-error"><strong>上次提交失败</strong><p>${escapeHtml(draft.submitError)}</p></div>`
    : '';
  const photoCount = Array.isArray(d.photos) ? d.photos.length : 0;
  let planSourceBadge = '';
  if (d.planId) {
    const plan = state.db.plans?.find((p) => p.id === d.planId);
    if (plan) {
      const planLabel = [plan.route, plan.plannedDate].filter(Boolean).join(' · ');
      planSourceBadge = `<span class="pill plan-source-pill" title="来自巡测计划">📋 ${escapeHtml(planLabel)}</span>`;
    }
  }
  return `<article class="card draft-card${selected ? ' is-selected' : ''}${draft.submitError ? ' has-error' : ''}">
    <div class="card-head">
      <label class="draft-check"><input type="checkbox" data-draft-check="${draft.id}" ${selected ? 'checked' : ''}><span></span></label>
      <h3>${escapeHtml(draftTitle(draft))}</h3>
      <div class="card-head-right">
        <span class="pill draft-pill">本地草稿</span>
        ${planSourceBadge}
        ${photoCount > 0 ? `<span class="pill">📷 ${photoCount}张</span>` : ''}
      </div>
    </div>
    <div class="meta">样点：${escapeHtml(draftSiteLabel(d.siteId))}</div>
    <div class="detail">
      <div>温度<br><strong>${escapeHtml(d.temperature ?? '-')}℃</strong></div>
      <div>湿度<br><strong>${escapeHtml(d.humidity ?? '-')}%</strong></div>
      <div>CO2<br><strong>${escapeHtml(d.co2 ?? '-')}ppm</strong></div>
      <div>滴水频率<br><strong>${escapeHtml(d.dripRate ?? '-')}</strong></div>
    </div>
    ${d.disturbance ? `<p><strong>干扰痕迹：</strong>${escapeHtml(d.disturbance)}</p>` : ''}
    <div class="meta draft-meta">创建：${fmtDate(draft.createdAt)} · 更新：${fmtDate(draft.updatedAt)}</div>
    ${errorBox}
    <div class="actions">
      <button data-draft-edit="${draft.id}">继续编辑</button>
      <button class="secondary" data-draft-submit="${draft.id}">提交入库</button>
      <button class="danger" data-draft-delete="${draft.id}">删除草稿</button>
    </div>
  </article>`;
}

function renderDraftsView() {
  const drafts = DraftStore.all();
  const allSelected = drafts.length > 0 && drafts.every((d) => state.selectedDraftIds.has(d.id));
  return `<section class="view" id="drafts">
    <div class="panel drafts-toolbar-panel">
      <h2>草稿箱 <span class="muted-text">（共 ${drafts.length} 条本地暂存记录，刷新页面不丢失）</span></h2>
      <div class="drafts-toolbar">
        <label class="check-all-label"><input type="checkbox" id="draftCheckAll" ${allSelected ? 'checked' : ''}><span>全选</span></label>
        <div class="inline-actions">
          <button id="draftSubmitSelected" ${state.selectedDraftIds.size === 0 ? 'disabled' : ''}>批量提交 (${state.selectedDraftIds.size})</button>
          <button class="danger" id="draftDeleteSelected" ${state.selectedDraftIds.size === 0 ? 'disabled' : ''}>删除选中 (${state.selectedDraftIds.size})</button>
          <button class="ghost" id="draftClearErrors">清除失败标记</button>
        </div>
      </div>
    </div>
    <div class="panel">
      <h2>本地草稿列表</h2>
      <div class="list" id="draftList">
        ${drafts.length
          ? drafts.map(renderDraftCard).join('')
          : '<div class="empty">暂无草稿 — 在「巡测记录」页填写表单后点击「保存草稿」可离线暂存</div>'}
      </div>
    </div>
  </section>`;
}

function refreshDraftsView() {
  const el = $('#drafts');
  if (!el) return;
  el.outerHTML = renderDraftsView();
  updateDraftBadge();
}

function fillSurveyForm(draft) {
  const view = state.config.views.find((v) => v.id === 'surveys');
  if (!view) return;
  const form = document.querySelector(`[data-create="surveys"]`);
  if (!form) return;
  const d = draft.data;
  for (const field of view.fields) {
    if (field.type === 'photos') {
      const container = form.querySelector(`.photo-entries[data-field="${field.name}"]`);
      if (container) {
        container.innerHTML = '';
        const photos = Array.isArray(d[field.name]) ? d[field.name] : [];
        photos.forEach((photo, idx) => {
          const div = document.createElement('div');
          div.innerHTML = photoEntryHtml(field.name, photo).replace('照片 ' + field.name, `照片 ${idx + 1}`);
          container.appendChild(div.firstElementChild);
        });
      }
      continue;
    }
    if (field.type === 'multirelation') {
      const sel = form.querySelector(`select[name="${field.name}"]`);
      if (sel && Array.isArray(d[field.name])) {
        for (const opt of sel.options) opt.selected = d[field.name].includes(opt.value);
      }
      continue;
    }
    const input = form.querySelector(`[name="${field.name}"]`);
    if (!input) continue;
    if (input.tagName === 'SELECT') {
      input.value = d[field.name] ?? (field.options ? field.options[0] : '');
    } else {
      input.value = d[field.name] ?? (field.default ?? '');
    }
  }
  state.editingDraftId = draft.id;
  const submitBtn = form.querySelector('button[type="submit"]') || form.querySelector('button');
  submitBtn.textContent = '更新草稿并提交入库';
  let draftBtn = form.querySelector('[data-save-draft]');
  if (draftBtn) draftBtn.textContent = '更新草稿';
}

async function submitOneDraft(draft) {
  try {
    await api(`/api/${draft.collection}`, { method: 'POST', body: JSON.stringify(draft.data) });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function submitDrafts(ids) {
  const drafts = DraftStore.all().filter((d) => ids.includes(d.id));
  if (!drafts.length) return { success: 0, fail: 0 };
  const successIds = [];
  const failed = [];
  for (const draft of drafts) {
    const result = await submitOneDraft(draft);
    if (result.ok) {
      successIds.push(draft.id);
    } else {
      DraftStore.setError(draft.id, result.error);
      failed.push({ id: draft.id, title: draftTitle(draft), error: result.error });
    }
  }
  if (successIds.length) {
    DraftStore.removeMany(successIds);
    successIds.forEach((id) => state.selectedDraftIds.delete(id));
    await load();
  }
  return { success: successIds.length, fail: failed.length, failed };
}

async function generateDraftsForPlan(planId) {
  const plan = state.db.plans?.find((p) => p.id === planId);
  if (!plan) {
    toast('计划不存在');
    return;
  }
  const siteIds = plan.siteIds || [];
  if (!siteIds.length) {
    toast('该计划未关联样点');
    return;
  }
  const existingDrafts = DraftStore.findByPlanId(planId);
  if (plan.draftsGenerated || existingDrafts.length > 0) {
    toast(plan.draftsGenerated ? '该计划已生成过巡测草稿，禁止重复生成' : `该计划已生成 ${existingDrafts.length} 条草稿，禁止重复生成`);
    return;
  }
  const draftItems = [];
  const surveysView = state.config.views.find((v) => v.id === 'surveys');
  const defaults = surveysView?.defaults || {};
  for (const siteId of siteIds) {
    const site = state.db.sites?.find((s) => s.id === siteId);
    if (!site) continue;
    const data = {
      ...defaults,
      planId: plan.id,
      siteId: site.id,
      surveyor: plan.manager || '',
      date: plan.plannedDate || new Date().toISOString().slice(0, 10),
      temperature: site.baselineTemp ?? '',
      humidity: site.baselineHumidity ?? '',
      co2: site.baselineCo2 ?? '',
      dripRate: 0,
      disturbance: '',
      photos: [],
      note: plan.note ? `巡测计划：${plan.route}（${plan.plannedDate}）` : ''
    };
    draftItems.push({
      data,
      extra: { planId: plan.id }
    });
  }
  if (!draftItems.length) {
    toast('没有可生成草稿的样点');
    return;
  }
  await api(`/api/action/plan-generate-drafts/${plan.id}`, { method: 'POST' });
  plan.draftsGenerated = true;
  const created = DraftStore.addMany(draftItems);
  state.selectedDraftIds.clear();
  render();
  updateDraftBadge();
  toast(`已生成 ${created.length} 条巡测草稿，已保存到草稿箱`);
  setTimeout(() => {
    setTab('drafts');
  }, 300);
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${renderHighRiskSummary()}
    ${renderMicroclimateTrends()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderConfigView(view) {
  const rules = state.config.thresholdRules || {};
  const canUpdate = hasPermission('config:update');
  const fieldsHtml = view.thresholdFields.map((field) => {
    const value = valueByPath(rules, field.name);
    const required = field.required ? 'required' : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'number'}" name="${field.name}" value="${escapeHtml(value)}" ${required} ${!canUpdate ? 'disabled' : ''}></label>`;
  }).join('');
  return `<section class="view" id="${view.id}">
    <div class="grid single">
      <form class="panel ${!canUpdate ? 'form-disabled' : ''}" data-config-thresholds data-view="${view.id}" ${!canUpdate ? 'onsubmit="return false"' : ''}>
        <h2>${escapeHtml(view.formTitle)}${!canUpdate ? ' <span class="pill warn" title="无权限修改">无权限</span>' : ''}</h2>
        <p class="config-desc">设置各环境参数的预警和高风险偏差阈值。当巡测实测值与样点基准值的偏差达到对应阈值时，系统将自动判定风险等级。</p>
        <div class="form-grid">${fieldsHtml}</div>
        <div class="actions"><button type="submit" ${!canUpdate ? 'disabled title="无权限修改配置"' : ''}>${escapeHtml(view.submitLabel || '保存')}</button></div>
        ${!canUpdate ? '<p class="form-disabled-hint">您当前角色无权限修改阈值配置，请联系管理员。</p>' : ''}
      </form>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const filterOptions = view.filterField ? [...new Set((state.db[view.collection] || []).map((item) => item[view.filterField]).filter(Boolean))] : [];
  const typeFilterOptions = view.typeFilterOptions || (view.typeFilterField ? [...new Set((state.db[view.collection] || []).map((item) => item[view.typeFilterField]).filter(Boolean))] : []);
  const isSurveyView = view.collection === 'surveys';
  const isSitesView = view.collection === 'sites';
  const canCreate = canCreateCollection(view.collection);
  const draftActions = isSurveyView
    ? `<button type="button" class="ghost" data-save-draft ${!state.currentUser ? 'disabled title="请先登录"' : ''}>保存草稿（离线暂存）</button>`
    : '';
  const submitLabel = isSurveyView && state.editingDraftId ? '更新草稿并提交入库' : (view.submitLabel || '保存');
  const viewFilters = state.listFilters[view.id] || {};
  const presetStatus = viewFilters.status || '';
  const presetAutoRisk = viewFilters.autoRiskLevel || '';
  const presetImportedIds = viewFilters.importedIds || '';
  const hasSurveyExtraFilters = isSurveyView;
  const hasExtraFilters = view.filterField || view.typeFilterField || hasSurveyExtraFilters;
  const toolbarClass = hasExtraFilters ? 'toolbar toolbar-wide' : 'toolbar';
  const formDisabled = !canCreate;

  const activeFilterBadges = [];
  if (presetStatus) activeFilterBadges.push(`<span class="pill active-filter" data-clear-filter="status" data-view="${view.id}">状态: ${escapeHtml(presetStatus)} ✕</span>`);
  if (presetAutoRisk) activeFilterBadges.push(`<span class="pill active-filter ${presetAutoRisk === '高风险' ? 'bad' : (presetAutoRisk === '预警' ? 'warn' : 'ok')}" data-clear-filter="autoRiskLevel" data-view="${view.id}">风险等级: ${escapeHtml(presetAutoRisk)} ✕</span>`);
  if (presetImportedIds) activeFilterBadges.push(`<span class="pill active-filter" data-clear-filter="importedIds" data-view="${view.id}">本次导入记录 ✕</span>`);
  const activeFilterHtml = activeFilterBadges.length ? `<div class="active-filters-bar">筛选中：${activeFilterBadges.join('')}</div>` : '';

  const baselineHint = isSitesView && canCreate ? baselineImpactHint({ id: 'new' }) : '';

  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel ${formDisabled ? 'form-disabled' : ''}" data-create="${view.collection}" data-view="${view.id}" ${formDisabled ? 'onsubmit="return false"' : ''}>
        <h2>${escapeHtml(view.formTitle)}${isSurveyView && state.editingDraftId ? ' <span class="pill draft-pill">编辑草稿中</span>' : ''}${formDisabled ? ' <span class="pill warn" title="无权限创建">无权限</span>' : ''}</h2>
        ${baselineHint}
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions">
          <button type="submit" ${formDisabled ? 'disabled title="无权限创建此类型记录"' : ''}>${escapeHtml(submitLabel)}</button>
          ${draftActions}
        </div>
        ${formDisabled ? '<p class="form-disabled-hint">您当前角色无权限创建此类型记录，请联系管理员。</p>' : ''}
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)} <span class="muted-text">（已入库记录）</span></h2>
        <div class="${toolbarClass}">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}" value="${escapeHtml(viewFilters.search || '')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option ${option === presetStatus ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>
          ${view.filterField ? `<select id="filter-${view.id}">
            <option value="">全部${escapeHtml(view.filterLabel || view.filterField)}</option>
            ${filterOptions.map((option) => `<option ${option === (viewFilters[view.filterField] || '') ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>` : ''}
          ${view.typeFilterField ? `<select id="typeFilter-${view.id}">
            <option value="">全部${escapeHtml(view.typeFilterLabel || view.typeFilterField)}</option>
            ${typeFilterOptions.map((option) => `<option ${option === (viewFilters[view.typeFilterField] || '') ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}
          </select>` : ''}
          ${isSurveyView ? `<select id="autoRisk-${view.id}">
            <option value="">全部风险等级</option>
            <option value="正常" ${"正常" === presetAutoRisk ? 'selected' : ''}>正常</option>
            <option value="预警" ${"预警" === presetAutoRisk ? 'selected' : ''}>预警</option>
            <option value="高风险" ${"高风险" === presetAutoRisk ? 'selected' : ''}>高风险</option>
          </select>` : ''}
        </div>
        ${activeFilterHtml}
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function zoneStatusTone(zone) {
  if (zone.abnormal > 0) return 'bad';
  if (zone.suspended > 0) return 'warn';
  if (zone.keyProtection > 0) return 'warn';
  return 'ok';
}

function renderZoneLegend(view) {
  return `<div class="zone-legend">
    <span class="zone-legend-title">${escapeHtml(view.legendTitle || '状态说明')}：</span>
    <span class="zone-legend-item"><span class="zone-legend-dot ok"></span>正常</span>
    <span class="zone-legend-item"><span class="zone-legend-dot warn"></span>重点保护</span>
    <span class="zone-legend-item"><span class="zone-legend-dot suspended"></span>暂停开放</span>
    <span class="zone-legend-item"><span class="zone-legend-dot bad"></span>异常待复查</span>
  </div>`;
}

function renderZoneCard(zone, caveName) {
  const tone = zoneStatusTone(zone);
  const detailKey = `${caveName}||${zone.name}`;
  const isActive = state.activeZoneDetail === detailKey;
  return `<div class="zone-card ${tone}${isActive ? ' is-open' : ''}" data-zone="${escapeHtml(caveName)}" data-zone-name="${escapeHtml(zone.name)}" tabindex="0" role="button">
    <div class="zone-card-head">
      <div class="zone-card-title">
        <h3>${escapeHtml(zone.name)}</h3>
        ${zone.route ? `<span class="zone-route">${escapeHtml(zone.route)}</span>` : ''}
      </div>
      <div class="zone-card-count">
        <strong>${zone.siteCount}</strong>
        <span>样点</span>
      </div>
    </div>
    <div class="zone-status-grid">
      <div class="zone-status ok" title="正常">
        <span class="zone-status-num">${zone.normal}</span>
        <span class="zone-status-label">正常</span>
      </div>
      <div class="zone-status warn" title="重点保护">
        <span class="zone-status-num">${zone.keyProtection}</span>
        <span class="zone-status-label">重点保护</span>
      </div>
      <div class="zone-status suspended" title="暂停开放">
        <span class="zone-status-num">${zone.suspended}</span>
        <span class="zone-status-label">暂停开放</span>
      </div>
      <div class="zone-status bad" title="异常待复查">
        <span class="zone-status-num">${zone.abnormal}</span>
        <span class="zone-status-label">异常待复查</span>
      </div>
    </div>
    <div class="zone-card-foot">
      <span>最近巡测：${zone.lastSurveyAt ? fmtDate(zone.lastSurveyAt) : '暂无记录'}</span>
      <span class="zone-expand-icon">${isActive ? '收起 ▲' : '展开详情 ▼'}</span>
    </div>
    ${isActive ? renderZoneDetailBody(caveName, zone.name) : ''}
  </div>`;
}

function renderZoneDetailBody(caveName, zoneName) {
  const detail = state.zoneDetailCache?.[`${caveName}||${zoneName}`];
  if (!detail) {
    return `<div class="zone-detail-loading" data-zone-loading="${escapeHtml(caveName)}" data-zone-name-loading="${escapeHtml(zoneName)}">
      <div class="loading-spinner"></div>
      <span>正在加载分区详情…</span>
    </div>`;
  }
  return `<div class="zone-detail">
    <div class="zone-detail-section">
      <h4>分区样点（${detail.sites.length} 个）</h4>
      <div class="zone-detail-list">
        ${detail.sites.length ? detail.sites.map((site) => {
          const latest = getLatestSurveyForSite(site.id);
          const statusTone = toneFor(site.protectedStatus);
          return `<div class="zone-site-item">
            <div class="zone-site-head">
              <strong>${escapeHtml(site.pointCode)}</strong>
              ${site.protectedStatus ? pill(site.protectedStatus, statusTone) : ''}
            </div>
            <div class="meta">${escapeHtml(site.route || '-')} · 敏感等级：${escapeHtml(site.sensitivity || '-')}</div>
            ${site.note ? `<p class="zone-site-note">${escapeHtml(site.note)}</p>` : ''}
            ${latest ? `<div class="zone-site-latest">
              <span class="meta">最近巡测：${escapeHtml(latest.surveyor || '-')} / ${escapeHtml(latest.date || '-')}</span>
              <span class="zone-site-latest-meta">
                温度 ${Number(latest.temperature || 0).toFixed(1)}℃ ·
                湿度 ${Number(latest.humidity || 0).toFixed(0)}% ·
                CO2 ${Number(latest.co2 || 0).toFixed(0)}ppm
              </span>
              ${latest.status ? pill(latest.status, toneFor(latest.status)) : ''}
            </div>` : `<div class="meta">暂无巡测记录</div>`}
          </div>`;
        }).join('') : '<div class="empty" style="padding:12px">暂无样点</div>'}
      </div>
    </div>
    <div class="zone-detail-section">
      <h4>最近巡测记录（最近 ${detail.recentSurveys.length} 条）</h4>
      <div class="zone-detail-list">
        ${detail.recentSurveys.length ? detail.recentSurveys.map((survey) => {
          const site = state.db.sites?.find((s) => s.id === survey.siteId);
          const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : survey.siteId;
          return `<div class="zone-survey-item">
            <div class="zone-survey-head">
              <strong>${escapeHtml(siteLabel)}</strong>
              ${survey.status ? pill(survey.status, toneFor(survey.status)) : ''}
              ${survey.autoRiskLevel && survey.autoRiskLevel !== '正常' ? pill(survey.autoRiskLevel, survey.autoRiskLevel === '高风险' ? 'bad' : 'warn') : ''}
            </div>
            <div class="meta">${escapeHtml(survey.surveyor || '-')} · ${escapeHtml(survey.date || '-')} · 滴水 ${survey.dripRate || 0} 滴/分钟</div>
            <div class="detail">
              <div>温度<br><strong>${Number(survey.temperature || 0).toFixed(1)}℃</strong>${survey.deviationTemp !== undefined ? `<small>偏差 ${Number(survey.deviationTemp).toFixed(1)}℃</small>` : ''}</div>
              <div>湿度<br><strong>${Number(survey.humidity || 0).toFixed(0)}%</strong>${survey.deviationHumidity !== undefined ? `<small>偏差 ${Number(survey.deviationHumidity).toFixed(0)}%</small>` : ''}</div>
              <div>CO2<br><strong>${Number(survey.co2 || 0).toFixed(0)}ppm</strong>${survey.deviationCo2 !== undefined ? `<small>偏差 ${Number(survey.deviationCo2).toFixed(0)}ppm</small>` : ''}</div>
            </div>
            ${survey.disturbance ? `<p><strong>干扰痕迹：</strong>${escapeHtml(survey.disturbance)}</p>` : ''}
            ${autoRiskHtml(survey)}
          </div>`;
        }).join('') : '<div class="empty" style="padding:12px">暂无巡测记录</div>'}
      </div>
    </div>
  </div>`;
}

function getLatestSurveyForSite(siteId) {
  const surveys = (state.db.surveys || []).filter((s) => s.siteId === siteId);
  if (!surveys.length) return null;
  return surveys.sort((a, b) => new Date(b.createdAt || b.date || 0) - new Date(a.createdAt || a.date || 0))[0];
}

function renderImportView(view) {
  const csvText = state.importCsvText || '';
  const previewData = state.importPreviewData;
  const resultData = state.importResultData;
  const hasPreview = previewData && previewData.preview && previewData.preview.length > 0;
  const hasResult = resultData !== null;

  let previewHtml = '';
  if (hasPreview && !hasResult) {
    const statsHtml = `
      <div class="import-stat"><span>总计</span><strong>${previewData.total}</strong></div>
      <div class="import-stat ok"><span>有效</span><strong>${previewData.valid}</strong></div>
      <div class="import-stat bad"><span>无效</span><strong>${previewData.invalid}</strong></div>
      ${previewData.missingRequired && previewData.missingRequired.length ? `<div class="import-stat warn"><span>缺少必填列</span><strong>${previewData.missingRequired.join('、')}</strong></div>` : ''}
    `;
    const rowsHtml = previewData.preview.map((row) => {
      const statusCell = row.isValid
        ? `<span class="pill ok">有效</span>`
        : `<span class="pill bad" title="${escapeHtml(row.errors.join('；'))}">${row.errors.length} 项错误</span>`;
      const rowClass = row.isValid ? '' : ' import-row-error';
      const errorTooltip = row.isValid ? '' : `<div class="import-error-tip">${row.errors.map((e) => `<span>• ${escapeHtml(e)}</span>`).join('')}</div>`;
      return `<tr class="${rowClass}">
        <td>${row.lineNumber}</td>
        <td class="import-pointcode">${escapeHtml(row.pointCode)}</td>
        <td class="import-sitelabel">${escapeHtml(row.siteLabel || '-')}</td>
        <td>${escapeHtml(row.temperature)}</td>
        <td>${escapeHtml(row.humidity)}</td>
        <td>${escapeHtml(row.co2)}</td>
        <td>${escapeHtml(row.dripRate)}</td>
        <td>${escapeHtml(row.surveyor || '-')}</td>
        <td>${escapeHtml(row.date || '-')}</td>
        <td>${statusCell}${errorTooltip}</td>
      </tr>`;
    }).join('');
    previewHtml = `
      <div class="import-preview-area">
        <div class="import-stats">${statsHtml}</div>
        <div class="import-preview-table-wrap">
          <table class="import-preview-table">
            <thead>
              <tr>
                <th>行号</th>
                <th>样点编号</th>
                <th>样点信息</th>
                <th>温度(℃)</th>
                <th>湿度(%)</th>
                <th>CO2(ppm)</th>
                <th>滴水频率</th>
                <th>巡测人员</th>
                <th>日期</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  let resultHtml = '';
  if (hasResult) {
    const resultCardHtml = `
      <div class="import-result-card">
        <div class="import-result-title">导入完成</div>
        <div class="import-result-stats">
          <div class="import-stat"><span>总计</span><strong>${resultData.total}</strong></div>
          <div class="import-stat ok"><span>成功</span><strong>${resultData.success}</strong></div>
          <div class="import-stat bad"><span>失败</span><strong>${resultData.failed}</strong></div>
        </div>
        ${resultData.riskSummary ? `
          <div class="import-risk-summary">
            <div class="import-risk-summary-title">风险结果摘要</div>
            <div class="import-risk-summary-stats">
              <div class="import-stat risk-stat ok"><span>正常</span><strong>${resultData.riskSummary.normal}</strong></div>
              <div class="import-stat risk-stat warn"><span>预警</span><strong>${resultData.riskSummary.warning}</strong></div>
              <div class="import-stat risk-stat bad"><span>高风险</span><strong>${resultData.riskSummary.highRisk}</strong></div>
            </div>
          </div>
        ` : ''}
      </div>
    `;
    let riskGroupsHtml = '';
    if (resultData.riskGroups) {
      const groupConfigs = [
        { key: 'normal', tone: 'ok' },
        { key: 'warning', tone: 'warn' },
        { key: 'highRisk', tone: 'bad' }
      ];
      const groupCardsHtml = groupConfigs.map((cfg) => {
        const group = resultData.riskGroups[cfg.key];
        if (!group || group.count === 0) return '';
        const itemsHtml = group.items.slice(0, 20).map((item) => `
          <div class="import-risk-group-item">
            <span class="import-risk-line">第${item.lineNumber}行</span>
            <span class="import-risk-pointcode">${escapeHtml(item.pointCode)}</span>
            <span class="pill ${cfg.tone}">${escapeHtml(group.label)}</span>
          </div>
        `).join('');
        const moreHtml = group.count > 20 ? `<div class="import-risk-group-more">...还有 ${group.count - 20} 条，点击下方按钮查看全部</div>` : '';
        return `
          <div class="import-risk-group-card ${cfg.tone}">
            <div class="import-risk-group-head">
              <span class="pill ${cfg.tone}">${escapeHtml(group.label)}</span>
              <span class="import-risk-group-count">共 ${group.count} 条</span>
              <button class="ghost small" data-jump-surveys="autoRiskLevel:${cfg.key === 'highRisk' ? '高风险' : (cfg.key === 'warning' ? '预警' : '正常')}">查看全部 →</button>
            </div>
            <div class="import-risk-group-items">
              ${itemsHtml}
              ${moreHtml}
            </div>
          </div>
        `;
      }).join('');
      const jumpAllBtn = resultData.importedIds && resultData.importedIds.length ? `
        <div class="import-risk-jump-all">
          <button data-jump-surveys="importedIds:${resultData.importedIds.join(',')}" class="secondary">查看本次导入的全部巡测记录 →</button>
        </div>
      ` : '';
      riskGroupsHtml = `
        <div id="importRiskGroups">
          <h3>成功记录按风险分组</h3>
          <div class="import-risk-groups-grid">
            ${groupCardsHtml}
          </div>
          ${jumpAllBtn}
        </div>
      `;
    }
    let failedHtml = '';
    if (resultData.failed > 0 && resultData.failedItems) {
      const failedItemsHtml = resultData.failedItems.map((item) => `
        <div class="import-failed-item">
          <div class="import-failed-head">
            <span class="import-failed-line">第 ${item.lineNumber} 行</span>
            <span class="import-failed-point">${escapeHtml(item.pointCode || '无样点')}</span>
          </div>
          <div class="import-failed-errors">
            ${item.errors.map((e) => `<span class="pill bad">${escapeHtml(e)}</span>`).join('')}
          </div>
        </div>
      `).join('');
      failedHtml = `
        <div id="importFailedList">
          <h3>失败明细</h3>
          <div>${failedItemsHtml}</div>
        </div>
      `;
    }
    resultHtml = `
      <div class="import-result-area">
        <div class="import-result-summary">${resultCardHtml}</div>
        ${riskGroupsHtml}
        ${failedHtml}
      </div>
    `;
  }

  const canImport = hasPermission('import:surveys');
  const submitDisabled = !previewData || previewData.valid === 0 || !canImport;

  return `<section class="view" id="${view.id}">
    <div class="grid single">
      <div class="panel import-panel ${!canImport ? 'form-disabled' : ''}">
        <h2>${escapeHtml(view.formTitle)}${!canImport ? ' <span class="pill warn" title="无权限导入">无权限</span>' : ''}</h2>
        <p class="config-desc">将传感器导出的 CSV 数据粘贴到下方文本框，系统将自动解析并校验样点编号和数据格式。校验通过后可批量写入巡测记录。</p>
        <div class="import-format-hint">
          <strong>CSV格式说明：</strong>
          <span>支持的列名（中英文均可）：样点编号、温度、湿度、CO2、滴水频率、巡测人员、日期、干扰痕迹</span>
          <span>必填列：样点编号、温度、湿度、CO2、滴水频率</span>
        </div>
        <label class="wide">
          CSV 文本
          <textarea id="importCsvText" placeholder="样点编号,温度,湿度,CO2,滴水频率,巡测人员,日期
D-07,17.2,88,720,12,沈宁,2026-06-20
A-01,18.0,85,560,0,李明,2026-06-20
C-03,16.5,93,760,8,王芳,2026-06-20">${escapeHtml(csvText)}</textarea>
        </label>
        <div class="actions import-actions">
          <button id="importPreviewBtn" class="secondary">预览解析结果</button>
          <button id="importSubmitBtn" ${submitDisabled ? 'disabled' : ''}>确认导入</button>
          <button id="importClearBtn" class="ghost">清空</button>
        </div>
        ${previewHtml}
        ${resultHtml}
      </div>
    </div>
  </section>`;
}

function renderZonemapView(view) {
  const caves = state.zoneOverview?.caves || [];
  if (!state.zoneDetailCache) state.zoneDetailCache = {};
  return `<section class="view" id="${view.id}">
    <div class="panel zonemap-panel">
      <h2>${escapeHtml(view.title || '洞穴分区态势图')}</h2>
      ${renderZoneLegend(view)}
      <div class="caves-container">
        ${caves.length ? caves.map((cave) => `
          <div class="cave-block">
            <div class="cave-block-head">
              <h3>${escapeHtml(cave.name)}</h3>
              <span class="cave-block-meta">共 ${cave.zones.reduce((s, z) => s + z.siteCount, 0)} 样点 · ${cave.zones.length} 分区</span>
            </div>
            <div class="zones-grid">
              ${cave.zones.map((zone) => renderZoneCard(zone, cave.name)).join('')}
            </div>
          </div>
        `).join('') : '<div class="empty">暂无洞穴分区数据</div>'}
      </div>
    </div>
  </section>`;
}

async function loadZoneDetail(caveName, zoneName) {
  const key = `${caveName}||${zoneName}`;
  if (state.zoneDetailCache?.[key]) return state.zoneDetailCache[key];
  const detail = await api(`/api/zone-detail/${encodeURIComponent(caveName)}/${encodeURIComponent(zoneName)}`);
  if (!state.zoneDetailCache) state.zoneDetailCache = {};
  state.zoneDetailCache[key] = detail;
  return detail;
}

function renderHeaderUser() {
  const el = $('#userInfo');
  if (!el) return;
  if (state.currentUser) {
    el.innerHTML = `
      <div class="user-info-inner">
        <span class="user-name">${escapeHtml(state.currentUser.name)}</span>
        <span class="user-role pill">${escapeHtml(state.currentUser.roleLabel)}</span>
        <button class="ghost" id="logoutBtn">退出</button>
      </div>
    `;
  } else {
    el.innerHTML = `
      <div class="user-info-inner">
        <span class="user-guest">未登录</span>
        <button id="loginBtn">登录</button>
      </div>
    `;
  }
}

function openLoginModal() {
  $('#loginModal').classList.add('show');
  const form = $('#loginForm');
  if (form) form.reset();
}

function closeLoginModal() {
  $('#loginModal').classList.remove('show');
}

async function doLogin(username, password) {
  try {
    const result = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    state.currentUser = result.user;
    state.authToken = result.token;
    localStorage.setItem(TOKEN_STORAGE_KEY, result.token);
    renderHeaderUser();
    await load();
    closeLoginModal();
    toast(`登录成功，欢迎 ${result.user.name}`);
    return true;
  } catch (err) {
    toast(err.message);
    return false;
  }
}

async function doLogout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch (e) {
    // 忽略退出时的错误
  }
  state.currentUser = null;
  state.authToken = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  render();
  toast('已退出登录');
}

async function loadCurrentUser() {
  const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!savedToken) return null;
  state.authToken = savedToken;
  try {
    const user = await api('/api/auth/me');
    if (user) {
      state.currentUser = user;
      renderHeaderUser();
      return user;
    }
  } catch (e) {
    // token 无效，清除
  }
  state.authToken = null;
  state.currentUser = null;
  localStorage.removeItem(TOKEN_STORAGE_KEY);
  renderHeaderUser();
  return null;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  renderHeaderUser();
  const viewsHtml = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'config') return renderConfigView(view);
    if (view.type === 'zonemap') return renderZonemapView(view);
    if (view.type === 'import') return renderImportView(view);
    return renderCrudView(view);
  }).join('');
  $('#main').innerHTML = viewsHtml + renderDraftsView();
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, overview, trends] = await Promise.all([
    api('/api/db'),
    api('/api/zone-overview'),
    api('/api/microclimate-trends')
  ]);
  state.db = db;
  state.zoneOverview = overview;
  state.microclimateTrends = trends;
  render();
}

async function toggleZoneDetail(cardEl) {
  const caveName = cardEl.dataset.zone;
  const zoneName = cardEl.dataset.zoneName;
  const key = `${caveName}||${zoneName}`;
  const isOpen = cardEl.classList.contains('is-open');
  if (isOpen) {
    state.activeZoneDetail = null;
    cardEl.classList.remove('is-open');
    const existingDetail = cardEl.querySelector(':scope > .zone-detail, :scope > .zone-detail-loading');
    if (existingDetail) existingDetail.remove();
    const icon = cardEl.querySelector('.zone-expand-icon');
    if (icon) icon.textContent = '展开详情 ▼';
  } else {
    state.activeZoneDetail = key;
    cardEl.classList.add('is-open');
    const icon = cardEl.querySelector('.zone-expand-icon');
    if (icon) icon.textContent = '收起 ▲';
    try {
      await loadZoneDetail(caveName, zoneName);
    } catch (err) {
      toast(`加载分区详情失败：${err.message}`);
      state.activeZoneDetail = null;
      cardEl.classList.remove('is-open');
      if (icon) icon.textContent = '展开详情 ▼';
      return;
    }
    const loadingEl = cardEl.querySelector(':scope > .zone-detail-loading');
    if (loadingEl) loadingEl.remove();
    if (!cardEl.querySelector(':scope > .zone-detail')) {
      cardEl.insertAdjacentHTML('beforeend', renderZoneDetailBody(caveName, zoneName));
    }
  }
}

async function previewImport() {
  const csvText = $('#importCsvText')?.value.trim();
  if (!csvText) {
    toast('请先粘贴 CSV 文本');
    return;
  }
  state.importCsvText = csvText;
  try {
    const result = await api('/api/surveys/import/preview', { method: 'POST', body: JSON.stringify({ csvText }) });
    state.importPreviewData = result;
    state.importResultData = null;
    render();
    setTab('import');
  } catch (err) {
    toast(err.message);
  }
}

async function submitImport() {
  const csvText = state.importCsvText;
  if (!csvText) {
    toast('请先粘贴 CSV 文本');
    return;
  }
  try {
    const result = await api('/api/surveys/import', { method: 'POST', body: JSON.stringify({ csvText }) });
    state.importResultData = result;
    state.importPreviewData = null;
    await load();
    if (result.failed === 0) {
      toast(`全部导入成功（${result.success} 条）`);
    } else if (result.success === 0) {
      toast(`全部导入失败（${result.failed} 条）`);
    } else {
      toast(`部分成功：${result.success} 条，失败 ${result.failed} 条`);
    }
  } catch (err) {
    toast(err.message);
  }
}

function clearImport() {
  state.importCsvText = '';
  state.importPreviewData = null;
  state.importResultData = null;
  render();
  setTab('import');
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const planGenerateDraftsBtn = event.target.closest('[data-plan-generate-drafts]');
  const addPhotoBtn = event.target.closest('.add-photo-btn');
  const removePhotoBtn = event.target.closest('.remove-photo-btn');
  const viewPhotosBtn = event.target.closest('[data-view-photos]');
  const closeModal = event.target.closest('[data-close-modal]');
  const closeAudit = event.target.closest('[data-close-audit]');
  const closeDiff = event.target.closest('[data-close-diff]');
  const closeSiteEdit = event.target.closest('[data-close-site-edit]');
  const closeRiskRecalc = event.target.closest('[data-close-risk-recalc]');
  const auditHistoryBtn = event.target.closest('[data-audit-history]');
  const viewDiffBtn = event.target.closest('[data-view-diff]');
  const rollbackBtn = event.target.closest('[data-rollback]');
  const saveDraftBtn = event.target.closest('[data-save-draft]');
  const draftEditBtn = event.target.closest('[data-draft-edit]');
  const draftSubmitBtn = event.target.closest('[data-draft-submit]');
  const draftDeleteBtn = event.target.closest('[data-draft-delete]');
  const checkAll = event.target.closest('#draftCheckAll');
  const submitSelBtn = event.target.closest('#draftSubmitSelected');
  const deleteSelBtn = event.target.closest('#draftDeleteSelected');
  const clearErrBtn = event.target.closest('#draftClearErrors');
  const zoneCard = event.target.closest('.zone-card');
  const importPreviewBtn = event.target.closest('#importPreviewBtn');
  const importSubmitBtn = event.target.closest('#importSubmitBtn');
  const importClearBtn = event.target.closest('#importClearBtn');
  const editSiteBtn = event.target.closest('[data-edit-site]');
  const doRecalcBtn = event.target.closest('#doRecalcRisksBtn');
  if (tab) setTab(tab.dataset.tab);
  if (zoneCard && !event.target.closest('.zone-detail') && !event.target.closest('.zone-detail-loading')) {
    event.preventDefault();
    await toggleZoneDetail(zoneCard);
    return;
  }
  if (planGenerateDraftsBtn) {
    const planId = planGenerateDraftsBtn.dataset.planGenerateDrafts;
    await generateDraftsForPlan(planId);
    return;
  }
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (addPhotoBtn) {
    addPhotoEntry(addPhotoBtn);
  }
  if (removePhotoBtn) {
    const entry = removePhotoBtn.closest('.photo-entry');
    const container = entry.parentElement;
    entry.remove();
    updatePhotoIndices(container);
  }
  if (viewPhotosBtn) {
    renderPhotoModal(viewPhotosBtn.dataset.viewPhotos);
  }
  if (closeModal) {
    closePhotoModal();
  }
  if (closeAudit) {
    closeAuditModal();
  }
  if (closeDiff) {
    closeDiffModal();
  }
  if (closeSiteEdit) {
    closeSiteEditModal();
  }
  if (closeRiskRecalc) {
    closeRiskRecalcModal();
  }
  if (editSiteBtn) {
    openSiteEditModal(editSiteBtn.dataset.editSite);
    return;
  }
  if (doRecalcBtn) {
    await doRecalculateRisks(doRecalcBtn.dataset.siteId);
    return;
  }
  if (auditHistoryBtn) {
    const [collection, id] = auditHistoryBtn.dataset.auditHistory.split(':');
    const title = auditHistoryBtn.dataset.auditTitle || id;
    await openAuditModal(collection, id, title);
  }
  if (viewDiffBtn) {
    openDiffModal(viewDiffBtn.dataset.viewDiff);
  }
  if (rollbackBtn) {
    const logId = rollbackBtn.dataset.rollback;
    const note = rollbackBtn.dataset.rollbackNote || '';
    if (confirm(note || '确认将记录恢复到本次操作完成后的状态？')) {
      await rollbackToLog(logId);
    }
  }
  if (saveDraftBtn) {
    const form = saveDraftBtn.closest('[data-create]');
    const view = state.config.views.find((entry) => entry.id === form.dataset.view);
    const payload = values(form, view);
    if (state.editingDraftId) {
      DraftStore.update(state.editingDraftId, payload);
      toast('草稿已更新');
    } else {
      DraftStore.add(payload);
      toast('草稿已保存到本地');
    }
    state.selectedDraftIds.clear();
    render();
  }
  if (draftEditBtn) {
    const id = draftEditBtn.dataset.draftEdit;
    const draft = DraftStore.get(id);
    if (!draft) { toast('草稿不存在'); return; }
    state.selectedDraftIds.clear();
    setTab('surveys');
    const viewEl = $('#surveys');
    if (!viewEl || !viewEl.classList.contains('active')) render();
    setTimeout(() => {
      fillSurveyForm(draft);
      toast('已载入草稿，可继续编辑');
    }, 50);
  }
  if (draftSubmitBtn) {
    const id = draftSubmitBtn.dataset.draftSubmit;
    const draft = DraftStore.get(id);
    if (!draft) { toast('草稿不存在'); return; }
    draftSubmitBtn.disabled = true;
    const result = await submitDrafts([id]);
    refreshDraftsView();
    if (result.fail > 0) {
      toast(`提交失败：${result.failed[0].error}`);
    } else {
      toast('已提交入库');
    }
  }
  if (draftDeleteBtn) {
    const id = draftDeleteBtn.dataset.draftDelete;
    if (!confirm('确定要删除该草稿吗？')) return;
    DraftStore.remove(id);
    state.selectedDraftIds.delete(id);
    refreshDraftsView();
    toast('已删除草稿');
  }
  if (checkAll) {
    const drafts = DraftStore.all();
    if (checkAll.checked) {
      drafts.forEach((d) => state.selectedDraftIds.add(d.id));
    } else {
      state.selectedDraftIds.clear();
    }
    refreshDraftsView();
  }
  if (submitSelBtn) {
    const ids = [...state.selectedDraftIds];
    if (!ids.length) return;
    submitSelBtn.disabled = true;
    const result = await submitDrafts(ids);
    refreshDraftsView();
    if (result.fail === 0) {
      toast(`全部提交成功（${result.success} 条）`);
    } else if (result.success === 0) {
      toast(`全部提交失败（${result.fail} 条），失败原因已标注`);
    } else {
      toast(`部分成功：${result.success} 条入库，${result.fail} 条失败（已保留）`);
    }
  }
  if (deleteSelBtn) {
    const ids = [...state.selectedDraftIds];
    if (!ids.length) return;
    if (!confirm(`确定要删除选中的 ${ids.length} 条草稿吗？`)) return;
    DraftStore.removeMany(ids);
    state.selectedDraftIds.clear();
    refreshDraftsView();
    toast('已删除选中草稿');
  }
  if (clearErrBtn) {
    DraftStore.clearErrors();
    refreshDraftsView();
    toast('已清除失败标记');
  }
  if (importPreviewBtn) {
    await previewImport();
  }
  if (importSubmitBtn) {
    await submitImport();
  }
  if (importClearBtn) {
    clearImport();
  }
  const jumpSurveysBtn = event.target.closest('[data-jump-surveys]');
  if (jumpSurveysBtn) {
    const filterSpec = jumpSurveysBtn.dataset.jumpSurveys;
    const colonIdx = filterSpec.indexOf(':');
    const filterKey = filterSpec.slice(0, colonIdx);
    const filterValue = filterSpec.slice(colonIdx + 1);
    state.listFilters.surveys = { ...(state.listFilters.surveys || {}) };
    for (const k of ['status', 'autoRiskLevel', 'importedIds', 'search']) {
      delete state.listFilters.surveys[k];
    }
    state.listFilters.surveys[filterKey] = filterValue;
    render();
    setTab('surveys');
    return;
  }
  const clearFilterBtn = event.target.closest('[data-clear-filter]');
  if (clearFilterBtn) {
    const viewId = clearFilterBtn.dataset.view;
    const filterKey = clearFilterBtn.dataset.clearFilter;
    if (state.listFilters[viewId]) {
      delete state.listFilters[viewId][filterKey];
    }
    render();
    setTab(viewId);
    return;
  }
});

function syncFilterFromDom(view) {
  if (!view || !view.id) return;
  state.listFilters[view.id] = state.listFilters[view.id] || {};
  const filters = state.listFilters[view.id];
  const searchEl = $(`#search-${view.id}`);
  if (searchEl) filters.search = searchEl.value.trim();
  const statusEl = $(`#status-${view.id}`);
  if (statusEl) filters.status = statusEl.value || '';
  if (view.filterField) {
    const filterEl = $(`#filter-${view.id}`);
    if (filterEl) filters[view.filterField] = filterEl.value || '';
  }
  if (view.typeFilterField) {
    const typeFilterEl = $(`#typeFilter-${view.id}`);
    if (typeFilterEl) filters[view.typeFilterField] = typeFilterEl.value || '';
  }
  if (view.collection === 'surveys') {
    const autoRiskEl = $(`#autoRisk-${view.id}`);
    if (autoRiskEl) filters.autoRiskLevel = autoRiskEl.value || '';
  }
}

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}` || event.target.id === `filter-${entry.id}` || event.target.id === `autoRisk-${entry.id}`));
  if (view) {
    syncFilterFromDom(view);
    $(`#list-${view.id}`).innerHTML = renderList(view);
  }
});

document.addEventListener('change', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `status-${entry.id}` || event.target.id === `filter-${entry.id}` || event.target.id === `typeFilter-${entry.id}` || event.target.id === `autoRisk-${entry.id}`));
  if (view) {
    syncFilterFromDom(view);
    $(`#list-${view.id}`).innerHTML = renderList(view);
  }
  const draftCheck = event.target.closest('[data-draft-check]');
  if (draftCheck) {
    const id = draftCheck.dataset.draftCheck;
    if (draftCheck.checked) state.selectedDraftIds.add(id); else state.selectedDraftIds.delete(id);
    refreshDraftsView();
  }
});

document.addEventListener('submit', async (event) => {
  const createForm = event.target.closest('[data-create]');
  const configForm = event.target.closest('[data-config-thresholds]');
  const siteEditForm = event.target.closest('#siteEditForm');
  
  if (createForm) {
    event.preventDefault();
    const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
    const payload = values(createForm, view);
    const editingId = state.editingDraftId;
    try {
      const result = await api(`/api/${createForm.dataset.create}`, { method: 'POST', body: JSON.stringify(payload) });
      if (editingId) {
        DraftStore.remove(editingId);
        state.editingDraftId = null;
      }
      createForm.reset();
      state.selectedDraftIds.clear();
      await load();
      if (result && result.autoRiskLevel && result.autoRiskLevel !== '正常') {
        toast(`自动判定：${result.autoRiskLevel} - ${(result.autoRiskReasons || []).join('；')}`);
      } else {
        toast('已保存');
      }
    } catch (err) {
      if (editingId) {
        DraftStore.setError(editingId, err.message);
        toast(`提交失败，已保存到草稿：${err.message}`);
      } else {
        toast(err.message);
      }
    }
  }
  
  if (configForm) {
    event.preventDefault();
    const formData = new FormData(configForm);
    const payload = {};
    for (const [key, value] of formData.entries()) {
      setValueByPath(payload, key, Number(value));
    }
    try {
      const result = await api('/api/config/thresholdRules', { method: 'PATCH', body: JSON.stringify(payload) });
      state.config.thresholdRules = result;
      render();
      toast('阈值规则已保存');
    } catch (error) {
      toast(error.message);
    }
  }

  if (siteEditForm) {
    event.preventDefault();
    const siteId = siteEditForm.dataset.siteId;
    const formData = new FormData(siteEditForm);
    const payload = {};
    for (const [key, value] of formData.entries()) {
      payload[key] = value;
    }
    const sitesView = state.config.views.find((v) => v.id === 'sites');
    if (sitesView) {
      for (const field of sitesView.fields) {
        if (field.type === 'number' && payload[field.name] !== undefined) {
          payload[field.name] = Number(payload[field.name]);
        }
      }
    }
    try {
      const result = await api(`/api/sites/${siteId}`, { method: 'PATCH', body: JSON.stringify(payload) });
      await load();
      closeSiteEditModal();
      if (result && result.baselineChanged) {
        toast('样点已保存，基准值已变更');
        openRiskRecalcModal(result);
      } else {
        toast('样点已保存');
      }
    } catch (err) {
      toast(err.message);
    }
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

document.addEventListener('click', (e) => {
  if (e.target.id === 'loginBtn' || e.target.closest('#loginBtn')) {
    openLoginModal();
  }
  if (e.target.id === 'logoutBtn' || e.target.closest('#logoutBtn')) {
    doLogout();
  }
  if (e.target.hasAttribute('data-close-login') || e.target.closest('[data-close-login]')) {
    closeLoginModal();
  }
});

$('#loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const username = form.username.value.trim();
  const password = form.password.value;
  if (username && password) {
    await doLogin(username, password);
  }
});

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape') {
    closePhotoModal();
    closeAuditModal();
    closeDiffModal();
    closeLoginModal();
    closeSiteEditModal();
    closeRiskRecalcModal();
  }
  const zoneCard = event.target.closest('.zone-card');
  if (zoneCard && (event.key === 'Enter' || event.key === ' ')) {
    if (!event.target.closest('.zone-detail') && !event.target.closest('.zone-detail-loading')) {
      event.preventDefault();
      await toggleZoneDetail(zoneCard);
    }
  }
});

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await loadCurrentUser();
  await load();
}

boot().catch((error) => toast(error.message));
