/**
 * 脱敏评测样本库（TASK-02，2026-11-17）
 *
 * 用途：QA-1 确定性回归与 QA-2 真实模型质量抽查的统一输入。
 * 原则（开发工作单 TASK-02）：
 *  - 全部样本为合成或脱敏数据，不含真实隐私正文、凭据、密钥、令牌；
 *  - 分类样本允许多个合理答案（acceptableCategories）；
 *  - 搜索样本记录"想找什么"与"目标链接"；
 *  - 安全与一致性样本结果唯一、确定；
 *  - 覆盖：同域不同主题 / 多级目录 / 同名目录 / 中英长无标题 / hash 路由 /
 *          业务参数 / 相似 URL / 登录页 / 内网页 / 隐私域 / 正文提取失败 /
 *          重复事件 / 断网重试 / SW 重启 / 过期提案 / 关联快照恢复。
 */

// ---------- 分类样本（允许多个合理答案） ----------

export interface ClassifySample {
  id: string;
  url: string;
  title: string;
  /** 原始导入目录（可空数组 = 收件箱/未整理路径） */
  folderPath: string[];
  /** 可用摘要（模拟 L1/L2 内容信号；缺省 = "仅按标题/URL 判断"场景） */
  contentSummary?: string;
  /** 多个合理答案（评测时命中任一即算正确） */
  acceptableCategories: string[];
  /** 覆盖维度说明 */
  notes?: string;
}

const d = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

