module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴、分区、样点和巡测路线记录微环境数据，发现异常后生成复查闭环。',
  roles: {
    admin: {
      label: '洞穴管理员',
      permissions: [
        'sites:create',
        'sites:update',
        'sites:delete',
        'sites:suspend',
        'surveys:create',
        'surveys:update',
        'surveys:delete',
        'surveys:markAbnormal',
        'surveys:review',
        'plans:create',
        'plans:update',
        'plans:delete',
        'plans:complete',
        'plans:generateDrafts',
        'reviews:create',
        'reviews:update',
        'reviews:delete',
        'reviews:complete',
        'incidents:create',
        'incidents:update',
        'incidents:delete',
        'incidents:process',
        'incidents:suspendSite',
        'import:surveys',
        'config:update',
        'audit:view',
        'audit:rollback'
      ]
    },
    surveyor: {
      label: '巡测员',
      permissions: [
        'surveys:create',
        'surveys:update',
        'surveys:markAbnormal',
        'plans:view',
        'plans:generateDrafts',
        'incidents:create',
        'import:surveys',
        'audit:view'
      ]
    },
    reviewer: {
      label: '审核员',
      permissions: [
        'surveys:view',
        'surveys:review',
        'reviews:create',
        'reviews:update',
        'reviews:complete',
        'incidents:view',
        'audit:view'
      ]
    }
  },
  zoneLayout: {
    '北麓三号洞': {
      order: 1,
      zones: [
        { name: '入口大厅区', order: 1, route: '东线巡测' },
        { name: '滴水帘区', order: 2, route: '西线巡测' },
        { name: '水晶花厅', order: 3, route: '中线巡测' },
        { name: '深部廊道', order: 4, route: '西线巡测' }
      ]
    },
    '南麓一号洞': {
      order: 2,
      zones: [
        { name: '前厅缓冲区', order: 1, route: '东线巡测' },
        { name: '石笋森林区', order: 2, route: '东线巡测' },
        { name: '地下湖边', order: 3, route: '中线巡测' }
      ]
    },
    '西麓二号洞': {
      order: 3,
      zones: [
        { name: '洞口过渡带', order: 1, route: '西线巡测' },
        { name: '流石坝区', order: 2, route: '中线巡测' }
      ]
    }
  },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已完成': 'ok',
    '已处理': 'ok',
    '已关闭': 'ok',
    '待执行': 'warn',
    '待处理': 'warn',
    '处理中': 'warn',
    '重点保护': 'warn',
    '预警': 'warn',
    '一般': 'warn',
    '异常待复查': 'bad',
    '高风险': 'bad',
    '严重': 'bad',
    '紧急': 'bad',
    '暂停开放': 'bad'
  },
  thresholdRules: {
    temperature: { warning: 2, critical: 4 },
    humidity: { warning: 10, critical: 20 },
    co2: { warning: 200, critical: 400 }
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    plans: { label: '巡测计划' },
    reviews: { label: '复查任务' },
    incidents: { label: '干扰事件' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '巡测记录', collection: 'surveys' },
    { label: '待复查', collection: 'surveys', filter: { field: 'status', value: '异常待复查' } },
    { label: '自动预警', collection: 'surveys', filter: { field: 'autoRiskLevel', value: '预警' } },
    { label: '自动高风险', collection: 'surveys', filter: { field: 'autoRiskLevel', value: '高风险' } },
    { label: '巡测计划', collection: 'plans' },
    { label: '待执行', collection: 'plans', filter: { field: 'status', value: '待执行' } },
    { label: '复查任务', collection: 'reviews' },
    { label: '待处理复查', collection: 'reviews', filter: { field: 'status', value: '待处理' } },
    { label: '干扰事件', collection: 'incidents' },
    { label: '待处理事件', collection: 'incidents', filter: { field: 'status', value: '待处理' } },
    { label: '严重事件', collection: 'incidents', filter: { field: 'severity', value: '严重' } },
    { label: '紧急事件', collection: 'incidents', filter: { field: 'severity', value: '紧急' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '趋势看板',
      type: 'dashboard',
      focusTitle: '异常与复查',
      focus: { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 8 }
    },
    {
      id: 'zonemap',
      label: '分区态势图',
      type: 'zonemap',
      title: '洞穴分区态势图',
      legendTitle: '状态说明'
    },
    {
      id: 'config',
      label: '阈值规则',
      type: 'config',
      formTitle: '阈值规则配置',
      submitLabel: '保存规则',
      thresholdFields: [
        { label: '温度预警阈值(℃)', name: 'temperature.warning', type: 'number', required: true },
        { label: '温度高风险阈值(℃)', name: 'temperature.critical', type: 'number', required: true },
        { label: '湿度预警阈值(%)', name: 'humidity.warning', type: 'number', required: true },
        { label: '湿度高风险阈值(%)', name: 'humidity.critical', type: 'number', required: true },
        { label: 'CO2预警阈值(ppm)', name: 'co2.warning', type: 'number', required: true },
        { label: 'CO2高风险阈值(ppm)', name: 'co2.critical', type: 'number', required: true }
      ]
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片说明',
      searchFields: ['surveyor', 'disturbance', 'photos.title', 'photos.location', 'photos.description'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已复查'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance', 'reviewNote'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' },
        { label: '自动风险等级', name: 'autoRiskLevel' },
        { label: '温度偏差', name: 'deviationTemp' },
        { label: '湿度偏差', name: 'deviationHumidity' },
        { label: 'CO2偏差', name: 'deviationCo2' }
      ],
      defaults: { status: '正常', reviewNote: '', photos: [], autoRiskLevel: '', autoRiskReasons: [], deviationTemp: 0, deviationHumidity: 0, deviationCo2: 0 },
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度', name: 'temperature', type: 'number', required: true },
        { label: '湿度', name: 'humidity', type: 'number', required: true },
        { label: 'CO2', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片证据', name: 'photos', type: 'photos', wide: true },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'import',
      label: '批量导入',
      type: 'import',
      collection: 'surveys',
      formTitle: '传感器数据批量导入',
      listTitle: '导入结果'
    },
    {
      id: 'plans',
      label: '巡测计划',
      collection: 'plans',
      formTitle: '新增巡测计划',
      listTitle: '计划列表',
      submitLabel: '保存计划',
      searchPlaceholder: '搜索路线、负责人、备注',
      searchFields: ['route', 'manager', 'note'],
      statusField: 'status',
      statusOptions: ['待执行', '已完成'],
      filterField: 'route',
      filterLabel: '路线',
      titleFields: ['route', 'plannedDate'],
      summaryFields: ['note'],
      detailFields: [
        { label: '负责人', name: 'manager' },
        { label: '预计日期', name: 'plannedDate' },
        { label: '样点数量', name: 'siteCount' }
      ],
      defaults: { status: '待执行' },
      fields: [
        { label: '巡测路线', name: 'route', required: true },
        { label: '负责人', name: 'manager', required: true },
        { label: '预计日期', name: 'plannedDate', type: 'date', required: true },
        { label: '状态', name: 'status', type: 'select', options: ['待执行', '已完成'] },
        { label: '样点', name: 'siteIds', type: 'multirelation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'reviews',
      label: '复查任务',
      collection: 'reviews',
      formTitle: '新建复查任务',
      listTitle: '复查任务列表',
      submitLabel: '保存任务',
      searchPlaceholder: '搜索负责人、处理建议、关联事件',
      searchFields: ['assignee', 'suggestion', 'incidentId'],
      statusField: 'status',
      statusOptions: ['待处理', '已完成'],
      titleFields: ['assignee', 'dueDate'],
      relation: { collection: 'surveys', localKey: 'surveyId', labelFields: ['surveyor', 'date'], withSite: true },
      summaryFields: ['suggestion', 'incidentResolvedHint'],
      detailFields: [
        { label: '截止日期', name: 'dueDate' },
        { label: '复查负责人', name: 'assignee' },
        { label: '关联事件', name: 'incidentId' }
      ],
      defaults: { status: '待处理', suggestion: '', incidentId: '', autoCreatedFromIncident: false },
      fields: [
        { label: '异常巡测记录', name: 'surveyId', type: 'relation', collection: 'surveys', labelFields: ['surveyor', 'date'], filter: { field: 'status', value: '异常待复查' }, withSite: true, required: true, wide: true },
        { label: '复查负责人', name: 'assignee', required: true },
        { label: '截止日期', name: 'dueDate', type: 'date', required: true },
        { label: '任务状态', name: 'status', type: 'select', options: ['待处理', '已完成'] },
        { label: '处理建议', name: 'suggestion', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'incidents',
      label: '干扰事件',
      collection: 'incidents',
      formTitle: '登记干扰事件',
      listTitle: '事件历史',
      submitLabel: '保存事件',
      searchPlaceholder: '搜索事件描述、上报人、处理说明',
      searchFields: ['description', 'reporter', 'handlingNote', 'photos.title', 'photos.description', 'linkedReviewId'],
      statusField: 'status',
      statusOptions: ['待处理', '处理中', '已处理', '已关闭'],
      filterField: 'severity',
      filterLabel: '严重程度',
      typeFilterField: 'eventType',
      typeFilterLabel: '事件类型',
      typeFilterOptions: ['护栏触碰', '灯光异常', '人员误入', '设备损坏', '其他干扰'],
      titleFields: ['eventType', 'occurredAt'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['description', 'handlingNote'],
      detailFields: [
        { label: '严重程度', name: 'severity' },
        { label: '事件类型', name: 'eventType' },
        { label: '上报人', name: 'reporter' },
        { label: '发生时间', name: 'occurredAt' },
        { label: '关联复查任务', name: 'linkedReviewId' }
      ],
      defaults: { status: '待处理', severity: '一般', photos: [], handlingNote: '', surveyId: '', autoCreateReview: false },
      fields: [
        { label: '关联样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '关联巡测记录', name: 'surveyId', type: 'relation', collection: 'surveys', labelFields: ['surveyor', 'date'], withSite: true, wide: true },
        { label: '事件类型', name: 'eventType', type: 'select', options: ['护栏触碰', '灯光异常', '人员误入', '设备损坏', '其他干扰'], required: true },
        { label: '严重程度', name: 'severity', type: 'select', options: ['一般', '严重', '紧急'], required: true },
        { label: '上报人', name: 'reporter', required: true },
        { label: '发生时间', name: 'occurredAt', type: 'datetime-local' },
        { label: '事件描述', name: 'description', type: 'textarea', required: true, wide: true },
        { label: '照片证据', name: 'photos', type: 'photos', wide: true },
        { label: '处理状态', name: 'status', type: 'select', options: ['待处理', '处理中', '已处理', '已关闭'] },
        { label: '处理说明', name: 'handlingNote', type: 'textarea', wide: true },
        { label: '自动创建联动复查任务', name: 'autoCreateReview', type: 'checkbox', hint: '严重或紧急事件登记时可选择自动创建复查任务，关联对应巡测记录或样点' }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] },
    {
      id: 'survey-alert',
      label: '标记异常',
      collection: 'surveys',
      relation: { collection: 'sites', localKey: 'siteId' },
      patches: [
        { field: 'status', value: '异常待复查' },
        { target: 'related', field: 'protectedStatus', value: '重点保护' }
      ]
    },
    { id: 'survey-review', label: '完成复查', collection: 'surveys', patches: [{ field: 'status', value: '已复查' }, { field: 'reviewNote', value: '异常已复核' }] },
    { id: 'plan-complete', label: '标记完成', collection: 'plans', patches: [{ field: 'status', value: '已完成' }] },
    { id: 'plan-reopen', label: '重新打开', collection: 'plans', patches: [{ field: 'status', value: '待执行' }] },
    { id: 'plan-generate-drafts', label: '生成巡测草稿', collection: 'plans', note: '巡测草稿已生成', patches: [{ field: 'draftsGenerated', value: true }] },
    {
      id: 'review-complete',
      label: '完成复查',
      collection: 'reviews',
      relation: { collection: 'surveys', localKey: 'surveyId' },
      patches: [
        { field: 'status', value: '已完成' },
        { target: 'related', field: 'status', value: '已复查' },
        { target: 'related', field: 'reviewNote', valuePath: 'item.suggestion' }
      ]
    },
    {
      id: 'incident-processing',
      label: '开始处理',
      collection: 'incidents',
      patches: [
        { field: 'status', value: '处理中' }
      ]
    },
    {
      id: 'incident-resolve',
      label: '处理完成',
      collection: 'incidents',
      patches: [
        { field: 'status', value: '已处理' }
      ]
    },
    {
      id: 'incident-close',
      label: '关闭事件',
      collection: 'incidents',
      patches: [
        { field: 'status', value: '已关闭' }
      ]
    },
    {
      id: 'incident-reopen',
      label: '重新打开',
      collection: 'incidents',
      patches: [
        { field: 'status', value: '待处理' }
      ]
    },
    {
      id: 'incident-suspend-site',
      label: '暂停样点开放',
      collection: 'incidents',
      danger: true,
      relation: { collection: 'sites', localKey: 'siteId' },
      guards: [
        { op: 'levelGte', left: 'item.severity', right: '严重', message: '仅严重及以上事件才可暂停样点' },
        { op: 'notIn', left: 'related.protectedStatus', values: ['暂停开放'], message: '样点已处于暂停开放状态' }
      ],
      patches: [
        { field: 'status', value: '处理中' },
        { target: 'related', field: 'protectedStatus', value: '暂停开放' }
      ],
      note: '因关联干扰事件暂停开放'
    }
  ]
};
