const state = {
  config: null,
  db: {},
  activeTab: ''
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
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || '请求失败');
  }
  if (res.status === 204) return null;
  return res.json();
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

function photosBadgeHtml(item) {
  const photos = item.photos || [];
  if (!photos.length) return '';
  return `<button class="photos-badge" data-view-photos="${item.id}">
    <span class="photos-icon">📷</span>
    <span>${photos.length} 张照片</span>
  </button>`;
}

function renderPhotoModal(surveyId) {
  const survey = state.db.surveys?.find((s) => s.id === surveyId);
  if (!survey || !survey.photos?.length) return;
  const site = state.db.sites?.find((s) => s.id === survey.siteId);
  const siteLabel = site ? `${site.cave} / ${site.zone} / ${site.pointCode}` : '';
  $('#photoModalTitle').textContent = `照片证据 - ${survey.surveyor} / ${survey.date}`;
  $('#photoModalBody').innerHTML = survey.photos.map((photo, index) => `
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
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
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
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3><div class="card-head-right">${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}${photosBadgeHtml(item)}</div></div>
    ${relation}
    ${siteListHtml}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${autoRiskHtml(item)}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions ? `<div class="actions">${actions}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  const filterValue = view.filterField ? ($(`#filter-${view.id}`)?.value || '') : '';
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

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${renderHighRiskSummary()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderConfigView(view) {
  const rules = state.config.thresholdRules || {};
  const fieldsHtml = view.thresholdFields.map((field) => {
    const value = valueByPath(rules, field.name);
    const required = field.required ? 'required' : '';
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'number'}" name="${field.name}" value="${escapeHtml(value)}" ${required}></label>`;
  }).join('');
  return `<section class="view" id="${view.id}">
    <div class="grid single">
      <form class="panel" data-config-thresholds data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <p class="config-desc">设置各环境参数的预警和高风险偏差阈值。当巡测实测值与样点基准值的偏差达到对应阈值时，系统将自动判定风险等级。</p>
        <div class="form-grid">${fieldsHtml}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
    </div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  const filterOptions = view.filterField ? [...new Set((state.db[view.collection] || []).map((item) => item[view.filterField]).filter(Boolean))] : [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
          ${view.filterField ? `<select id="filter-${view.id}">
            <option value="">全部${escapeHtml(view.filterLabel || view.filterField)}</option>
            ${filterOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>` : ''}
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views.map((view) => {
    if (view.type === 'dashboard') return renderDashboardView(view);
    if (view.type === 'config') return renderConfigView(view);
    return renderCrudView(view);
  }).join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const addPhotoBtn = event.target.closest('.add-photo-btn');
  const removePhotoBtn = event.target.closest('.remove-photo-btn');
  const viewPhotosBtn = event.target.closest('[data-view-photos]');
  const closeModal = event.target.closest('[data-close-modal]');
  if (tab) setTab(tab.dataset.tab);
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
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}` || event.target.id === `filter-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('change', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `status-${entry.id}` || event.target.id === `filter-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const createForm = event.target.closest('[data-create]');
  const configForm = event.target.closest('[data-config-thresholds]');
  
  if (createForm) {
    event.preventDefault();
    const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
    const result = await api(`/api/${createForm.dataset.create}`, { method: 'POST', body: JSON.stringify(values(createForm, view)) });
    createForm.reset();
    await load();
    if (result && result.autoRiskLevel && result.autoRiskLevel !== '正常') {
      toast(`自动判定：${result.autoRiskLevel} - ${(result.autoRiskReasons || []).join('；')}`);
    } else {
      toast('已保存');
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
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePhotoModal();
  }
});

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