const classifySamples: ClassifySample[] = [
  // ===== 同域不同主题（B3 核心验收：域名粗判不能锁死最终目录） =====
  {
    id: "cls-same-domain-1",
    url: "https://github.com/some-org/cookbook",
    title: "家常菜谱合集",
    folderPath: [],
    contentSummary: "红烧肉、糖醋排骨、清蒸鱼的家常做法步骤与火候要点。",
    acceptableCategories: ["生活", "美食", "阅读"],
    notes: "同域不同主题：github.com 但内容是美食",
  },
  {
    id: "cls-same-domain-2",
    url: "https://github.com/some-org/react-starter",
    title: "React 项目模板",
    folderPath: [],
    contentSummary: "开箱即用的 React 18 + Vite 工程模板，含 ESLint 与 CI 配置。",
    acceptableCategories: ["开发"],
    notes: "同域不同主题：github.com 且内容确实是开发",
  },
  {
    id: "cls-same-domain-3",
    url: "https://www.bilibili.com/video/BV1finance001",
    title: "个人理财入门课",
    folderPath: [],
    contentSummary: "记账、应急金、指数基金定投的基础概念讲解视频。",
    acceptableCategories: ["财务", "学习", "课程"],
    notes: "同域不同主题：bilibili.com 但内容是理财课程",
  },
  {
    id: "cls-same-domain-4",
    url: "https://www.zhihu.com/question/123456789",
    title: "有哪些值得去的徒步路线",
    folderPath: [],
    contentSummary: "户外爱好者讨论国内经典徒步线路的难度、季节与装备。",
    acceptableCategories: ["户外", "旅行", "生活"],
    notes: "同域不同主题：zhihu.com 但内容是户外旅行",
  },
  {
    id: "cls-same-domain-5",
    url: "https://medium.com/@someone/rust-async-deep-dive-2026",
    title: "Rust 异步运行时深度解析",
    folderPath: [],
    contentSummary: "从 Future trait 到 tokio 调度器的异步执行机制源码级解析。",
    acceptableCategories: ["开发", "阅读"],
    notes: "同域不同主题：medium.com 域名规则未收录，靠标题/内容",
  },
  {
    id: "cls-same-domain-6",
    url: "https://www.zhihu.com/column/c_1234567890",
    title: "某个技术专栏的 Rust 合集",
    folderPath: [],
    contentSummary: "专栏作者持续更新的 Rust 语言系列文章目录页。",
    acceptableCategories: ["开发", "阅读"],
    notes: "同域不同主题：zhihu.com 且内容是开发（对照 cls-same-domain-4 的户外主题）",
  },

  // ===== 多级目录 / 同名目录 =====
  {
    id: "cls-deep-1",
    url: "https://react.dev/learn/state",
    title: "Managing State",
    folderPath: ["开发", "前端", "React", "官方文档"],
    acceptableCategories: ["开发", "文档", "学习"],
    notes: "四级目录深度",
  },
  {
    id: "cls-deep-2",
    url: "https://kubernetes.io/docs/concepts/workloads/",
    title: "Workloads | Kubernetes",
    folderPath: ["开发", "运维", "K8s"],
    acceptableCategories: ["开发", "运维", "文档"],
    notes: "三级目录",
  },
  {
    id: "cls-samename-1",
    url: "https://docs.example.com/team-a/guide",
    title: "团队 A 接入指南",
    folderPath: ["工作", "接入指南"],
    acceptableCategories: ["工作", "文档"],
    notes: "同名目录：与下一条父目录不同但目录名相同",
  },
  {
    id: "cls-samename-2",
    url: "https://docs.example.com/team-b/guide",
    title: "团队 B 接入指南",
    folderPath: ["外包", "接入指南"],
    acceptableCategories: ["工作", "文档", "外包"],
    notes: "同名目录：ensurePath 需按父目录区分",
  },

  // ===== 中文 / 英文 / 长标题 / 无标题 =====
  {
    id: "cls-lang-zh",
    url: "https://zh.example-wiki.cn/wiki/量子计算基础",
    title: "量子计算基础（中文科普）",
    folderPath: [],
    contentSummary: "量子比特、叠加态与量子纠缠的入门科普文章。",
    acceptableCategories: ["阅读", "学习", "科普"],
    notes: "中文标题+中文内容",
  },
  {
    id: "cls-lang-en",
    url: "https://news.ycombinator.com/item?id=12345678",
    title: "Show HN: I built a bookmark manager",
    folderPath: [],
    acceptableCategories: ["科技资讯", "开发", "阅读"],
    notes: "英文标题",
  },
  {
    id: "cls-long-title",
    url: "https://example.com/very/long/path/2026/report",
    title:
      "2026年度个人知识管理体系搭建完整指南：从信息收集、整理、内化到输出的全流程实践方法与工具选型详细复盘总结".repeat(
        2,
      ),
    folderPath: [],
    acceptableCategories: ["阅读", "学习", "效率"],
    notes: "超长标题边界（>512 截断）",
  },
  {
    id: "cls-no-title",
    url: "https://example-utility.internal-app.dev/tool/render",
    title: "Untitled",
    folderPath: [],
    acceptableCategories: ["工具", "未分类"],
    notes: "无标题页（title=Untitled），仅按 URL 判断",
  },

  // ===== hash 路由 / 业务参数 / 相似但不同的 URL（B4-3 保守去重） =====
  {
    id: "cls-hash-1",
    url: "https://app.example-crm.com/contacts#/detail/1001",
    title: "客户 1001 详情",
    folderPath: ["工作"],
    acceptableCategories: ["工作"],
    notes: "hash 路由：与 1002 是不同实体，不得合并",
  },
  {
    id: "cls-hash-2",
    url: "https://app.example-crm.com/contacts#/detail/1002",
    title: "客户 1002 详情",
    folderPath: ["工作"],
    acceptableCategories: ["工作"],
    notes: "hash 路由：canonicalize 会去 hash——合并误吞风险样本（B4-3）",
  },
  {
    id: "cls-param-1",
    url: "https://shop.example-goods.com/order?orderId=A-2026-001",
    title: "订单 A-2026-001",
    folderPath: ["购物"],
    acceptableCategories: ["购物", "生活"],
    notes: "业务参数承载实体 ID：去除参数即丢实体",
  },
  {
    id: "cls-param-2",
    url: "https://shop.example-goods.com/order?orderId=A-2026-002",
    title: "订单 A-2026-002",
    folderPath: ["购物"],
    acceptableCategories: ["购物", "生活"],
    notes: "同上：仅参数不同",
  },
  {
    id: "cls-similar-1",
    url: "https://docs.example-suite.com/suite/v2/getting-started",
    title: "套件 v2 快速开始",
    folderPath: [],
    acceptableCategories: ["文档", "开发"],
    notes: "相似 URL 三连之一：v2/v3 是不同版本文档",
  },
  {
    id: "cls-similar-2",
    url: "https://docs.example-suite.com/suite/v3/getting-started",
    title: "套件 v3 快速开始",
    folderPath: [],
    acceptableCategories: ["文档", "开发"],
    notes: "相似 URL 三连之二",
  },
  {
    id: "cls-similar-3",
    url: "https://docs.example-suite.com/suite/v2/migration",
    title: "套件 v2→v3 迁移指南",
    folderPath: [],
    acceptableCategories: ["文档", "开发"],
    notes: "相似 URL 三连之三：去重只可给建议不可自动合并",
  },

  // ===== 正文提取失败 / 缺内容 =====
  {
    id: "cls-nocontent-1",
    url: "https://spa.example-heavy-app.com/dashboard",
    title: "数据看板",
    folderPath: [],
    acceptableCategories: ["工具", "工作", "未分类"],
    notes: "SPA 页面正文提取失败（client 渲染，innerText 空）",
  },
  {
    id: "cls-nocontent-2",
    url: "https://pay.example-gov.cn/query-result",
    title: "查询结果页",
    folderPath: [],
    acceptableCategories: ["未分类", "生活"],
    notes: "结果页无有效正文；显示『仅按标题/URL 判断』（B3）",
  },

  // ===== 常规分类样本（扩充规模 + 各主题覆盖） =====
  ...[
    ["https://tailwindcss.com/docs/installation", "Tailwind CSS 安装文档", ["开发", "文档", "设计"]],
    ["https://www.typescriptlang.org/docs/handbook/", "TypeScript Handbook", ["开发", "文档", "学习"]],
    ["https://huggingface.co/blog/some-nlp-model", "开源 NLP 模型实测", ["开发", "AI", "阅读"]],
    ["https://arxiv.org/abs/2601.12345", "检索增强生成的综述论文", ["学习", "阅读", "AI"]],
    ["https://caniuse.com/?search=container", "Can I Use - CSS Container Queries", ["开发", "工具"]],
    ["https://codepen.io/pen/some-demo", "CSS 动画 Demo", ["开发", "设计"]],
    ["https://dribbble.com/shots/some-shot", "仪表盘界面设计稿", ["设计"]],
    ["https://www.figma.com/file/some-file", "设计系统源文件", ["设计", "工作"]],
    ["https://coolors.co/palette/some", "配色方案生成器", ["设计", "工具"]],
    ["https://www.youtube.com/watch?v=abc123", "算法面试专题讲座", ["视频", "学习"]],
    ["https://www.bilibili.com/video/BV1xx411c79H", "布莱泽奥特曼第 10 集", ["视频"]],
    ["https://music.163.com/playlist?id=123", "深夜学习歌单", ["音乐", "生活"]],
    ["https://open.spotify.com/album/some-album", "Focus Jazz Album", ["音乐"]],
    ["https://movie.douban.com/subject/1234567/", "星际穿越 (2014)", ["影视", "视频"]],
    ["https://www.imdb.com/title/tt0123456/", "Some Sci-Fi Movie - IMDb", ["影视"]],
    ["https://weread.qq.com/web/bookDetail/some", "《纳瓦尔宝典》读书笔记", ["阅读", "学习"]],
    ["https://book.douban.com/subject/1000001/", "《代码大全》", ["阅读", "学习", "开发"]],
    ["https://x.com/someone/status/123456", "某工程师关于性能优化的推文串", ["社交", "开发", "阅读"]],
    ["https://v2ex.com/t/1000000", "大家都用什么笔记软件", ["社交", "工具", "效率"]],
    ["https://www.reddit.com/r/rust/comments/abc/", "Rust 2026 roadmap discussion", ["社交", "开发"]],
    ["https://twitter.com/some_dev/status/999", "类型系统科普推文", ["社交", "开发", "阅读"]],
    ["https://www.weibo.com/u/1234567890", "某科普博主主页", ["社交"]],
    ["https://s.taobao.com/products?q=keyboard", "机械键盘搜索结果", ["购物"]],
    ["https://item.jd.com/100012345678.html", "65% 配列机械键盘", ["购物"]],
    ["https://www.amazon.cn/dp/B0XXXXXXXX", "人体工学椅", ["购物", "生活"]],
    ["https://www.smzdm.com/p/1234567/", "显示器性价比横评", ["购物", "阅读"]],
    ["https://www.icourse163.org/course/SCU-123456", "大学 Python 公开课", ["学习", "课程"]],
    ["https://www.coursera.org/learn/machine-learning", "Machine Learning 课程", ["学习", "AI", "课程"]],
    ["https://leetcode.cn/problems/two-sum/", "两数之和 - LeetCode", ["开发", "学习"]],
    ["https://www.runoob.com/sql/sql-tutorial.html", "SQL 教程", ["学习", "开发", "文档"]],
    ["https://developer.mozilla.org/zh-CN/docs/Web/API/fetch_api", "Fetch API - MDN", ["开发", "文档"]],
    ["https://webpack.js.org/concepts/", "Webpack 核心概念", ["开发", "文档"]],
    ["https://vitejs.dev/guide/", "Vite 指南", ["开发", "文档"]],
    ["https://www.docker.com/blog/some-post/", "Docker 最佳实践博客", ["开发", "运维"]],
    ["https://terraform.io/docs/language/index.html", "Terraform 语言文档", ["开发", "运维", "文档"]],
    ["https://prometheus.io/docs/introduction/overview/", "Prometheus 监控文档", ["开发", "运维"]],
    ["https://grafana.com/docs/grafana/latest/", "Grafana 可视化文档", ["开发", "运维"]],
    ["https://www.ruanyifeng.com/blog/2026/01/weekly-issue-300.html", "科技爱好者周刊第 300 期", ["阅读", "科技资讯"]],
    ["https://www.jiqizhixin.com/articles/some-ai", "大模型推理成本下降分析", ["AI", "科技资讯", "阅读"]],
    ["https://ssci.example-journal.cn/paper/123", "某社会科学论文（正文提取失败样例）", ["学习", "阅读"]],
    ["https://maps.example-amap.com/place/B0FF012345", "常去的羽毛球馆位置", ["生活", "运动", "工具"]],
    ["https://www.dianping.com/shop/1234567", "公司楼下的面馆", ["生活", "美食"]],
    ["https://www.ctrip.com/hotels/detail?hotelId=123", "出差常订酒店", ["旅行", "工作"]],
    ["https://flights.example.cn/booking/HA999", "常飞航线值机入口", ["旅行", "工具"]],
    ["https://mail.example-mail.cn/inbox", "网页邮箱收件箱", ["工具", "工作"]],
    ["https://translate.example.cn/", "在线翻译", ["工具"]],
    ["https://excalidraw.com/#room=some", "在线白板协作", ["工具", "设计", "工作"]],
    ["https://www.notion.so/workspace/docs", "个人项目笔记页", ["工具", "效率", "工作"]],
    ["https://obsidian.md/plugins/some-plugin", "某 Obsidian 插件", ["工具", "效率"]],
    ["https://github.com/some-org/awesome-list", "Awesome 某领域资源合集", ["开发", "阅读"]],
    ["https://stackoverflow.com/questions/12345678", "某个 Git 冲突处理问题", ["开发"]],
    ["https://unix.stackexchange.com/questions/123456", "cron 任务不执行的排查", ["开发", "运维"]],
    ["https://www.cnblogs.com/someuser/p/18600000.html", "一次线上内存泄漏排查记", ["开发", "阅读"]],
    ["https://juejin.cn/post/1234567890123456", "前端微前端落地方案总结", ["开发", "阅读"]],
    ["https://segmentfault.com/a/1190000040000000", "SQLite WAL 模式详解", ["开发", "阅读", "数据库"]],
    ["https://www.infoq.cn/article/some-arch", "某大厂架构演进演讲实录", ["开发", "阅读"]],
    ["https://css-tricks.com/some-article/", "CSS Grid 布局技巧", ["开发", "设计"]],
    ["https://web.dev/articles/vitals", "Core Web Vitals 指南", ["开发"]],
    ["https://a11y.example-guide.org/checklist", "无障碍设计清单", ["设计", "开发"]],
    ["https://law.wkinfo.example.cn/search?keyword=劳动合同", "劳动法条目检索（正文提取失败样例）", ["学习", "工作"]],
    ["https://www.gov.example.cn/policy/2026-01", "某地人才补贴政策", ["生活", "工作"]],
    ["https://hospital-example.org.cn/register", "医院挂号平台（登录墙）", ["生活"]],
    ["https://insurance.example.cn/policy/mine", "我的保单页（登录墙）", ["财务", "生活"]],
    ["https://bank.example-icbc.bank/cards", "信用卡权益页（隐私域样本）", ["财务"]],
    ["https://nas.example-home.local:5443/dashboard", "家里 NAS 面板（内网样本）", ["工具", "运维"]],
    ["https://192.168.1.10:8443/router", "路由器管理页（内网样本）", ["工具"]],
    ["https://git.example-company.internal/group/repo", "公司内网 Git（内网样本）", ["工作", "开发"]],
    ["https://docs.example-company.internal/oncall", "值班响应手册（内网样本）", ["工作"]],
    ["https://www.example-news.cn/tech/ai-2026", "AI 行业动态周报", ["科技资讯", "阅读"]],
    ["https://example-zhuanlan.example.cn/p/12345678", "深度学习推理优化实践专栏", ["AI", "开发", "阅读"]],
    ["https://www.example-podcasts.cn/episodes/42", "某技术播客第 42 期", ["科技资讯", "播客"]],
    ["https://canvas.example-edu.cn/courses/101", "在线课程作业页（登录墙）", ["学习", "课程"]],
    ["https://figma.example-plugin.dev/mirror", "Figma 插件镜像工具", ["设计", "工具"]],
    ["https://sqlite.org/datatype3.html", "SQLite 数据类型文档", ["开发", "数据库", "文档"]],
    ["https://www.postgresql.org/docs/current/wal.html", "PostgreSQL WAL 文档", ["开发", "数据库", "文档"]],
    ["https://redis.io/docs/latest/develop/", "Redis 官方文档（自建禁用 Redis，样本仅作分类评测）", ["开发", "数据库", "文档"]],
    ["https://nginx.org/en/docs/", "Nginx 文档", ["开发", "运维", "文档"]],
    ["https://chat.example-ai.cn/chat/some-thread", "与 AI 讨论架构设计的对话", ["AI", "工作", "开发"]],
  ].map(([url, title, cats], i): ClassifySample => ({
    id: `cls-bulk-${i + 1}`,
    url: url as string,
    title: title as string,
    folderPath: [],
    acceptableCategories: cats as string[],
  })),

  // ===== 用户固定/纠正优先样本（B3 优先级链验证） =====
  {
    id: "cls-pinned-1",
    url: "https://www.youtube.com/watch?v=study-lofi",
    title: "学习时听的 Lo-Fi 直播",
    folderPath: ["学习专注"], // 用户手动归类过的目录
    acceptableCategories: ["学习专注", "音乐"], // 用户固定归类 > 域名粗判（youtube.com≠视频）
    notes: "用户固定归类优先：youtube.com 不应强制归入「视频」",
  },
  {
    id: "cls-pinned-2",
    url: "https://github.com/company/handbook",
    title: "公司制度手册仓库",
    folderPath: ["工作"],
    acceptableCategories: ["工作"], // 用户纠正过：github.com 的这条属于工作
    notes: "用户确认过的纠正 > 内容语义 > 域名粗判",
  },
];

