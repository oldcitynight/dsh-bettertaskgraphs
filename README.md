# dsh-better-task-grapth

本构建版本为 `0.3.1-rc.44`。适用宿主和配套版本见 [兼容清单](DSH-COMPATIBILITY.json)。

独立运行保留动态上下文开发前 `0.2.3` 的五个工具、初始指引与事务语义；通用扩展接口供其他插件登记工作流和会话策略。动态上下文装配、修改审批及其提示词由扩展插件实现。

配套扩展：[dsh-dynamic-context](https://github.com/oldcitynight/dsh-dynamic-context)。本候选的验证范围与复现方式见 [VALIDATION.md](VALIDATION.md)。

DeepSeek Harness 的事务型任务图 Bundle，包含模型侧的任务图工具和会话输入区的任务图面板。支持嵌套容器、条件分支、单一活动叶节点，以及基于 DSH 会话证据的提交与对账。

面板的事务关系区列出进入条件及对应任务状态。点击「全屏」后，沿连线从左往右阅读。可沿同一条前置链推出的重复条件会合并显示。独立的跨列前置留在目标卡片的进入条件中，并在卡片上标记数量。点击节点可切换所选事务，按 Esc 返回会话。

## 兼容范围

分支 `0.2.1-alpha.4` 采用 npm 标签 `dsh-0.2.1-alpha.4`。配套动态上下文版本为 `0.1.1-rc.44`。

- DSH `0.2.1-alpha.4`、`0.2.1-alpha.3`，使用 Web profile。
- Node.js `^22.19.0 || >=24.0.0`，开发用 npm。此包与 DSH 共享会话、工具和远程调用接口，升级 DSH 时需要重新验证这些接口。

## 构建和打包

```sh
npm ci
npm run build
npm test
npm run pack:bundle
```

`build` 从前端源码生成可由 DSH Web 加载的 `client.js`。`check` 校验生成物与源码一致，`pack:bundle` 会重新构建前端并生成 `dist/dsh-better-task-grapth-0.3.1-rc.44.tgz`。包内包含服务端模块、Web 构建产物、对应源码和构建脚本，以及 Bundle 配置补丁。

## 安装到独立 Web profile

在本仓库目录下运行。以下命令使用名为 `bettertaskgraphs` 的新 profile。DSH 的 `--from-default-profile` 会重置同名 profile，已有该名称时请改用新名字。

```sh
dsh --profile bettertaskgraphs --from-default-profile web --dump-config
dsh plugin --profile bettertaskgraphs add "$PWD/dist/dsh-better-task-grapth-0.3.1-rc.44.tgz"
dsh --profile bettertaskgraphs --dump-config
dsh --profile bettertaskgraphs
```

通过 `--dump-config` 可以确认已合成 `dsh-better-task-grapth` 配置层。若同一台机器已运行 Web，请为新 profile 选择一个空闲端口。用 `dsh plugin --profile bettertaskgraphs remove dsh-better-task-grapth` 移除该配置层。

## 工作区与已有任务图

本包由 `dsh-bettertaskgraphs` 更名为 `dsh-better-task-grapth`。升级已有 profile 时，在空闲边界移除旧包，再安装同一宿主线的新包及配套动态上下文。原项目根和账本目录继续使用；自定义配置中的任务图层 `id` 需改为 `dsh-better-task-grapth`，保留其 `config`。同一 profile 只启用一份任务图插件。

Bundle 默认将会话创建时的工作目录作为项目根，账本位于根目录下的 `.dsh/transaction-graphs-v4/`。后续工作目录必须位于该根内，账本路径拒绝符号链接。也可以在 profile 的 `cordis.patch.yml` 中固定项目根。

```yaml
- id: dsh-better-task-grapth
  config:
    projectRoot: /absolute/path/to/project
    storageRelative: .dsh/transaction-graphs-v4
    enableSwitch: false
```

替换原有的 `dsh-project-transaction-graph` 时，请在目标 profile 移除旧 Bundle 后再安装此包。两者使用同一组工具和会话投影键。新包沿用 V4 账本与会话事件格式。要接回已有任务图，须使用原会话、相同的项目根和账本目录，并沿用原先的 `enableSwitch` 设置。如果会话从项目子目录启动，请显式指定原项目根。

[DSH 官方 Bundle 打包文档](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-rc.5/docs/user/develop/basic/publish.zh.md)

## 插件间联动 API v1

公共模块导出为 `dsh-better-task-grapth/core`、`/store`、`/host`、`/interop`。消费者无需再访问包内私有路径。`ctx.transactionGraph.workflowContract` 固定为 `dsh-taskgraph-workflow-v1`。

宿主插件通过 `registerWorkflowProvider(adapter)` 登记一个联动工作流，返回取消登记函数。adapter 必须给出 contract、version:1、kind、workflowId、真实 projectRoot、operations、authorize、read、execute；subscribe 可发布已提交后的变更通知。重复标识拒绝覆盖，取消登记会取消该入口发起的在途执行。

控制器端接口：

```js
const graph = ctx.transactionGraph
const ref = { kind: 'dynamic-context', workflowId: 'project-workflow' }
const workflows = graph.listWorkflows(controllerAgent)
const snapshot = graph.readWorkflow(controllerAgent, ref)
const result = await graph.dispatchWorkflow(controllerAgent, ref, 'run_next', {
  expectedRevision: snapshot.revision,
}, signal)
const unsubscribe = graph.subscribeWorkflows(notice => {
  // notice 只含 contract、kind、workflowId、type、revision；重新读取提交后的状态。
})
```

动态上下文提供 `submit`、`status`、`run_next`；durable 模式另提供 `pause`、`resume`、`reconcile`、`maintenance`。submit 的 request 为 `{proposal:{taskGraph,contextGraph}}`，两张图仍由动态上下文的一个 CAS 文档原子提交。read 返回同一真实任务图、contextVersion、报告引用和执行状态；不返回原始上下文和报告正文。恢复/对账仍须精确 revision、attempt 与检查点票据，不能通过联动接口绕过。

入口只接受当前注册的真实控制器、原始与当前工作目录均在本项目内；worker 不能提升成控制器。参数由对应 provider 严格校验，来源 Agent 和取消信号由宿主绑定，模型参数不能替换。通知监听器异常不会回滚已提交状态。

联动工作流和原生事务图有明确的存储域。现有 `transaction_graph_*` 工具及 Web 面板仍读取其原有会话账本，不镜像动态图，不把模型报告转成正式事务成功。联动 API 也不会自动完成 Goal 或接管 Web 聊天入口。

## 通用会话扩展接口

`extensionContract` 为 `dsh-taskgraph-session-extension-v1`，公共入口为 `/extensions`。

- `registerSessionPolicy({id, allowClassic(agent)})` 返回注销函数。无策略时原有工具与指引保持启用；扩展可对单个会话禁止经典图写入与提示，工具可见性由扩展的会话作用域控制。
- `createExtensionStore(options)` 创建通用 CAS 存储，不实现扩展业务。默认容量保持原值，调用方可以显式选择容量。
- `inspectGraphPresence(agent)` 根据原生持久化日志和提交收据，区分从未创建、创建待提交、已存在、提交后丢失/损坏以及不确定的创建记录。缺失历史图不能当作空白会话重建。

独立图依然由五个原有工具推进。rc.11 移除了早期候选中的 `workflowOnly`、`revision` 配置、`transaction_graph_revise` 和 `/revision*` 导出；使用这些早期候选接口的宿主需要调整为扩展插件。结构性 `REVISED` 事件仍可由受信扩展使用，旧已提交 V4 事件可读；遗留待提交修订不会跳过原扩展审批自动落盘。

`artifactProof` 默认上限恢复为 16 MiB；扩展可通过第四参数 `{maxBytes}` 明确扩大自身证据范围，不改变独立任务图默认值。

## 许可证

Copyright (C) 2026 oldcitynight and contributors.

本插件按 GPL-3.0-only 授权。完整条款见 [LICENSE](./LICENSE)。
