# Studio 网关会话适配

用户已通过短信登录并被网关放行，但 Studio 仍显示 Authentication Required / Add header。当前 Mastra 的原生 capabilities 接口对现有自定义 API 认证配置返回 enabled:true、login:null 且没有 user，Studio 因此显示自己的 Header 登录表单。

本期只在 Studio 已启用、身份来自网关确认的 Cookie 会话时，声明 Studio 内置登录界面未启用。Mastra 的原生 capabilities 是 framework-public 端点，会跳过用户中间件；因此宿主将 GET /agent/api/auth/capabilities 精确转发到 Agent 自有的 /studio-auth/capabilities。身份验证先于适配响应，浏览器登录继续由既有 Server 网关完成。适配接口及公开入口拒绝匿名请求；框架原生的内部公开元数据端点不改动。普通 API 的 Mastra 原生认证、资源级用户隔离保留，Bearer 适配响应与已安装原生端点对比验收。不改写 Mastra 依赖、前端资源或构建产物，不新增 JWT、Service Key 或 ENV；main/production 不启用 Studio。

回归用例复现旧行为，覆盖合法会话、无身份、未验证 Cookie、无效身份、Bearer 调用及关闭 Studio 的场景。构建产物的 HTTP 冒烟使用与测试容器一致的 NODE_ENV=production，验证原生 Studio 页面、资源、capabilities 以及受保护 API；使用内存存储和隔离身份替身，不调用真实短信、模型或数据库。

发布基准为实际成功的 448cdb7c49945a445a9243137e190eb328ca45db。复用同一成功配置快照，新增/修改/删除 ENV 均无，无额外 SQL 或回填。Agent 新版健康后，另行应用上述单一路径的宿主入口映射；宿主维护在仓库外完成，沿用本会话已有授权，不接入应用自动发布执行器。Mastra 版本和存储配置未变，启动仍按框架管理存储；应用恢复不撤销已提交存储变化。实际发布结果以对应 Actions 与宿主记录为准。