// ---------- 搜索样本（记录"想找什么"与目标链接） ----------

export interface SearchSample {
  id: string;
  /** 想找什么（用户意图，人工可读） */
  intent: string;
  /** 实际输入的查询词 */
  query: string;
  /** 目标链接：命中任一即找回成功 */
  targetUrls: string[];
  /** 相似但不该误吞的干扰项 */
  mustNotMatchUrls?: string[];
  notes?: string;
}

const searchSamples: SearchSample[] = [
  {
    id: "srch-1",
    intent: "找之前收藏的那篇 SQLite WAL 文章",
    query: "SQLite WAL",
    targetUrls: ["https://segmentfault.com/a/1190000040000000"],
    notes: "标题记忆型",
  },
  {
    id: "srch-2",
    intent: "找回讲红烧肉做法的那条收藏（记得存过一篇美食笔记）",
    query: "红烧肉",
    targetUrls: ["https://github.com/some-org/cookbook"],
    notes: "正文关键词型：命中依赖 content_cache.l2_text",
  },
  {
    id: "srch-3",
    intent: "找那个客户 1001 的详情页",
    query: "客户 1001",
    targetUrls: ["https://app.example-crm.com/contacts#/detail/1001"],
    mustNotMatchUrls: ["https://app.example-crm.com/contacts#/detail/1002"],
    notes: "hash 路由区分：1002 是干扰项",
  },
  {
    id: "srch-4",
    intent: "找套件 v3 的快速开始文档",
    query: "套件 v3",
    targetUrls: ["https://docs.example-suite.com/suite/v3/getting-started"],
    mustNotMatchUrls: ["https://docs.example-suite.com/suite/v2/getting-started"],
    notes: "相似 URL 区分：v2 是干扰项",
  },
  {
    id: "srch-5",
    intent: "找 TypeScript 的手册",
    query: "typescript handbook",
    targetUrls: ["https://www.typescriptlang.org/docs/handbook/"],
    notes: "英文标题记忆型（小写查询）",
  },
  {
    id: "srch-6",
    intent: "找那次线上内存泄漏的排查记录",
    query: "内存泄漏 排查",
    targetUrls: ["https://www.cnblogs.com/someuser/p/18600000.html"],
    notes: "多关键词组合",
  },
  {
    id: "srch-7",
    intent: "找人体工学椅那单",
    query: "人体工学椅",
    targetUrls: ["https://www.amazon.cn/dp/B0XXXXXXXX"],
    notes: "购物类",
  },
  {
    id: "srch-8",
    intent: "找公司值班手册（记得在内网）",
    query: "值班 响应",
    targetUrls: ["https://docs.example-company.internal/oncall"],
    notes: "内网书签也可被搜索（标题/URL 层）",
  },
  {
    id: "srch-9",
    intent: "找那个算法讲座视频",
    query: "算法 讲座",
    targetUrls: ["https://www.youtube.com/watch?v=abc123"],
    notes: "标题组合",
  },
  {
    id: "srch-10",
    intent: "找量子计算的科普文章",
    query: "量子计算",
    targetUrls: ["https://zh.example-wiki.cn/wiki/量子计算基础"],
    notes: "中文标题",
  },
  {
    id: "srch-11",
    intent: "找 Prometheus 监控文档",
    query: "prometheus 监控",
    targetUrls: ["https://prometheus.io/docs/introduction/overview/"],
    notes: "URL+标题双命中",
  },
  {
    id: "srch-12",
    intent: "找 Lo-Fi 学习直播",
    query: "lo-fi",
    targetUrls: ["https://www.youtube.com/watch?v=study-lofi"],
    notes: "连字符查询",
  },
];

// ---------- 安全与一致性样本（唯一、确定结果） ----------

export interface SafetySample {
  id: string;
  kind: "privacy_domain" | "intranet" | "login_page" | "dedup_identity";
  url: string;
  title: string;
  /** 唯一确定预期 */
  expected: string;
}

const safetySamples: SafetySample[] = [
  {
    id: "safe-privacy-1",
    kind: "privacy_domain",
    url: "https://icbc.bank/login",
    title: "银行登录",
    expected:
      "捕获前拦截：正文读取函数未被调用；无正文/快照网络请求发出；仅存元数据；服务端再校验同样拒绝",
  },
  {
    id: "safe-privacy-2",
    kind: "privacy_domain",
    url: "https://mail.example.cn.work/",
    title: "企业邮箱",
    expected: "同 privacy_domain：不读取、不上传正文，不调用模型",
  },
  {
    id: "safe-intranet-1",
    kind: "intranet",
    url: "https://nas.example-home.local:5443/dashboard",
    title: "NAS 面板",
    expected: "扩展端就地捕获可用（用户在页面上）；服务端抓取必须拒绝（自建默认禁止私网抓取）",
  },
  {
    id: "safe-intranet-2",
    kind: "intranet",
    url: "http://192.168.1.10:8443/router",
    title: "路由器管理",
    expected: "同 intranet；且 http 内网协议不被强制升级为 https（canonicalizeUrl isLocal 路径）",
  },
  {
    id: "safe-login-1",
    kind: "login_page",
    url: "https://hospital-example.org.cn/register",
    title: "医院挂号平台",
    expected: "服务端抓取遇登录墙 → failReason 记录，不标记为抓取成功；扩展端就地捕获正常",
  },
  {
    id: "safe-dedup-1",
    kind: "dedup_identity",
    url: "https://shop.example-goods.com/order?orderId=A-2026-001",
    title: "订单 A-2026-001",
    expected: "永久保留原始 URL；不因参数/协议差异自动合并；相似 URL 只出建议",
  },
  {
    id: "safe-dedup-2",
    kind: "dedup_identity",
    url: "https://app.example-crm.com/contacts#/detail/1001",
    title: "客户 1001",
    expected: "hash 路由页面与 /contacts#/detail/1002 是不同实体，永不自动合并",
  },
  {
    id: "safe-dedup-3",
    kind: "dedup_identity",
    url: "https://github.com/microsoft/vscode?utm_source=news",
    title: "VS Code",
    expected: "tracking 参数（utm_*）规范化后与裸 URL 判重可合并（唯一允许的规范化合并维度）",
  },
];

// ---------- 场景样本（重复事件 / 断网重试 / SW 重启 / 过期提案 / 快照恢复） ----------

export interface ScenarioSample {
  id: string;
  dimension:
    | "duplicate_event"
    | "offline_retry"
    | "sw_restart"
    | "stale_proposal"
    | "snapshot_restore"
    | "user_manual_move";
  /** 场景描述（人工可读） */
  setup: string;
  action: string;
  /** 唯一确定预期 */
  expected: string;
}

const scenarioSamples: ScenarioSample[] = [
  {
    id: "scn-dup-1",
    dimension: "duplicate_event",
    setup: "浏览器 bookmarks.onCreated 与 onMoved 对同一书签各触发一次",
    action: "两次事件进入收件箱处理",
    expected: "只产生一条应用库书签与一个分类任务（幂等键去重），不重复移动",
  },
  {
    id: "scn-dup-2",
    dimension: "duplicate_event",
    setup: "扩展收藏按钮与服务端已有同 URL 书签",
    action: "POST /bookmarks 重复提交",
    expected: "返回 duplicate=true，不新建行，不生成新任务",
  },
  {
    id: "scn-offline-1",
    dimension: "offline_retry",
    setup: "服务端离线时用户拖书签进收件箱",
    action: "恢复网络后自动重试",
    expected: "操作保留在持久队列，恢复后恰好提交一次；不丢、不重复",
  },
  {
    id: "scn-offline-2",
    dimension: "offline_retry",
    setup: "快照上传中断网",
    action: "上传失败",
    expected: "不记录为成功；书签仍在；恢复后可重试",
  },
  {
    id: "scn-sw-1",
    dimension: "sw_restart",
    setup: "收件箱有待处理事件时 Service Worker 被 Kill",
    action: "SW 因新事件唤醒",
    expected: "持久待发送操作恢复并继续处理；内存队列丢失不等于操作丢失",
  },
  {
    id: "scn-stale-1",
    dimension: "stale_proposal",
    setup: "整理提案生成后，用户手动把其中某书签移到别的目录",
    action: "应用该提案",
    expected: "已被手动修改的项目提示冲突并跳过，不静默覆盖用户修改",
  },
  {
    id: "scn-stale-2",
    dimension: "stale_proposal",
    setup: "回滚版本包含一个回滚前又被用户手动移动过的书签",
    action: "执行回滚",
    expected: "跳过该项目或要求确认；不破坏用户后来的修改",
  },
  {
    id: "scn-snap-1",
    dimension: "snapshot_restore",
    setup: "书签 A 有关联快照，整理合并把 B 并入 A 后回滚",
    action: "合并 → 回滚",
    expected: "书签 A、B 都恢复，快照关联与正文缓存仍可访问",
  },
  {
    id: "scn-snap-2",
    dimension: "snapshot_restore",
    setup: "服务端重启",
    action: "打开重启前保存的快照",
    expected: "快照仍可读取（文件+索引持久）",
  },
  {
    id: "scn-manual-1",
    dimension: "user_manual_move",
    setup: "用户手动把书签从自动分类目录移出",
    action: "后续任何自动整理",
    expected: "永不自动移回（用户手动归类优先），监听循环不触发重复移动",
  },
];

// ---------- 汇总导出 ----------

export interface EvalSampleLibrary {
  version: string;
  generatedFor: string;
  classify: ClassifySample[];
  search: SearchSample[];
  safety: SafetySample[];
  scenario: ScenarioSample[];
}

export const EVAL_SAMPLE_LIBRARY: EvalSampleLibrary = {
  version: "2026-11-17.1",
  generatedFor: "TASK-02 脱敏评测样本库（QA-1 确定性回归 / QA-2 真实模型抽查）",
  classify: classifySamples,
  search: searchSamples,
  safety: safetySamples,
  scenario: scenarioSamples,
};

/** 导出为 ingest 接口可用的 JSON（分类样本 → 书签导入批次） */
export function toIngestJson(library = EVAL_SAMPLE_LIBRARY, idempotencyKey = "eval-samples-v1"): {
  idempotencyKey: string;
  items: Array<{ url: string; title: string; folderPath: string[]; addedAt: string }>;
} {
  return {
    idempotencyKey,
    items: library.classify.map((s) => ({
      url: s.url,
      title: s.title,
      folderPath: s.folderPath,
      addedAt: d(30),
    })),
  };
}
